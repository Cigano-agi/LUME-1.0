import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { createLumeMcpCore } from '../src/mcp/core.js';
import { LUME_MCP_PROTOCOL_VERSION, startLumeMcpStdio } from '../src/mcp/stdio-server.js';
import { startFromEnvironment } from '../src/mcp/stdio-entry.js';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';
import { lumePresencePath, startLumeAppPresence } from '../src/mcp/presence.js';
import { startBrokerApp } from './fixtures/mcp-broker-app.js';
import pacote from '../package.json' with { type: 'json' };

const CONTEXT = { clientId: 'claude-desktop', credential: 'credencial-local-segura-de-teste-com-32-bytes' };

function fixture(t) {
  const db = abrirBanco(); t.after(() => db.close()); new ContextoApp(db); new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo@g.us', 'Equipe');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('grupo@g.us','wa-1','saida','eu',1,'texto','{}','Enviar proposta','2026-09-18T12:00:00.000Z','2026-09-18','minha')`).run();
  const state = { enabled: true, revoked: false, revision: '1', scope: { kind: 'all' } };
  const core = createLumeMcpCore({ db, agora: () => new Date('2026-09-18T15:00:00Z'), secret: Buffer.alloc(32, 4), authorize: async ({ clientId, credential }) => clientId === CONTEXT.clientId && credential === CONTEXT.credential ? structuredClone(state) : { enabled: false } });
  return { db, state, core };
}

function transport(core, options = {}) {
  const input = new PassThrough(), output = new PassThrough(); let buffer = '', messages = [], waiters = [];
  output.on('data', chunk => {
    buffer += chunk.toString('utf8');
    for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line) continue; const value = JSON.parse(line); const waiter = waiters.shift(); if (waiter) waiter(value); else messages.push(value); }
  });
  const server = startLumeMcpStdio({ core, ...CONTEXT, version: pacote.version, input, output, ...options });
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
  const send = async value => { input.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n'); return next(); };
  return { input, output, server, send, next };
}

const init = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'teste', version: '1' } } });

test('stdio negocia initialize, lista as cinco tools e executa chamada estruturada', async t => {
  const f = fixture(t), io = transport(f.core); t.after(() => io.server.stop());
  const initialized = await io.send(init(1));
  assert.equal(initialized.result.protocolVersion, LUME_MCP_PROTOCOL_VERSION);
  assert.equal(initialized.result.serverInfo.version, pacote.version);
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  const listed = await io.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(listed.result.tools.length, 5); assert.ok(listed.result.tools.every(tool => tool.annotations.readOnlyHint));
  const called = await io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: {} } });
  assert.equal(called.result.structuredContent.ok, true);
  assert.equal(called.result.structuredContent.items[0].summary, 'Enviar proposta');
  assert.equal(called.result.content[0].type, 'text'); assert.equal(called.result.isError, undefined);
});

test('stdio fecha protocolo para ordem, JSON, método, tool e entrada inválidos', async t => {
  const f = fixture(t), io = transport(f.core); t.after(() => io.server.stop());
  assert.equal((await io.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).error.code, -32002);
  assert.equal((await io.send('{quebrado')).error.code, -32700);
  await io.send(init(2));
  assert.equal((await io.send({ jsonrpc: '2.0', id: 3, method: 'arquivo/ler', params: {} })).error.code, -32601);
  assert.equal((await io.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lume_apagar_tudo', arguments: {} } })).error.code, -32602);
  const invalid = await io.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lume_buscar_contexto', arguments: { question: null } } });
  assert.equal(invalid.result.isError, true); assert.equal(invalid.result.structuredContent.error.code, 'INVALID_INPUT');
  assert.ok(!JSON.stringify(invalid).includes('SELECT'));
});

test('stdio usa credencial injetada e revoga na chamada seguinte', async t => {
  const f = fixture(t), io = transport(f.core); t.after(() => io.server.stop()); await io.send(init(1));
  let r = await io.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: {} } });
  assert.equal(r.result.structuredContent.ok, true);
  f.state.enabled = false; f.state.revoked = true; f.state.revision = '2';
  r = await io.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: {} } });
  assert.equal(r.result.isError, true); assert.equal(r.result.structuredContent.error.code, 'SCOPE_REVOKED');
  assert.ok(!JSON.stringify(r).includes('Enviar proposta'));
});

test('stdio drena chamada aceita antes de fechar e encerra recurso uma vez', async () => {
  let release, closed = 0;
  const core = { tools: () => [{ name: 'lume_teste', inputSchema: { type: 'object' } }], executar: () => new Promise(resolve => { release = () => resolve({ ok: true, items: [] }); }) };
  const io = transport(core, { onClose: async () => { closed++; } }); await io.send(init(1));
  io.input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lume_teste', arguments: {} } }) + '\n');
  await new Promise(resolve => setImmediate(resolve)); const stopping = io.server.stop(); release();
  const response = await io.next(); await stopping; await io.server.stop();
  assert.equal(response.result.structuredContent.ok, true); assert.equal(closed, 1);
});

test('stdio aceita cancelamento enquanto a ferramenta está em execução', async () => {
  let release;
  const core = { tools: () => [{ name: 'lume_teste', inputSchema: { type: 'object' } }], executar: () => new Promise(resolve => { release = () => resolve({ ok: true, items: [] }); }) };
  const io = transport(core); await io.send(init(1));
  io.input.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lume_teste', arguments: {} } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  io.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9, reason: 'teste' } }) + '\n');
  release(); const response = await io.next(); await io.server.stop();
  assert.equal(response.error.code, -32800); assert.equal(response.id, 9);
});

test('entry exige broker aberto e revogação corta BEGIN', async t => {
  const userData = mkdtempSync(join(homedir(), 'lume-mcp-')), dir = join(userData, 'data'), database = join(dir, 'assessor.db'), activation = join(dir, 'mcp', 'claude-desktop.json');
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  mkdirSync(join(dir, 'mcp'), { recursive: true });
  const db = abrirBanco(database); new ContextoApp(db); new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo@g.us', 'Equipe');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('grupo@g.us','wa-1','saida','eu',1,'texto','{}','Fonte local','2026-09-18T12:00:00.000Z','2026-09-18','minha')`).run(); db.close();
  const descriptor = { client_id: CONTEXT.clientId, credential_hash: createHash('sha256').update(CONTEXT.credential).digest('hex'), revision: '11111111-1111-4111-8111-111111111111', enabled: true, scope: { kind: 'all' }, token_secret: Buffer.alloc(32, 9).toString('base64url') };
  writeFileSync(activation, JSON.stringify(descriptor));
  let presence = startLumeAppPresence({ dataDir: dir });
  await startBrokerApp(t, { userData, credential: CONTEXT.credential, activate: false });
  const names = ['LUME_MCP_DATABASE', 'LUME_MCP_ACTIVATION_FILE', 'LUME_MCP_PRESENCE_FILE', 'LUME_MCP_CLIENT_ID', 'LUME_MCP_CREDENTIAL'], old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { LUME_MCP_DATABASE: database, LUME_MCP_ACTIVATION_FILE: activation, LUME_MCP_PRESENCE_FILE: lumePresencePath(dir), LUME_MCP_CLIENT_ID: CONTEXT.clientId, LUME_MCP_CREDENTIAL: CONTEXT.credential });
  t.after(() => { for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name]; });
  const input = new PassThrough(), output = new PassThrough(); let buffer = '', responses = [];
  output.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); responses.push(...lines.filter(Boolean).map(JSON.parse)); });
  const selected = await selecionarPerfilBoot(userData);
  const server = await startFromEnvironment({ input, output, version: pacote.version, userData, expectedSelection: { tipo: selected.tipo, id: selected.id, geracao: selected.geracao } }); t.after(() => server.stop().catch(() => {}));
  input.write(JSON.stringify(init(1)) + '\n'); input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: { date: '2026-09-18' } } }) + '\n');
  while (responses.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(responses[0].result.serverInfo.version, pacote.version);
  assert.equal(responses[1].result.structuredContent.items[0].summary, 'Fonte local');
  presence.stop();
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: { date: '2026-09-18' } } }) + '\n');
  while (responses.length < 3) await new Promise(resolve => setImmediate(resolve));
  assert.equal(responses[2].result.structuredContent.error.code, 'LUME_CLOSED');
  presence = startLumeAppPresence({ dataDir: dir }); t.after(() => presence.stop());
  writeFileSync(activation, JSON.stringify({ ...descriptor, enabled: false, revision: '22222222-2222-4222-8222-222222222222' }));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: { date: '2026-09-18' } } }) + '\n');
  await assert.rejects(server.closed, { code: 'MCP_DRAIN_UNCONFIRMED' });
});

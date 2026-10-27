import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { detectClaudeDesktop, LumeMcpDesktopService } from '../src/mcp/desktop-service.js';
import { startLumeAppPresence } from '../src/mcp/presence.js';
import { inspectStoredMcpb } from '../scripts/build-lume-mcpb.mjs';
import { criarServidor } from '../src/painel/servidor.js';
import downloads from '../desktop/downloads.cjs';
import pacote from '../package.json' with { type: 'json' };

const MCPB_NAME = `Lume-${pacote.version}.mcpb`;

const temp = t => {
  const dir = mkdtempSync(join(homedir(), 'lume-mcp-desktop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('serviço desktop ativa somente Hoje, entrega pacote e nunca expõe caminho ou hash', t => {
  const dataDir = temp(t);
  const service = new LumeMcpDesktopService({ dataDir, packageRoot: resolve('.'), now: () => new Date('2026-09-19T15:00:00.000Z') });
  assert.equal(service.estado().clientes[0].estado, 'desligado');
  assert.equal(service.estado().clientes[1].estado, 'em_breve');
  assert.equal(service.estado().pacote.versao_disponivel, pacote.version);
  assert.equal(service.estado().pacote.atualizacao, 'manual');
  assert.equal(service.estado().pacote.versao_instalada, null);
  assert.throws(() => service.pacoteClaude(), /Prepare o acesso/);
  const activated = service.ativarClaudeHoje({ confirmar: true });
  assert.equal(activated.clientes[0].estado, 'preparado');
  assert.equal(activated.clientes[0].escopo, 'Hoje');
  assert.match(activated.activation_code, /^[A-Za-z0-9_-]{43}$/);
  for (const forbidden of [dataDir, 'credential_hash', 'token_secret', 'revision']) assert.equal(JSON.stringify(activated).includes(forbidden), false);
  const state = service.estado();
  assert.equal('activation_code' in state, false);
  const packed = service.pacoteClaude();
  assert.match(packed.name, /^Lume-[0-9A-Za-z.-]+\.mcpb$/);
  assert.ok(Buffer.isBuffer(packed.bytes));
  const entries = inspectStoredMcpb(packed.bytes);
  assert.ok(entries.some(entry => entry.name === 'manifest.json'));
  for (const name of ['src/mcp/activation.js', 'src/mcp/profile-broker-client.js',
    'src/mcp/broker-frames.js', 'src/mcp/broker-bootstrap.js', 'src/mcp/broker-acl-native.js']) {
    assert.ok(entries.some(entry => entry.name === name), `${name} ausente do download`);
  }
  const native = ['native/win-acl/bin/lume-acl.exe', 'native/win-acl/bin/manifest.json'];
  for (const name of native) assert.equal(entries.some(entry => entry.name === name), process.platform !== 'darwin', name);
  if (process.platform === 'darwin') {
    const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data);
    assert.deepEqual(manifest.compatibility.platforms, ['darwin']);
  }
  assert.equal(entries.some(entry => entry.name === 'src/mcp/broker-identity.js' || entry.name.startsWith('node_modules/')), false);
  assert.equal(service.revogarClaude({ confirmar: 'DESLIGAR' }).clientes[0].estado, 'desligado');
});

test('autoteste executa o stdio empacotado com configuração temporária e leitura local', async t => {
  const dataDir = temp(t), database = join(dataDir, 'assessor.db');
  const db = abrirBanco(database); new ContextoApp(db); new Desktop(db); db.close();
  const presence = startLumeAppPresence({ dataDir }); t.after(() => presence.stop());
  const service = new LumeMcpDesktopService({ dataDir, packageRoot: resolve('.'), platform: process.platform, now: () => new Date('2026-09-19T15:00:00.000Z') });
  service.ativarClaudeHoje({ confirmar: true });
  const result = await service.testarClaudeLocal();
  assert.deepEqual(result.provas, { pacote: true, configuracao: true, leitura_local: true, transporte_stdio: true });
  assert.equal(result.ok, true);
  assert.equal(result.claude_conectado, false);
  assert.equal(JSON.stringify(result).includes(dataDir), false);
});

test('estado diferencia sistema incompatível e pacote indisponível sem afirmar ausência do Claude', t => {
  const dataDir = temp(t);
  const incompatible = new LumeMcpDesktopService({ dataDir, packageRoot: resolve('.'), platform: 'linux', env: {}, exists: () => false }).estado();
  assert.equal(incompatible.clientes[0].instalacao, 'sistema_incompativel');
  assert.equal(incompatible.clientes[0].sistema_compativel, false);
  const packageUnavailable = new LumeMcpDesktopService({ dataDir, packageRoot: dataDir, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Perfil' }, exists: () => false }).estado();
  assert.equal(packageUnavailable.clientes[0].instalacao, 'nao_confirmado');
  assert.equal(packageUnavailable.clientes[0].pacote_disponivel, false);
});

test('detecção do Claude é somente leitura e ausência fica não confirmada', () => {
  const checked = [];
  assert.deepEqual(detectClaudeDesktop({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Perfil' }, exists: path => { checked.push(path); return path.endsWith('Claude.exe') && path.includes('Programs'); } }), { estado: 'detectado' });
  assert.ok(checked.every(path => path.startsWith('C:\\Perfil')));
  assert.deepEqual(detectClaudeDesktop({ platform: 'darwin', env: { HOME: '/Users/teste' }, exists: () => false }), { estado: 'nao_confirmado' });
  assert.deepEqual(detectClaudeDesktop({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Perfil' }, exists: () => { throw new Error('acesso negado C:\\privado'); } }), { estado: 'nao_confirmado' });
  assert.deepEqual(detectClaudeDesktop({ platform: 'linux', env: {}, exists: () => true }), { estado: 'sistema_incompativel' });
});

test('API MCP exige aceite e token, valida comandos, autoteste e pacote sem metadados privados', async t => {
  const db = abrirBanco(), calls = [];
  const state = { clientes: [{ id: 'claude-desktop', nome: 'Claude Desktop', estado: 'desligado', escopo: null, problema: null, pacote_disponivel: true, sistema_compativel: true, instalacao: 'nao_confirmado' }, { id: 'chatgpt', nome: 'ChatGPT', estado: 'em_breve', escopo: null }], mac_validado: false };
  const mcp = {
    estado: () => state,
    ativarClaudeHoje: input => { calls.push(['activate', input]); return { ...state, activation_code: 'codigo-visivel-uma-vez' }; },
    revogarClaude: input => { calls.push(['revoke', input]); return state; },
    testarClaudeLocal: async () => { calls.push(['test']); return { ok: true, estado: 'aprovado', provas: { pacote: true, configuracao: true, leitura_local: true, transporte_stdio: true }, claude_conectado: false }; },
    pacoteClaude: () => ({ name: MCPB_NAME, bytes: Buffer.from('PK\u0003\u0004pacote') })
  };
  const conexao = { estado: () => ({ estado: 'desconectada' }), parar: async () => {} };
  const server = criarServidor(db, { desktop: true, mcp, conexao });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/sessao')).json();
  assert.equal((await fetch(base + '/api/v3/mcp', { headers: { 'x-assessor-token': session.token } })).status, 403);
  new Desktop(db).aceitar({ nome: 'Pessoa teste', aceito: true, versao: VERSAO_TERMOS });
  assert.equal((await fetch(base + '/api/v3/mcp')).status, 403);
  const headers = { 'x-assessor-token': session.token };
  assert.deepEqual(await (await fetch(base + '/api/v3/mcp', { headers })).json(), state);
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/v3/mcp/ativar-claude', { confirmar: true, extra: 'não' })).status, 400);
  assert.equal((await post('/api/v3/mcp/ativar-claude', { confirmar: true })).status, 200);
  assert.equal((await post('/api/v3/mcp/testar-local', { extra: true })).status, 400);
  const tested = await post('/api/v3/mcp/testar-local', {});
  assert.equal(tested.status, 200);
  assert.equal((await tested.json()).claude_conectado, false);
  mcp.testarClaudeLocal = async () => { throw new Error('ENOENT C:\\Users\\Pessoa\\segredo'); };
  const failedTest = await post('/api/v3/mcp/testar-local', {});
  assert.equal(failedTest.status, 400);
  assert.deepEqual(await failedTest.json(), { erro: 'O teste local não passou. Feche e abra o Lume e tente novamente.' });
  assert.equal((await post('/api/v3/mcp/revogar-claude', { confirmar: 'DESLIGAR' })).status, 200);
  const response = await fetch(base + '/api/v3/mcp/pacote', { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('content-disposition'), `attachment; filename="${MCPB_NAME}"`);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'PK\u0003\u0004pacote');
  assert.deepEqual(calls, [['activate', { confirmar: true, renovar: undefined }], ['test'], ['revoke', { confirmar: 'DESLIGAR' }]]);
  mcp.pacoteClaude = () => { throw new Error('ENOENT C:\\Users\\Pessoa\\segredo'); };
  const failure = await fetch(base + '/api/v3/mcp/pacote', { headers });
  assert.equal(failure.status, 400);
  assert.deepEqual(await failure.json(), { erro: 'Não foi possível preparar a extensão. Tente novamente.' });
});

test('Electron aceita somente MCPB do Lume vindo de blob da própria janela', () => {
  const good = { janelaCorreta: true, origem: 'http://127.0.0.1:3210', url: 'blob:http://127.0.0.1:3210/id', nome: MCPB_NAME };
  assert.equal(downloads.downloadPermitido(good), true);
  for (const change of [{ nome: 'Lume.mcpb' }, { nome: '../Lume-3.1.0.mcpb' }, { nome: 'Lume-3.1.0.mcpb.exe' }, { url: 'blob:http://evil.test/id' }]) {
    assert.equal(downloads.downloadPermitido({ ...good, ...change }), false);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { startFromEnvironment } from '../src/mcp/stdio-entry.js';
import { startLumeAppPresence } from '../src/mcp/presence.js';
import { brokerTestUserData, fixtureCredential, legacyProfile, startBrokerApp } from './fixtures/mcp-broker-app.js';

const names = ['LUME_MCP_CLIENT_ID', 'LUME_MCP_CREDENTIAL'];
function setCredential(t) {
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.LUME_MCP_CLIENT_ID = 'claude-desktop';
  process.env.LUME_MCP_CREDENTIAL = fixtureCredential;
  t.after(() => { for (const name of names) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name]; });
}

test('sem descriptor protegido não responde initialize nem abre banco', async t => {
  setCredential(t);
  const userData = brokerTestUserData(t), database = join(userData, 'data', 'assessor.db');
  const input = new PassThrough(), output = new PassThrough();
  let stdout = ''; output.on('data', chunk => { stdout += chunk; });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  await assert.rejects(startFromEnvironment({ input, output, version: '3.2.0-beta.6', userData, expectedSelection: legacyProfile }));
  assert.equal(existsSync(database), false);
  assert.equal(stdout, '');
});

test('broker concede GRANT antes de initialize e fecha sessão com dois DBs', async t => {
  setCredential(t);
  let granted = false;
  const app = await startBrokerApp(t, { onHello: () => { granted = true; } });
  const database = join(app.dataDir, 'assessor.db');
  const db = abrirBanco(database); new ContextoApp(db); new Desktop(db);
  db.exec('CREATE TABLE lume_execucoes (id TEXT PRIMARY KEY)');
  db.close();
  const presence = startLumeAppPresence({ dataDir: app.dataDir });
  t.after(() => presence.stop());
  const input = new PassThrough(), output = new PassThrough();
  let stdout = ''; output.on('data', chunk => { stdout += chunk; });
  const server = await startFromEnvironment({ input, output, version: '3.2.0-beta.6', userData: app.userData, expectedSelection: legacyProfile });
  t.after(() => server.stop().catch(() => {}));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  const deadline = Date.now() + 2000;
  while (stdout.trim().split('\n').length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const lines = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].result.serverInfo.name, 'lume');
  assert.equal(lines[1].result.tools.length, 9);
  assert.equal(granted, true);
  writeFileSync(join(app.userData, 'perfil-ativo.json'), '{invalid');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: {} } }) + '\n');
  const cutoff = Date.now() + 1000;
  while (stdout.trim().split('\n').length < 3 && Date.now() < cutoff) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(stdout.trim().split('\n')[2]).result.structuredContent.error.code, 'SCOPE_REVOKED');
  await new Promise(resolve => setImmediate(resolve));
  const draining = app.broker.drain({ timeoutMs: 1000 });
  await Promise.race([server.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('DRAIN_DID_NOT_STOP_MCP')), 1200))]);
  assert.deepEqual(await draining, { closed: true });
});

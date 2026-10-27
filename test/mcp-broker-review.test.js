import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { startBrokerApp, fixtureCredential, legacyProfile } from './fixtures/mcp-broker-app.js';
import { applyClaudeActivation } from '../src/mcp/activation.js';
import { connectProfileBroker } from '../src/mcp/profile-broker-client.js';
import { startLumeMcpStdio } from '../src/mcp/stdio-server.js';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite');
const OriginalDatabase = sqlite.DatabaseSync;
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function seedDatabase(dataDir, withExecutions = false) {
  const path = join(dataDir, 'assessor.db');
  const db = new OriginalDatabase(path);
  if (withExecutions) db.exec('CREATE TABLE lume_execucoes (id TEXT)');
  db.close();
  return path;
}

function observeDatabase() {
  const opened = [], closeAttempts = [];
  let failReadClose = false, failSecondOpen = false, attempts = 0;
  class ObservedDatabase extends OriginalDatabase {
    constructor(...args) {
      attempts++;
      if (failSecondOpen && attempts === 2) throw new Error('SYNTHETIC_DB_SECOND_OPEN_FAILED');
      super(...args); opened.push(this);
    }
    close() {
      closeAttempts.push(this);
      if (failReadClose && this === opened[0]) {
        failReadClose = false;
        throw new Error('SYNTHETIC_DB_CLOSE_FAILED');
      }
      return super.close();
    }
  }
  sqlite.DatabaseSync = ObservedDatabase;
  syncBuiltinESMExports();
  return {
    opened, closeAttempts,
    reset({ failFirstClose = false, failOpenTwo = false } = {}) {
      opened.length = 0;
      closeAttempts.length = 0;
      failReadClose = failFirstClose;
      failSecondOpen = failOpenTwo;
      attempts = 0;
    },
    disposeOpened() {
      for (const db of opened) try { OriginalDatabase.prototype.close.call(db); } catch { /* already closed */ }
    },
    restore() {
      sqlite.DatabaseSync = OriginalDatabase;
      syncBuiltinESMExports();
      this.disposeOpened();
    }
  };
}
const observed = observeDatabase();
after(() => observed.restore());

function configureEnvironment(dataDir) {
  const values = {
    LUME_MCP_DATA_DIR: dataDir,
    LUME_MCP_DATABASE: join(dataDir, 'assessor.db'),
    LUME_MCP_ACTIVATION_FILE: join(dataDir, 'mcp', 'claude-desktop.json'),
    LUME_MCP_PRESENCE_FILE: join(dataDir, 'mcp', 'app-presence.json'),
    LUME_MCP_CLIENT_ID: 'claude-desktop',
    LUME_MCP_CREDENTIAL: fixtureCredential,
    LUME_MCP_SELF_TEST_READ_ONLY: undefined
  };
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  return () => { for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; };
}

async function start(userData) {
  const { startFromEnvironment } = await import('../src/mcp/stdio-entry.js');
  return startFromEnvironment({ userData, expectedSelection: legacyProfile, version,
    input: new PassThrough(), output: new PassThrough() });
}

test('C1: broker com admissão fechada recusa antes de qualquer DatabaseSync', { timeout: 12000 }, async t => {
  const fixture = await startBrokerApp(t);
  seedDatabase(fixture.dataDir);
  fixture.broker.stopAdmission();
  const restoreEnv = configureEnvironment(fixture.dataDir);
  observed.reset();
  try {
    const outcome = await start(fixture.userData).then(server => ({ server }), error => ({ error }));
    if (outcome.server) { await outcome.server.stop(); assert.fail('MCP iniciou sem GRANT'); }
    assert.ok(outcome.error, 'conexão deveria ser recusada');
    assert.equal(observed.opened.length, 0, 'SQLite abriu antes do GRANT');
  } finally { restoreEnv(); }
});

test('C1: perda do listener antes de connect rejeita sem abrir DB', { timeout: 12000 }, async t => {
  const fixture = await startBrokerApp(t);
  seedDatabase(fixture.dataDir);
  await fixture.broker.close();
  const restoreEnv = configureEnvironment(fixture.dataDir);
  observed.reset();
  try {
    await assert.rejects(start(fixture.userData));
    assert.equal(observed.opened.length, 0, 'canal perdido antes do GRANT não abre DB');
  } finally { restoreEnv(); }
});

test('C1: DRAIN no tick de GRANT impede start e qualquer DB', { timeout: 12000 }, async t => {
  let fixture, drainPromise;
  fixture = await startBrokerApp(t, { onHello: () => process.nextTick(() => {
    drainPromise = fixture.broker.drain({ timeoutMs: 300 });
    drainPromise.catch(() => {});
  }) });
  seedDatabase(fixture.dataDir);
  const restoreEnv = configureEnvironment(fixture.dataDir);
  observed.reset();
  try {
    await assert.rejects(start(fixture.userData), /MCP_BROKER_UNAVAILABLE|BROKER_CHANNEL_UNCERTAIN/);
    assert.equal(observed.opened.length, 0, 'DRAIN após GRANT não pode abrir DB');
    assert.ok(drainPromise, 'fixture deve ter enviado DRAIN');
    await assert.rejects(drainPromise, /UNCERTAIN/);
  } finally { observed.disposeOpened(); restoreEnv(); }
});

test('C1: escopo/revision alterados após HELLO são recusados antes do DB', { timeout: 12000 }, async t => {
  let fixture;
  fixture = await startBrokerApp(t, { onHello: () => process.nextTick(() => {
    applyClaudeActivation({ activationPath: fixture.activationPath,
      scope: { kind: 'today', date: '2026-09-27' } });
  }) });
  seedDatabase(fixture.dataDir);
  const restoreEnv = configureEnvironment(fixture.dataDir);
  observed.reset();
  try {
    await assert.rejects(start(fixture.userData));
    assert.equal(observed.opened.length, 0, 'revision/escopo alterados não podem abrir DB');
    await assert.rejects(fixture.broker.drain({ timeoutMs: 300 }), /UNCERTAIN/);
  } finally { observed.disposeOpened(); restoreEnv(); }
});

test('C1: falha na segunda abertura fecha primeiro DB e não emite CLOSED', { timeout: 12000 }, async t => {
  const fixture = await startBrokerApp(t);
  seedDatabase(fixture.dataDir, true);
  const restoreEnv = configureEnvironment(fixture.dataDir);
  observed.reset({ failOpenTwo: true });
  try {
    await assert.rejects(start(fixture.userData), /SYNTHETIC_DB_SECOND_OPEN_FAILED/);
    assert.equal(observed.opened.length, 1);
    assert.equal(observed.closeAttempts.includes(observed.opened[0]), true);
    await assert.rejects(fixture.broker.drain({ timeoutMs: 300 }), /UNCERTAIN/);
  } finally { observed.disposeOpened(); restoreEnv(); }
});

test('C1: falha ao fechar DB de leitura ainda tenta fechar DB de execução e aborta sem CLOSED', { timeout: 12000 }, async t => {
  const fixture = await startBrokerApp(t);
  seedDatabase(fixture.dataDir, true);
  const restoreEnv = configureEnvironment(fixture.dataDir);
  observed.reset({ failFirstClose: true });
  let server;
  try {
    server = await start(fixture.userData);
    assert.equal(observed.opened.length, 2, 'perfil com execuções exige dois DBs');
    await assert.rejects(server.stop(), /MCP_DRAIN_UNCONFIRMED/);
    assert.equal(observed.closeAttempts.includes(observed.opened[0]), true, 'DB de leitura tentou fechar');
    assert.equal(observed.closeAttempts.includes(observed.opened[1]), true, 'DB de execução tentou fechar');
    await assert.rejects(fixture.broker.drain({ timeoutMs: 300 }), /UNCERTAIN/, 'sem CLOSED após close falho');
  } finally {
    if (server) try { await server.stop(); } catch { /* already uncertain */ }
    observed.disposeOpened();
    restoreEnv();
  }
});

test('C1: mudança de escopo após GRANT invalida BEGIN da sessão antiga', { timeout: 12000 }, async t => {
  const fixture = await startBrokerApp(t);
  const client = await connectProfileBroker({ descriptor: fixture.descriptor, selection: legacyProfile,
    clientId: 'claude-desktop', credential: fixtureCredential });
  applyClaudeActivation({ activationPath: fixture.activationPath,
    scope: { kind: 'today', date: '2026-09-27' } });
  try {
    await assert.rejects(client.begin(), /BROKER_CHANNEL_UNCERTAIN/);
    await assert.rejects(fixture.broker.drain({ timeoutMs: 300 }), /UNCERTAIN/);
  } finally { client.abort(); }
});

test('C1: DRAIN durante operação admitida espera END e resposta em stdout saudável', { timeout: 5000 }, async () => {
  const input = new PassThrough(), output = new PassThrough(), events = [], replies = [];
  output.on('data', bytes => { for (const line of bytes.toString().trim().split('\n')) if (line) replies.push(JSON.parse(line)); });
  let beginCore, finishCore;
  const coreStarted = new Promise(resolve => { beginCore = resolve; });
  const coreFinished = new Promise(resolve => { finishCore = resolve; });
  const server = startLumeMcpStdio({ input, output, version: '1.0.0', clientId: 'synthetic', credential: 'synthetic',
    core: { tools: () => [{ name: 'synthetic_tool' }], executar: async () => {
      events.push('core'); beginCore(); await coreFinished; return { ok: true, items: [] };
    } },
    operationGate: { begin: async () => { events.push('begin'); return { requestId: 'synthetic' }; },
      end: async () => { events.push('end'); } },
    onClose: async () => { events.push('close'); } });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'synthetic_tool', arguments: {} } }) + '\n');
  await coreStarted;
  const stopped = server.stop();
  finishCore();
  await stopped;
  assert.deepEqual(events, ['begin', 'core', 'end', 'close']);
  assert.equal(replies.find(reply => reply.id === 2)?.result?.structuredContent?.ok, true);
});

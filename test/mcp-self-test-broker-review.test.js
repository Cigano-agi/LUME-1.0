import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { LumeMcpDesktopService, runPackagedStdio } from '../src/mcp/desktop-service.js';
import { startLumeAppPresence } from '../src/mcp/presence.js';

function syntheticChild(t, body) {
  const parent = mkdtempSync(join(homedir(), 'lume-self-test-review-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const entry = join(parent, 'server', 'index.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, body, { flag: 'wx' });
  return { parent, entry };
}

const positive = [
  { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'lume' } } },
  { jsonrpc: '2.0', id: 2, result: { structuredContent: { ok: true, items: [] } } },
  { jsonrpc: '2.0', id: 3, result: { tools: ['lume_resumo_do_dia', 'lume_buscar_contexto', 'lume_abrir_fonte', 'lume_listar_pendencias', 'lume_listar_negocios'].map(name => ({ name })) } }
];
function emitAndExit(messages) {
  return `process.stdout.write(${JSON.stringify(messages.map(message => JSON.stringify(message)).join('\n') + '\n')}, () => process.exit(0));`;
}

test('C2.5: saída zero com três respostas e sem recusa de execução não é aprovação', async t => {
  const { parent, entry } = syntheticChild(t, emitAndExit(positive));
  await assert.rejects(runPackagedStdio({ entry, profileEnv: { APPDATA: parent }, credential: 'synthetic-review-credential', timeoutMs: 2000 }), /SELF_TEST_EARLY_EXIT/);
});

test('C2.5: execução indevidamente aceita invalida autoteste mesmo após três respostas', async t => {
  const acceptedExecution = { jsonrpc: '2.0', id: 4, result: { structuredContent: { ok: true } } };
  const { parent, entry } = syntheticChild(t, emitAndExit([...positive, acceptedExecution]));
  await assert.rejects(runPackagedStdio({ entry, profileEnv: { APPDATA: parent }, credential: 'synthetic-review-credential', timeoutMs: 2000 }), /SELF_TEST_EXECUTION/);
});

test('C2.5: timeout de filho sem respostas permanece incerto', async t => {
  const { parent, entry } = syntheticChild(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(runPackagedStdio({ entry, profileEnv: { APPDATA: parent }, credential: 'synthetic-review-credential', timeoutMs: 250 }), error => {
    assert.match(error.message, /SELF_TEST_TIMEOUT/);
    assert.equal(error.uncertain, true);
    return true;
  });
});

test('C2.5: stdout acima do limite não é interpretado como resposta', async t => {
  const { parent, entry } = syntheticChild(t, "process.stdout.write('x'.repeat(140 * 1024), () => process.exit(0));");
  await assert.rejects(runPackagedStdio({ entry, profileEnv: { APPDATA: parent }, credential: 'synthetic-review-credential', timeoutMs: 2000 }), /SELF_TEST_PROTOCOL/);
});

test('C2.5: falha sintética no close do snapshot preserva stage e original', { timeout: 12000 }, async t => {
  const parent = mkdtempSync(join(homedir(), 'lume-self-test-review-db-'));
  const dataDir = join(parent, 'AssessorDesktop', 'data');
  mkdirSync(dataDir, { recursive: true });
  const sourceDb = join(dataDir, 'assessor.db');
  const db = abrirBanco(sourceDb); new ContextoApp(db); new Desktop(db); db.close();
  const presence = startLumeAppPresence({ dataDir });
  const service = new LumeMcpDesktopService({ dataDir, packageRoot: process.cwd(), now: () => new Date('2026-09-19T15:00:00.000Z') });
  service.ativarClaudeHoje({ confirmar: true });
  const activationPath = join(dataDir, 'mcp', 'claude-desktop.json');
  const originalActivation = readFileSync(activationPath);
  const originalClose = DatabaseSync.prototype.close;
  let held;
  DatabaseSync.prototype.close = function (...args) {
    let file = '';
    try { file = String(this.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file || '').replaceAll('\\', '/').toLowerCase(); }
    catch { /* non-open helper handle */ }
    if (file.includes('/autoteste-') && file.endsWith('/appdata/assessordesktop/data/assessor.db')) {
      held = this;
      throw new Error('SYNTHETIC_SNAPSHOT_CLOSE');
    }
    return originalClose.apply(this, args);
  };
  t.after(() => {
    DatabaseSync.prototype.close = originalClose;
    if (held) try { originalClose.call(held); } catch { /* test handle already closed */ }
    presence.stop();
    rmSync(parent, { recursive: true, force: true });
  });
  let failure;
  try { await service.testarClaudeLocal(); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'FALHA_INTERNA');
  assert.ok(held, 'close do snapshot deve ter sido induzido');
  assert.equal(readFileSync(activationPath).equals(originalActivation), true);
  const stages = readdirSync(join(dataDir, 'mcp', 'packages')).filter(name => name.startsWith('autoteste-'));
  assert.equal(stages.length, 1, 'stage incerto deve permanecer para diagnóstico');
});

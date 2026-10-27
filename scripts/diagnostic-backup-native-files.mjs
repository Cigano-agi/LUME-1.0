// Prova descartável: somente SQLite e dados sintéticos numa raiz temporária exclusiva.
// Uso após liberação da coordenação: node scripts/diagnostic-backup-native-files.mjs --case normal|crash
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROWS = 1000;
const WATCHDOG_MS = 20000;
const OUTPUT_LIMIT = 64 * 1024;
const names = ['acervo.sqlite', 'acervo.sqlite-wal', 'acervo.sqlite-shm'];
const args = process.argv.slice(2);
const childMode = args[0] === '--child';
const mode = args[0] === '--case' || childMode ? args[1] : null;
assert.ok(['normal', 'crash'].includes(mode) && args.length === 2, 'uso: --case normal|crash');

const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = stat => ({ dev: stat.dev.toString(), ino: stat.ino.toString() });

async function checkedStat(target, root, expected) {
  assert.ok(path.isAbsolute(target) && samePath(target, path.resolve(target)), 'alvo não absoluto');
  assert.ok(samePath(target, root) || inside(root, target), 'alvo fora da raiz exclusiva');
  const stat = await lstat(target, { bigint: true });
  assert.ok(!stat.isSymbolicLink(), 'link/reparse recusado');
  assert.ok(samePath(await realpath(target), target), 'caminho reparse recusado');
  if (expected) assert.ok(sameIdentity(stat, expected), 'identidade da raiz alterada');
  if (stat.isFile()) assert.equal(stat.nlink, 1n, 'hardlink recusado');
  return stat;
}

async function removeOwnedTree(target, root, expected) {
  const stat = await checkedStat(target, root, expected);
  if (stat.isDirectory()) {
    for (const name of await readdir(target)) {
      const child = path.resolve(target, name);
      assert.ok(inside(root, child) && samePath(path.dirname(child), target), 'entrada fora da raiz');
      await removeOwnedTree(child, root);
    }
    await checkedStat(target, root, stat);
    await rmdir(target);
  } else if (stat.isFile()) {
    await checkedStat(target, root, stat);
    await unlink(target);
  } else throw new Error('tipo de entrada temporária recusado');
}

async function ownedRoot() {
  const base = path.resolve(tmpdir());
  const root = path.resolve(await mkdtemp(path.join(base, 'lume-native-files-')));
  assert.ok(!samePath(root, base) && samePath(path.dirname(root), base) &&
    !samePath(root, process.cwd()) && !samePath(root, homedir()), 'raiz temporária inesperada');
  const stat = await checkedStat(root, root);
  assert.ok(stat.isDirectory(), 'raiz temporária não é diretório');
  return { root, stat };
}

async function createEmptyFiles(root) {
  const ids = {};
  for (const name of names) {
    const target = path.join(root, name);
    const handle = await open(target, 'wx', 0o600);
    try { assert.equal((await handle.stat({ bigint: true })).size, 0n); }
    finally { await handle.close(); }
    const stat = await checkedStat(target, root);
    assert.ok(stat.isFile(), 'pré-criado não é arquivo');
    ids[name] = identity(stat);
  }
  return ids;
}

async function snapshot(root, ids) {
  const files = {};
  for (const name of names) {
    try {
      const stat = await checkedStat(path.join(root, name), root);
      files[name] = { exists: true, same: stat.dev === BigInt(ids[name].dev) &&
        stat.ino === BigInt(ids[name].ino), file: stat.isFile(), size: Number(stat.size) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files[name] = { exists: false, same: false };
    }
  }
  return files;
}

const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const scalar = (db, name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
const pragmas = db => ({ journal_mode: scalar(db, 'journal_mode'),
  synchronous: scalar(db, 'synchronous'), foreign_keys: scalar(db, 'foreign_keys') });

async function runChild() {
  const root = process.env.LUME_NATIVE_ROOT;
  assert.ok(root && path.isAbsolute(root) && samePath(root, path.resolve(root)), 'raiz ausente');
  const rootStat = await checkedStat(root, root);
  assert.ok(rootStat.isDirectory() && rootStat.dev === BigInt(process.env.LUME_NATIVE_ROOT_DEV) &&
    rootStat.ino === BigInt(process.env.LUME_NATIVE_ROOT_INO), 'raiz do filho divergente');
  const ids = JSON.parse(process.env.LUME_NATIVE_IDS || '{}');
  assert.deepEqual(Object.keys(ids).sort(), names.slice().sort(), 'inventário inicial incompleto');
  const dbPath = path.join(root, names[0]);
  let db;
  let reader;
  let stage = 'open';
  const record = async (name, extra = {}) => emit({ status: 'stage', stage: name,
    files: await snapshot(root, ids), ...extra });
  try {
    db = new DatabaseSync(dbPath, { timeout: 5000 });
    await record('open');
    stage = 'wal';
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    const settings = pragmas(db);
    await record('wal', { pragmas: settings });
    assert.deepEqual(settings, { journal_mode: 'wal', synchronous: 2, foreign_keys: 1 },
      'PRAGMAs efetivos divergentes do staging');
    stage = 'ddl';
    db.exec('CREATE TABLE amostra (id INTEGER PRIMARY KEY, valor TEXT NOT NULL)');
    await record('ddl');
    const insert = db.prepare('INSERT INTO amostra(id,valor) VALUES (?,?)');
    stage = 'rollback';
    db.exec('BEGIN IMMEDIATE');
    insert.run(1, 'sintético-rollback');
    await record('beforeRollback');
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) n FROM amostra').get().n, 0);
    await record('rollback', { count: 0 });
    stage = mode === 'crash' ? 'crashReady' : 'commit';
    db.exec('BEGIN IMMEDIATE');
    for (let i = 1; i <= (mode === 'crash' ? 1 : ROWS); i++) insert.run(i, `sintético-${i}`);
    if (mode === 'crash') {
      await record('crashReady', { uncommittedRows: 1 });
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
    await record('beforeCommit', { uncommittedRows: ROWS });
    db.exec('COMMIT');
    assert.equal(db.prepare('SELECT count(*) n FROM amostra').get().n, ROWS);
    await record('commit', { count: ROWS });
    stage = 'checkpointRestart';
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(RESTART)').get();
    await record('checkpointRestart', { checkpoint });
    assert.equal(checkpoint.busy, 0, 'checkpoint ocupado');
    stage = 'afterResetWrite';
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE amostra SET valor=? WHERE id=1').run('sintético-reset');
    db.exec('COMMIT');
    await record('afterResetWrite', { count: ROWS });
    stage = 'readOnlyOpen';
    reader = new DatabaseSync(dbPath, { readOnly: true });
    const readerCount = reader.prepare('SELECT count(*) n FROM amostra').get().n;
    const integrity = reader.prepare('PRAGMA integrity_check').get().integrity_check;
    await record('readOnlyOpen', { count: readerCount, integrity, pragmas: pragmas(reader) });
    assert.equal(readerCount, ROWS);
    assert.equal(integrity, 'ok');
    stage = 'readOnlyClosed';
    reader.close(); reader = null;
    await record('readOnlyClosed');
    stage = 'primaryClosed';
    db.close(); db = null;
    await record('primaryClosed');
    emit({ status: 'result', outcome: 'observed', rows: ROWS });
  } catch (error) {
    emit({ status: 'result', outcome: 'refuted', failedStage: stage,
      error: { name: error.name || 'Error', code: error.code || null } });
  } finally {
    if (reader) reader.close();
    if (db) db.close();
  }
}

async function runSupervised(root, stat, ids) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, LUME_NATIVE_ROOT: root, LUME_NATIVE_ROOT_DEV: stat.dev.toString(),
      LUME_NATIVE_ROOT_INO: stat.ino.toString(), LUME_NATIVE_IDS: JSON.stringify(ids) },
  });
  let stdout = '';
  let stderr = '';
  let pending = '';
  let outputBytes = 0;
  let overflow = false;
  let timedOut = false;
  let crashKillSent = false;
  let spawnError;
  const events = [];
  const capture = (which, chunk) => {
    const kept = chunk.subarray(0, Math.max(0, OUTPUT_LIMIT - outputBytes));
    outputBytes += kept.length;
    if (which === 'stdout') {
      const part = kept.toString('utf8');
      stdout += part;
      pending += part;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.status === 'stage') {
            events.push(event);
            emit(event); // Diagnóstico parcial, nunca recibo de sucesso.
            if (mode === 'crash' && event.stage === 'crashReady') crashKillSent = child.kill('SIGKILL');
          } else if (event.status === 'result') events.push(event);
        } catch { /* Validação de protocolo ao fechar o filho. */ }
      }
    } else stderr += kept.toString('utf8');
    if (kept.length < chunk.length) { overflow = true; child.kill('SIGKILL'); }
  };
  child.stdout.on('data', chunk => capture('stdout', chunk));
  child.stderr.on('data', chunk => capture('stderr', chunk));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, WATCHDOG_MS);
  let code; let signal;
  try {
    ({ code, signal } = await new Promise(resolve => {
      child.once('error', error => { spawnError = error.code || error.name; });
      child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    }));
  } finally { clearTimeout(timer); }
  return { code, signal, timedOut, overflow, spawnError, crashKillSent,
    events, stdout, stderr, outputBytes };
}

async function runParent() {
  const owned = await ownedRoot();
  let result;
  try {
    const ids = await createEmptyFiles(owned.root);
    const initial = await snapshot(owned.root, ids);
    const supervised = await runSupervised(owned.root, owned.stat, ids);
    const afterClose = await snapshot(owned.root, ids); // Apenas lstat: não reabrir SQLite.
    assert.ok(!supervised.timedOut && !supervised.overflow && !supervised.spawnError,
      'supervisor falhou por timeout, overflow ou spawn');
    const childResult = supervised.events.findLast(event => event.status === 'result');
    if (mode === 'normal' || childResult?.outcome === 'refuted')
      assert.equal(supervised.code, 0, 'filho falhou sem resultado estruturado');
    else assert.ok(supervised.crashKillSent && (supervised.code !== 0 || supervised.signal),
      'encerramento abrupto não comprovado');
    if (mode === 'normal') assert.ok(childResult, 'resultado do filho ausente');
    const stages = supervised.events.filter(event => event.status === 'stage');
    const required = mode === 'normal'
      ? ['open', 'wal', 'ddl', 'beforeRollback', 'rollback', 'beforeCommit', 'commit',
        'checkpointRestart', 'afterResetWrite', 'readOnlyOpen', 'readOnlyClosed', 'primaryClosed']
      : ['open', 'wal', 'ddl', 'beforeRollback', 'rollback', 'crashReady'];
    const missingStages = required.filter(name => !stages.some(event => event.stage === name));
    const identityChanges = stages.filter(event => event.stage !== 'primaryClosed').flatMap(event =>
      names.filter(name => !event.files[name]?.exists || !event.files[name]?.same || !event.files[name]?.file)
        .map(name => ({ stage: event.stage, file: name, observation: event.files[name] })));
    const afterChanges = names.filter(name => afterClose[name].exists && !afterClose[name].same)
      .map(name => ({ stage: 'afterChildClose', file: name, observation: afterClose[name] }));
    const crashMissing = mode === 'crash' ? names.filter(name => !afterClose[name].exists)
      .map(name => ({ stage: 'afterChildClose', file: name, observation: afterClose[name] })) : [];
    const hypothesisPassed = missingStages.length === 0 &&
      (mode === 'normal' ? childResult?.outcome === 'observed' : supervised.crashKillSent) &&
      identityChanges.length === 0 && afterChanges.length === 0 && crashMissing.length === 0;
    result = { status: 'result', mode, hypothesisPassed, childExit: { code: supervised.code,
      signal: supervised.signal, killedDuringTransaction: supervised.crashKillSent },
    initial, stages, afterChildClose: afterClose, missingStages,
    identityChanges: [...identityChanges, ...afterChanges, ...crashMissing],
    childResult: childResult || null, outputBytes: supervised.outputBytes,
    childClosed: true, watchdogMs: WATCHDOG_MS };
  } finally {
    await checkedStat(owned.root, owned.root, owned.stat);
    await removeOwnedTree(owned.root, owned.root, owned.stat);
    await assert.rejects(lstat(owned.root, { bigint: true }), { code: 'ENOENT' });
  }
  emit({ ...result, ownedRootRemoved: true });
}

if (childMode) await runChild();
else await runParent();

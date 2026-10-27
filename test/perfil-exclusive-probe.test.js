import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, lstat, realpath, rm, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const childPath = fileURLToPath(new URL('./fixtures/perfil-exclusive-probe-child.mjs', import.meta.url));
const children = new Set();
const deadlineMs = 5000; // Harness deadline only; never evidence that a lock exists.
const safeEnv = Object.fromEntries([
  'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'HOME', 'TMPDIR',
].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));

function bounded(promise, label) {
  return new Promise((resolveValue, rejectValue) => {
    const timer = setTimeout(() => rejectValue(new Error(`${label} timed out`)), deadlineMs);
    promise.then(
      (value) => { clearTimeout(timer); resolveValue(value); },
      (error) => { clearTimeout(timer); rejectValue(error); },
    );
  });
}

async function actor() {
  const child = fork(childPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: safeEnv });
  children.add(child);
  let nextId = 0;
  const pending = new Map();
  let readyResolve, readyReject, exitResolve;
  let exited = false;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const exit = new Promise((resolveExit) => { exitResolve = resolveExit; });
  child.on('message', (reply) => {
    if (reply.ready) return readyResolve();
    const resolveReply = pending.get(reply.id);
    if (resolveReply) {
      pending.delete(reply.id);
      resolveReply(reply);
    }
  });
  child.on('error', (error) => {
    readyReject(error);
    for (const resolveReply of pending.values()) resolveReply({ ok: false, error: { code: 'SPAWN', message: error.message } });
    pending.clear();
  });
  child.on('exit', (code, signal) => {
    exited = true;
    children.delete(child);
    readyReject(new Error(`child exited before ready: ${code}/${signal}`));
    for (const resolveReply of pending.values()) resolveReply({ ok: false, error: { code: 'EXIT', message: `${code}/${signal}` } });
    pending.clear();
    exitResolve();
  });
  await bounded(ready, 'child ready');
  return {
    child,
    run(op, path) {
      return bounded(new Promise((resolveReply) => {
        const id = ++nextId;
        pending.set(id, resolveReply);
        child.send({ id, op, path }, (error) => {
          if (error && pending.delete(id)) resolveReply({ ok: false, error: { code: 'IPC', message: error.message } });
        });
      }), `child ${op}`);
    },
    exit() {
      if (!exited && child.connected) child.disconnect();
      return bounded(exit, 'child exit');
    },
  };
}

function ok(reply, expected) {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  if (expected !== undefined) assert.deepEqual(reply.value, expected);
}

function busy(reply, step) {
  assert.equal(reply.ok, false, `${step}: ${JSON.stringify(reply)}`);
  assert.equal(reply.error.code, 'ERR_SQLITE_ERROR', `${step}: ${JSON.stringify(reply)}`);
  assert.match(reply.error.message, /database is locked/i, `${step}: ${JSON.stringify(reply)}`);
}

async function fixture(fn, name = 'synthetic.sqlite') {
  const root = await mkdtemp(join(homedir(), 'lume-exclusive-probe-'));
  const path = join(root, name);
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO marker(value) VALUES ('original-a'), ('original-b');");
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.close();
    await fn(path);
    const check = new DatabaseSync(path);
    try {
      assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(check.prepare('SELECT value FROM marker ORDER BY id').all().map((row) => row.value),
        ['original-a', 'original-b']);
    } finally { check.close(); }
  } finally {
    const remaining = [...children];
    const exits = remaining.map((child) => new Promise((resolveExit) => child.once('exit', resolveExit)));
    for (const child of remaining) child.kill();
    // If termination is unconfirmed, keep the synthetic root for diagnosis.
    await bounded(Promise.all(exits), 'all child exits before cleanup');
    const home = await realpath(homedir());
    const target = await realpath(root);
    assert.equal(resolve(target).startsWith(`${resolve(home)}${sep}`), true, 'cleanup target outside homedir');
    assert.match(target.slice(home.length + 1), /^lume-exclusive-probe-[^\\/]+$/);
    assert.equal((await lstat(target)).isDirectory(), true);
    await rm(target, { recursive: true, force: true });
  }
}

test('mode=rw string URI opens exact existing DB and never creates absent DB in Node', async () => fixture(async (path) => {
  const root = dirname(path);
  const missing = join(root, 'ausente espaço # % 漢字.sqlite');
  const vanished = join(root, 'removido espaço # % 漢字.sqlite');
  const owner = await actor();
  const peer = await actor();
  try {
    await assert.rejects(lstat(missing), { code: 'ENOENT' });
    const absent = await owner.run('openUriRw', missing);
    assert.equal(absent.ok, false, JSON.stringify(absent));
    assert.equal(absent.error.code, 'ERR_SQLITE_ERROR');
    await assert.rejects(lstat(missing), { code: 'ENOENT' });

    await writeFile(vanished, 'synthetic');
    await unlink(vanished);
    const removed = await owner.run('openUriRw', vanished);
    assert.equal(removed.ok, false, JSON.stringify(removed));
    assert.equal(removed.error.code, 'ERR_SQLITE_ERROR');
    await assert.rejects(lstat(vanished), { code: 'ENOENT' });

    ok(await owner.run('openUriRw', path), 'opened-uri-rw');
    ok(await owner.run('mode'), 'exclusive');
    ok(await owner.run('beginExclusive'), 'begun');
    const main = (await owner.run('databaseList')).value.find((row) => row.name === 'main');
    assert.ok(main?.file, 'PRAGMA database_list did not identify main DB');
    assert.equal(await realpath(main.file), await realpath(path));
    ok(await owner.run('read'), [{ id: 1, value: 'original-a' }, { id: 2, value: 'original-b' }]);
    ok(await peer.run('open', path));
    busy(await peer.run('read'), 'peer while URI lease active');
    ok(await owner.run('rollback'));
    busy(await peer.run('read'), 'peer after URI lease ROLLBACK');
    ok(await owner.run('close'));
    ok(await peer.run('read'), [{ id: 1, value: 'original-a' }, { id: 2, value: 'original-b' }]);
    ok(await peer.run('close'));
  } finally { await Promise.all([owner.exit(), peer.exit()]); }
}, 'db espaço # % 漢字.sqlite'));

test('WAL exclusive: PRAGMA is only a setting; idle and active consumers block acquisition', async () => fixture(async (path) => {
  for (const state of ['idle', 'activeRead', 'activeWriter', 'openedOnly']) {
    const consumer = await actor();
    const owner = await actor();
    try {
      ok(await consumer.run('open', path));
      if (state === 'idle') ok(await consumer.run('read'));
      if (state === 'activeRead') ok(await consumer.run('activeRead'));
      if (state === 'activeWriter') ok(await consumer.run('beginImmediate'));
      ok(await owner.run('open', path));
      ok(await owner.run('mode'), 'exclusive');
      const acquire = await owner.run('beginExclusive');
      // An unqueried DatabaseSync has no WAL read lock yet.
      if (state === 'openedOnly') {
        ok(acquire, 'begun');
        busy(await consumer.run('read'), 'first query on previously opened consumer');
        ok(await owner.run('rollback'));
      } else {
        // This is the acquiring step, not the PRAGMA response.
        busy(acquire, state);
      }
      if (state === 'activeRead') ok(await consumer.run('rollback'));
      if (state === 'activeWriter') ok(await consumer.run('rollback'));
      ok(await consumer.run('close'));
      ok(await owner.run('beginExclusive'), 'begun');
      ok(await owner.run('rollback'));
      ok(await owner.run('close'));
    } finally {
      await Promise.all([consumer.exit(), owner.exit()]);
    }
  }
}));

test('WAL exclusive blocks new readers and writers, close releases, crash releases OS lock', async () => fixture(async (path) => {
  const owner = await actor();
  const reader = await actor();
  const writer = await actor();
  try {
    ok(await owner.run('open', path));
    ok(await owner.run('mode'), 'exclusive');
    ok(await owner.run('beginExclusive'), 'begun');
    ok(await reader.run('open', path));
    busy(await reader.run('read'), 'new reader query');
    ok(await writer.run('open', path));
    busy(await writer.run('beginImmediate'), 'new writer BEGIN IMMEDIATE');
    ok(await owner.run('rollback'));
    // WAL exclusive mode retains its lock after transaction end.
    busy(await reader.run('read'), 'reader after ROLLBACK, before close');
    ok(await owner.run('close'));
    ok(await reader.run('read'), [{ id: 1, value: 'original-a' }, { id: 2, value: 'original-b' }]);
    ok(await writer.run('beginImmediate'), 'begun');
    ok(await writer.run('rollback'));
    ok(await reader.run('close'));
    ok(await writer.run('close'));

    const crashOwner = await actor();
    try {
      ok(await crashOwner.run('open', path));
      ok(await crashOwner.run('mode'), 'exclusive');
      ok(await crashOwner.run('beginExclusive'), 'begun');
      ok(await crashOwner.run('crash'), 'crashing');
      await crashOwner.exit();
      const afterCrash = await actor();
      try {
        ok(await afterCrash.run('open', path));
        ok(await afterCrash.run('read'), [{ id: 1, value: 'original-a' }, { id: 2, value: 'original-b' }]);
        ok(await afterCrash.run('close'));
      } finally { await afterCrash.exit(); }
    } finally { await crashOwner.exit(); }
  } finally { await Promise.all([owner.exit(), reader.exit(), writer.exit()]); }
}));

test('WAL BEGIN IMMEDIATE baseline allows readers while preventing another writer', async () => fixture(async (path) => {
  const owner = await actor();
  const reader = await actor();
  const writer = await actor();
  try {
    ok(await owner.run('open', path));
    ok(await owner.run('beginImmediate'), 'begun');
    ok(await reader.run('open', path));
    ok(await reader.run('read'), [{ id: 1, value: 'original-a' }, { id: 2, value: 'original-b' }]);
    ok(await writer.run('open', path));
    busy(await writer.run('beginImmediate'), 'second writer BEGIN IMMEDIATE');
    ok(await owner.run('rollback'));
    ok(await writer.run('beginImmediate'), 'begun');
    ok(await writer.run('rollback'));
    ok(await owner.run('close'));
    ok(await reader.run('close'));
    ok(await writer.run('close'));
  } finally { await Promise.all([owner.exit(), reader.exit(), writer.exit()]); }
}));

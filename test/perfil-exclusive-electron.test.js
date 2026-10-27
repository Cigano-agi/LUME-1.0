import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, mkdir, lstat, realpath, rm, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import electronPath from 'electron';

const electronMain = fileURLToPath(new URL('./fixtures/perfil-exclusive-electron.cjs', import.meta.url));
const nodeClient = fileURLToPath(new URL('./fixtures/perfil-exclusive-probe-child.mjs', import.meta.url));
const deadlineMs = 12000; // Only bounds the test harness; not lock evidence.
const safeEnv = Object.fromEntries([
  'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'HOME', 'TMPDIR', 'DISPLAY', 'XDG_RUNTIME_DIR',
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

function track(child, processes) {
  const state = { child, exited: false };
  state.exit = new Promise((resolveExit) => {
    const finish = (code, signal) => {
      if (state.exited) return;
      state.exited = true;
      processes.delete(state);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveExit({ code, signal });
    };
    child.once('exit', finish);
    child.once('error', () => { if (!child.pid) finish(null, 'SPAWN_ERROR'); });
  });
  processes.add(state);
  return state;
}

async function nodeActor(processes) {
  const state = track(fork(nodeClient, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: safeEnv }), processes);
  let readyResolve, readyReject, nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  state.child.on('message', (row) => {
    if (row.ready) return readyResolve();
    const resolveReply = pending.get(row.id);
    if (resolveReply) { pending.delete(row.id); resolveReply(row); }
  });
  state.child.once('error', readyReject);
  state.exit.then(() => {
    readyReject(new Error('Node client exited before ready'));
    for (const resolveReply of pending.values()) resolveReply({ ok: false, error: { code: 'EXIT' } });
    pending.clear();
  });
  await bounded(ready, 'Node client ready');
  return {
    run(op, path) {
      return bounded(new Promise((resolveReply) => {
        const id = ++nextId;
        pending.set(id, resolveReply);
        state.child.send({ id, op, path }, (error) => {
          if (error && pending.delete(id)) resolveReply({ ok: false, error: { code: 'IPC', message: error.message } });
        });
      }), `Node client ${op}`);
    },
    async exit() {
      if (!state.exited && state.child.connected) state.child.disconnect();
      return bounded(state.exit, 'Node client exit');
    },
  };
}

async function electronActor(processes, dbPath, userData, { uriMode = false } = {}) {
  const args = [electronMain, `--probe-db=${dbPath}`, `--probe-user-data=${userData}`];
  if (uriMode) args.push('--probe-uri-mode=rw');
  const state = track(spawn(electronPath, args, {
    env: safeEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }), processes);
  let buffer = '', waiting;
  const queue = [];
  state.child.stderr.on('data', () => {});
  state.child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    if (buffer.length > 8192) return state.child.kill();
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (waiting) { const resolveReply = waiting; waiting = undefined; resolveReply(row); }
      else queue.push(row);
    }
  });
  state.child.once('error', (error) => {
    if (waiting) { const resolveReply = waiting; waiting = undefined; resolveReply({ event: 'error', code: 'SPAWN', message: error.message }); }
  });
  state.exit.then((result) => {
    if (waiting) { const resolveReply = waiting; waiting = undefined; resolveReply({ event: 'exit', ...result }); }
  });
  function receive(label) {
    return bounded(new Promise((resolveReply) => {
      if (queue.length) return resolveReply(queue.shift());
      assert.equal(waiting, undefined, 'only one outstanding Electron read');
      waiting = resolveReply;
    }), label);
  }
  const ready = await receive('Electron main ready');
  assert.equal(ready.event, 'ready', JSON.stringify(ready));
  assert.equal(ready.runtime, 'electron-main');
  assert.match(ready.versions.node, /^\d+\./);
  assert.match(ready.versions.sqlite, /^\d+\./);
  assert.match(ready.versions.electron, /^\d+\./);
  assert.ok(Number.isInteger(ready.port) && ready.port > 0);
  return {
    versions: ready.versions,
    async command(command, expectedEvent) {
      const reply = await bounded(new Promise((resolveReply, rejectReply) => {
        const socket = net.connect({ host: '127.0.0.1', port: ready.port }, () => socket.write(`${command}\n`));
        let response = '';
        socket.on('data', (chunk) => {
          response += String(chunk);
          if (response.length > 1024) { socket.destroy(); return rejectReply(new Error('Electron reply too large')); }
          const end = response.indexOf('\n');
          if (end >= 0) {
            socket.destroy();
            try { resolveReply(JSON.parse(response.slice(0, end))); } catch (error) { rejectReply(error); }
          }
        });
        socket.once('error', rejectReply);
        socket.once('close', () => { if (!response.includes('\n')) rejectReply(new Error('Electron control closed without ACK')); });
      }), `Electron ${command}`);
      assert.equal(reply.event, expectedEvent, JSON.stringify(reply));
      return reply;
    },
    async exit() {
      const result = await bounded(state.exit, 'Electron main exit');
      assert.deepEqual(result, { code: 0, signal: null });
    },
  };
}

test('Electron main mode=rw string URI keeps absent DB absent and locks exact existing DB', async () => {
  const root = await mkdtemp(join(homedir(), 'lume-exclusive-electron-'));
  const dbPath = join(root, 'db espaço # % 漢字.sqlite');
  const userData = join(root, 'userData');
  const processes = new Set();
  try {
    await mkdir(userData);
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO marker(value) VALUES ('original-a'), ('original-b');");
      assert.equal(seed.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally { seed.close(); }

    const owner = await electronActor(processes, dbPath, userData, { uriMode: true });
    const missing = `${dbPath}.missing`;
    const vanished = `${dbPath}.vanished`;
    await assert.rejects(lstat(missing), { code: 'ENOENT' });
    const deniedMissing = await owner.command('openUriMissing', 'open-error');
    assert.equal(deniedMissing.code, 'ERR_SQLITE_ERROR');
    await assert.rejects(lstat(missing), { code: 'ENOENT' });
    await writeFile(vanished, 'synthetic');
    await unlink(vanished);
    const deniedVanished = await owner.command('openUriVanished', 'open-error');
    assert.equal(deniedVanished.code, 'ERR_SQLITE_ERROR');
    await assert.rejects(lstat(vanished), { code: 'ENOENT' });

    await owner.command('openUriExisting', 'opened-uri-rw');
    const acquired = await owner.command('acquire', 'acquired');
    assert.equal(acquired.mode, 'exclusive');
    const listed = await owner.command('databaseList', 'database-list');
    assert.ok(listed.databaseFile);
    assert.equal(await realpath(listed.databaseFile), await realpath(dbPath));
    const peer = await nodeActor(processes);
    try {
      ok(await peer.run('open', dbPath));
      busy(await peer.run('read'));
      await owner.command('rollback', 'rolled-back');
      busy(await peer.run('read'));
      await owner.command('close', 'closed');
      await owner.exit();
      ok(await peer.run('read'), [{ id: 1, value: 'original-a' }, { id: 2, value: 'original-b' }]);
      ok(await peer.run('close'));
    } finally { await peer.exit(); }
    const check = new DatabaseSync(dbPath);
    try {
      assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(check.prepare('SELECT value FROM marker ORDER BY id').all().map((row) => row.value),
        ['original-a', 'original-b']);
    } finally { check.close(); }
    process.stdout.write(`ELECTRON_URI_VERSIONS=${JSON.stringify(owner.versions)}\n`);
  } finally {
    const remaining = [...processes];
    const exits = remaining.map((state) => state.exit);
    for (const state of remaining) state.child.kill();
    await bounded(Promise.all(exits), 'all child exits before cleanup');
    const home = await realpath(homedir());
    const target = await realpath(root);
    assert.equal(dirname(target), home, 'cleanup root must be direct child of homedir');
    assert.match(target.slice(home.length + 1), /^lume-exclusive-electron-[^\\/]+$/);
    assert.equal((await lstat(target)).isDirectory(), true);
    await rm(target, { recursive: true, force: true });
  }
});

function ok(row, expected) {
  assert.equal(row.ok, true, JSON.stringify(row));
  if (expected !== undefined) assert.deepEqual(row.value, expected);
}

function busy(row) {
  assert.equal(row.ok, false, JSON.stringify(row));
  assert.equal(row.error.code, 'ERR_SQLITE_ERROR');
  assert.match(row.error.message, /database is locked/i);
}

test('Electron main EXCLUSIVE WAL blocks Node peers and refuses preexisting WAL reader', async () => {
  const root = await mkdtemp(join(homedir(), 'lume-exclusive-electron-'));
  const dbPath = join(root, 'synthetic.sqlite');
  const userData = join(root, 'userData');
  const processes = new Set();
  try {
    await mkdir(userData);
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE marker(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO marker(value) VALUES ('original-a'), ('original-b');");
      assert.equal(seed.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally { seed.close(); }

    const owner = await electronActor(processes, dbPath, userData);
    const acquired = await owner.command('acquire', 'acquired');
    assert.equal(acquired.mode, 'exclusive');
    const reader = await nodeActor(processes);
    const writer = await nodeActor(processes);
    try {
      ok(await reader.run('open', dbPath));
      busy(await reader.run('read'));
      ok(await writer.run('open', dbPath));
      busy(await writer.run('beginImmediate'));
      busy(await writer.run('writeAttempt'));
      await owner.command('rollback', 'rolled-back');
      busy(await reader.run('read'));
      busy(await writer.run('beginImmediate'));
      await owner.command('close', 'closed');
      await owner.exit();
      ok(await reader.run('read'), [{ id: 1, value: 'original-a' }, { id: 2, value: 'original-b' }]);
      ok(await writer.run('beginImmediate'), 'begun');
      ok(await writer.run('rollback'));
      ok(await reader.run('close'));
      ok(await writer.run('close'));
    } finally { await Promise.all([reader.exit(), writer.exit()]); }

    const oldReader = await nodeActor(processes);
    try {
      ok(await oldReader.run('open', dbPath));
      ok(await oldReader.run('read'));
      const deniedOwner = await electronActor(processes, dbPath, userData);
      assert.deepEqual(deniedOwner.versions, owner.versions);
      const denied = await deniedOwner.command('acquire', 'busy');
      assert.equal(denied.mode, 'exclusive');
      assert.equal(denied.code, 'ERR_SQLITE_ERROR');
      assert.match(denied.message, /database is locked/i);
      await deniedOwner.command('close', 'closed');
      await deniedOwner.exit();
      ok(await oldReader.run('close'));
    } finally { await oldReader.exit(); }

    const check = new DatabaseSync(dbPath);
    try {
      assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(check.prepare('SELECT value FROM marker ORDER BY id').all().map((row) => row.value),
        ['original-a', 'original-b']);
    } finally { check.close(); }
    process.stdout.write(`ELECTRON_EXCLUSIVE_VERSIONS=${JSON.stringify(owner.versions)}\n`);
  } finally {
    const remaining = [...processes];
    const exits = remaining.map((state) => state.exit);
    for (const state of remaining) state.child.kill();
    // Preserve the synthetic root if process termination cannot be confirmed.
    await bounded(Promise.all(exits), 'all child exits before cleanup');
    const home = await realpath(homedir());
    const target = await realpath(root);
    assert.equal(dirname(target), home, 'cleanup root must be direct child of homedir');
    assert.match(target.slice(home.length + 1), /^lume-exclusive-electron-[^\\/]+$/);
    assert.equal((await lstat(target)).isDirectory(), true);
    await rm(target, { recursive: true, force: true });
  }
});

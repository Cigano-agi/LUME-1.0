import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { snapshotLumeProfile, verifySnapshot } from '../scripts/snapshot-lume-profile.mjs';

test('Windows probe distingue CLI do Lume de outro projeto no mesmo PC', { skip: process.platform !== 'win32' }, async () => {
  const source = await readFile(new URL('../scripts/snapshot-lume-profile.mjs', import.meta.url), 'utf8');
  const literal = source.match(/const command = ("[^\n]+?");/)?.[1];
  assert.ok(literal);
  const command = JSON.parse(literal);
  const run = commandLine => {
    const fake = `@([pscustomobject]@{Name='node.exe';CommandLine='${commandLine}'})`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      command.replace('Get-CimInstance Win32_Process', fake)], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(run('C:\\Users\\Usuario\\orca\\projects\\Lume\\app\\bin\\app.js'), 'running');
  assert.equal(run('node bin/app.js'), 'running');
  assert.equal(run('node "bin/app.js"'), 'running');
  assert.equal(run('node .\\bin\\app.js'), 'running');
  assert.equal(run('node ".\\bin\\app.js"'), 'running');
  assert.equal(run('C:\\Users\\Usuario\\orca\\projects\\assessor-2.0\\bin\\app.js'), 'stopped');
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lume-snapshot-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(path.join(source, 'data'), { recursive: true });
  await mkdir(path.join(source, 'credenciais'));
  await mkdir(path.join(source, 'empty'));
  await writeFile(path.join(source, 'data', 'assessor.db'), 'synthetic database');
  await writeFile(path.join(source, 'data', 'assessor.db-wal'), 'synthetic wal');
  await writeFile(path.join(source, 'credenciais', 'session'), 'synthetic credential');
  return { root, source, destination: path.join(root, 'snapshot'), rehearsal: path.join(root, 'rehearsal'), processProbe: async () => false };
}

test('snapshot preserves every DB/WAL/auth byte and rehearses a fresh profile with verified hashes', async t => {
  const f = await fixture(t);
  const result = await snapshotLumeProfile(f);
  assert.equal(result.files, 3);
  assert.equal(result.verified, true);
  assert.equal(result.rehearsed, true);
  for (const name of ['data/assessor.db', 'data/assessor.db-wal', 'credenciais/session']) {
    assert.deepEqual(await readFile(path.join(f.source, name)), await readFile(path.join(f.destination, 'profile', name)));
    assert.deepEqual(await readFile(path.join(f.source, name)), await readFile(path.join(f.rehearsal, name)));
  }
  await access(path.join(f.rehearsal, 'empty'));
  const manifest = JSON.parse(await readFile(path.join(f.destination, 'manifest.json')));
  assert.equal(manifest.files.length, 3);
  assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(JSON.stringify(manifest).includes('synthetic credential'), false);
  await writeFile(path.join(f.destination, 'profile', 'credenciais', 'session'), 'corrupted');
  await assert.rejects(verifySnapshot(f.destination), { code: 'SNAPSHOT_HASH_MISMATCH' });
});

test('refuses running Lume and inability to inspect processes before creating outputs', async t => {
  for (const processProbe of [async () => true, async () => { throw new Error('probe failure'); }]) {
    const f = await fixture(t);
    await assert.rejects(snapshotLumeProfile({ ...f, processProbe }), { code: 'LUME_NOT_STOPPED' });
    await assert.rejects(access(f.destination), { code: 'ENOENT' });
  }
});

test('refuses existing and overlapping destinations without modifying source', async t => {
  const f = await fixture(t);
  for (const change of [{ destination: f.source }, { rehearsal: f.source }, { destination: path.join(f.source, 'backup') }, { rehearsal: f.destination }])
    await assert.rejects(snapshotLumeProfile({ ...f, ...change }), { code: 'SNAPSHOT_PATH_CONFLICT' });
  await mkdir(f.destination);
  await assert.rejects(snapshotLumeProfile(f), { code: 'SNAPSHOT_DESTINATION_EXISTS' });
  assert.equal(await readFile(path.join(f.source, 'credenciais', 'session'), 'utf8'), 'synthetic credential');
});

test('refuses symlink contents and ancestor junctions', async t => {
  const f = await fixture(t);
  await symlink(path.join(f.source, 'credenciais'), path.join(f.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotLumeProfile(f), { code: 'SNAPSHOT_UNSAFE_PATH' });
  await assert.rejects(access(f.destination), { code: 'ENOENT' });
  const linkedRoot = path.join(f.root, 'linked-source');
  await symlink(f.source, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(snapshotLumeProfile({ ...f, source: linkedRoot }), { code: 'SNAPSHOT_UNSAFE_PATH' });
});

test('refuses writing credentials into a Git tree', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, '.git'));
  await assert.rejects(snapshotLumeProfile(f), { code: 'SNAPSHOT_DESTINATION_IN_GIT' });
});

test('rehearsal preserves a real SQLite WAL and its committed event', async t => {
  const f = await fixture(t);
  await rm(path.join(f.source, 'data', 'assessor.db-wal'));
  await rm(path.join(f.source, 'data', 'assessor.db'));
  const db = new DatabaseSync(path.join(f.source, 'data', 'assessor.db'));
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE events(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO events VALUES(1,\'synthetic event\')');
    const result = await snapshotLumeProfile(f);
    assert.equal(result.rehearsed, true);
    const restored = new DatabaseSync(path.join(f.rehearsal, 'data', 'assessor.db'));
    try {
      assert.equal(restored.prepare('SELECT text FROM events WHERE id=1').get().text, 'synthetic event');
      assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally { restored.close(); }
  } finally { db.close(); }
});

test('source mutation or Lume restarting during copy cannot produce a completed receipt', async t => {
  for (const restart of [true, false]) {
    const f = await fixture(t);
    let calls = 0;
    const processProbe = async () => {
      if (++calls === 3) {
        if (restart) return true;
        await writeFile(path.join(f.source, 'credenciais', 'session'), 'changed synthetic credential');
      }
      return false;
    };
    await assert.rejects(snapshotLumeProfile({ ...f, processProbe }), { code: restart ? 'LUME_NOT_STOPPED' : 'SNAPSHOT_SOURCE_CHANGED' });
    await assert.rejects(access(path.join(f.destination, 'receipt.json')), { code: 'ENOENT' });
    await assert.rejects(access(f.rehearsal), { code: 'ENOENT' });
  }
});

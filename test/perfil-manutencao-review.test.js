import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';
import { acquireExclusiveDb, createMaintenanceMarker, markMaintenanceStarted, readMaintenanceMarker, releaseUnstartedMarker } from '../src/perfil-manutencao.js';

const OP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(t, { withDb = true } = {}) {
  const home = realpathSync(homedir());
  const userData = mkdtempSync(join(home, 'lume-maint-review-'));
  const dataDir = join(userData, 'data');
  mkdirSync(dataDir);
  const dbPath = join(dataDir, 'assessor.db');
  if (withDb) {
    const db = new DatabaseSync(dbPath);
    try { db.exec('PRAGMA journal_mode=WAL; CREATE TABLE prova(id INTEGER PRIMARY KEY); INSERT INTO prova VALUES(1)'); }
    finally { db.close(); }
  }
  t.after(() => {
    const target = realpathSync(userData);
    assert.equal(dirname(target), home, 'cleanup outside homedir');
    assert.match(basename(target), /^lume-maint-review-[^\\/]+$/);
    assert.equal(lstatSync(target).isDirectory(), true);
    rmSync(target, { recursive: true, force: true });
  });
  return { userData, dbPath, markerPath: join(userData, 'perfil-manutencao.json') };
}

async function marker(x) {
  const selection = await selecionarPerfilBoot(x.userData);
  const handle = await createMaintenanceMarker({ userData: x.userData, selection, opId: OP_ID, kind: 'notetaker-delete' });
  return { handle, selection };
}

test('review: release e markMaintenanceStarted serializam a fase através do await ACL', async (t) => {
  const x = fixture(t), { handle } = await marker(x);
  const pendingRelease = releaseUnstartedMarker(handle);
  const pendingSettled = Promise.allSettled([pendingRelease]);
  let started = false;
  try { markMaintenanceStarted(handle); started = true; }
  catch (error) { assert.equal(error.code, 'PERFIL_MANUTENCAO_INVALIDA'); }
  const [release] = await pendingSettled;
  if (started) {
    assert.equal(release.status, 'rejected', 'start confirmado impede release');
    assert.equal(existsSync(x.markerPath), true, 'marcador iniciado deve permanecer');
  } else {
    assert.equal(release.status, 'fulfilled', 'release reservado primeiro termina sem start');
    assert.equal(existsSync(x.markerPath), false);
  }
});

test('review: release e acquire não confirmam ao mesmo tempo', async (t) => {
  const x = fixture(t), { handle, selection } = await marker(x);
  const pendingRelease = releaseUnstartedMarker(handle);
  const pendingAcquire = acquireExclusiveDb({ selection, maintenanceHandle: handle });
  const [release, acquire] = await Promise.allSettled([pendingRelease, pendingAcquire]);
  if (acquire.status === 'fulfilled') assert.deepEqual(acquire.value.close(), { closed: true });
  assert.notEqual(release.status, acquire.status, 'release e acquire não podem confirmar juntos');
  assert.equal(existsSync(x.markerPath), acquire.status === 'fulfilled',
    'lease confirmado mantém marcador; release confirmado pode removê-lo');
});

test('review: create exige DB legado existente e não cria marcador se ausente', async (t) => {
  const x = fixture(t, { withDb: false });
  const selection = await selecionarPerfilBoot(x.userData);
  await assert.rejects(createMaintenanceMarker({ userData: x.userData, selection, opId: OP_ID, kind: 'notetaker-delete' }));
  assert.equal(existsSync(x.dbPath), false);
  assert.equal(existsSync(x.markerPath), false);
});

test('review: journal surge durante ACL de create e impede marcador novo', async (t) => {
  const x = fixture(t), selection = await selecionarPerfilBoot(x.userData);
  const pending = createMaintenanceMarker({ userData: x.userData, selection, opId: OP_ID, kind: 'notetaker-delete' });
  mkdirSync(join(x.userData, 'notetaker-delete-journal'));
  const [created] = await Promise.allSettled([pending]);
  assert.equal(created.status, 'rejected', 'journal surgido durante await impede create');
  assert.equal(existsSync(x.markerPath), false, 'conflito antes de create não deixa marker novo');
});

test('review: handle novo não adquire lease sobre journal órfão surgido depois', async (t) => {
  const x = fixture(t), { handle, selection } = await marker(x);
  mkdirSync(join(x.userData, 'notetaker-delete-journal'));
  const [acquire] = await Promise.allSettled([acquireExclusiveDb({ selection, maintenanceHandle: handle })]);
  if (acquire.status === 'fulfilled') assert.deepEqual(acquire.value.close(), { closed: true });
  assert.equal(acquire.status, 'rejected', 'nova operação não pode adquirir com journal pré-existente');
  assert.equal(existsSync(x.markerPath), true);
});

test('review: opId array não passa create nem cold reader por coerção de RegExp', async (t) => {
  const fresh = fixture(t), selection = await selecionarPerfilBoot(fresh.userData);
  const [created] = await Promise.allSettled([createMaintenanceMarker({
    userData: fresh.userData, selection, opId: [OP_ID], kind: 'notetaker-delete',
  })]);
  const coldRoot = fixture(t);
  await marker(coldRoot);
  const raw = JSON.parse(readFileSync(coldRoot.markerPath, 'utf8'));
  raw.opId = [OP_ID];
  writeFileSync(coldRoot.markerPath, `${JSON.stringify(raw)}\n`);
  const [cold] = await Promise.allSettled([readMaintenanceMarker({ userData: coldRoot.userData })]);
  assert.equal(created.status, 'rejected', 'create exige UUID string');
  assert.equal(existsSync(fresh.markerPath), false);
  assert.equal(cold.status, 'rejected', 'cold reader exige UUID string');
  assert.equal(existsSync(coldRoot.markerPath), true);
});

test('review: troca do DB após marcador recusa recovery e lease do handle antigo', async (t) => {
  const x = fixture(t), { handle, selection } = await marker(x);
  renameSync(x.dbPath, join(dirname(x.dbPath), 'anterior.sqlite'));
  const replacement = new DatabaseSync(x.dbPath);
  try { replacement.exec('CREATE TABLE substituto(id INTEGER PRIMARY KEY)'); }
  finally { replacement.close(); }
  const cold = await Promise.allSettled([readMaintenanceMarker({ userData: x.userData })]);
  const lease = await Promise.allSettled([acquireExclusiveDb({ selection, maintenanceHandle: handle })]);
  if (lease[0].status === 'fulfilled') assert.deepEqual(lease[0].value.close(), { closed: true });
  assert.equal(cold[0].status, 'rejected', 'recovery não pode aceitar outro DB no mesmo caminho');
  assert.equal(lease[0].status, 'rejected', 'handle antigo não pode adquirir DB substituído');
  assert.equal(existsSync(x.markerPath), true);
});

test('review: falha de close nunca vira recibo confirmado em retry', async (t) => {
  const x = fixture(t), { handle, selection } = await marker(x);
  const lease = await acquireExclusiveDb({ selection, maintenanceHandle: handle });
  const nativeClose = DatabaseSync.prototype.close;
  Object.defineProperty(lease.db, 'close', { configurable: true, value: () => { throw Error('injected close failure'); } });
  try {
    assert.throws(() => lease.close(), { code: 'PERFIL_MANUTENCAO_INCERTA' });
    assert.throws(() => lease.close(), { code: 'PERFIL_MANUTENCAO_INCERTA' });
    assert.equal(existsSync(x.markerPath), true);
  } finally {
    delete lease.db.close;
    nativeClose.call(lease.db);
  }
});

test('review: create não adota marker substituto com bytes idênticos durante ACL', { skip: process.platform !== 'win32' }, async (t) => {
  const x = fixture(t), selection = await selecionarPerfilBoot(x.userData);
  let swapped = false, swapError;
  const timer = setInterval(() => {
    if (swapped || !existsSync(x.markerPath)) return;
    try {
      const raw = readFileSync(x.markerPath);
      if (!raw.length || raw.at(-1) !== 10) return;
      renameSync(x.markerPath, join(x.userData, 'marker-original'));
      writeFileSync(x.markerPath, raw);
      swapped = true;
    } catch (error) { swapError = error; }
  }, 1);
  let result;
  try {
    [result] = await Promise.allSettled([createMaintenanceMarker({
      userData: x.userData, selection, opId: OP_ID, kind: 'notetaker-delete',
    })]);
  } finally { clearInterval(timer); }
  if (swapError) throw swapError;
  assert.equal(swapped, true, 'barreira ACL não observou marker criado');
  assert.equal(result.status, 'rejected', 'create não pode emitir handle para inode substituto');
  assert.equal(existsSync(x.markerPath), true);
});

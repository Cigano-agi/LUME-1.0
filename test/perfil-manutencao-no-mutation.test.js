import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';
import {
  acquireExclusiveDb, acquireExclusiveNoMutation, assertNormalBootAllowed, createMaintenanceMarker,
  finishMaintenanceWithoutMutation, markMaintenanceStarted, readMaintenanceMarker,
} from '../src/perfil-manutencao.js';

const OP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function fixture(t) {
  const home = realpathSync(homedir());
  const userData = mkdtempSync(join(home, 'lume-maint-no-mutation-'));
  const dataDir = join(userData, 'data');
  mkdirSync(dataDir);
  const dbPath = join(dataDir, 'assessor.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE prova(id INTEGER PRIMARY KEY); INSERT INTO prova VALUES(1)');
  db.close();
  t.after(() => {
    const target = realpathSync(userData);
    assert.equal(dirname(target), home);
    assert.match(basename(target), /^lume-maint-no-mutation-/);
    rmSync(target, { recursive: true, force: true });
  });
  return { userData, dataDir, dbPath, marker: join(userData, 'perfil-manutencao.json'), journal: join(userData, 'notetaker-delete-journal') };
}
async function started(x) {
  const selection = await selecionarPerfilBoot(x.userData);
  const handle = await createMaintenanceMarker({ userData: x.userData, selection, opId: OP, kind: 'notetaker-delete' });
  markMaintenanceStarted(handle);
  return { selection, handle };
}

test('via sem mutação entrega token opaco e remove apenas seu marcador depois do close', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  const token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle });
  assert.equal(Object.isFrozen(token), true);
  assert.deepEqual(Reflect.ownKeys(token), []);
  assert.throws(() => assertNormalBootAllowed(x.userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  assert.deepEqual(await finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), {
    opId: OP, kind: 'notetaker-delete', outcome: 'sem_mutacao', leaseClosed: true, markerRemoved: true,
  });
  assert.equal(existsSync(x.marker), false);
  assert.doesNotThrow(() => assertNormalBootAllowed(x.userData));
  const db = new DatabaseSync(x.dbPath);
  try { assert.deepEqual(db.prepare('SELECT id FROM prova').all().map(row => row.id), [1]); }
  finally { db.close(); }
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
});

test('created, recovery, token falso e lease genérico não abrem finalização', async t => {
  const x = fixture(t), selection = await selecionarPerfilBoot(x.userData);
  const handle = await createMaintenanceMarker({ userData: x.userData, selection, opId: OP, kind: 'notetaker-delete' });
  await assert.rejects(acquireExclusiveNoMutation({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  const cold = await readMaintenanceMarker({ userData: x.userData });
  await assert.rejects(acquireExclusiveNoMutation({ selection, maintenanceHandle: cold }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  markMaintenanceStarted(handle);
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: Object.freeze({}) }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: { ...handle }, noMutationToken: Object.freeze({}) }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  const lease = await acquireExclusiveDb({ selection, maintenanceHandle: handle });
  try { await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: lease }), { code: 'PERFIL_MANUTENCAO_INVALIDA' }); }
  finally { lease.close(); }
  assert.equal(existsSync(x.marker), true);
});

test('journal antes da aquisição recusa token e mantém marcador', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  mkdirSync(x.journal);
  await assert.rejects(acquireExclusiveNoMutation({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(x.marker), true);
});

test('token alheio e duas finalizações concorrentes não liberam operação errada', async t => {
  const a = fixture(t), b = fixture(t);
  const first = await started(a), second = await started(b);
  const tokenA = await acquireExclusiveNoMutation({ selection: first.selection, maintenanceHandle: first.handle });
  const tokenB = await acquireExclusiveNoMutation({ selection: second.selection, maintenanceHandle: second.handle });
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: second.handle, noMutationToken: tokenA }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: { ...first.handle }, noMutationToken: tokenA }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  const pending = finishMaintenanceWithoutMutation({ maintenanceHandle: first.handle, noMutationToken: tokenA });
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: first.handle, noMutationToken: tokenA }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(a.marker), true);
  await pending;
  assert.equal(existsSync(a.marker), false);
  assert.equal(existsSync(b.marker), true);
  await finishMaintenanceWithoutMutation({ maintenanceHandle: second.handle, noMutationToken: tokenB });
});

test('journal surgido depois da aquisição retém marcador e consome token', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  const token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle });
  mkdirSync(x.journal);
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(x.marker), true);
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
});

test('journal surgido durante ACL de finalização impede close como recibo de sucesso', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  const token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle });
  const pending = finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token });
  mkdirSync(x.journal);
  await assert.rejects(pending, { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(x.marker), true);
});

test('marcador substituído após aquisição retém marcador', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  const token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle });
  renameSync(x.marker, join(x.userData, 'old-marker'));
  writeFileSync(x.marker, readFileSync(join(x.userData, 'old-marker')));
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(x.marker), true);
});

test('DB substituído antes da aquisição recusa token sem liberar marcador', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  renameSync(x.dbPath, join(x.dataDir, 'old.db'));
  const db = new DatabaseSync(x.dbPath);
  db.exec('CREATE TABLE substituta(id INTEGER)'); db.close();
  await assert.rejects(acquireExclusiveNoMutation({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(x.marker), true);
});

test('troca de marcador ou DB no close é detectada na revalidação posterior', async t => {
  for (const kind of ['marker', 'db']) {
    const x = fixture(t), { selection, handle } = await started(x);
    const token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle });
    const nativeClose = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function () {
      nativeClose.call(this);
      if (kind === 'marker') {
        renameSync(x.marker, join(x.userData, 'old-marker'));
        writeFileSync(x.marker, readFileSync(join(x.userData, 'old-marker')));
      } else {
        renameSync(x.dbPath, join(x.dataDir, 'old.db'));
        const replacement = new DatabaseSync(x.dbPath);
        replacement.exec('CREATE TABLE substituta(id INTEGER)');
        nativeClose.call(replacement);
      }
    };
    try { await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' }); }
    finally { DatabaseSync.prototype.close = nativeClose; }
    assert.equal(existsSync(x.marker), true);
  }
});

test('close incerto nunca remove marcador nem permite retry', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  const token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle });
  const nativeClose = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { nativeClose.call(this); throw Error('close incerto injetado'); };
  try { await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INCERTA' }); }
  finally { DatabaseSync.prototype.close = nativeClose; }
  assert.equal(existsSync(x.marker), true);
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.throws(() => assertNormalBootAllowed(x.userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
});

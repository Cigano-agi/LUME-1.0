import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';
import {
  acquireExclusiveDb, acquireExclusiveNoMutation, assertNormalBootAllowed,
  createMaintenanceMarker, finishMaintenanceWithoutMutation, markMaintenanceStarted,
  readMaintenanceMarker,
} from '../src/perfil-manutencao.js';

const OP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fault = () => Object.assign(new Error('falha injetada'), { code: 'EIO' });

function fixture(t) {
  const home = fs.realpathSync(homedir());
  const userData = fs.mkdtempSync(join(home, 'lume-maint-review-'));
  const dataDir = join(userData, 'data');
  fs.mkdirSync(dataDir);
  const dbPath = join(dataDir, 'assessor.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE prova(id INTEGER PRIMARY KEY, valor TEXT); INSERT INTO prova VALUES(1, \'intacto\')');
  db.close();
  t.after(() => {
    const target = fs.realpathSync(userData);
    assert.equal(dirname(target), home);
    assert.match(basename(target), /^lume-maint-review-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { userData, dbPath, marker: join(userData, 'perfil-manutencao.json') };
}

function denyDeleteSql() {
  const prepare = DatabaseSync.prototype.prepare;
  const exec = DatabaseSync.prototype.exec;
  let calls = 0;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    assert.doesNotMatch(sql, /\bDELETE\b/i);
    calls++;
    return prepare.call(this, sql, ...args);
  };
  DatabaseSync.prototype.exec = function (sql, ...args) {
    assert.doesNotMatch(sql, /\bDELETE\b/i);
    calls++;
    return exec.call(this, sql, ...args);
  };
  return () => {
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.exec = exec;
    assert.ok(calls > 0, 'o guard SQL observou a aquisição');
  };
}

async function started(x) {
  const selection = await selecionarPerfilBoot(x.userData);
  const handle = await createMaintenanceMarker({ userData: x.userData, selection, opId: OP, kind: 'notetaker-delete' });
  markMaintenanceStarted(handle);
  return { selection, handle };
}

async function assertNoMutation(x, before) {
  assert.deepEqual(fs.readFileSync(x.dbPath), before);
  const db = new DatabaseSync(x.dbPath);
  try { assert.deepEqual(db.prepare('SELECT id, valor FROM prova').all().map(row => ({ ...row })), [{ id: 1, valor: 'intacto' }]); }
  finally { db.close(); }
}

test('falha de unlink anterior à remoção mantém marker, dados e cold boot fechado', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  const before = fs.readFileSync(x.dbPath);
  const markerBefore = fs.readFileSync(x.marker);
  const restoreSql = denyDeleteSql();
  let token;
  try { token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle }); }
  finally { restoreSql(); }
  assert.equal(Object.isFrozen(token), true);
  assert.deepEqual(Reflect.ownKeys(token), []);
  const originalUnlink = fs.unlinkSync;
  let reached = false;
  fs.unlinkSync = function (path, ...args) {
    if (path === x.marker) {
      reached = true;
      assert.equal(fs.existsSync(x.marker), true);
      throw fault();
    }
    return originalUnlink.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'EIO' }); }
  finally { fs.unlinkSync = originalUnlink; syncBuiltinESMExports(); }
  assert.equal(reached, true);
  assert.equal(fs.existsSync(x.marker), true);
  assert.deepEqual(fs.readFileSync(x.marker), markerBefore);
  await assertNoMutation(x, before);
  assert.throws(() => assertNormalBootAllowed(x.userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(acquireExclusiveNoMutation({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  const cold = await readMaintenanceMarker({ userData: x.userData });
  await assert.rejects(acquireExclusiveNoMutation({ selection, maintenanceHandle: cold }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: cold, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  const generic = await acquireExclusiveDb({ selection, maintenanceHandle: cold });
  try { await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: cold, noMutationToken: generic }), { code: 'PERFIL_MANUTENCAO_INVALIDA' }); }
  finally { generic.close(); }
});

test('falha de syncDirectory após unlink consome token sem alterar conteúdo nem recompor marker', async t => {
  const x = fixture(t), { selection, handle } = await started(x);
  const before = fs.readFileSync(x.dbPath);
  const restoreSql = denyDeleteSql();
  let token;
  try { token = await acquireExclusiveNoMutation({ selection, maintenanceHandle: handle }); }
  finally { restoreSql(); }
  const originalOpen = fs.openSync, originalFsync = fs.fsyncSync;
  let openedDirectory = false, reachedSync = false;
  fs.openSync = function (path, flags, ...args) {
    if (path === x.userData && flags === 'r') {
      openedDirectory = true;
      // Windows não abre diretórios com fs.openSync('r'); fornecer um fd sintético
      // permite alcançar o fsync posterior sem tocar política ou dados reais.
      return originalOpen.call(this, x.dbPath, 'r');
    }
    return originalOpen.call(this, path, flags, ...args);
  };
  fs.fsyncSync = function (fd) {
    if (openedDirectory) {
      reachedSync = true;
      assert.equal(fs.existsSync(x.marker), false, 'unlink já ocorreu');
      throw fault();
    }
    return originalFsync.call(this, fd);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'EIO' }); }
  finally { fs.openSync = originalOpen; fs.fsyncSync = originalFsync; syncBuiltinESMExports(); }
  assert.equal(reachedSync, true);
  assert.equal(fs.existsSync(x.marker), false);
  await assertNoMutation(x, before);
  await assert.rejects(finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: token }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(acquireExclusiveNoMutation({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.doesNotThrow(() => assertNormalBootAllowed(x.userData));
  await assert.rejects(readMaintenanceMarker({ userData: x.userData }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
});

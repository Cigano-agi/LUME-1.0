import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';
import { acquireExclusiveDb, assertNormalBootAllowed, createMaintenanceMarker, markMaintenanceStarted, readMaintenanceMarker, releaseUnstartedMarker } from '../src/perfil-manutencao.js';

const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(t, withDb = true) {
  const userData = mkdtempSync(join(homedir(), 'lume-maint-api-'));
  const dataDir = join(userData, 'data');
  mkdirSync(dataDir);
  const dbPath = join(dataDir, 'assessor.db');
  if (withDb) {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE prova(id INTEGER PRIMARY KEY); INSERT INTO prova VALUES(1)');
    db.close();
  }
  t.after(() => {
    assert.equal(dirname(resolve(userData)), resolve(homedir()));
    assert.match(basename(userData), /^lume-maint-api-/);
    rmSync(userData, { recursive: true, force: true });
  });
  return { userData, dataDir, dbPath };
}
const make = async x => createMaintenanceMarker({ userData: x.userData, selection: await selecionarPerfilBoot(x.userData), opId: OP, kind: 'notetaker-delete' });

test('marcador próprio é estrito, recovery lê sem liberar e release só antes de start', async t => {
  const x = fixture(t), handle = await make(x);
  assert.throws(() => assertNormalBootAllowed(x.userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  const recovered = await readMaintenanceMarker({ userData: x.userData });
  assert.equal(recovered.opId, OP);
  assert.equal(recovered.selection.dataDir, x.dataDir);
  await assert.rejects(releaseUnstartedMarker(recovered));
  assert.deepEqual(await releaseUnstartedMarker(handle), { released: true });
  assert.equal(existsSync(join(x.userData, 'perfil-manutencao.json')), false);
  assert.doesNotThrow(() => assertNormalBootAllowed(x.userData));
  const started = await make(x);
  markMaintenanceStarted(started);
  await assert.rejects(releaseUnstartedMarker(started));
});

test('marcador substituído e órfão nunca são removidos pelo dono antigo', async t => {
  const x = fixture(t), handle = await make(x);
  const marker = join(x.userData, 'perfil-manutencao.json');
  renameSync(marker, join(x.userData, 'old-marker'));
  writeFileSync(marker, readFileSync(join(x.userData, 'old-marker')));
  await assert.rejects(releaseUnstartedMarker(handle));
  assert.equal(existsSync(marker), true);
  assert.throws(() => assertNormalBootAllowed(x.userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
});

test('DB ausente recusa criação do marcador e, após retirada, lease sem recriar', async t => {
  const x = fixture(t, false), selection = await selecionarPerfilBoot(x.userData);
  await assert.rejects(make(x), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(join(x.userData, 'perfil-manutencao.json')), false);
  const db = new DatabaseSync(x.dbPath); db.exec('CREATE TABLE prova(id INTEGER)'); db.close();
  const handle = await make(x);
  rmSync(x.dbPath);
  await assert.rejects(acquireExclusiveDb({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  assert.equal(existsSync(x.dbPath), false);
  await assert.rejects(releaseUnstartedMarker(handle), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
});

test('DB substituído por link/hardlink recusa sem tocar alvo', async t => {
  for (const kind of ['symlink', 'hardlink']) {
    const x = fixture(t), selection = await selecionarPerfilBoot(x.userData), handle = await make(x);
    const outside = join(x.userData, 'outside.db');
    writeFileSync(outside, 'untouched');
    rmSync(x.dbPath);
    try {
      if (kind === 'symlink') symlinkSync(outside, x.dbPath, 'file');
      else linkSync(outside, x.dbPath);
    } catch (error) {
      if (kind !== 'symlink' || error.code !== 'EPERM') throw error;
      t.diagnostic('symlink Windows sem privilégio; hardlink segue testado');
      continue;
    }
    await assert.rejects(acquireExclusiveDb({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  }
});

test('lease EXCLUSIVE barra leitor e writer depois do ROLLBACK e close libera', async t => {
  const x = fixture(t), selection = await selecionarPerfilBoot(x.userData), handle = await make(x);
  const lease = await acquireExclusiveDb({ selection, maintenanceHandle: handle });
  assert.equal(lease.acquired, true);
  assert.equal(lease.db.isTransaction, false);
  const other = new DatabaseSync(x.dbPath, { timeout: 0 });
  try {
    assert.throws(() => other.prepare('SELECT * FROM prova').all(), /database is locked/);
    assert.throws(() => other.exec('BEGIN IMMEDIATE'), /database is locked/);
    assert.deepEqual(await lease.close(), { closed: true });
    assert.deepEqual(other.prepare('SELECT * FROM prova').all().map(row => row.id), [1]);
  } finally { other.close(); await lease.close(); }
});

test('troca do diretório data depois do marcador recusa o lease e o release', async t => {
  const x = fixture(t), selection = await selecionarPerfilBoot(x.userData), handle = await make(x);
  rmSync(x.dataDir, { recursive: true });
  mkdirSync(x.dataDir);
  const db = new DatabaseSync(x.dbPath); db.exec('CREATE TABLE outra(id INTEGER)'); db.close();
  await assert.rejects(releaseUnstartedMarker(handle), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(acquireExclusiveDb({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
});

test('DB regular trocado depois do marcador recusa live e cold recovery', async t => {
  const x = fixture(t), selection = await selecionarPerfilBoot(x.userData), handle = await make(x);
  renameSync(x.dbPath, join(x.dataDir, 'old.db'));
  const replacement = new DatabaseSync(x.dbPath); replacement.exec('CREATE TABLE nova(id INTEGER)'); replacement.close();
  await assert.rejects(acquireExclusiveDb({ selection, maintenanceHandle: handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(readMaintenanceMarker({ userData: x.userData }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  await assert.rejects(releaseUnstartedMarker(handle), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
});

test('schema adulterado, IDs extras e handle falso não liberam marker frio', async t => {
  const x = fixture(t), handle = await make(x), marker = join(x.userData, 'perfil-manutencao.json');
  await assert.rejects(releaseUnstartedMarker({ ...handle }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  const cold = await readMaintenanceMarker({ userData: x.userData });
  await assert.rejects(releaseUnstartedMarker(cold), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
  const valid = JSON.parse(readFileSync(marker, 'utf8'));
  for (const patch of [{ extra: 1 }, { opId: 'not-uuid' }, { kind: 'restore' }, { dataIdentity: { ...valid.dataIdentity, ino: '0' } }]) {
    writeFileSync(marker, JSON.stringify({ ...valid, ...patch }));
    await assert.rejects(readMaintenanceMarker({ userData: x.userData }), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
    assert.throws(() => assertNormalBootAllowed(x.userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  }
  await assert.rejects(releaseUnstartedMarker(handle), { code: 'PERFIL_MANUTENCAO_INVALIDA' });
});

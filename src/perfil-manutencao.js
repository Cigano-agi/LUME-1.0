import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, isAbsolute, normalize, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyBrokerAcl } from './mcp/broker-acl-native.js';
import { conferirPerfilTeste } from './notetaker/perfil-teste.js';
import { montarPlanoExclusao } from './notetaker/exclusao-plano.js';
import { inventariarArquivosExclusao } from './notetaker/exclusao-arquivos.js';
import { CONTROLE_EXCLUSAO, DDL_CONTROLE_EXCLUSAO, NOMES_OBJETOS_CONTROLE_EXCLUSAO, validarControleExclusao } from './notetaker/exclusao-controle.js';
import { assertNormalBootAllowed } from './perfil-boot-guard.js';

export { assertNormalBootAllowed } from './perfil-boot-guard.js';

const MARKER = 'perfil-manutencao.json';
const JOURNAL = 'notetaker-delete-journal';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 4096;
const handles = new WeakMap();
const noMutationTokens = new WeakMap();
const contentHandles = new WeakMap();
const contentReceipts = new WeakMap();
const completedContentReceipts = new WeakSet();
const contentReservations = new Map();
const fail = code => Object.assign(new Error(code), { code });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = stat => Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
const exact = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === names.slice().sort().join(',');

function pathValid(userData) {
  if (typeof userData !== 'string' || !isAbsolute(userData) || normalize(userData) !== userData || userData.includes('\0'))
    throw fail('PERFIL_CAMINHO_INVALIDO');
  return userData;
}
function absent(path) {
  try { lstatSync(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw fail('PERFIL_MANUTENCAO_PENDENTE'); }
}
function checked(path, type) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch { throw fail('PERFIL_MANUTENCAO_INVALIDA'); }
  if (stat.isSymbolicLink() || (type === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return stat;
}
function chain(path) {
  const root = parse(path).root;
  return relative(root, path).split(sep).filter(Boolean).reduce((all, piece) => [...all, join(all.at(-1), piece)], [root]);
}
function checkedChain(path) { return chain(path).map(name => ({ name, stat: checked(name, 'directory') })); }
function sameChain(before) { return before.every(({ name, stat }) => same(stat, checked(name, 'directory'))); }
function stablePath(path) {
  const real = realpathSync(path);
  return process.platform === 'win32' ? real.toLowerCase() === resolve(path).toLowerCase() : real === resolve(path);
}
async function protectedPath(userData, target, type) {
  const root = checkedChain(userData);
  if (!stablePath(userData)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const paths = chain(target);
  if (paths.indexOf(userData) < 0 || paths.length > 32) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const targetStat = checked(target, type);
  if (process.platform === 'win32') await verifyBrokerAcl({ userData, paths, strictFrom: paths.indexOf(userData) });
  else {
    const uid = process.getuid?.();
    if (!Number.isInteger(uid)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    for (const [index, path] of paths.entries()) {
      const stat = checked(path, path === target && type === 'file' ? 'file' : 'directory');
      const writable = Number(stat.mode) & 0o022;
      const stickyAncestor = index < paths.indexOf(userData) && stat.isDirectory() && stat.uid === 0n &&
        (Number(stat.mode) & 0o1000);
      if ((stat.uid !== BigInt(uid) && stat.uid !== 0n) || (writable && !stickyAncestor) ||
          (index >= paths.indexOf(userData) && stat.uid !== BigInt(uid))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    }
  }
  if (!sameChain(root) || !same(targetStat, checked(target, type))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return targetStat;
}
function legacy(userData, selection) {
  if (!exact(selection, ['tipo', 'id', 'geracao', 'dataDir', 'credenciaisDir']) ||
      selection.tipo !== 'legado' || selection.id !== 'legado' || selection.geracao !== null ||
      selection.dataDir !== join(userData, 'data') || selection.credenciaisDir !== join(userData, 'credenciais'))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  for (const marker of ['perfil-ativo.json', 'perfil-publicacao.json', 'profiles'])
    if (!absent(join(userData, marker))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const root = checked(userData, 'directory'), data = checked(selection.dataDir, 'directory');
  if (!stablePath(selection.dataDir)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const dbPath = join(selection.dataDir, 'assessor.db'), db = checked(dbPath, 'file');
  if (!stablePath(dbPath)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return { root, data, db };
}
function markerPath(userData) { return join(pathValid(userData), MARKER); }
function journalPath(userData) { return join(pathValid(userData), JOURNAL); }

function snapshot(userData, markerStat, raw, payload, state, selection) {
  const value = Object.freeze({ opId: payload.opId, kind: payload.kind, perfil: Object.freeze({ ...payload.perfil }),
    rootIdentity: Object.freeze({ ...payload.rootIdentity }), dataIdentity: Object.freeze({ ...payload.dataIdentity }),
    dbIdentity: Object.freeze({ ...payload.dbIdentity }),
    markerIdentity: identity(markerStat), selection: Object.freeze({ ...selection }) });
  handles.set(value, { userData, markerStat, raw, state });
  return value;
}
function contentSnapshot(userData, markerStat, raw, payload, state, selection, perfil) {
  const handle = Object.freeze(Object.create(null));
  contentHandles.set(handle, { userData, markerStat, raw, payload, state, selection, perfil,
    reservationKey: `${userData}\0${payload.markerId}`, lease: null });
  return handle;
}
function handleInfo(handle) {
  const info = handles.get(handle);
  if (!info) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return info;
}
function readMarkerBytes(path, expected) {
  const before = checked(path, 'file');
  if ((expected && !same(before, expected)) || before.size < 1n || before.size > BigInt(MAX_BYTES))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!same(opened, before) || !opened.isFile() || opened.nlink !== 1n) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd, { bigint: true });
    const pathAfter = checked(path, 'file');
    if (length < 1 || length > MAX_BYTES || !same(before, after) || !same(before, pathAfter) ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.size !== pathAfter.size ||
        before.mtimeNs !== pathAfter.mtimeNs || BigInt(length) !== before.size)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } catch { throw fail('PERFIL_MANUTENCAO_INVALIDA'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function sameMarker(info) {
  const path = markerPath(info.userData), stat = checked(path, 'file');
  if (!same(stat, info.markerStat) || stat.size !== info.markerStat.size ||
      stat.mtimeNs !== info.markerStat.mtimeNs || readMarkerBytes(path, stat) !== info.raw)
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return stat;
}
function sameProfile(handle, info) {
  const { root, data, db } = legacy(info.userData, handle.selection);
  if (JSON.stringify(identity(root)) !== JSON.stringify(handle.rootIdentity) ||
      JSON.stringify(identity(data)) !== JSON.stringify(handle.dataIdentity) ||
      JSON.stringify(identity(db)) !== JSON.stringify(handle.dbIdentity))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return { root, data, db };
}
function syncDirectory(path) {
  let fd;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(error?.code) &&
        !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function createMaintenanceMarker({ userData, selection, opId, kind } = {}) {
  pathValid(userData);
  if (typeof opId !== 'string' || !UUID.test(opId) || kind !== 'notetaker-delete')
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  assertNormalBootAllowed(userData);
  const { root, data, db } = legacy(userData, selection);
  await protectedPath(userData, userData, 'directory');
  await protectedPath(userData, selection.dataDir, 'directory');
  await protectedPath(userData, join(selection.dataDir, 'assessor.db'), 'file');
  assertNormalBootAllowed(userData);
  if (!same(root, checked(userData, 'directory')) || !same(data, checked(selection.dataDir, 'directory')) ||
      !same(db, checked(join(selection.dataDir, 'assessor.db'), 'file')))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const payload = { schema: 1, opId, kind, perfil: { tipo: 'legado', id: 'legado', geracao: null },
    rootIdentity: identity(root), dataIdentity: identity(data), dbIdentity: identity(db) };
  const raw = JSON.stringify(payload) + '\n';
  if (Buffer.byteLength(raw) > MAX_BYTES) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let fd;
  try {
    fd = openSync(markerPath(userData), 'wx', 0o600);
    writeFileSync(fd, raw, 'utf8'); fsyncSync(fd);
    const createdStat = fstatSync(fd, { bigint: true });
    closeSync(fd); fd = undefined;
    const markerStat = await protectedPath(userData, markerPath(userData), 'file');
    if (!same(createdStat, markerStat) || readMarkerBytes(markerPath(userData), markerStat) !== raw ||
        !same(root, checked(userData, 'directory')) ||
        !same(data, checked(selection.dataDir, 'directory')) ||
        !same(db, checked(join(selection.dataDir, 'assessor.db'), 'file')) ||
        !absent(journalPath(userData))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    syncDirectory(userData);
    return snapshot(userData, markerStat, raw, payload, 'created', selection);
  } catch { throw fail('PERFIL_MANUTENCAO_INVALIDA'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function readMaintenanceMarker({ userData } = {}) {
  pathValid(userData);
  const path = markerPath(userData);
  const markerStat = await protectedPath(userData, path, 'file');
  if (markerStat.size < 1n || markerStat.size > BigInt(MAX_BYTES)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const raw = readMarkerBytes(path, markerStat);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw fail('PERFIL_MANUTENCAO_INVALIDA'); }
  if (payload?.schema === 2) {
    if (!exact(payload, ['schema','opId','kind','perfil','rootIdentity','dataIdentity','dbIdentity','previa','markerId']) ||
        typeof payload.opId !== 'string' || !UUID.test(payload.opId) || payload.kind !== 'notetaker-delete-content' ||
        typeof payload.markerId !== 'string' || !UUID.test(payload.markerId) ||
        !exact(payload.perfil, ['tipo','id','geracao']) || payload.perfil.tipo !== 'legado' ||
        payload.perfil.id !== 'legado' || payload.perfil.geracao !== null ||
        !exact(payload.previa, ['sessaoId','revisao','assinatura','schemaAssinatura']) ||
        typeof payload.previa.sessaoId !== 'string' || !UUID.test(payload.previa.sessaoId) ||
        !Number.isInteger(payload.previa.revisao) || payload.previa.revisao < 0 ||
        !/^[a-f0-9]{64}$/.test(payload.previa.assinatura) || !/^[a-f0-9]{64}$/.test(payload.previa.schemaAssinatura) ||
        !exact(payload.rootIdentity, ['dev','ino']) || !exact(payload.dataIdentity, ['dev','ino']) ||
        !exact(payload.dbIdentity, ['dev','ino']) ||
        !/^(0|[1-9][0-9]*)$/.test(payload.rootIdentity.dev) || !/^(0|[1-9][0-9]*)$/.test(payload.rootIdentity.ino) ||
        !/^(0|[1-9][0-9]*)$/.test(payload.dataIdentity.dev) || !/^(0|[1-9][0-9]*)$/.test(payload.dataIdentity.ino) ||
        !/^(0|[1-9][0-9]*)$/.test(payload.dbIdentity.dev) || !/^(0|[1-9][0-9]*)$/.test(payload.dbIdentity.ino))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const selection = { tipo: 'legado', id: 'legado', geracao: null,
      dataDir: join(userData, 'data'), credenciaisDir: join(userData, 'credenciais') };
    const perfil = { notetakerExperimento: true, testProfileRoot: userData, testMarker: payload.markerId };
    let verifiedRoot;
    try { verifiedRoot = conferirPerfilTeste(perfil); } catch { throw fail('PERFIL_MANUTENCAO_INVALIDA'); }
    if (verifiedRoot !== userData) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const { root, data, db } = legacy(userData, selection);
    if (JSON.stringify(identity(root)) !== JSON.stringify(payload.rootIdentity) ||
        JSON.stringify(identity(data)) !== JSON.stringify(payload.dataIdentity) ||
        JSON.stringify(identity(db)) !== JSON.stringify(payload.dbIdentity) ||
        !same(markerStat, checked(path, 'file')) || readMarkerBytes(path, markerStat) !== raw)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    await protectedPath(userData, selection.dataDir, 'directory');
    await protectedPath(userData, join(selection.dataDir, 'assessor.db'), 'file');
    if (!same(markerStat, checked(path, 'file')) || readMarkerBytes(path, markerStat) !== raw)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    return contentSnapshot(userData, markerStat, raw, payload, 'recovery', Object.freeze(selection), Object.freeze(perfil));
  }
  if (!exact(payload, ['schema', 'opId', 'kind', 'perfil', 'rootIdentity', 'dataIdentity', 'dbIdentity']) || payload.schema !== 1 ||
      typeof payload.opId !== 'string' || !UUID.test(payload.opId) || payload.kind !== 'notetaker-delete' ||
      !exact(payload.perfil, ['tipo', 'id', 'geracao']) || payload.perfil.tipo !== 'legado' ||
      payload.perfil.id !== 'legado' || payload.perfil.geracao !== null ||
      !exact(payload.rootIdentity, ['dev', 'ino']) || !exact(payload.dataIdentity, ['dev', 'ino']) ||
      !exact(payload.dbIdentity, ['dev', 'ino']) ||
      !/^(0|[1-9][0-9]*)$/.test(payload.rootIdentity.dev) || !/^(0|[1-9][0-9]*)$/.test(payload.rootIdentity.ino) ||
      !/^(0|[1-9][0-9]*)$/.test(payload.dataIdentity.dev) || !/^(0|[1-9][0-9]*)$/.test(payload.dataIdentity.ino) ||
      !/^(0|[1-9][0-9]*)$/.test(payload.dbIdentity.dev) || !/^(0|[1-9][0-9]*)$/.test(payload.dbIdentity.ino))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const selection = { tipo: 'legado', id: 'legado', geracao: null,
    dataDir: join(userData, 'data'), credenciaisDir: join(userData, 'credenciais') };
  const { root, data, db } = legacy(userData, selection);
  if (JSON.stringify(identity(root)) !== JSON.stringify(payload.rootIdentity) ||
      JSON.stringify(identity(data)) !== JSON.stringify(payload.dataIdentity) ||
      JSON.stringify(identity(db)) !== JSON.stringify(payload.dbIdentity) ||
      !same(markerStat, checked(path, 'file')) || readMarkerBytes(path, markerStat) !== raw)
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  await protectedPath(userData, selection.dataDir, 'directory');
  await protectedPath(userData, join(selection.dataDir, 'assessor.db'), 'file');
  if (!same(markerStat, checked(path, 'file')) || readMarkerBytes(path, markerStat) !== raw ||
      JSON.stringify(identity(checked(userData, 'directory'))) !== JSON.stringify(payload.rootIdentity) ||
      JSON.stringify(identity(checked(selection.dataDir, 'directory'))) !== JSON.stringify(payload.dataIdentity) ||
      JSON.stringify(identity(checked(join(selection.dataDir, 'assessor.db'), 'file'))) !== JSON.stringify(payload.dbIdentity))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return snapshot(userData, markerStat, raw, payload, 'recovery', selection);
}

export function markMaintenanceStarted(handle) {
  const info = handleInfo(handle);
  if (info.state !== 'created') throw fail('PERFIL_MANUTENCAO_INVALIDA');
  sameMarker(info);
  sameProfile(handle, info);
  info.state = 'started';
}

export async function releaseUnstartedMarker(handle) {
  const info = handleInfo(handle);
  if (info.state !== 'created' || !absent(journalPath(info.userData))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  sameProfile(handle, info);
  const current = sameMarker(info);
  await protectedPath(info.userData, markerPath(info.userData), 'file');
  sameProfile(handle, info);
  if (info.state !== 'created' || !same(current, sameMarker(info)) || !absent(journalPath(info.userData)))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  info.state = 'releasing';
  unlinkSync(markerPath(info.userData));
  info.state = 'released';
  syncDirectory(info.userData);
  if (!absent(markerPath(info.userData))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return { released: true };
}

export async function acquireExclusiveDb({ selection, maintenanceHandle } = {}) {
  const info = handleInfo(maintenanceHandle), userData = info.userData;
  const recovery = info.state === 'recovery';
  if (!['created', 'started', 'recovery'].includes(info.state) ||
      (!recovery && !absent(journalPath(userData))) ||
      selection?.dataDir !== maintenanceHandle.selection.dataDir || selection?.tipo !== 'legado' ||
      selection?.id !== 'legado' || selection?.geracao !== null) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  info.state = 'acquiring';
  sameMarker(info);
  const { root, data } = sameProfile(maintenanceHandle, info);
  const dbPath = join(selection.dataDir, 'assessor.db');
  const before = checked(dbPath, 'file');
  if (!stablePath(dbPath)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  await protectedPath(userData, dbPath, 'file');
  if (!same(before, checked(dbPath, 'file')) || (!recovery && !absent(journalPath(userData))))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let db;
  try {
    db = new DatabaseSync(pathToFileURL(dbPath).href + '?mode=rw', { timeout: 0 });
    const mode = db.prepare('PRAGMA locking_mode=EXCLUSIVE').get();
    if (mode?.locking_mode !== 'exclusive') throw fail('PERFIL_MANUTENCAO_INVALIDA');
    db.exec('BEGIN EXCLUSIVE'); db.exec('ROLLBACK');
    const main = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
    if (!main?.file || resolve(main.file).toLowerCase() !== resolve(dbPath).toLowerCase() ||
        !same(root, checked(userData, 'directory')) || !same(data, checked(selection.dataDir, 'directory')) ||
        !same(before, checked(dbPath, 'file')) || (!recovery && !absent(journalPath(userData))))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    sameMarker(info);
  } catch {
    try { db?.close(); } catch { throw fail('PERFIL_MANUTENCAO_INCERTA'); }
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  }
  info.state = 'leased';
  let state = 'open';
  return Object.freeze({ acquired: true, dbIdentity: identity(before), db,
    close() {
      if (state === 'closed') return { closed: true };
      if (state !== 'open') throw fail('PERFIL_MANUTENCAO_INCERTA');
      state = 'uncertain';
      try { db.close(); state = 'closed'; return { closed: true }; }
      catch { throw fail('PERFIL_MANUTENCAO_INCERTA'); }
    } });
}

// Via quente e sem acesso público à conexão. O lease A permanece privado neste módulo.
export async function acquireExclusiveNoMutation({ selection, maintenanceHandle } = {}) {
  const info = handleInfo(maintenanceHandle);
  if (info.state !== 'started' || !absent(journalPath(info.userData)))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const lease = await acquireExclusiveDb({ selection, maintenanceHandle });
  try {
    if (info.state !== 'leased' || !absent(journalPath(info.userData)))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    sameMarker(info);
    sameProfile(maintenanceHandle, info);
  } catch (error) {
    info.state = 'uncertain';
    try { lease.close(); } catch { throw fail('PERFIL_MANUTENCAO_INCERTA'); }
    throw error;
  }
  const token = Object.freeze(Object.create(null));
  noMutationTokens.set(token, { maintenanceHandle, info, lease, state: 'open' });
  return token;
}

export async function finishMaintenanceWithoutMutation({ maintenanceHandle, noMutationToken } = {}) {
  const binding = noMutationTokens.get(noMutationToken);
  if (!binding || binding.maintenanceHandle !== maintenanceHandle || binding.state !== 'open' ||
      handleInfo(maintenanceHandle) !== binding.info || binding.info.state !== 'leased')
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  // A reserva síncrona impede duas finalizações durante a validação ACL assíncrona.
  binding.state = 'sealed';
  const { info, lease } = binding;
  info.state = 'finishing';
  const userData = info.userData, marker = markerPath(userData), journal = journalPath(userData);
  let closed = false;
  try {
    if (!absent(journal)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    sameProfile(maintenanceHandle, info);
    const original = sameMarker(info);
    await protectedPath(userData, marker, 'file');
    await protectedPath(userData, join(maintenanceHandle.selection.dataDir, 'assessor.db'), 'file');
    if (!absent(journal)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    sameProfile(maintenanceHandle, info);
    if (!same(original, sameMarker(info))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    if (lease.close()?.closed !== true) throw fail('PERFIL_MANUTENCAO_INCERTA');
    closed = true;
    if (!absent(journal)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    sameProfile(maintenanceHandle, info);
    if (!same(original, sameMarker(info))) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    unlinkSync(marker);
    syncDirectory(userData);
    if (!absent(marker)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
    binding.state = 'finished';
    info.state = 'finished';
    return Object.freeze({ opId: maintenanceHandle.opId, kind: maintenanceHandle.kind,
      outcome: 'sem_mutacao', leaseClosed: true, markerRemoved: true });
  } catch (error) {
    binding.state = 'uncertain';
    info.state = 'uncertain';
    if (!closed) {
      try { lease.close(); } catch { throw fail('PERFIL_MANUTENCAO_INCERTA'); }
    }
    throw error;
  }
}

const CONTROL = CONTROLE_EXCLUSAO.tabelaControle;
const RECEIPTS = CONTROLE_EXCLUSAO.tabelaRecibos;
const CONTENT_KIND = 'notetaker-delete-content';
const SHA256 = /^[a-f0-9]{64}$/;
const q = name => `"${String(name).replaceAll('"', '""')}"`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key)?.value;
const plain = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));

function copyContentInput(input = {}) {
  if(!plain(input,['userData','selection','opId','perfil','previa']))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const userData=own(input,'userData'),selection=own(input,'selection'),opId=own(input,'opId'),perfil=own(input,'perfil'),previa=own(input,'previa');
  if (!plain(selection, ['tipo','id','geracao','dataDir','credenciaisDir']) ||
      !plain(perfil, ['notetakerExperimento','testProfileRoot','testMarker']) ||
      !plain(previa, ['sessaoId','revisao','assinatura','schemaAssinatura'])) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const selectionCopy = Object.freeze(Object.fromEntries(['tipo','id','geracao','dataDir','credenciaisDir'].map(k=>[k,own(selection,k)])));
  const perfilCopy = Object.freeze(Object.fromEntries(['notetakerExperimento','testProfileRoot','testMarker'].map(k=>[k,own(perfil,k)])));
  const previaCopy = Object.freeze(Object.fromEntries(['sessaoId','revisao','assinatura','schemaAssinatura'].map(k=>[k,own(previa,k)])));
  pathValid(userData);
  if (typeof opId !== 'string' || !UUID.test(opId) || typeof previaCopy.sessaoId !== 'string' || !UUID.test(previaCopy.sessaoId) ||
      !Number.isSafeInteger(previaCopy.revisao) || previaCopy.revisao < 0 || !SHA256.test(previaCopy.assinatura) ||
      !SHA256.test(previaCopy.schemaAssinatura)) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let root;
  try { root = conferirPerfilTeste(perfilCopy); } catch { throw fail('PERFIL_MANUTENCAO_INVALIDA'); }
  if (root !== userData || perfilCopy.testProfileRoot !== userData) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const identities = legacy(userData, selectionCopy);
  return { userData, selection: selectionCopy, opId, perfil: perfilCopy, previa: previaCopy, identities };
}

function comparePreview(plan, previa) {
  if (plan.sessaoId !== previa.sessaoId || plan.revisao !== previa.revisao ||
      plan.assinatura !== previa.assinatura || plan.schemaAssinatura !== previa.schemaAssinatura)
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  if (plan.bloqueios?.exclusao?.length) throw fail('PERFIL_MANUTENCAO_INVALIDA');
}
function assertContentProfile(info) {
  let root;
  try { root=conferirPerfilTeste(info.perfil); } catch { throw fail('PERFIL_MANUTENCAO_INVALIDA'); }
  const current=legacy(info.userData,info.selection);
  if(root!==info.userData||JSON.stringify(identity(current.root))!==JSON.stringify(info.payload.rootIdentity)||
      JSON.stringify(identity(current.data))!==JSON.stringify(info.payload.dataIdentity)||
      JSON.stringify(identity(current.db))!==JSON.stringify(info.payload.dbIdentity))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return current;
}

function stableSqlValue(value) {
  if (value === null) return ['n'];
  if (typeof value === 'bigint') return ['i', value.toString()];
  if (typeof value === 'number') return ['r', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'string') return ['t', value];
  if (value instanceof Uint8Array) return ['b', Buffer.from(value).toString('base64')];
  throw fail('PERFIL_MANUTENCAO_INVALIDA');
}
function digestContent(db) {
  const digest = createHash('sha256');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(x=>x.name).filter(name=>!NOMES_OBJETOS_CONTROLE_EXCLUSAO.includes(name));
  let rowsTotal=0,bytesTotal=0;
  for (const name of names) {
    const columns=db.prepare(`PRAGMA table_info(${q(name)})`).all().map(x=>x.name);
    const order=columns.length?` ORDER BY ${columns.map(q).join(',')}`:'';
    const statement = db.prepare(`SELECT * FROM ${q(name)}${order}`);
    statement.setReadBigInts(true);
    digest.update(JSON.stringify(['table',name,columns]));
    for (const row of statement.iterate()) {
      const encoded=JSON.stringify(columns.map(key=>stableSqlValue(row[key]))),bytes=Buffer.byteLength(encoded);
      if(++rowsTotal>100000||bytes>4*1024*1024||(bytesTotal+=bytes)>256*1024*1024)throw fail('PERFIL_MANUTENCAO_INVALIDA');
      digest.update(encoded);
    }
  }
  return digest.digest('hex');
}
function deleteOrder(db, tables) {
  const names = new Set(tables.filter(x=>x.remover.length).map(x=>x.nome));
  const edges = new Map([...names].map(name=>[name,new Set()]));
  for (const child of names) for (const fk of db.prepare(`PRAGMA foreign_key_list(${q(child)})`).all())
    if (names.has(fk.table) && fk.table !== child) edges.get(child).add(fk.table);
  const incoming = new Map([...names].map(name=>[name,0]));
  for (const parents of edges.values()) for (const parent of parents) incoming.set(parent,incoming.get(parent)+1);
  const ready=[...names].filter(x=>incoming.get(x)===0).sort(), order=[];
  while(ready.length){
    const current=ready.shift();order.push(current);
    for(const parent of edges.get(current))if(incoming.set(parent,incoming.get(parent)-1).get(parent)===0){ready.push(parent);ready.sort();}
  }
  if(order.length!==names.size)throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return order;
}
function applyDeletes(db, plan) {
  const byName=new Map(plan.tabelas.map(x=>[x.nome,x]));
  let total=0;
  for(const name of deleteOrder(db,plan.tabelas)){
    const table=byName.get(name);
    const where=table.pk.map(column=>`${q(column)}=?`).join(' AND ');
    const statement=db.prepare(`DELETE FROM ${q(name)} WHERE ${where}`);
    for(const tuple of table.remover){
      const result=statement.run(...tuple);
      if(result.changes!==1)throw fail('PERFIL_MANUTENCAO_INVALIDA');
      total++;
    }
  }
  return total;
}
function simulateAfterDigest(db, plan) {
  db.exec('SAVEPOINT lume_c1_simulate_delete');
  try { applyDeletes(db,plan); return digestContent(db); }
  finally { db.exec('ROLLBACK TO lume_c1_simulate_delete; RELEASE lume_c1_simulate_delete'); }
}
function closeContentLease(info) {
  const lease=info.lease;
  if(!lease||lease.closed) return;
  lease.closed=true;
  try{lease.db.close();}catch{throw fail('PERFIL_MANUTENCAO_INCERTA');}
}
async function acquireContentDb(handle, info) {
  if (!['created','recovery'].includes(info.state) || info.lease) throw fail('PERFIL_MANUTENCAO_INVALIDA');
  info.state='acquiring';
  sameMarker(info);assertContentProfile(info);
  const dbPath=join(info.selection.dataDir,'assessor.db'),before=checked(dbPath,'file');
  await protectedPath(info.userData,dbPath,'file');
  assertContentProfile(info);
  if(!same(before,checked(dbPath,'file'))||JSON.stringify(identity(before))!==JSON.stringify(info.payload.dbIdentity))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let db;
  try{
    db=new DatabaseSync(pathToFileURL(dbPath).href+'?mode=rw',{timeout:0});
    const mode=db.prepare('PRAGMA locking_mode=EXCLUSIVE').get();
    if(mode?.locking_mode!=='exclusive'||db.prepare('PRAGMA foreign_keys').get()?.foreign_keys!==1)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    db.exec('BEGIN EXCLUSIVE');db.exec('ROLLBACK');
    const main=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main');
    if(!main?.file||resolve(main.file).toLowerCase()!==resolve(dbPath).toLowerCase()||!same(before,checked(dbPath,'file')))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    sameMarker(info);assertContentProfile(info);
  }catch(error){try{db?.close();}catch{throw fail('PERFIL_MANUTENCAO_INCERTA');}throw error?.code?error:fail('PERFIL_MANUTENCAO_INVALIDA');}
  info.lease={db,closed:false};info.state='leased';return db;
}

function manifestPaths(info) {
  const root=journalPath(info.userData),dir=join(root,info.payload.opId);
  return {root,dir,file:join(dir,'manifesto.json'),audio:join(info.userData,'notetaker-audio')};
}
function manifestFileEntry(file,index){return Object.freeze({parteId:file.parteId,nome:file.nome,sha256:file.sha256,bytes:file.bytes,
  identidade:Object.freeze({...file.identidade}),quarentena:`q-${String(index).padStart(3,'0')}-${file.parteId}.wav`});}
function parseManifest(raw,info){
  if(Buffer.byteLength(raw)<2||Buffer.byteLength(raw)>262144)throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let value;try{value=JSON.parse(raw);}catch{throw fail('PERFIL_MANUTENCAO_INVALIDA');}
  const fields=['schema','opId','markerId','sessaoId','perfilId','dbIdentity','previa','digestSqlAntes','digestSqlDepois','pksRemovidas','arquivos','tabelas'];
  if(!plain(value,fields)||value.schema!==1||value.opId!==info.payload.opId||value.markerId!==info.payload.markerId||
      value.sessaoId!==info.payload.previa.sessaoId||value.perfilId!==info.payload.markerId||
      JSON.stringify(value.dbIdentity)!==JSON.stringify(info.payload.dbIdentity)||JSON.stringify(value.previa)!==JSON.stringify(info.payload.previa)||
      !SHA256.test(value.digestSqlAntes)||!SHA256.test(value.digestSqlDepois)||!Number.isSafeInteger(value.pksRemovidas)||value.pksRemovidas<0||
      !Array.isArray(value.arquivos)||!Array.isArray(value.tabelas))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  for(const [index,file] of value.arquivos.entries()){
    if(!plain(file,['parteId','nome','sha256','bytes','identidade','quarentena'])||typeof file.parteId!=='string'||!UUID.test(file.parteId)||
        file.nome!==file.parteId+'.wav'||!SHA256.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<46||
        file.quarentena!==`q-${String(index).padStart(3,'0')}-${file.parteId}.wav`||!plain(file.identidade,['dev','ino','mtimeNs','ctimeNs']))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
  }
  return value;
}
function readBounded(path,max){
  const before=checked(path,'file');if(before.size<2n||before.size>BigInt(max))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let fd;try{fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=fstatSync(fd,{bigint:true});
    if(!same(before,opened)||opened.nlink!==1n)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const bytes=Buffer.alloc(Number(before.size));let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(count<=0)throw fail('PERFIL_MANUTENCAO_INVALIDA');offset+=count;}
    const afterFd=fstatSync(fd,{bigint:true}),afterPath=checked(path,'file');
    if(!same(before,afterFd)||!same(before,afterPath)||before.size!==afterPath.size||before.mtimeNs!==afterPath.mtimeNs)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }catch(error){throw error?.code==='PERFIL_MANUTENCAO_INVALIDA'?error:fail('PERFIL_MANUTENCAO_INVALIDA');}
  finally{if(fd!==undefined)closeSync(fd);}
}
async function readManifest(info, required=true){
  const paths=manifestPaths(info);
  if(absent(paths.root)){if(!required)return null;throw fail('PERFIL_MANUTENCAO_INVALIDA');}
  await protectedPath(info.userData,paths.root,'directory');
  if(absent(paths.dir))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  await protectedPath(info.userData,paths.dir,'directory');
  if(absent(paths.file))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  await protectedPath(info.userData,paths.file,'file');
  assertContentProfile(info);sameMarker(info);
  const raw=readBounded(paths.file,262144),value=parseManifest(raw,info);
  const rootEntries=readdirSync(paths.root);if(rootEntries.length!==1||rootEntries[0]!==info.payload.opId)throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const allowed=new Set(['manifesto.json',...value.arquivos.map(x=>x.quarentena)]);
  const entries=readdirSync(paths.dir);if(!entries.includes('manifesto.json')||entries.some(name=>!allowed.has(name)))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return {value,raw,sha256:sha256(raw),paths};
}
function assertFileIdentity(path,file,{original=false}={}){
  const before=checked(path,'file');
  if(String(before.dev)!==file.identidade.dev||String(before.ino)!==file.identidade.ino||String(before.mtimeNs)!==file.identidade.mtimeNs||
      (original&&String(before.ctimeNs)!==file.identidade.ctimeNs)||Number(before.size)!==file.bytes)throw fail('PERFIL_MANUTENCAO_INVALIDA');
  let fd;try{fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=fstatSync(fd,{bigint:true});
    if(!same(before,opened)||opened.nlink!==1n)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let offset=0;
    while(offset<file.bytes){const count=readSync(fd,buffer,0,Math.min(buffer.length,file.bytes-offset),offset);if(count<=0)throw fail('PERFIL_MANUTENCAO_INVALIDA');digest.update(buffer.subarray(0,count));offset+=count;}
    const afterFd=fstatSync(fd,{bigint:true}),afterPath=checked(path,'file');
    if(offset!==file.bytes||digest.digest('hex')!==file.sha256||!same(before,afterFd)||!same(before,afterPath)||before.mtimeNs!==afterPath.mtimeNs)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
  }finally{if(fd!==undefined)closeSync(fd);}
  return before;
}
function pathState(path){try{return {present:true,stat:checked(path,'file')};}catch(error){try{lstatSync(path);}catch(missing){if(missing?.code==='ENOENT')return {present:false};}throw error;}}
function syncPair(paths){syncDirectory(paths.audio);syncDirectory(paths.dir);syncDirectory(paths.root);}
function cleanupJournal(info,manifest){
  const {paths}=manifest;
  if(JSON.stringify(readdirSync(paths.root))!==JSON.stringify([info.payload.opId])||
      JSON.stringify(readdirSync(paths.dir))!==JSON.stringify(['manifesto.json']))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  assertContentProfile(info);sameMarker(info);
  unlinkSync(paths.file);syncDirectory(paths.dir);rmdirSync(paths.dir);syncDirectory(paths.root);rmdirSync(paths.root);syncDirectory(info.userData);
}
async function cleanupPartialTerminalJournal(info,manifest,outcome){
  const {paths}=manifest;
  if(outcome==='concluida'){
    for(const file of manifest.value.arquivos)if(pathState(join(paths.audio,file.nome)).present)throw fail('PERFIL_MANUTENCAO_INVALIDA');
  }else{
    for(const file of manifest.value.arquivos){const source=join(paths.audio,file.nome);if(!pathState(source).present)throw fail('PERFIL_MANUTENCAO_INVALIDA');assertFileIdentity(source,file);}
  }
  if(absent(paths.root))return;
  await protectedPath(info.userData,paths.root,'directory');assertContentProfile(info);sameMarker(info);
  const rootEntries=readdirSync(paths.root);
  if(rootEntries.length===0){rmdirSync(paths.root);syncDirectory(info.userData);return;}
  if(rootEntries.length!==1||rootEntries[0]!==info.payload.opId||absent(paths.dir))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  await protectedPath(info.userData,paths.dir,'directory');
  if(readdirSync(paths.dir).length!==0)throw fail('PERFIL_MANUTENCAO_INVALIDA');
  rmdirSync(paths.dir);syncDirectory(paths.root);rmdirSync(paths.root);syncDirectory(info.userData);
}
function receiptRow(db,opId){return db.prepare(`SELECT * FROM ${q(RECEIPTS)} WHERE op_id=?`).get(opId);}
function controlRow(db,opId){return db.prepare(`SELECT * FROM ${q(CONTROL)} WHERE op_id=?`).get(opId);}
function manifestFromControl(info,control){
  if(!control||typeof control.manifesto_json!=='string'||sha256(control.manifesto_json)!==control.manifesto_sha256)
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  return {value:parseManifest(control.manifesto_json,info),raw:control.manifesto_json,sha256:control.manifesto_sha256,paths:manifestPaths(info)};
}
function assertCorrelation(info,manifest,control,receipt){
  const p=info.payload;
  if(!control||control.op_id!==p.opId||control.schema_version!==1||control.sessao_id!==p.previa.sessaoId||
      control.perfil_id!==p.markerId||control.db_dev!==p.dbIdentity.dev||control.db_ino!==p.dbIdentity.ino||
      control.selecao_assinatura!==p.previa.assinatura||control.schema_assinatura!==p.previa.schemaAssinatura||
      control.digest_sql_antes!==manifest.value.digestSqlAntes||control.manifesto_json!==manifest.raw||control.manifesto_sha256!==manifest.sha256)
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  if(receipt&&(receipt.op_id!==control.op_id||receipt.sessao_id!==control.sessao_id||receipt.perfil_id!==control.perfil_id||
      receipt.db_dev!==control.db_dev||receipt.db_ino!==control.db_ino||receipt.selecao_assinatura!==control.selecao_assinatura||
      receipt.schema_assinatura!==control.schema_assinatura||receipt.digest_sql_antes!==control.digest_sql_antes||
      receipt.digest_sql_depois!==manifest.value.digestSqlDepois||receipt.manifesto_sha256!==control.manifesto_sha256||
      receipt.pks_removidas!==manifest.value.pksRemovidas||receipt.arquivos_total!==manifest.value.arquivos.length))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
}
function preflightPostCommit(manifest,row){
  const total=manifest.value.arquivos.length;
  if(!row||row.arquivos_total!==total||row.arquivos_pendentes<0||row.arquivos_pendentes>total)
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const processed=total-row.arquivos_pendentes;let nextMissing=false;
  for(const [index,file] of manifest.value.arquivos.entries()){
    const source=pathState(join(manifest.paths.audio,file.nome)),quarantinePath=join(manifest.paths.dir,file.quarentena),quarantine=pathState(quarantinePath);
    if(source.present)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    if(quarantine.present)assertFileIdentity(quarantinePath,file);
    if(index<processed&&quarantine.present)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    if(index===processed&&row.arquivos_pendentes>0){nextMissing=!quarantine.present;continue;}
    if(index>processed&&!quarantine.present)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    if(row.arquivos_pendentes===0&&quarantine.present)throw fail('PERFIL_MANUTENCAO_INVALIDA');
  }
  return {processed,nextMissing};
}
function updateProgress(db,info,manifest){
  const opId=info.payload.opId,total=manifest.value.arquivos.length;
  const initial=receiptRow(db,opId);preflightPostCommit(manifest,initial);
  if(total===0){
    const row=initial;if(row.estado==='conteudo_commitido'&&row.arquivos_pendentes===0){
      db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE ${q(RECEIPTS)} SET estado='concluida' WHERE op_id=?`).run(opId);
        db.prepare(`UPDATE ${q(CONTROL)} SET fase='concluida' WHERE op_id=?`).run(opId);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    }
    preflightPostCommit(manifest,receiptRow(db,opId));
    return;
  }
  while(true){
    const row=receiptRow(db,opId);if(row.arquivos_pendentes===0)break;
    const processed=total-row.arquivos_pendentes,index=processed,file=manifest.value.arquivos[index];
    if(!file)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const source=join(manifest.paths.audio,file.nome),quarantine=join(manifest.paths.dir,file.quarentena);
    const s=pathState(source),z=pathState(quarantine);
    if(s.present)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    if(z.present){assertFileIdentity(quarantine,file);unlinkSync(quarantine);syncPair(manifest.paths);}
    else if(processed>=total)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    db.exec('BEGIN IMMEDIATE');
    try{
      const current=receiptRow(db,opId);if(current.arquivos_pendentes!==row.arquivos_pendentes)throw fail('PERFIL_MANUTENCAO_INVALIDA');
      const pending=row.arquivos_pendentes-1,state=pending===0?'concluida':'arquivos_pendentes';
      db.prepare(`UPDATE ${q(RECEIPTS)} SET arquivos_pendentes=?,estado=? WHERE op_id=?`).run(pending,state,opId);
      db.prepare(`UPDATE ${q(CONTROL)} SET fase=? WHERE op_id=?`).run(state,opId);db.exec('COMMIT');
    }catch(error){try{if(db.isTransaction)db.exec('ROLLBACK');}catch{}throw error;}
  }
  preflightPostCommit(manifest,receiptRow(db,opId));
}
function makeOperationReceipt(handle,info,outcome){
  const receipt=Object.freeze(Object.create(null));contentReceipts.set(receipt,{handle,info,outcome,consumed:false});return receipt;
}

async function validateInitialContentAbort(db,info){
  let plan;
  db.exec('BEGIN');
  try{
    plan=montarPlanoExclusao(db,{sessaoId:info.payload.previa.sessaoId,...info.perfil});
    comparePreview(plan,info.payload.previa);db.exec('ROLLBACK');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  await inventariarArquivosExclusao({perfil:info.perfil,sessaoId:plan.sessaoId,partes:plan.arquivos});
  db.exec('BEGIN');
  try{
    const current=montarPlanoExclusao(db,{sessaoId:info.payload.previa.sessaoId,...info.perfil});
    comparePreview(current,info.payload.previa);
    if(current.assinatura!==plan.assinatura||JSON.stringify(current.arquivos)!==JSON.stringify(plan.arquivos))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    db.exec('ROLLBACK');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}

export async function beginContentMaintenance(input = {}) {
  const copied=copyContentInput(input),key=`${copied.userData}\0${copied.perfil.testMarker}`;
  if(contentReservations.has(key))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const reservation={state:'beginning'};contentReservations.set(key,reservation);
  let fd,created=false;
  try{
    assertNormalBootAllowed(copied.userData);
    await protectedPath(copied.userData,copied.userData,'directory');
    await protectedPath(copied.userData,copied.selection.dataDir,'directory');
    await protectedPath(copied.userData,join(copied.selection.dataDir,'assessor.db'),'file');
    assertNormalBootAllowed(copied.userData);
    const {root,data,db}=legacy(copied.userData,copied.selection);
    if(!same(root,copied.identities.root)||!same(data,copied.identities.data)||!same(db,copied.identities.db))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const payload={schema:2,opId:copied.opId,kind:CONTENT_KIND,perfil:{tipo:'legado',id:'legado',geracao:null},
      rootIdentity:identity(root),dataIdentity:identity(data),dbIdentity:identity(db),previa:{...copied.previa},markerId:copied.perfil.testMarker};
    const raw=JSON.stringify(payload)+'\n';if(Buffer.byteLength(raw)>MAX_BYTES)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    fd=openSync(markerPath(copied.userData),'wx',0o600);created=true;writeFileSync(fd,raw,'utf8');fsyncSync(fd);
    const made=fstatSync(fd,{bigint:true});closeSync(fd);fd=undefined;
    const markerStat=await protectedPath(copied.userData,markerPath(copied.userData),'file');
    const stable=legacy(copied.userData,copied.selection);
    if(!same(stable.root,copied.identities.root)||!same(stable.data,copied.identities.data)||!same(stable.db,copied.identities.db)||
        !same(made,markerStat)||readMarkerBytes(markerPath(copied.userData),markerStat)!==raw||!absent(journalPath(copied.userData)))
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    syncDirectory(copied.userData);
    const handle=contentSnapshot(copied.userData,markerStat,raw,payload,'created',copied.selection,copied.perfil);
    reservation.state='begun';reservation.handle=handle;return handle;
  }catch(error){if(fd!==undefined)closeSync(fd);if(!created)contentReservations.delete(key);else reservation.state='sealed';throw error?.code?error:fail('PERFIL_MANUTENCAO_INVALIDA');}
}

export async function executeContentMaintenance(input = {}) {
  if(!plain(input,['maintenanceHandle']))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const maintenanceHandle=own(input,'maintenanceHandle');
  const info=contentHandles.get(maintenanceHandle);
  if(!info||info.state!=='created'||contentReservations.get(info.reservationKey)?.handle!==maintenanceHandle)
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  info.state='executing';contentReservations.get(info.reservationKey).state='executing';
  let db;
  try{
    info.state='created';db=await acquireContentDb(maintenanceHandle,info);info.state='executing';
    db.exec('BEGIN IMMEDIATE');let plan;
    try{plan=montarPlanoExclusao(db,{sessaoId:info.payload.previa.sessaoId,...info.perfil});comparePreview(plan,info.payload.previa);db.exec('COMMIT');}
    catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    const inventory=await inventariarArquivosExclusao({perfil:info.perfil,sessaoId:plan.sessaoId,partes:plan.arquivos});
    db.exec('BEGIN IMMEDIATE');
    let manifest,manifestRaw,manifestHash;
    try{
      const current=montarPlanoExclusao(db,{sessaoId:plan.sessaoId,...info.perfil});comparePreview(current,info.payload.previa);
      if(current.assinatura!==plan.assinatura||JSON.stringify(current.arquivos)!==JSON.stringify(plan.arquivos))throw fail('PERFIL_MANUTENCAO_INVALIDA');
      const existingControl=validarControleExclusao(db);
      if(existingControl.ativo)throw fail('PERFIL_MANUTENCAO_INVALIDA');
      if(!existingControl.presente)for(const ddl of DDL_CONTROLE_EXCLUSAO)db.exec(ddl);
      const digestSqlAntes=digestContent(db),digestSqlDepois=simulateAfterDigest(db,current);
      const files=inventory.arquivos.map(manifestFileEntry);
      const tables=current.tabelas.map(t=>({nome:t.nome,pk:[...t.pk],remover:t.remover.map(tuple=>[...tuple]),preservar:t.preservar.map(tuple=>[...tuple])}));
      const pksRemovidas=tables.reduce((n,t)=>n+t.remover.length,0);
      manifest={schema:1,opId:info.payload.opId,markerId:info.payload.markerId,sessaoId:current.sessaoId,
        perfilId:info.payload.markerId,dbIdentity:{...info.payload.dbIdentity},previa:{...info.payload.previa},
        digestSqlAntes,digestSqlDepois,pksRemovidas,arquivos:files,tabelas:tables};
      manifestRaw=JSON.stringify(manifest);if(Buffer.byteLength(manifestRaw)>262144)throw fail('PERFIL_MANUTENCAO_INVALIDA');
      manifestHash=sha256(manifestRaw);
      db.prepare(`INSERT INTO ${q(CONTROL)} (op_id,schema_version,sessao_id,perfil_id,db_dev,db_ino,selecao_assinatura,schema_assinatura,digest_sql_antes,manifesto_json,manifesto_sha256,fase,criado_em)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(info.payload.opId,1,current.sessaoId,info.payload.markerId,info.payload.dbIdentity.dev,
        info.payload.dbIdentity.ino,current.assinatura,current.schemaAssinatura,digestSqlAntes,manifestRaw,manifestHash,'preparando',new Date().toISOString());
      db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    const paths=manifestPaths(info);mkdirSync(paths.root,{mode:0o700});mkdirSync(paths.dir,{mode:0o700});
    let fd=openSync(paths.file,'wx',0o600);try{writeFileSync(fd,manifestRaw,'utf8');fsyncSync(fd);}finally{closeSync(fd);}syncPair(paths);
    const parsed={value:parseManifest(manifestRaw,info),raw:manifestRaw,sha256:manifestHash,paths};
    const audioStat=checked(paths.audio,'directory'),journalStat=checked(paths.dir,'directory');
    if(audioStat.dev!==journalStat.dev)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    for(const file of parsed.value.arquivos){const source=join(paths.audio,file.nome),target=join(paths.dir,file.quarentena);
      assertFileIdentity(source,file,{original:true});if(pathState(target).present)throw fail('PERFIL_MANUTENCAO_INVALIDA');renameSync(source,target);syncPair(paths);assertFileIdentity(target,file);}
    db.exec('BEGIN IMMEDIATE');
    try{
      const again=montarPlanoExclusao(db,{sessaoId:plan.sessaoId,...info.perfil});comparePreview(again,info.payload.previa);
      if(digestContent(db)!==parsed.value.digestSqlAntes)throw fail('PERFIL_MANUTENCAO_INVALIDA');
      db.prepare(`UPDATE ${q(CONTROL)} SET fase='quarentena' WHERE op_id=? AND fase='preparando'`).run(info.payload.opId);
      const removed=applyDeletes(db,again);if(removed!==parsed.value.pksRemovidas||digestContent(db)!==parsed.value.digestSqlDepois)
        throw fail('PERFIL_MANUTENCAO_INVALIDA');
      const total=parsed.value.arquivos.length;
      db.prepare(`INSERT INTO ${q(RECEIPTS)} (op_id,schema_version,sessao_id,perfil_id,db_dev,db_ino,selecao_assinatura,schema_assinatura,digest_sql_antes,digest_sql_depois,manifesto_sha256,pks_removidas,arquivos_total,arquivos_pendentes,estado,commit_em)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(info.payload.opId,1,plan.sessaoId,info.payload.markerId,info.payload.dbIdentity.dev,
        info.payload.dbIdentity.ino,plan.assinatura,plan.schemaAssinatura,parsed.value.digestSqlAntes,parsed.value.digestSqlDepois,
        parsed.sha256,removed,total,total,'conteudo_commitido',new Date().toISOString());
      db.prepare(`UPDATE ${q(CONTROL)} SET fase='conteudo_commitido' WHERE op_id=?`).run(info.payload.opId);db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    const control=controlRow(db,info.payload.opId),receipt=receiptRow(db,info.payload.opId);assertCorrelation(info,parsed,control,receipt);
    if(digestContent(db)!==parsed.value.digestSqlDepois)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    updateProgress(db,info,parsed);
    const terminalControl=controlRow(db,info.payload.opId),terminalReceipt=receiptRow(db,info.payload.opId);
    assertCorrelation(info,parsed,terminalControl,terminalReceipt);
    if(terminalControl.fase!=='concluida'||terminalReceipt.estado!=='concluida'||terminalReceipt.arquivos_pendentes!==0)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    cleanupJournal(info,parsed);info.state='executed';return makeOperationReceipt(maintenanceHandle,info,'concluida');
  }catch(error){info.state='uncertain';try{closeContentLease(info);}catch{}throw error?.code?error:fail('PERFIL_MANUTENCAO_INCERTA');}
}

export async function recoverContentMaintenance(input = {}) {
  if(!plain(input,['maintenanceHandle']))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const maintenanceHandle=own(input,'maintenanceHandle');
  const info=contentHandles.get(maintenanceHandle);
  if(!info||info.state!=='recovery'||contentReservations.has(info.reservationKey))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  contentReservations.set(info.reservationKey,{state:'recovering',handle:maintenanceHandle});
  let db;
  try{
    db=await acquireContentDb(maintenanceHandle,info);info.state='recovering';
    const controlState=validarControleExclusao(db);
    if(!controlState.presente){
      const manifest=await readManifest(info,false);
      if(manifest||!absent(journalPath(info.userData)))throw fail('PERFIL_MANUTENCAO_INVALIDA');
      await validateInitialContentAbort(db,info);
      info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'abortada');
    }
    const control=controlRow(db,info.payload.opId),receipt=receiptRow(db,info.payload.opId);
    if(!control){
      if(receipt||!absent(journalPath(info.userData)))throw fail('PERFIL_MANUTENCAO_INVALIDA');
      await validateInitialContentAbort(db,info);
      info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'abortada');
    }
    const paths=manifestPaths(info),durable=manifestFromControl(info,control);
    let manifest;
    if(absent(paths.root))manifest=null;
    else if(absent(paths.file)){
      assertCorrelation(info,durable,control,receipt);
      if(control.fase==='abortada'&&!receipt&&digestContent(db)===durable.value.digestSqlAntes){
        await cleanupPartialTerminalJournal(info,durable,'abortada');info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'abortada');
      }
      if(control.fase==='concluida'&&receipt?.estado==='concluida'&&receipt.arquivos_pendentes===0&&digestContent(db)===durable.value.digestSqlDepois){
        await cleanupPartialTerminalJournal(info,durable,'concluida');info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'concluida');
      }
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    }else manifest=await readManifest(info,true);
    if(!manifest){
      assertCorrelation(info,durable,control,receipt);
      if(control.fase==='abortada'&&!receipt&&digestContent(db)===durable.value.digestSqlAntes){
        await cleanupPartialTerminalJournal(info,durable,'abortada');info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'abortada');
      }
      if(control.fase==='preparando'&&!receipt&&digestContent(db)===durable.value.digestSqlAntes){
        for(const file of durable.value.arquivos){const source=join(durable.paths.audio,file.nome);if(!pathState(source).present)throw fail('PERFIL_MANUTENCAO_INVALIDA');assertFileIdentity(source,file,{original:true});}
        db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE ${q(CONTROL)} SET fase='abortada' WHERE op_id=?`).run(info.payload.opId);db.exec('COMMIT');}
        catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
        info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'abortada');
      }
      if(control.fase==='concluida'&&receipt?.estado==='concluida'&&receipt.arquivos_pendentes===0&&
          digestContent(db)===durable.value.digestSqlDepois&&durable.value.arquivos.every(file=>!pathState(join(durable.paths.audio,file.nome)).present)){
        info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'concluida');
      }
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    }
    assertCorrelation(info,manifest,control,receipt);
    if(!receipt){
      if(control.fase==='abortada'&&digestContent(db)===manifest.value.digestSqlAntes){
        for(const file of manifest.value.arquivos){const source=join(manifest.paths.audio,file.nome),target=join(manifest.paths.dir,file.quarentena);
          if(!pathState(source).present||pathState(target).present)throw fail('PERFIL_MANUTENCAO_INVALIDA');assertFileIdentity(source,file);}
        cleanupJournal(info,manifest);info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'abortada');
      }
      if(!['preparando','quarentena'].includes(control.fase)||digestContent(db)!==manifest.value.digestSqlAntes)
        throw fail('PERFIL_MANUTENCAO_INVALIDA');
      for(const file of [...manifest.value.arquivos].reverse()){
        const source=join(manifest.paths.audio,file.nome),target=join(manifest.paths.dir,file.quarentena),s=pathState(source),z=pathState(target);
        if(s.present&&z.present||!s.present&&!z.present)throw fail('PERFIL_MANUTENCAO_INVALIDA');
        if(z.present){assertFileIdentity(target,file);renameSync(target,source);syncPair(manifest.paths);}assertFileIdentity(source,file);
      }
      db.exec('BEGIN IMMEDIATE');try{db.prepare(`UPDATE ${q(CONTROL)} SET fase='abortada' WHERE op_id=?`).run(info.payload.opId);db.exec('COMMIT');}
      catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      cleanupJournal(info,manifest);info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'abortada');
    }
    if(digestContent(db)!==manifest.value.digestSqlDepois)throw fail('PERFIL_MANUTENCAO_INVALIDA');
    updateProgress(db,info,manifest);
    const finalControl=controlRow(db,info.payload.opId),finalReceipt=receiptRow(db,info.payload.opId);assertCorrelation(info,manifest,finalControl,finalReceipt);
    if(finalControl.fase!=='concluida'||finalReceipt.estado!=='concluida'||finalReceipt.arquivos_pendentes!==0)
      throw fail('PERFIL_MANUTENCAO_INVALIDA');
    cleanupJournal(info,manifest);info.state='recovered';return makeOperationReceipt(maintenanceHandle,info,'concluida');
  }catch(error){info.state='uncertain';try{closeContentLease(info);}catch{}throw error?.code?error:fail('PERFIL_MANUTENCAO_INCERTA');}
}

export async function completeContentMaintenance(input = {}) {
  if(!plain(input,['maintenanceHandle','receipt']))throw fail('PERFIL_MANUTENCAO_INVALIDA');
  const maintenanceHandle=own(input,'maintenanceHandle'),receipt=own(input,'receipt');
  const info=contentHandles.get(maintenanceHandle),binding=contentReceipts.get(receipt);
  if(!info||!binding||binding.handle!==maintenanceHandle||binding.info!==info||binding.consumed||!['executed','recovered'].includes(info.state))
    throw fail('PERFIL_MANUTENCAO_INVALIDA');
  binding.consumed=true;info.state='completing';
  try{
    sameMarker(info);assertContentProfile(info);
    await protectedPath(info.userData,markerPath(info.userData),'file');
    sameMarker(info);assertContentProfile(info);
    if(!absent(journalPath(info.userData)))throw fail('PERFIL_MANUTENCAO_INVALIDA');
    const db=info.lease?.db,controlState=validarControleExclusao(db);
    if(binding.outcome==='concluida'){
      const control=controlRow(db,info.payload.opId),row=receiptRow(db,info.payload.opId);
      if(!controlState.presente||control?.fase!=='concluida'||row?.estado!=='concluida'||row?.arquivos_pendentes!==0)
        throw fail('PERFIL_MANUTENCAO_INVALIDA');
      const durable=manifestFromControl(info,control);assertCorrelation(info,durable,control,row);
      if(digestContent(db)!==durable.value.digestSqlDepois||durable.value.arquivos.some(file=>pathState(join(durable.paths.audio,file.nome)).present))
        throw fail('PERFIL_MANUTENCAO_INVALIDA');
    }else{
      const control=controlState.presente?controlRow(db,info.payload.opId):undefined;
      const row=controlState.presente?receiptRow(db,info.payload.opId):undefined;
      if(!control){
        if(row)throw fail('PERFIL_MANUTENCAO_INVALIDA');
        await validateInitialContentAbort(db,info);
      }else{
        if(control.fase!=='abortada'||row)throw fail('PERFIL_MANUTENCAO_INVALIDA');
        const durable=manifestFromControl(info,control);assertCorrelation(info,durable,control,undefined);
        if(digestContent(db)!==durable.value.digestSqlAntes)throw fail('PERFIL_MANUTENCAO_INVALIDA');
        for(const file of durable.value.arquivos){const source=join(durable.paths.audio,file.nome);if(!pathState(source).present)throw fail('PERFIL_MANUTENCAO_INVALIDA');assertFileIdentity(source,file);}
      }
    }
    closeContentLease(info);
    sameMarker(info);assertContentProfile(info);unlinkSync(markerPath(info.userData));syncDirectory(info.userData);
    if(!absent(markerPath(info.userData)))throw fail('PERFIL_MANUTENCAO_INVALIDA');
    contentReservations.delete(info.reservationKey);info.state='complete';
    const terminal=Object.freeze(Object.create(null));completedContentReceipts.add(terminal);return terminal;
  }catch(error){info.state='uncertain';try{closeContentLease(info);}catch{}throw error?.code?error:fail('PERFIL_MANUTENCAO_INCERTA');}
}

export function isContentMaintenanceComplete(receipt) { return completedContentReceipts.has(receipt); }

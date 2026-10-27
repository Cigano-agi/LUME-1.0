import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { assertNormalBootAllowed } from './perfil-boot-guard.js';

const MAX_SELECTOR_BYTES = 4096;
const MAX_UINT64 = 18446744073709551615n;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_UINT64 = /^(0|[1-9][0-9]*)$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a, b) {
  return sameIdentity(a, b) && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs &&
    a.nlink === b.nlink;
}

async function inspect(target, kind, code, optional = false) {
  let info;
  try {
    info = await lstat(target, { bigint: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    fail(code);
  }
  if (info.isSymbolicLink() || !info[kind === 'directory' ? 'isDirectory' : 'isFile']()) fail(code);
  if (kind === 'file' && info.nlink !== 1n) fail(code);
  return info;
}

async function directoryChain(target, code, optionalLast = false) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const segments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const seen = [];
  let current = root;
  seen.push({ target: current, info: await inspect(current, 'directory', code) });
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const info = await inspect(current, 'directory', code, optionalLast && index === segments.length - 1);
    if (info === null) return { exists: false, seen };
    seen.push({ target: current, info });
  }
  return { exists: true, seen };
}

async function recheckDirectories(seen, code) {
  for (const entry of seen) {
    const current = await inspect(entry.target, 'directory', code);
    if (!sameIdentity(entry.info, current)) fail(code);
  }
}

async function existsAny(target, code) {
  try {
    await lstat(target, { bigint: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    fail(code);
  }
}

async function readSelector(target) {
  const before = await inspect(target, 'file', 'PERFIL_SELETOR_INVALIDO');
  if (before.size > BigInt(MAX_SELECTOR_BYTES)) fail('PERFIL_SELETOR_INVALIDO');
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(before, opened)) fail('PERFIL_SELETOR_INVALIDO');
    const buffer = Buffer.alloc(MAX_SELECTOR_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count > MAX_SELECTOR_BYTES) fail('PERFIL_SELETOR_INVALIDO');
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await inspect(target, 'file', 'PERFIL_SELETOR_INVALIDO');
    if (!sameFile(before, afterHandle) || !sameFile(before, afterPath) || BigInt(count) !== before.size) {
      fail('PERFIL_SELETOR_INVALIDO');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
  } catch (error) {
    if (error.code?.startsWith('PERFIL_')) throw error;
    fail('PERFIL_SELETOR_INVALIDO');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function exactKeys(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}

function uint64(value) {
  return typeof value === 'string' && DECIMAL_UINT64.test(value) && BigInt(value) <= MAX_UINT64;
}

function parseSelector(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail('PERFIL_SELETOR_INVALIDO');
  }
  if (!exactKeys(value, ['schema', 'id', 'geracao', 'diretorio']) || value.schema !== 1 ||
      typeof value.id !== 'string' || !UUID_V4.test(value.id) ||
      typeof value.geracao !== 'string' || !UUID_V4.test(value.geracao) ||
      !exactKeys(value.diretorio, ['dev', 'ino']) ||
      !uint64(value.diretorio.dev) || !uint64(value.diretorio.ino)) {
    fail('PERFIL_SELETOR_INVALIDO');
  }
  return value;
}

async function optionalDirectory(target, root, code) {
  const checked = await directoryChain(target, code, true);
  await recheckDirectories(root.seen, code);
  if (checked.exists) await recheckDirectories(checked.seen, code);
  return checked;
}

/** Resolve a seleção local sem criar, abrir DB ou consultar credenciais. */
export async function resolverPerfilAtivo(options) {
  if (!exactKeys(options, ['userData']) || Object.getPrototypeOf(options) !== Object.prototype) {
    fail('PERFIL_CAMINHO_INVALIDO');
  }
  const { userData } = options;
  if (typeof userData !== 'string' || !path.isAbsolute(userData) ||
      path.normalize(userData) !== userData) fail('PERFIL_CAMINHO_INVALIDO');
  assertNormalBootAllowed(userData);
  const root = await directoryChain(userData, 'PERFIL_CAMINHO_INVALIDO');
  const journal = path.join(userData, 'perfil-publicacao.json');
  if (await existsAny(journal, 'PERFIL_RECUPERACAO_PENDENTE')) fail('PERFIL_RECUPERACAO_PENDENTE');

  const selectorPath = path.join(userData, 'perfil-ativo.json');
  if (!(await existsAny(selectorPath, 'PERFIL_SELETOR_INVALIDO'))) {
    if (await existsAny(path.join(userData, 'profiles'), 'PERFIL_SELECAO_PENDENTE')) {
      fail('PERFIL_SELECAO_PENDENTE');
    }
    const dataDir = path.join(userData, 'data');
    const credenciaisDir = path.join(userData, 'credenciais');
    const legacyData = await optionalDirectory(dataDir, root, 'PERFIL_DESTINO_INVALIDO');
    const legacyCredentials = await optionalDirectory(credenciaisDir, root, 'PERFIL_DESTINO_INVALIDO');
    const legacyDbPath = path.join(dataDir, 'assessor.db');
    const legacyDb = legacyData.exists
      ? await inspect(legacyDbPath, 'file', 'PERFIL_DESTINO_INVALIDO', true)
      : null;
    if (legacyData.exists) await recheckDirectories(legacyData.seen, 'PERFIL_DESTINO_INVALIDO');
    if (legacyCredentials.exists) await recheckDirectories(legacyCredentials.seen, 'PERFIL_DESTINO_INVALIDO');
    if (legacyDb) {
      const currentLegacyDb = await inspect(legacyDbPath, 'file', 'PERFIL_DESTINO_INVALIDO');
      if (!sameFile(legacyDb, currentLegacyDb)) fail('PERFIL_DESTINO_INVALIDO');
    } else if (legacyData.exists && await existsAny(legacyDbPath, 'PERFIL_DESTINO_INVALIDO')) {
      fail('PERFIL_DESTINO_INVALIDO');
    }
    await recheckDirectories(root.seen, 'PERFIL_CAMINHO_INVALIDO');
    if ((!legacyData.exists && await existsAny(dataDir, 'PERFIL_DESTINO_INVALIDO')) ||
        (!legacyCredentials.exists && await existsAny(credenciaisDir, 'PERFIL_DESTINO_INVALIDO'))) {
      fail('PERFIL_DESTINO_INVALIDO');
    }
    if (await existsAny(journal, 'PERFIL_RECUPERACAO_PENDENTE')) fail('PERFIL_RECUPERACAO_PENDENTE');
    if (await existsAny(selectorPath, 'PERFIL_SELETOR_INVALIDO') ||
        await existsAny(path.join(userData, 'profiles'), 'PERFIL_SELECAO_PENDENTE')) {
      fail('PERFIL_SELECAO_PENDENTE');
    }
    assertNormalBootAllowed(userData);
    return Object.freeze({ tipo: 'legado', id: 'legado', geracao: null, dataDir, credenciaisDir });
  }

  const selectorText = await readSelector(selectorPath);
  const selectorInfo = await inspect(selectorPath, 'file', 'PERFIL_SELETOR_INVALIDO');
  const selector = parseSelector(selectorText);
  const profileDir = path.join(userData, 'profiles', selector.id);
  const dataDir = path.join(profileDir, 'data');
  const credenciaisDir = path.join(profileDir, 'credenciais');
  const data = await directoryChain(dataDir, 'PERFIL_DESTINO_INVALIDO');
  const dataInfo = data.seen.at(-1).info;
  if (dataInfo.dev !== BigInt(selector.diretorio.dev) ||
      dataInfo.ino !== BigInt(selector.diretorio.ino)) fail('PERFIL_IDENTIDADE_DIVERGENTE');
  const dbPath = path.join(dataDir, 'assessor.db');
  const db = await inspect(dbPath, 'file', 'PERFIL_DESTINO_INVALIDO');
  const credentials = await optionalDirectory(credenciaisDir, root, 'PERFIL_DESTINO_INVALIDO');
  await recheckDirectories(data.seen, 'PERFIL_IDENTIDADE_DIVERGENTE');
  if (credentials.exists) await recheckDirectories(credentials.seen, 'PERFIL_DESTINO_INVALIDO');
  else if (await existsAny(credenciaisDir, 'PERFIL_DESTINO_INVALIDO')) fail('PERFIL_DESTINO_INVALIDO');
  const currentDb = await inspect(dbPath, 'file', 'PERFIL_DESTINO_INVALIDO');
  if (!sameFile(db, currentDb)) fail('PERFIL_DESTINO_INVALIDO');
  if (await existsAny(journal, 'PERFIL_RECUPERACAO_PENDENTE')) fail('PERFIL_RECUPERACAO_PENDENTE');
  if (await readSelector(selectorPath) !== selectorText ||
      !sameFile(selectorInfo, await inspect(selectorPath, 'file', 'PERFIL_SELETOR_INVALIDO'))) {
    fail('PERFIL_SELETOR_INVALIDO');
  }
  assertNormalBootAllowed(userData);
  return Object.freeze({ tipo: 'gerido', id: selector.id, geracao: selector.geracao, dataDir, credenciaisDir });
}

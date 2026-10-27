import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { conferirPerfilTeste } from './perfil-teste.js';
import { cabecalhoWav, MAX_PARTE_PCM, UUID } from './contrato.js';
import { createHash } from 'node:crypto';

const MAX_PARTES = 120;
const CHUNK_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const FIELDS = ['parteId', 'nome', 'sha256'];
const API_CODES = new Set(['ENTRADA', 'FECHADO', 'INTEGRIDADE', 'LIMITE', 'CONFLITO', 'CANCELADO', 'IO']);
const erro = (code, message) => Object.assign(new Error(message), { code });
const ownData = (object, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const statShape = stat => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
  nlink: String(stat.nlink),
  mode: String(stat.mode),
});
const sameStat = (left, right) => {
  const a = statShape(left), b = statShape(right);
  return Object.keys(a).every(key => a[key] === b[key]);
};
const identity = stat => Object.freeze({
  dev: String(stat.dev),
  ino: String(stat.ino),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
});
const directoryIdentity = stat => Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
const frozen = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
};
function abort(signal) {
  if (signal?.aborted) throw erro('CANCELADO', 'Inventario cancelado.');
}
function yieldEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}
function ioError(error, code = 'IO') {
  if (error?.code === 'ENOENT' || error?.code === 'ELOOP' || error?.code === 'ENOTDIR')
    return erro('INTEGRIDADE', 'Arquivo gerido indisponivel.');
  return erro(code, 'Falha ao conferir arquivo gerido.');
}
function ownError(error, fallback = 'IO') {
  return API_CODES.has(error?.code) ? error : ioError(error, fallback);
}
function validateInput({ perfil, sessaoId, partes, signal } = {}) {
  if (!Array.isArray(partes) || partes.length > MAX_PARTES || typeof sessaoId !== 'string' || !UUID.test(sessaoId) ||
      (signal !== undefined && (!signal || typeof signal !== 'object' ||
        typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')))
    throw erro('ENTRADA', 'Pedido de inventario invalido.');

  const copied = [];
  const ids = new Set(), names = new Set();
  for (const item of partes) {
    if (!item || typeof item !== 'object' ||
        (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) ||
        Reflect.ownKeys(item).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(item, key)))
      throw erro('ENTRADA', 'Parte de inventario invalida.');
    const parteId = ownData(item, 'parteId'), nome = ownData(item, 'nome'), sha256 = ownData(item, 'sha256');
    if (typeof parteId !== 'string' || !UUID.test(parteId) || typeof nome !== 'string' ||
        nome !== parteId + '.wav' || typeof sha256 !== 'string' || !SHA256.test(sha256) ||
        ids.has(parteId.toLowerCase()) || names.has(nome.toLowerCase()))
      throw erro('ENTRADA', 'Parte de inventario invalida.');
    ids.add(parteId.toLowerCase()); names.add(nome.toLowerCase());
    copied.push(Object.freeze({ parteId, nome, sha256 }));
  }
  copied.sort((a, b) => a.parteId.localeCompare(b.parteId));
  const perfilCopy = Object.freeze({
    notetakerExperimento: ownData(perfil ?? {}, 'notetakerExperimento'),
    testProfileRoot: ownData(perfil ?? {}, 'testProfileRoot'),
    testMarker: ownData(perfil ?? {}, 'testMarker'),
  });
  return { perfilCopy, sessaoId, copied, signal };
}
function inspectProfile(perfil) {
  let root;
  try { root = conferirPerfilTeste(perfil); }
  catch { throw erro('FECHADO', 'Perfil de teste fechado.'); }
  try {
    const rootStat = lstatSync(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root)
      throw erro('FECHADO', 'Raiz de teste invalida.');
    const audioRoot = join(root, 'notetaker-audio');
    const audioStat = lstatSync(audioRoot, { bigint: true });
    if (!audioStat.isDirectory() || audioStat.isSymbolicLink() || realpathSync(audioRoot) !== audioRoot)
      throw erro('FECHADO', 'Pasta de audio invalida.');
    return { root, audioRoot, rootStat, audioStat };
  } catch (error) {
    throw ownError(error, 'FECHADO');
  }
}
function assertDirectoryStable(root, audioRoot, rootBefore, audioBefore) {
  try {
    const rootNow = lstatSync(root, { bigint: true });
    const audioNow = lstatSync(audioRoot, { bigint: true });
    if (!rootNow.isDirectory() || rootNow.isSymbolicLink() || realpathSync(root) !== root ||
        !audioNow.isDirectory() || audioNow.isSymbolicLink() || realpathSync(audioRoot) !== audioRoot ||
        !sameStat(rootBefore, rootNow) || !sameStat(audioBefore, audioNow))
      throw erro('CONFLITO', 'Raiz ou pasta mudou durante o inventario.');
  } catch (error) {
    throw ownError(error, 'CONFLITO');
  }
}
function assertNoSidecar(audioRoot, nome) {
  for (const suffix of ['.tmp', '.journal']) {
    const sidecar = join(audioRoot, nome + suffix);
    try {
      lstatSync(sidecar, { bigint: true });
      throw erro('CONFLITO', 'Parte selecionada tem sidecar pendente.');
    } catch (error) {
      if (error?.code === 'CONFLITO') throw error;
      if (error?.code !== 'ENOENT') throw ioError(error, 'CONFLITO');
    }
  }
}
function openPart(audioRoot, part) {
  const filePath = join(audioRoot, part.nome);
  let before;
  try {
    before = lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || realpathSync(filePath) !== filePath)
      throw erro('INTEGRIDADE', 'Arquivo WAV invalido.');
    if (before.size > BigInt(MAX_PARTE_PCM + 44)) throw erro('LIMITE', 'WAV excede o limite de bytes.');
    if (before.size < 46n) throw erro('INTEGRIDADE', 'Arquivo WAV invalido.');
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const fd = openSync(filePath, constants.O_RDONLY | noFollow);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameStat(before, opened) || realpathSync(filePath) !== filePath)
        throw erro('CONFLITO', 'Arquivo WAV mudou ao abrir.');
      const result = { fd, before, filePath };
      return result;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  } catch (error) {
    throw ownError(error, 'INTEGRIDADE');
  }
}

/** Read-only, bounded inventory for a synthetic notetaker profile. */
export async function inventariarArquivosExclusao({ perfil, sessaoId, partes, signal } = {}) {
  const input = validateInput({ perfil, sessaoId, partes, signal });
  abort(input.signal);
  const { root, audioRoot, rootStat, audioStat } = inspectProfile(input.perfilCopy);
  const files = [];
  const observed = [];
  let bytesTotal = 0;
  try {
    for (const part of input.copied) {
      abort(input.signal);
      assertDirectoryStable(root, audioRoot, rootStat, audioStat);
      assertNoSidecar(audioRoot, part.nome);
      const opened = openPart(audioRoot, part);
      let fd = opened.fd;
      try {
        const before = opened.before;
        const header = Buffer.alloc(44);
        const headerBytes = readSync(fd, header, 0, header.length, 0);
        const pcmBytes = Number(before.size) - 44;
        if (headerBytes !== 44 || pcmBytes < 2 || pcmBytes % 2 || !header.equals(cabecalhoWav(pcmBytes)))
          throw erro('INTEGRIDADE', 'Cabecalho WAV nao canonico.');

        const digest = createHash('sha256');
        const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
        let readBytes = 0;
        while (readBytes < Number(before.size)) {
          abort(input.signal);
          const amount = Math.min(buffer.length, Number(before.size) - readBytes);
          const count = readSync(fd, buffer, 0, amount, readBytes);
          if (count <= 0) throw erro('INTEGRIDADE', 'WAV truncado.');
          digest.update(buffer.subarray(0, count));
          readBytes += count;
          await yieldEventLoop();
        }
        abort(input.signal);
        const afterFd = fstatSync(fd, { bigint: true });
        const afterPath = lstatSync(opened.filePath, { bigint: true });
        if (readBytes !== Number(before.size) || !sameStat(before, afterFd) || !sameStat(before, afterPath) ||
            afterPath.isSymbolicLink() || afterPath.nlink !== 1n || realpathSync(opened.filePath) !== opened.filePath ||
            digest.digest('hex') !== part.sha256)
          throw erro('INTEGRIDADE', 'WAV mudou ou hash divergente.');

        bytesTotal += readBytes;
        if (bytesTotal > MAX_PARTES * (MAX_PARTE_PCM + 44)) throw erro('LIMITE', 'Inventario excede o limite.');
        files.push(Object.freeze({ parteId: part.parteId, nome: part.nome, sha256: part.sha256,
          bytes: readBytes, identidade: identity(afterFd) }));
        observed.push({ filePath: opened.filePath, before });
      } finally {
        closeSync(fd);
        fd = undefined;
      }
      assertNoSidecar(audioRoot, part.nome);
      assertDirectoryStable(root, audioRoot, rootStat, audioStat);
    }
    abort(input.signal);
    assertDirectoryStable(root, audioRoot, rootStat, audioStat);
    for (let i = 0; i < input.copied.length; i++) {
      const part = input.copied[i], item = observed[i];
      assertNoSidecar(audioRoot, part.nome);
      try {
        const current = lstatSync(item.filePath, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
            !sameStat(item.before, current) || realpathSync(item.filePath) !== item.filePath)
          throw erro('CONFLITO', 'Arquivo mudou durante o inventario.');
      } catch (error) { throw ownError(error, 'CONFLITO'); }
    }
    return frozen({ schema: 1, sessaoId: input.sessaoId, arquivos: files, bytesTotal,
      raiz: directoryIdentity(rootStat), pasta: directoryIdentity(audioStat) });
  } catch (error) {
    throw ownError(error);
  }
}

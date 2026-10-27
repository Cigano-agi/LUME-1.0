import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { listarInventarioNativo } from './inventario-nativo.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const PROIBIDOS = new Set(['.git', '.codex', '.claude', '.agents', '.env', '.npmrc', '.netrc', '.ssh', '.aws', '.kube', '.gnupg', '.docker', '.pypirc', '.gitconfig',
  'agents.md', 'claude.md', 'credentials.json', 'id_rsa', 'id_ed25519']);

function caminhoSeguro(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) throw Error('INVALID_PATH');
  const partes = value.split('/');
  if (partes.some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || /[\x00-\x1f<>:"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || PROIBIDOS.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /^agents(?:[._-].*)?\.md$/i.test(part) || /^(?:.*\.(?:pem|p12|pfx|key|kdbx)|(?:secrets?|credentials?|tokens?)(?:[._-]|$))/i.test(part))) throw Error('FORBIDDEN_PATH');
  if (value === 'manifesto.json') throw Error('FORBIDDEN_PATH');
  return partes;
}

export function validarCaminhoProjeto(value) {
  caminhoSeguro(value);
  return true;
}

export async function listarArquivosProjeto({ origem } = {}) {
  return listarInventarioNativo({ origem });
}

function mesmoArquivo(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

async function componenteRegular(root, partes) {
  let atual = root;
  for (let i = 0; i < partes.length; i++) {
    atual = path.join(atual, partes[i]);
    const s = await lstat(atual);
    if (s.isSymbolicLink() || s.isBlockDevice() || s.isCharacterDevice() || s.isFIFO() || s.isSocket() || i === partes.length - 1 && s.nlink !== 1) throw Error('UNSAFE_SOURCE');
    if (i < partes.length - 1 ? !s.isDirectory() : !s.isFile()) throw Error('UNSAFE_SOURCE');
  }
  return atual;
}

export async function prepararProjetoIsolado({ origem, destino, arquivos } = {}) {
  if (typeof origem !== 'string' || typeof destino !== 'string' || !Array.isArray(arquivos) || !arquivos.length || arquivos.length > 5000) throw Error('INVALID_INPUT');
  const origemSelecionada = await lstat(origem);
  if (!origemSelecionada.isDirectory() || origemSelecionada.isSymbolicLink()) throw Error('UNSAFE_SOURCE');
  const origemReal = await realpath(origem);
  const origemStat = await lstat(origemReal);
  if (!origemStat.isDirectory() || origemStat.isSymbolicLink()) throw Error('UNSAFE_SOURCE');
  const destinoAbs = path.resolve(destino);
  const paiDestino = await realpath(path.dirname(destinoAbs));
  if (destinoAbs === origemReal || destinoAbs.startsWith(origemReal + path.sep) || origemReal.startsWith(destinoAbs + path.sep)) throw Error('UNSAFE_DESTINATION');
  if (paiDestino === origemReal || paiDestino.startsWith(origemReal + path.sep)) throw Error('UNSAFE_DESTINATION');
  try { await lstat(destinoAbs); throw Error('DESTINATION_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const normalizados = arquivos.map(caminho => ({ caminho, partes: caminhoSeguro(caminho) }));
  if (new Set(normalizados.map(x => x.caminho.toLowerCase())).size !== normalizados.length) throw Error('DUPLICATE_PATH');
  const copias = [];
  let total = 0;
  for (const item of normalizados) {
    const arquivo = await componenteRegular(origemReal, item.partes);
    const antes = await lstat(arquivo);
    if (antes.size > 256 * 1024 * 1024 || (total += antes.size) > 512 * 1024 * 1024) throw Error('PROJECT_TOO_LARGE');
    // The file descriptor and the path are checked both before and after reading.
    // A swapped link or a write during the snapshot invalidates the entire copy.
    const handle = await open(arquivo, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const aberto = await handle.stat();
      if (!mesmoArquivo(antes, aberto) || aberto.nlink !== 1) throw Error('SOURCE_CHANGED');
      bytes = await handle.readFile();
      const depois = await handle.stat();
      const caminhoDepois = await componenteRegular(origemReal, item.partes);
      const atual = await lstat(caminhoDepois);
      if (!mesmoArquivo(antes, depois) || !mesmoArquivo(antes, atual) || bytes.length !== antes.size) throw Error('SOURCE_CHANGED');
    } finally { await handle.close(); }
    copias.push({ caminho: item.caminho, bytes, sha256: sha256(bytes), sourceStat: antes });
  }
  // Recheck every source after the whole snapshot. A previously read source
  // changing while a later file is copied cannot produce a success manifest.
  for (const item of copias) {
    const arquivo = await componenteRegular(origemReal, caminhoSeguro(item.caminho));
    const atual = await lstat(arquivo);
    if (!mesmoArquivo(item.sourceStat, atual)) throw Error('SOURCE_CHANGED');
    const handle = await open(arquivo, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      if (!mesmoArquivo(item.sourceStat, await handle.stat()) || sha256(await handle.readFile()) !== item.sha256 ||
          !mesmoArquivo(item.sourceStat, await handle.stat()) || !mesmoArquivo(item.sourceStat, await lstat(arquivo))) throw Error('SOURCE_CHANGED');
    } finally { await handle.close(); }
  }
  await mkdir(destinoAbs, { recursive: false });
  for (const item of copias) {
    const target = path.join(destinoAbs, ...caminhoSeguro(item.caminho));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, item.bytes, { flag: 'wx' });
  }
  const manifesto = {
    versao: 1,
    escopo: { arquivos: copias.map(x => x.caminho) },
    arquivos: copias.map(x => ({ caminho: x.caminho, sha256: x.sha256, bytes: x.bytes.length }))
  };
  const manifestoBytes = Buffer.from(JSON.stringify(manifesto));
  await writeFile(path.join(destinoAbs, 'manifesto.json'), manifestoBytes, { flag: 'wx' });
  return { destino: destinoAbs, manifesto, manifestoSha256: sha256(manifestoBytes) };
}

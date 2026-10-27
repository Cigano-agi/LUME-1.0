import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { MAX_AUDIO_DOWNLOAD } from './audio-whatsapp.js';
import { EXT_MIDIA_CICLO } from './ciclo-midia-worker.js';
import { MAX_BYTES_AUDIO, validarAudioWav } from './audio-desktop-contrato.js';

const MiB = 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * MiB;
const MAX_ARQUIVOS=100000;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const fail = (code, message = code) => { const error = new Error(message); error.code = code; throw error; };
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

async function regularManaged(file, root) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || !inside(root, file))
    fail('ANEXO_FORA_DA_RAIZ');
  let current = path.parse(file).root;
  for (const part of path.relative(current, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await lstat(current, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') fail('ANEXO_AUSENTE'); throw error; }
    if (stat.isSymbolicLink() || (current === file ? !stat.isFile() : !stat.isDirectory())) fail('ANEXO_CAMINHO_INVALIDO');
    if (current === file && stat.nlink !== 1n) fail('ANEXO_LINK_MULTIPLO');
  }
  return lstat(file, { bigint: true });
}

function item(item) {
  if (!item || Object.getPrototypeOf(item) !== Object.prototype) fail('ANEXO_INVENTARIO_INVALIDO');
  const descriptors = Object.getOwnPropertyDescriptors(item);
  if (Reflect.ownKeys(descriptors).sort().join(',') !== 'caminho,classe' ||
      !Object.values(descriptors).every(d => Object.hasOwn(d, 'value')) ||
      !['transcricao', 'notetaker', 'ciclo_midia'].includes(descriptors.classe.value) || typeof descriptors.caminho.value !== 'string')
    fail('ANEXO_INVENTARIO_INVALIDO');
  return { classe: descriptors.classe.value, caminho: descriptors.caminho.value };
}

/** Inventário do snapshot SQLite; nenhum caminho de origem entra no pacote. */
export async function inventariarAnexosV10(db, { dbPath, arquivos = [], signal } = {}) {
  if (!Array.isArray(arquivos)) fail('ANEXO_INVENTARIO_INVALIDO');
  if(arquivos.length>MAX_ARQUIVOS)fail('ANEXO_LIMITE');
  const root = path.join(path.dirname(dbPath), 'anexos');
  const expected = [];
  for (const row of db.prepare("SELECT arquivo FROM transcricoes WHERE arquivo IS NOT NULL AND arquivo <> '' ORDER BY arquivo").iterate())
    expected.push({ classe: 'transcricao', caminho: row.arquivo });
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ciclo_midias'").get())
    for(const row of db.prepare('SELECT evento_id,caminho,sha256,mime,tamanho FROM ciclo_midias ORDER BY evento_id').iterate()){
      if(!Number.isSafeInteger(row.evento_id)||row.evento_id<1||
        typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||
        !Object.hasOwn(EXT_MIDIA_CICLO,row.mime)||
        !Number.isSafeInteger(row.tamanho)||row.tamanho<1||row.tamanho>MAX_AUDIO_DOWNLOAD)
        fail('ANEXO_REFERENCIA_INVALIDA');
      expected.push({classe:'ciclo_midia',caminho:row.caminho,sha256:row.sha256,tamanho:row.tamanho});
    }
  for (const row of db.prepare('SELECT caminho FROM notetaker_partes ORDER BY caminho').iterate()) {
    if (typeof row.caminho !== 'string' || !row.caminho) fail('ANEXO_REFERENCIA_INVALIDA');
    fail('ANEXOS_SEM_LOCK', 'A restauração notetaker ainda não possui paridade v10');
  }
  if(expected.length>MAX_ARQUIVOS)fail('ANEXO_LIMITE');
  const supplied = arquivos.map(item);
  const byKey = new Map();
  for (const value of supplied) {
    const k = key(value.caminho);
    if (byKey.has(k)) fail('ANEXO_DUPLICADO');
    byKey.set(k, value);
  }
  if (byKey.size !== expected.length) fail('ANEXO_INVENTARIO_DIVERGENTE');
  let total = 0;
  const result = [];
  for (const reference of expected) {
    signal?.throwIfAborted();
    const suppliedItem = byKey.get(key(reference.caminho));
    if (!suppliedItem || suppliedItem.classe !== reference.classe) fail('ANEXO_INVENTARIO_DIVERGENTE');
    const before = await regularManaged(reference.caminho, root);
    if (before.size > BigInt(MAX_TOTAL) || total + Number(before.size) > MAX_TOTAL) fail('ANEXO_LIMITE');
    if(reference.classe==='ciclo_midia'&&before.size!==BigInt(reference.tamanho))fail('ANEXO_REFERENCIA_INVALIDA');
    if (reference.classe === 'transcricao' && before.size > BigInt(MAX_BYTES_AUDIO)) fail('ANEXO_FORMATO_INVALIDO');
    const handle = await open(reference.caminho, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let digest;
    try {
      if (!same(before, await handle.stat({ bigint: true }))) fail('ANEXO_ALTERADO');
      const hash = createHash('sha256');
      const partes = [];
      for await (const bytes of handle.createReadStream({ highWaterMark: MiB, autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(bytes);
        if (reference.classe === 'transcricao') partes.push(bytes);
      }
      if (!same(before, await handle.stat({ bigint: true }))) fail('ANEXO_ALTERADO');
      if (reference.classe === 'transcricao') {
        try { validarAudioWav(Buffer.concat(partes)); }
        catch { fail('ANEXO_FORMATO_INVALIDO'); }
      }
      digest = hash.digest('hex');
      if(reference.classe==='ciclo_midia'&&digest!==reference.sha256)fail('ANEXO_HASH_DIVERGENTE');
    } finally { await handle.close(); }
    total += Number(before.size);
    result.push(Object.freeze({ id: result.length + 1, classe: reference.classe, caminho: reference.caminho, root,
      bytes: Number(before.size), sha256: digest, identity: before }));
  }
  return Object.freeze(result);
}

export async function* quadrosAnexoV10(anexo, { signal } = {}) {
  const before = await regularManaged(anexo.caminho, anexo.root);
  if (!same(before, anexo.identity)) fail('ANEXO_ALTERADO');
  const handle = await open(anexo.caminho, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!same(before, await handle.stat({ bigint: true }))) fail('ANEXO_ALTERADO');
    yield { cabecalho: { tipo: 'arquivo', id: anexo.id, classe: anexo.classe, bytes: anexo.bytes,
      sha256: anexo.sha256, nome: `anexo-${anexo.id}.bin` }, payload: Buffer.alloc(0) };
    let offset = 0, indice = 0;
    for await (const bytes of handle.createReadStream({ highWaterMark: MiB, autoClose: false })) {
      signal?.throwIfAborted();
      yield { cabecalho: { tipo: 'chunk', id: anexo.id, indice, offset }, payload: bytes };
      offset += bytes.length; indice++;
    }
    if (!same(before, await handle.stat({ bigint: true })) || offset !== anexo.bytes) fail('ANEXO_ALTERADO');
    yield { cabecalho: { tipo: 'fimArquivo', id: anexo.id, bytes: anexo.bytes, sha256: anexo.sha256 }, payload: Buffer.alloc(0) };
  } finally { await handle.close(); }
}

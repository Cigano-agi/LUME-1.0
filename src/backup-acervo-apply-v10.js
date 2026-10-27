import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validarAudioWav } from './audio-desktop-contrato.js';
import { EXT_MIDIA_CICLO } from './ciclo-midia-worker.js';

const MiB = 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const JOURNAL = 'perfil-publicacao.json';
const NEXT = 'perfil-publicacao.next';
const MAX_ANEXOS = 100000;
const MAX_JOURNAL = 32 * MiB;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
const expectedName = name => /^data-pendente-[0-9a-f]{32}$/.test(name);
const nomeAnexo=nome=>/^audio-[0-9a-f-]{36}\.wav$/.test(nome)||
  /^ciclo-midia-\d+-[0-9a-f-]{36}\.(ogg|m4a|mp3|wav|aac|amr|flac)$/.test(nome);
function anexosJournalValidos(journal){
  if(![1,2].includes(journal?.schema)||!Array.isArray(journal.anexos)||journal.anexos.length>MAX_ANEXOS)return false;
  const names=new Set(),ids=new Set();
  return journal.anexos.every(item=>{
    if(!item||!Number.isSafeInteger(item.id)||item.id<1||ids.has(item.id)||
      typeof item.nome!=='string'||names.has(item.nome)||!nomeAnexo(item.nome)||
      typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))return false;
    ids.add(item.id);names.add(item.nome);
    if(journal.schema===1)return Object.keys(item).sort().join(',')==='id,nome,sha256'&&/^audio-/.test(item.nome);
    if(!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>20*MiB)return false;
    if(item.classe==='transcricao')return Object.keys(item).sort().join(',')==='bytes,classe,id,nome,sha256'&&/^audio-/.test(item.nome);
    if(item.classe==='ciclo_midia')return Object.keys(item).sort().join(',')==='bytes,classe,eventoId,id,mime,nome,sha256'&&
      Number.isSafeInteger(item.eventoId)&&item.eventoId>0&&Object.hasOwn(EXT_MIDIA_CICLO,item.mime)&&
      item.nome.startsWith(`ciclo-midia-${item.eventoId}-`)&&item.nome.endsWith('.'+EXT_MIDIA_CICLO[item.mime]);
    return false;
  });
}

async function safePath(target, kind, missingLast = false) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.normalize(target) !== target)
    fail('PERFIL_CAMINHO_INVALIDO');
  let current = path.parse(target).root;
  const parts = path.relative(current, target).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = await lstat(current, { bigint: true }); }
    catch (error) {
      if (missingLast && i === parts.length - 1 && error.code === 'ENOENT') return null;
      fail('PERFIL_CAMINHO_INVALIDO');
    }
    if (st.isSymbolicLink() || (i === parts.length - 1 && kind === 'file' ? !st.isFile() || st.nlink !== 1n : !st.isDirectory()))
      fail('PERFIL_CAMINHO_INVALIDO');
  }
  return lstat(target, { bigint: true });
}

export async function hashArquivoV10(file) {
  const before = await safePath(file, 'file');
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    if (!same(before, await handle.stat({ bigint: true }))) fail('PLANO_INVALIDO');
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ highWaterMark: MiB, autoClose: false })) hash.update(bytes);
    if (!same(before, await handle.stat({ bigint: true }))) fail('PLANO_INVALIDO');
    return hash.digest('hex');
  } finally { await handle.close(); }
}

async function saveJournal(root, body, exclusive = false) {
  const target = path.join(root, exclusive ? JOURNAL : NEXT);
  const bytes = Buffer.from(JSON.stringify(body));
  if (bytes.length > MAX_JOURNAL) fail('ANEXO_LIMITE');
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) await rename(target, path.join(root, JOURNAL));
}

async function extract(pack, meta, file) {
  const source = await open(pack, constants.O_RDONLY | NOFOLLOW);
  let target;
  try {
    target = await open(file, 'wx', 0o600);
    let offset = 0;
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(MiB);
    while (offset < meta.bytes) {
      const wanted = Math.min(buffer.length, meta.bytes - offset);
      const { bytesRead } = await source.read(buffer, 0, wanted, meta.offset + offset);
      if (bytesRead < 1) fail('ANEXO_INCOMPLETO');
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten < 1) fail('ANEXO_INCOMPLETO');
        written += result.bytesWritten;
      }
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await target.sync();
    if (digest.digest('hex') !== meta.sha256) fail('ANEXO_HASH_DIVERGENTE');
  } finally { await target?.close(); await source.close(); }
  // A transcrição contém WAV normalizado. O original preserva o contêiner recebido.
  if(meta.classe==='transcricao'){
    try { validarAudioWav(await readFile(file)); }
    catch { fail('ANEXO_FORMATO_INVALIDO'); }
  }
}

async function auditCandidate(root, candidate, journal) {
  if (candidate !== 'data' && !expectedName(candidate)) fail('PERFIL_RECUPERACAO_PENDENTE');
  const data = path.join(root, candidate);
  await safePath(data, 'directory');
  const entries = (await readdir(data)).sort();
  if (entries.join(',') !== 'anexos,assessor.db') fail('PERFIL_RECUPERACAO_PENDENTE');
  const files = (await readdir(path.join(data, 'anexos'))).sort();
  if (files.join(',') !== journal.anexos.map(item => item.nome).sort().join(',')) fail('PERFIL_RECUPERACAO_PENDENTE');
  const dbPath = path.join(data, 'assessor.db');
  if (await hashArquivoV10(dbPath) !== journal.dbSha256) fail('PERFIL_RECUPERACAO_PENDENTE');
  for (const item of journal.anexos) {
    const file = path.join(data, 'anexos', item.nome);
    if(journal.schema===2&&(await safePath(file,'file')).size!==BigInt(item.bytes))fail('PERFIL_RECUPERACAO_PENDENTE');
    if (await hashArquivoV10(file) !== item.sha256) fail('PERFIL_RECUPERACAO_PENDENTE');
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get() ||
        db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get()?.valor !== '1')
      fail('PERFIL_RECUPERACAO_PENDENTE');
    for (const item of journal.anexos) {
      const file = path.join(root, 'data', 'anexos', item.nome);
      if(item.classe==='ciclo_midia'){
        const row=db.prepare('SELECT caminho,sha256,mime,tamanho FROM ciclo_midias WHERE evento_id=?').get(item.eventoId);
        if(row?.caminho!==file||row.sha256!==item.sha256||row.mime!==item.mime||row.tamanho!==item.bytes)
          fail('PERFIL_RECUPERACAO_PENDENTE');
      }else if(db.prepare('SELECT COUNT(*) n FROM transcricoes WHERE arquivo=?').get(file).n!==1)
        fail('PERFIL_RECUPERACAO_PENDENTE');
    }
    if(db.prepare("SELECT 1 FROM transcricoes WHERE arquivo LIKE 'anexo:%' LIMIT 1").get()||
      db.prepare("SELECT 1 FROM ciclo_midias WHERE caminho LIKE 'anexo:%' LIMIT 1").get())fail('PERFIL_RECUPERACAO_PENDENTE');
  } finally { db.close(); }
}

async function removeBuilding(root, candidate) {
  const target = path.join(root, candidate);
  const st = await safePath(target, 'directory', true);
  if (!st) return;
  const entries = await readdir(target);
  if (entries.some(name => !['assessor.db', 'assessor.db-wal', 'assessor.db-shm', 'anexos'].includes(name)))
    fail('PERFIL_RECUPERACAO_PENDENTE');
  for (const name of entries) {
    const p = path.join(target, name);
    if (name !== 'anexos') await safePath(p, 'file');
    else {
      await safePath(p, 'directory');
      for (const child of await readdir(p)) {
        if (!nomeAnexo(child)) fail('PERFIL_RECUPERACAO_PENDENTE');
        await safePath(path.join(p, child), 'file');
      }
    }
  }
  // Só remove o diretório candidato que este journal nomeou, após validar todos os filhos.
  await rm(target, { recursive: true });
}

/** Recupera apenas publicação v10 gerada neste perfil; journal estranho bloqueia o boot. */
export async function recuperarAplicacaoV10({ destinoNovo, publicadorEncerrado = false } = {}) {
  if (typeof destinoNovo !== 'string' || !path.isAbsolute(destinoNovo) || path.normalize(destinoNovo) !== destinoNovo)
    fail('PERFIL_CAMINHO_INVALIDO');
  await safePath(path.dirname(destinoNovo), 'directory');
  const reservationPath = destinoNovo + '.lume-v10-reserva';
  const reservationStat = await safePath(reservationPath, 'file', true);
  const root = await safePath(destinoNovo, 'directory', true);
  if (!reservationStat) {
    if (!root) return { estado: 'sem-pendencia' };
    const journalPath = path.join(destinoNovo, JOURNAL);
    const leftover = await safePath(journalPath, 'file', true);
    if (leftover) {
      if (publicadorEncerrado !== true || leftover.size > BigInt(MAX_JOURNAL)) fail('PERFIL_RECUPERACAO_PENDENTE');
      let journal;
      try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
      catch { fail('PERFIL_RECUPERACAO_PENDENTE'); }
      if (!anexosJournalValidos(journal) || journal.phase !== 'ready' || !expectedName(journal.candidate) ||
          !/^[a-f0-9]{64}$/.test(journal.dbSha256) ||
          await safePath(path.join(destinoNovo, journal.candidate), 'directory', true) ||
          !(await safePath(path.join(destinoNovo, 'data'), 'directory', true))) fail('PERFIL_RECUPERACAO_PENDENTE');
      await auditCandidate(destinoNovo, 'data', journal);
      await unlink(journalPath);
      return { estado: 'publicada' };
    }
    return { estado: 'sem-pendencia' };
  }
  if (publicadorEncerrado !== true) fail('PERFIL_RECUPERACAO_PENDENTE');
  let reservation;
  try { reservation = JSON.parse(await readFile(reservationPath, 'utf8')); }
  catch { fail('PERFIL_RECUPERACAO_PENDENTE'); }
  if (reservation?.schema !== 1 || typeof reservation.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(reservation.id) || reservation.destino !== path.basename(destinoNovo))
    fail('PERFIL_RECUPERACAO_PENDENTE');
  if (!root) { await unlink(reservationPath); return { estado: 'revertida' }; }
  const journalPath = path.join(destinoNovo, JOURNAL);
  const st = await safePath(journalPath, 'file', true);
  if (!st) {
    if ((await readdir(destinoNovo)).length !== 0) fail('PERFIL_RECUPERACAO_PENDENTE');
    await rmdir(destinoNovo);
    await unlink(reservationPath);
    return { estado: 'revertida' };
  }
  if (st.size > BigInt(MAX_JOURNAL)) fail('PERFIL_RECUPERACAO_PENDENTE');
  let journal;
  try { journal = JSON.parse(await readFile(journalPath, 'utf8')); }
  catch { fail('PERFIL_RECUPERACAO_PENDENTE'); }
  if (![1,2].includes(journal?.schema) || !expectedName(journal.candidate) || !['building', 'ready'].includes(journal.phase) ||
      journal.id !== reservation.id) fail('PERFIL_RECUPERACAO_PENDENTE');
  const dataPath = path.join(destinoNovo, 'data');
  const data = await safePath(dataPath, 'directory', true);
  const candidate = await safePath(path.join(destinoNovo, journal.candidate), 'directory', true);
  if (journal.phase === 'building') {
    if (data) fail('PERFIL_RECUPERACAO_PENDENTE');
    await removeBuilding(destinoNovo, journal.candidate);
    const next = path.join(destinoNovo, NEXT);
    if (await safePath(next, 'file', true)) await unlink(next);
    await unlink(journalPath);
    if ((await readdir(destinoNovo)).length !== 0) fail('PERFIL_RECUPERACAO_PENDENTE');
    await rmdir(destinoNovo);
    await unlink(reservationPath);
    return { estado: 'revertida' };
  }
  if (!anexosJournalValidos(journal) || !/^[a-f0-9]{64}$/.test(journal.dbSha256) ||
      Boolean(data) === Boolean(candidate)) fail('PERFIL_RECUPERACAO_PENDENTE');
  if (candidate) {
    await auditCandidate(destinoNovo, journal.candidate, journal);
    await rename(path.join(destinoNovo, journal.candidate), dataPath);
  }
  await auditCandidate(destinoNovo, 'data', journal);
  await unlink(reservationPath);
  await unlink(journalPath);
  return { estado: 'publicada' };
}

/** Publica backup autenticado somente em um perfil novo, nunca substitui data/credenciais reais. */
export async function publicarAcervoV10({ destinoNovo, state } = {}) {
  if (!state || typeof state !== 'object') fail('PLANO_INVALIDO');
  if (typeof destinoNovo !== 'string' || !path.isAbsolute(destinoNovo) || path.normalize(destinoNovo) !== destinoNovo)
    fail('PERFIL_CAMINHO_INVALIDO');
  if (!Array.isArray(state.fileMetas) || state.fileMetas.length > MAX_ANEXOS) fail('ANEXO_LIMITE');
  await safePath(path.dirname(destinoNovo), 'directory');
  if (await safePath(destinoNovo, 'directory', true)) fail('PERFIL_OCUPADO');
  const id = randomUUID();
  const reservationPath = destinoNovo + '.lume-v10-reserva';
  const reserve = await open(reservationPath, 'wx', 0o600);
  try { await reserve.writeFile(JSON.stringify({ schema: 1, id, destino: path.basename(destinoNovo) })); await reserve.sync(); }
  finally { await reserve.close(); }
  await mkdir(destinoNovo, { mode: 0o700 });
  const candidate = 'data-pendente-' + id.replaceAll('-', '');
  await saveJournal(destinoNovo, { schema: 2, id, phase: 'building', candidate }, true);
  const candidatePath = path.join(destinoNovo, candidate);
  const anexosDir = path.join(candidatePath, 'anexos');
  await mkdir(candidatePath, { mode: 0o700 });
  await mkdir(anexosDir, { mode: 0o700 });
  const dbPath = path.join(candidatePath, 'assessor.db');
  await copyFile(path.join(state.area.caminho, 'acervo.sqlite'), dbPath, constants.COPYFILE_EXCL);
  if (await hashArquivoV10(dbPath) !== state.dbSha256) fail('PLANO_INVALIDO');
  const annex = [];
  const lookup=new DatabaseSync(dbPath,{readOnly:true});
  let mediaInfo;
  try{
    mediaInfo=new Map(state.fileMetas.filter(meta=>meta.classe==='ciclo_midia').map(meta=>{
      const row=lookup.prepare('SELECT evento_id,mime,sha256,tamanho FROM ciclo_midias WHERE caminho=?')
        .get(`anexo:${meta.id}`);
      if(!row||row.sha256!==meta.sha256||row.tamanho!==meta.bytes||
        !Object.hasOwn(EXT_MIDIA_CICLO,row.mime))fail('ANEXO_REFERENCIA_INVALIDA');
      return [meta.id,row];
    }));
  }finally{lookup.close();}
  for (const meta of state.fileMetas) {
    if(!['transcricao','ciclo_midia'].includes(meta.classe))fail('ANEXO_CLASSE_INVALIDA');
    const media=mediaInfo.get(meta.id);
    const nome=media?`ciclo-midia-${media.evento_id}-${randomUUID()}.${EXT_MIDIA_CICLO[media.mime]}`:
      `audio-${randomUUID()}.wav`;
    await extract(path.join(state.area.caminho, 'anexos.pack'), meta, path.join(anexosDir, nome));
    annex.push(media?{id:meta.id,classe:'ciclo_midia',nome,sha256:meta.sha256,bytes:meta.bytes,
      eventoId:media.evento_id,mime:media.mime}:
      {id:meta.id,classe:'transcricao',nome,sha256:meta.sha256,bytes:meta.bytes});
  }
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of annex) {
        const result=item.classe==='ciclo_midia'?
          db.prepare('UPDATE ciclo_midias SET caminho=? WHERE evento_id=? AND caminho=?')
            .run(path.join(destinoNovo,'data','anexos',item.nome),item.eventoId,`anexo:${item.id}`):
          db.prepare('UPDATE transcricoes SET arquivo=? WHERE arquivo=?')
            .run(path.join(destinoNovo, 'data', 'anexos', item.nome), `anexo:${item.id}`);
        if (result.changes !== 1) fail('ANEXO_REFERENCIA_INVALIDA');
      }
      if (db.prepare("SELECT 1 FROM transcricoes WHERE arquivo LIKE 'anexo:%' LIMIT 1").get()||
        db.prepare("SELECT 1 FROM ciclo_midias WHERE caminho LIKE 'anexo:%' LIMIT 1").get()) fail('ANEXO_REFERENCIA_INVALIDA');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode=DELETE');
  } finally { db.close(); }
  const dbSha256 = await hashArquivoV10(dbPath);
  const ready = { schema: 2, id, phase: 'ready', candidate, dbSha256, anexos: annex };
  await saveJournal(destinoNovo, ready);
  return recuperarAplicacaoV10({ destinoNovo, publicadorEncerrado: true });
}

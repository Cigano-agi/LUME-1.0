import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { TABELAS_I_V9 } from '../src/backup-acervo-catalogo.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { gravarPacote } from '../src/backup-stream.js';
import { validarAcervoV9, descartarPlanoV9 } from '../src/backup-acervo-restore-v9.js';

const TIMEOUT_MS = 600_000;
const RSS_LIMIT = 512 * 1024 * 1024;
const MANDATORY = ['eventos', 'conversas_app'];
const KNOWN = new Set([
  'FONTE_INVALIDA', 'CAMINHO_INVALIDO', 'CAMINHO_SOBREPOSTO', 'OUTPUT_OCUPADO',
  'CAMINHO_ALTERADO', 'DIAGNOSTICO_CANCELADO', 'DIAGNOSTICO_TIMEOUT',
  'DIAGNOSTICO_RSS_EXCEDIDO', 'INTEGRIDADE_FALHOU', 'FK_INVALIDA',
  'SCHEMA_NAO_MAPEADO', 'SCHEMA_INCOMPLETO', 'TABELA_G_POVOADA', 'PK_DIVERGENTE',
  'ANEXOS_SEM_LOCK', 'VALOR_SQL_INVALIDO', 'ROW_MAIOR_4MIB', 'PK_INVALIDA',
  'SEMANTICA_INVALIDA', 'DOMINIO_INVALIDO', 'TIPO_INVALIDO', 'TIPO_SQL_DIVERGENTE',
  'TABELA_INVALIDA', 'CATALOGO_DIVERGENTE', 'PACOTE_ALTERADO', 'STAGING_ALTERADO',
  'RESTORE_CANCELADO', 'LIMPEZA_PENDENTE', 'PARIDADE_DIVERGENTE',
]);
const q = name => `"${name.replaceAll('"', '""')}"`;
const key = name => process.platform === 'win32' ? name.toLowerCase() : name;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function same(a, b) { return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.isSymbolicLink() === b.isSymbolicLink(); }
function stop(signal) { if (signal?.aborted) fail(['DIAGNOSTICO_TIMEOUT', 'DIAGNOSTICO_RSS_EXCEDIDO'].includes(signal.reason?.code) ? signal.reason.code : 'DIAGNOSTICO_CANCELADO'); }
function ancestor(a, b) { const relative = path.relative(key(a), key(b)); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

async function chain(p, type) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.resolve(p) !== p) fail('CAMINHO_INVALIDO');
  const root = path.parse(p).root;
  const result = [];
  let current = root;
  for (const part of p.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let st;
    try { st = await lstat(current, { bigint: true }); } catch { fail(type === 'file' ? 'FONTE_INVALIDA' : 'CAMINHO_INVALIDO'); }
    if (st.isSymbolicLink() || st.isBlockDevice() || st.isCharacterDevice()) fail('CAMINHO_INVALIDO');
    if (current === p ? (type === 'file' ? !st.isFile() || st.nlink !== 1n : !st.isDirectory()) : !st.isDirectory()) fail('CAMINHO_INVALIDO');
    result.push({ path: current, st });
  }
  if (!result.length) fail('CAMINHO_INVALIDO');
  return result;
}

async function unchanged(chains) {
  for (const entries of chains) for (const entry of entries) {
    let now;
    try { now = await lstat(entry.path, { bigint: true }); } catch { fail('CAMINHO_ALTERADO'); }
    if (!same(entry.st, now) || now.isSymbolicLink() ||
      (entry.st.isFile() && (now.size !== entry.st.size || now.mtimeNs !== entry.st.mtimeNs || now.ctimeNs !== entry.st.ctimeNs || now.nlink !== 1n))) fail('CAMINHO_ALTERADO');
  }
}

async function signature(file, signal) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { stop(signal); hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

function typed(value) {
  if (value === null) return ['n'];
  if (typeof value === 'bigint') return ['i', value.toString()];
  if (typeof value === 'number' && Number.isFinite(value)) return ['r', value];
  if (typeof value === 'string' && value.isWellFormed()) return ['t', value];
  if (value instanceof Uint8Array) return ['b', Buffer.from(value).toString('base64')];
  fail('VALOR_SQL_INVALIDO');
}

async function summarize(db, signal, sample) {
  if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') fail('INTEGRIDADE_FALHOU');
  if (db.prepare('PRAGMA foreign_key_check').get()) fail('FK_INVALIDA');
  const tables = Object.create(null);
  for (const table of TABELAS_I_V9) {
    stop(signal);
    const sql = `SELECT ${table.colunas.map(q).join(',')} FROM ${q(table.nome)} ORDER BY ${table.pk.map(q).join(',')}`;
    const stmt = db.prepare(sql); stmt.setReadBigInts(true);
    const hash = createHash('sha256'); let count = 0;
    for (const row of stmt.iterate()) {
      stop(signal); sample();
      const payload = Buffer.from(JSON.stringify({ v: table.colunas.map(c => typed(row[c])) }), 'utf8');
      const length = Buffer.allocUnsafe(4); length.writeUInt32BE(payload.length);
      hash.update(length).update(payload); count++;
      if ((count & 1023) === 0) await nextTurn();
    }
    tables[table.nome] = { linhas: count, sha256: hash.digest('hex') };
  }
  return tables;
}

async function checkpoint(file) {
  let db;
  try { db = await lstat(file, { bigint: true }); } catch { fail('CAMINHO_ALTERADO'); }
  if (!db.isFile() || db.isSymbolicLink() || db.nlink !== 1n) fail('CAMINHO_ALTERADO');
  for (const suffix of ['-wal', '-shm']) {
    let sidecar;
    try { sidecar = await lstat(`${file}${suffix}`, { bigint: true }); }
    catch (error) { if (error.code !== 'ENOENT') fail('CAMINHO_ALTERADO'); }
    if (sidecar) fail('CAMINHO_ALTERADO');
  }
  return { db };
}

function sameCheckpoint(a, b) {
  return same(a.db, b.db) && a.db.size === b.db.size && a.db.mtimeNs === b.db.mtimeNs && a.db.ctimeNs === b.db.ctimeNs;
}

export function compararParidade(origem, oraculo) {
  const tabelas = TABELAS_I_V9.map(table => {
    const a = origem[table.nome], b = oraculo[table.nome];
    if (!a || !b) fail('PARIDADE_DIVERGENTE');
    return { tabela: table.nome, origem: a, oraculo: b, igual: a.linhas === b.linhas && a.sha256 === b.sha256 };
  });
  const eventos = tabelas.find(t => t.tabela === 'eventos').igual;
  const conversas_app = tabelas.find(t => t.tabela === 'conversas_app').igual;
  return { eventos, conversas_app, tabelas };
}

async function removeFile(file, identity) {
  if (!identity) return true;
  let now;
  try { now = await lstat(file, { bigint: true }); } catch (error) { return error.code === 'ENOENT'; }
  if (!same(identity, now) || !now.isFile() || now.nlink !== 1n) return false;
  try { await unlink(file); return true; } catch { return false; }
}

async function removeDir(dir, identity) {
  if (!identity) return true;
  let now;
  try { now = await lstat(dir, { bigint: true }); } catch (error) { return error.code === 'ENOENT'; }
  if (!same(identity, now) || !now.isDirectory()) return false;
  try { if ((await readdir(dir)).length) return false; await rmdir(dir); return true; } catch { return false; }
}

async function optionalStat(file) {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function reserveSidecars(file, own, prefix) {
  for (const [suffix, field] of [['-wal', `${prefix}WalSt`], ['-shm', `${prefix}ShmSt`]]) {
    const handle = await open(`${file}${suffix}`, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { own[field] = await handle.stat({ bigint: true }); }
    finally { await handle.close(); }
  }
}

async function assertSidecars(file, own, prefix) {
  for (const [suffix, field] of [['-wal', `${prefix}WalSt`], ['-shm', `${prefix}ShmSt`]]) {
    const now = await optionalStat(`${file}${suffix}`);
    if (now && (!same(own[field], now) || !now.isFile() || now.nlink !== 1n)) fail('CAMINHO_ALTERADO');
  }
}

async function assertOwnDirs(own) {
  for (const [dir, identity] of [[own.work, own.workSt], [own.stage, own.stageSt], [own.oracle, own.oracleSt]]) {
    const now = await optionalStat(dir);
    if (!same(identity, now) || !now?.isDirectory() || now.isSymbolicLink()) fail('CAMINHO_ALTERADO');
  }
}

/** Saída fechada: apenas códigos, fases, contagens e hashes, sem conteúdo do acervo. */
export async function executarDiagnostico({ source, outputRoot, signal, __testAfterOrigin, __testBeforeCleanup } = {}) {
  const result = { codigo: 'DIAGNOSTICO_FALHOU', fase: 'entrada', pacoteCriado: false,
    validacao: 'NAO_INICIADA', paridade: { eventos: null, conversas_app: null, tabelas: [] },
    limpeza: 'NAO_NECESSARIA', rssPicoBytes: 0, pacoteEfemero: 'CHAVE_SOMENTE_EM_MEMORIA' };
  const local = new AbortController();
  const onAbort = () => local.abort(signal?.reason);
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => local.abort(Object.assign(new Error('timeout'), { code: 'DIAGNOSTICO_TIMEOUT' })), TIMEOUT_MS);
  let sourceDb, oracleDb, origin, plan;
  let sourceChain, rootChain, rootSt, sourceSignature, own = null;
  const baseline = process.memoryUsage().rss;
  const sample = () => { const rss = process.memoryUsage().rss; result.rssPicoBytes = Math.max(result.rssPicoBytes, rss); if (rss - baseline > RSS_LIMIT) fail('DIAGNOSTICO_RSS_EXCEDIDO'); };
  const monitor = setInterval(() => {
    const rss = process.memoryUsage().rss;
    result.rssPicoBytes = Math.max(result.rssPicoBytes, rss);
    if (rss - baseline > RSS_LIMIT) local.abort(Object.assign(new Error('rss'), { code: 'DIAGNOSTICO_RSS_EXCEDIDO' }));
  }, 100);
  try {
    stop(local.signal);
    if (typeof source !== 'string' || typeof outputRoot !== 'string' || !path.isAbsolute(source) || !path.isAbsolute(outputRoot)) fail('CAMINHO_INVALIDO');
    if (ancestor(source, outputRoot) || ancestor(outputRoot, source)) fail('CAMINHO_SOBREPOSTO');
    sourceChain = await chain(source, 'file'); rootChain = await chain(outputRoot, 'dir');
    rootSt = rootChain.at(-1).st;
    if ((await readdir(outputRoot)).length) fail('OUTPUT_OCUPADO');
    await unchanged([sourceChain, rootChain]);
    result.fase = 'origem';
    const sourceCheckpoint = await checkpoint(source);
    sourceSignature = await signature(source, local.signal);
    const suffix = randomUUID();
    own = { work: path.join(outputRoot, `lume-work-${suffix}`), stage: path.join(outputRoot, `lume-stage-${suffix}`), oracle: path.join(outputRoot, `lume-oracle-${suffix}`) };
    await mkdir(own.work); own.workSt = await lstat(own.work, { bigint: true });
    await mkdir(own.stage); own.stageSt = await lstat(own.stage, { bigint: true });
    await mkdir(own.oracle); own.oracleSt = await lstat(own.oracle, { bigint: true });
    own.input = path.join(own.work, 'fonte.sqlite');
    await copyFile(source, own.input, constants.COPYFILE_EXCL);
    own.inputSt = await lstat(own.input, { bigint: true });
    if (JSON.stringify(await signature(own.input, local.signal)) !== JSON.stringify(sourceSignature)) fail('CAMINHO_ALTERADO');
    if (!sameCheckpoint(sourceCheckpoint, await checkpoint(source))) fail('CAMINHO_ALTERADO');
    await reserveSidecars(own.input, own, 'input');
    sourceDb = new DatabaseSync(own.input, { readOnly: true });
    const sourceTables = await summarize(sourceDb, local.signal, sample);
    sourceDb.close(); sourceDb = null;
    await assertSidecars(own.input, own, 'input');
    if (JSON.stringify(await signature(source, local.signal)) !== JSON.stringify(sourceSignature)) fail('CAMINHO_ALTERADO');
    if (!sameCheckpoint(sourceCheckpoint, await checkpoint(source))) fail('CAMINHO_ALTERADO');
    await unchanged([sourceChain, rootChain]);
    own.package = path.join(own.work, 'acervo.lumebak');
    result.fase = 'pacote';
    await assertOwnDirs(own);
    const password = randomBytes(32).toString('hex');
    origin = await criarOrigemV9({ dbPath: own.input, arquivos: [], perfil: { dono: '' }, signal: local.signal });
    await __testAfterOrigin?.();
    await gravarPacote({ origem: origin.origem, destino: own.package, senha: password, signal: local.signal });
    await origin.fechar(); origin = null;
    await assertSidecars(own.input, own, 'input');
    own.packageSt = await lstat(own.package, { bigint: true });
    result.pacoteCriado = true;
    await unchanged([sourceChain, rootChain]);
    await assertOwnDirs(own);
    if (own.packageSt.nlink !== 1n || !own.packageSt.isFile()) fail('CAMINHO_ALTERADO');
    result.fase = 'validacao';
    const validated = await validarAcervoV9({ pacote: own.package, senha: password, raizStaging: own.stage, signal: local.signal });
    plan = validated.plano; result.validacao = 'VALIDADA';
    stop(local.signal);
    await assertOwnDirs(own);
    const names = await readdir(own.stage);
    if (names.length !== 1) fail('CAMINHO_ALTERADO');
    const staged = path.join(own.stage, names[0], 'acervo.sqlite');
    const before = await checkpoint(staged);
    own.copy = path.join(own.oracle, 'oraculo.sqlite');
    await copyFile(staged, own.copy, constants.COPYFILE_EXCL);
    own.copySt = await lstat(own.copy, { bigint: true });
    if (JSON.stringify(await signature(staged, local.signal)) !== JSON.stringify(await signature(own.copy, local.signal)) ||
      !sameCheckpoint(before, await checkpoint(staged))) fail('CAMINHO_ALTERADO');
    await reserveSidecars(own.copy, own, 'oracle');
    result.fase = 'paridade';
    oracleDb = new DatabaseSync(own.copy, { readOnly: true });
    const oracleTables = await summarize(oracleDb, local.signal, sample);
    oracleDb.close(); oracleDb = null;
    await assertSidecars(own.copy, own, 'oracle');
    if (!sameCheckpoint(before, await checkpoint(staged))) fail('CAMINHO_ALTERADO');
    if (JSON.stringify(await signature(source, local.signal)) !== JSON.stringify(sourceSignature) ||
      !sameCheckpoint(sourceCheckpoint, await checkpoint(source))) fail('CAMINHO_ALTERADO');
    result.paridade = compararParidade(sourceTables, oracleTables);
    result.codigo = MANDATORY.every(name => result.paridade[name]) ? 'PARIDADE_CONFIRMADA' : 'PARIDADE_DIVERGENTE';
  } catch (error) {
    result.codigo = local.signal.aborted ? (['DIAGNOSTICO_TIMEOUT', 'DIAGNOSTICO_RSS_EXCEDIDO'].includes(local.signal.reason?.code) ? local.signal.reason.code : 'DIAGNOSTICO_CANCELADO') :
      KNOWN.has(error?.code) ? error.code : 'DIAGNOSTICO_FALHOU';
    if (result.fase === 'validacao') result.validacao = 'RECUSADA';
  } finally {
    clearTimeout(timer); clearInterval(monitor); signal?.removeEventListener('abort', onAbort);
    try { oracleDb?.close(); } catch { result.limpeza = 'PENDENTE'; }
    try { sourceDb?.close(); } catch { result.limpeza = 'PENDENTE'; }
    try { await origin?.fechar(); } catch { result.limpeza = 'PENDENTE'; }
    try { await __testBeforeCleanup?.(); } catch { result.limpeza = 'PENDENTE'; result.codigo = 'DIAGNOSTICO_FALHOU'; }
    if (own) {
      let clean = result.limpeza !== 'PENDENTE';
      try {
        await unchanged([sourceChain, rootChain]);
        await assertOwnDirs(own);
        if (rootSt && !same(rootSt, await lstat(outputRoot, { bigint: true }))) fail('CAMINHO_ALTERADO');
      } catch { clean = false; result.codigo = 'CAMINHO_ALTERADO'; }
      if (clean) try { if (plan) { const receipt = await descartarPlanoV9(plan); if (receipt.limpezaPendente) clean = false; } } catch { clean = false; }
      if (clean) {
        for (const [file, identity] of [[`${own.copy}-wal`, own.oracleWalSt], [`${own.copy}-shm`, own.oracleShmSt], [own.copy, own.copySt],
          [`${own.input}-wal`, own.inputWalSt], [`${own.input}-shm`, own.inputShmSt], [own.input, own.inputSt], [own.package, own.packageSt]]) {
          if (!(await removeFile(file, identity))) clean = false;
        }
        for (const [dir, identity] of [[own.oracle, own.oracleSt], [own.work, own.workSt], [own.stage, own.stageSt]]) {
          if (!(await removeDir(dir, identity))) clean = false;
        }
      }
      result.limpeza = clean ? 'CONCLUIDA' : 'PENDENTE';
      if (!clean && result.codigo !== 'CAMINHO_ALTERADO') result.codigo = 'LIMPEZA_PENDENTE';
    }
    try {
      if (sourceChain && rootChain) {
        await unchanged([sourceChain, rootChain]);
        await checkpoint(source);
      }
    }
    catch { result.codigo = 'CAMINHO_ALTERADO'; }
    result.rssPicoBytes = Math.max(result.rssPicoBytes, process.memoryUsage().rss);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--output-root'].includes(args[i]) || !args[i + 1] || parsed[args[i]]) { parsed.invalid = true; break; }
    parsed[args[i]] = args[i + 1];
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  const result = parsed.invalid || args.length !== 4
    ? { codigo: 'CAMINHO_INVALIDO', fase: 'entrada', pacoteCriado: false, validacao: 'NAO_INICIADA', paridade: { eventos: null, conversas_app: null, tabelas: [] }, limpeza: 'NAO_NECESSARIA', rssPicoBytes: 0, pacoteEfemero: 'CHAVE_SOMENTE_EM_MEMORIA' }
    : await executarDiagnostico({ source: parsed['--source'], outputRoot: parsed['--output-root'], signal: controller.signal });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.codigo === 'PARIDADE_CONFIRMADA' ? 0 : 1;
}

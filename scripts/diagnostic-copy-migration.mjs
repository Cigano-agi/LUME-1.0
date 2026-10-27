#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve, isAbsolute, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, readdir, realpath, copyFile } from 'node:fs/promises';
import { DDL_V9 } from '../src/backup-acervo-schema-manifest-v9.js';

const SCRIPT = fileURLToPath(import.meta.url);
const APP_ROOT = resolve(dirname(SCRIPT), '..');
const CODES = new Set([
  'COPIA_PREPARADA', 'ARGUMENTOS_INVALIDOS', 'ORIGEM_INSEGURA', 'ORIGEM_OCUPADA',
  'ORIGEM_MUDOU', 'DESTINO_INSEGURO', 'COPIA_DIVERGENTE', 'SQLITE_INVALIDO',
  'SCHEMA_NAO_MAPEADO', 'SCHEMA_INCOMPLETO', 'G_POVOADA', 'MIGRACAO_ALTERARIA_DADOS',
  'DADOS_PREEXISTENTES_ALTERADOS', 'SEGUNDA_PASSAGEM_NAO_IDEMPOTENTE',
  'RECURSO_EXCEDIDO', 'TEMPO_ESGOTADO', 'CANCELADO', 'FALHA_INESPERADA',
]);
const PHASES = new Set(['validacao', 'copia', 'inventario', 'migracao1', 'migracao2', 'auditoria', 'fechamento']);
const RECEIPT_KEYS = ['codigo', 'fase', 'origemIntacta', 'tabelasOriginais', 'tabelasNovas', 'divergencias', 'dbFechado'];
const count = n => Number.isSafeInteger(n) && n >= 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));

export function validarRecibo03A20(value) {
  if (!exact(value, RECEIPT_KEYS) || !CODES.has(value.codigo) || !PHASES.has(value.fase) ||
      typeof value.origemIntacta !== 'boolean' || typeof value.dbFechado !== 'boolean' ||
      !count(value.tabelasOriginais) || !count(value.tabelasNovas) || !count(value.divergencias)) return false;
  if (value.codigo === 'COPIA_PREPARADA' && (value.fase !== 'fechamento' || !value.origemIntacta ||
      !value.dbFechado || value.divergencias !== 0)) return false;
  return true;
}

function decodeReceipt(chunks) {
  let value;
  try {
    const output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (!output.endsWith('\n') || output.slice(0, -1).includes('\n') || output.slice(0, -1).includes('\r')) return null;
    value = JSON.parse(output.trimEnd());
  } catch { return null; }
  return validarRecibo03A20(value) ? value : null;
}

function supervisorResult(codigo = 'RECIBO_INVALIDO') {
  return { codigo, codigoFilho: null, processo: { iniciado: false, fechamentoConfirmado: false, exitCode: null }, recibo: null };
}

/** Testável com filhos sintéticos; a CLI pública fixa comando e argumentos. */
export async function supervisionarFilho({ comando, argumentos = [], outputRoot, timeoutMs = 600_000,
  graceMs = 300, finalMs = 1_000, signal, spawnImpl = spawn, maxStdoutBytes = 256 * 1024,
  maxStderrBytes = 64 * 1024 } = {}) {
  const result = supervisorResult();
  if (typeof comando !== 'string' || !isAbsolute(comando) || typeof outputRoot !== 'string' ||
      !isAbsolute(outputRoot) || resolve(outputRoot) !== outputRoot || !Array.isArray(argumentos) ||
      !argumentos.every(x => typeof x === 'string') || ![timeoutMs, graceMs, finalMs, maxStdoutBytes, maxStderrBytes].every(count) ||
      timeoutMs === 0 || maxStdoutBytes === 0 || maxStderrBytes === 0) {
    result.codigo = 'ARGUMENTOS_INVALIDOS'; return result;
  }
  if (signal?.aborted) { result.codigo = 'CANCELADO'; return result; }
  const env = Object.fromEntries(['SystemRoot', 'WINDIR'].filter(k => typeof process.env[k] === 'string').map(k => [k, process.env[k]]));
  env.TEMP = outputRoot; env.TMP = outputRoot; env.TMPDIR = outputRoot;
  let child;
  try { child = spawnImpl(comando, argumentos, { shell: false, windowsHide: true,
    cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { result.codigo = 'FALHA_SPAWN'; return result; }
  result.processo.iniciado = true;
  const chunks = [];
  let stdoutBytes = 0, stderrBytes = 0, closed = false, reason = null, spawnError = false, settled = false;
  let watchdog, graceTimer, finalTimer;
  let finish;
  const completed = new Promise(resolveDone => { finish = resolveDone; });
  const settle = () => { if (!settled) { settled = true; finish(); } };
  const stop = code => {
    if (reason) return;
    reason = code;
    try { child.kill('SIGTERM'); } catch {}
    graceTimer = setTimeout(() => { if (!closed) { try { child.kill('SIGKILL'); } catch {} } }, graceMs);
    finalTimer = setTimeout(settle, graceMs + finalMs);
  };
  const onAbort = () => stop('CANCELADO');
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) stop('SAIDA_EXCEDIDA');
    else chunks.push(chunk);
  });
  child.stdout.on('error', () => stop('SAIDA_FALHOU'));
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > maxStderrBytes) stop('SAIDA_EXCEDIDA'); });
  child.stderr.on('error', () => stop('SAIDA_FALHOU'));
  child.on('error', () => { spawnError = true; stop('FALHA_SPAWN'); });
  child.on('close', (code, signalName) => {
    closed = true;
    result.processo.fechamentoConfirmado = true;
    result.processo.exitCode = code;
    result.processo.sinalizado = Boolean(signalName);
    settle();
  });
  watchdog = setTimeout(() => stop('TEMPO_ESGOTADO'), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  await completed;
  clearTimeout(watchdog); clearTimeout(graceTimer); clearTimeout(finalTimer);
  signal?.removeEventListener('abort', onAbort);
  if (!closed) { result.codigo = 'FECHAMENTO_NAO_CONFIRMADO'; return result; }
  if (spawnError) { result.codigo = 'FALHA_SPAWN'; return result; }
  if (reason) { result.codigo = reason; return result; }
  const receipt = decodeReceipt(chunks);
  if (result.processo.exitCode !== 0) {
    result.codigo = 'FILHO_EXIT_NAO_ZERO';
    result.codigoFilho = receipt?.codigo ?? null;
    result.recibo = receipt;
    return result;
  }
  if (!receipt || receipt.codigo !== 'COPIA_PREPARADA') return result;
  result.codigo = 'COPIA_PREPARADA';
  result.codigoFilho = receipt.codigo;
  result.recibo = receipt;
  return result;
}

function parseArgs(args) {
  if (args.length !== 4) return null;
  const values = {};
  for (let index = 0; index < 4; index += 2) {
    if (!['--source', '--output-root'].includes(args[index]) || values[args[index]] || !args[index + 1]) return null;
    values[args[index]] = args[index + 1];
  }
  const source = values['--source'], outputRoot = values['--output-root'];
  if (![source, outputRoot].every(x => typeof x === 'string' && isAbsolute(x) && resolve(x) === x)) return null;
  return { source, outputRoot };
}

const MiB = 1024 * 1024;
const RSS_BUDGET = 512 * MiB;
const MAX_CELL = 32 * MiB;
const q = name => `"${name.replaceAll('"', '""')}"`;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function budget() { if (process.memoryUsage().rss > RSS_BUDGET) fail('RECURSO_EXCEDIDO'); }
function sameStat(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
}
function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
async function statPath(path) {
  try { return await lstat(path, { bigint: true }); }
  catch { fail('ORIGEM_INSEGURA'); }
}
async function safeAncestry(path, lastType) {
  let current = resolve(path);
  for (;;) {
    const st = await statPath(current);
    if (st.isSymbolicLink() || (current === path && (lastType === 'file' ? !st.isFile() : !st.isDirectory())))
      fail(current === path && lastType === 'dir' ? 'DESTINO_INSEGURO' : 'ORIGEM_INSEGURA');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try { await realpath(path); } catch { fail(lastType === 'file' ? 'ORIGEM_INSEGURA' : 'DESTINO_INSEGURO'); }
}
async function noSourceSidecars(source) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(`${source}${suffix}`); fail('ORIGEM_OCUPADA'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: MiB })) { budget(); hash.update(chunk); }
  return hash.digest('hex');
}
async function sourceFingerprint(source) {
  await noSourceSidecars(source);
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) fail('ORIGEM_INSEGURA');
  const hash = await hashFile(source);
  const after = await lstat(source, { bigint: true });
  await noSourceSidecars(source);
  if (!sameStat(before, after)) fail('ORIGEM_MUDOU');
  return { stat: after, hash };
}
async function unchangedSource(source, original) {
  const now = await sourceFingerprint(source);
  if (!sameStat(original.stat, now.stat) || original.hash !== now.hash) fail('ORIGEM_MUDOU');
}
export async function capturarOrigemOffline(source) { return sourceFingerprint(source); }
export async function confirmarOrigemOffline(source, fingerprint) { return unchangedSource(source, fingerprint); }
async function validatePaths(source, outputRoot) {
  await safeAncestry(source, 'file');
  const sourceSt = await lstat(source, { bigint: true });
  if (sourceSt.nlink !== 1n) fail('ORIGEM_INSEGURA');
  try { await safeAncestry(outputRoot, 'dir'); }
  catch (error) { if (error.code === 'ORIGEM_INSEGURA') fail('DESTINO_INSEGURO'); throw error; }
  if (inside(source, outputRoot) || inside(outputRoot, source)) fail('DESTINO_INSEGURO');
  if ((await readdir(outputRoot)).length !== 0) fail('DESTINO_INSEGURO');
}

function frame(hash, tag, payload = Buffer.alloc(0)) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (bytes.length > MAX_CELL) fail('RECURSO_EXCEDIDO');
  const header = Buffer.allocUnsafe(9);
  header.writeUInt8(tag.charCodeAt(0), 0);
  header.writeBigUInt64BE(BigInt(bytes.length), 1);
  hash.update(header); hash.update(bytes);
}
function typedFrame(hash, value) {
  if (value === null) return frame(hash, 'n');
  if (typeof value === 'bigint') return frame(hash, 'i', Buffer.from(value.toString()));
  if (typeof value === 'number' && Number.isFinite(value)) {
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value); return frame(hash, 'r', bytes);
  }
  if (typeof value === 'string') return frame(hash, 't', Buffer.from(value, 'utf8'));
  if (value instanceof Uint8Array) return frame(hash, 'b', value);
  fail('SQLITE_INVALIDO');
}
async function summarizeTable(db, table, original = null) {
  const schema = db.prepare(`PRAGMA table_info(${q(table)})`).all();
  const actualPk = schema.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  const columns = original?.columns ?? schema.map(c => c.name);
  const pk = original?.pk ?? actualPk;
  const declaredTypes = columns.map(name => schema.find(c => c.name === name)?.type);
  if (original && (pk.length !== actualPk.length || pk.some((name, i) => name !== actualPk[i]) ||
      declaredTypes.some((type, i) => type === undefined || type !== original.declaredTypes[i])))
    fail('DADOS_PREEXISTENTES_ALTERADOS');
  if (columns.length === 0) fail('SCHEMA_NAO_MAPEADO');
  const hash = createHash('sha256');
  frame(hash, 'd', 'LUME_03A20_TYPED_ROWS_V1');
  frame(hash, 'T', table);
  for (const [i, name] of columns.entries()) { frame(hash, 'C', name); frame(hash, 'D', declaredTypes[i]); }
  for (const name of pk) frame(hash, 'P', name);
  const ordering = pk.length ? pk.map(q) : columns.flatMap(name => [
    `typeof(${q(name)}) COLLATE BINARY`, `${q(name)} COLLATE BINARY`,
  ]);
  const query = `SELECT ${columns.map(q).join(',')} FROM ${q(table)} ORDER BY ${ordering.join(',')}`;
  const stmt = db.prepare(query); stmt.setReadBigInts(true);
  let rows = 0;
  for (const row of stmt.iterate()) {
    frame(hash, 'R');
    for (const name of pk) typedFrame(hash, row[name]);
    for (const name of columns) typedFrame(hash, row[name]);
    rows++;
    if (!count(rows)) fail('RECURSO_EXCEDIDO');
    if (rows % 1024 === 0) { budget(); await new Promise(setImmediate); }
  }
  budget();
  return { columns, pk, declaredTypes, rows, hash: hash.digest('hex') };
}

// Superfície mínima para provar o digest com SQLite sintético.
export async function resumirTabelaDiagnostica(db, table, original = null) {
  return summarizeTable(db, table, original);
}

const FILA_DDL = Object.freeze({
  wa_fila_retomada: ['table', 'wa_fila_retomada', [
    'CREATE TABLE wa_fila_retomada (',
    '        interrupcao_id TEXT NOT NULL REFERENCES wa_interrupcoes(id) ON DELETE CASCADE,',
    '        conversa_id TEXT NOT NULL, estado TEXT NOT NULL,',
    '        tentativas INTEGER NOT NULL DEFAULT 0, proxima_tentativa_em TEXT,',
    '        ultimo_erro TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL,',
    '        PRIMARY KEY(interrupcao_id,conversa_id))',
  ].join('\n')],
  wa_fila_retomada_ordem: ['index', 'wa_fila_retomada',
    'CREATE INDEX wa_fila_retomada_ordem ON wa_fila_retomada(estado,proxima_tentativa_em,criado_em)'],
  wa_fila_retomada_removida: ['trigger', 'eventos', [
    'CREATE TRIGGER wa_fila_retomada_removida AFTER DELETE ON eventos BEGIN',
    '        DELETE FROM wa_fila_retomada WHERE conversa_id=old.conversa_id',
    '          AND NOT EXISTS(SELECT 1 FROM eventos WHERE conversa_id=old.conversa_id);',
    '      END',
  ].join('\n')],
});

export function validarFilaDiagnostica(db) {
  for (const [name, [type, table, sql]] of Object.entries(FILA_DDL)) {
    const rows = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name=? COLLATE NOCASE').all(name);
    if (rows.length !== 1 || rows[0].type !== type || rows[0].name !== name ||
        rows[0].tbl_name !== table || rows[0].sql?.trim() !== sql) fail('SCHEMA_NAO_MAPEADO');
  }
  const table = db.prepare('PRAGMA table_list').all().find(row => row.schema === 'main' && row.name === 'wa_fila_retomada');
  if (table?.type !== 'table' || table.ncol !== 8 || table.wr !== 0 || table.strict !== 0) fail('SCHEMA_NAO_MAPEADO');
  const expected = [
    ['interrupcao_id', 'TEXT', 1, null, 1, 0],
    ['conversa_id', 'TEXT', 1, null, 2, 0],
    ['estado', 'TEXT', 1, null, 0, 0],
    ['tentativas', 'INTEGER', 1, '0', 0, 0],
    ['proxima_tentativa_em', 'TEXT', 0, null, 0, 0],
    ['ultimo_erro', 'TEXT', 0, null, 0, 0],
    ['criado_em', 'TEXT', 1, null, 0, 0],
    ['atualizado_em', 'TEXT', 1, null, 0, 0],
  ];
  const actual = db.prepare('PRAGMA table_xinfo(wa_fila_retomada)').all()
    .map(c => [c.name, c.type, c.notnull, c.dflt_value, c.pk, c.hidden]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('SCHEMA_NAO_MAPEADO');
  const fk = db.prepare('PRAGMA foreign_key_list(wa_fila_retomada)').all();
  if (fk.length !== 1 || fk[0].table !== 'wa_interrupcoes' ||
      fk[0].from !== 'interrupcao_id' || fk[0].to !== 'id' ||
      fk[0].on_update !== 'NO ACTION' || fk[0].on_delete !== 'CASCADE' ||
      fk[0].match !== 'NONE') fail('SCHEMA_NAO_MAPEADO');
  const indexes = db.prepare('PRAGMA index_list(wa_fila_retomada)').all()
    .map(row => [row.name, row.unique, row.origin, row.partial]).sort((a, b) => a[0].localeCompare(b[0]));
  if (JSON.stringify(indexes) !== JSON.stringify([
    ['sqlite_autoindex_wa_fila_retomada_1', 1, 'pk', 0],
    ['wa_fila_retomada_ordem', 0, 'c', 0],
  ])) fail('SCHEMA_NAO_MAPEADO');
  const indexColumns = [
    ['sqlite_autoindex_wa_fila_retomada_1', [
      [0, 0, 'interrupcao_id', 0, 'BINARY', 1],
      [1, 1, 'conversa_id', 0, 'BINARY', 1],
      [2, -1, null, 0, 'BINARY', 0],
    ]],
    ['wa_fila_retomada_ordem', [
      [0, 2, 'estado', 0, 'BINARY', 1],
      [1, 4, 'proxima_tentativa_em', 0, 'BINARY', 1],
      [2, 6, 'criado_em', 0, 'BINARY', 1],
      [3, -1, null, 0, 'BINARY', 0],
    ]],
  ];
  for (const [name, expectedColumns] of indexColumns) {
    const actualColumns = db.prepare(`PRAGMA index_xinfo(${name})`).all()
      .map(row => [row.seqno, row.cid, row.name, row.desc, row.coll, row.key]);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) fail('SCHEMA_NAO_MAPEADO');
  }
  if (db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='wa_fila_retomada' LIMIT 1").get())
    fail('SCHEMA_NAO_MAPEADO');
  if (db.prepare('SELECT 1 FROM wa_fila_retomada LIMIT 1').get()) fail('MIGRACAO_ALTERARIA_DADOS');
  return true;
}

async function inventory(db, catalog, original = null, expectFila = false) {
  const known = new Map(catalog.map(item => [item.nome, item]));
  const existing = new Set();
  if (!original) {
    for (const name of Object.keys(FILA_DDL)) {
      if (db.prepare('SELECT 1 FROM main.sqlite_schema WHERE name=? COLLATE NOCASE LIMIT 1').get(name))
        fail('SCHEMA_NAO_MAPEADO');
    }
  }
  let filaMigrada = false;
  for (const entry of db.prepare('PRAGMA table_list').iterate()) {
    if (entry.schema !== 'main') continue;
    if (entry.name.startsWith('sqlite_')) continue;
    if (DDL_V9.auxiliares[entry.name]?.[0] === entry.type) continue;
    // O migrador atual cria esta fila depois do inventário v9 inicial. Ela não
    // pertence ao catálogo congelado e só pode existir vazia na cópia migrada.
    if (entry.name === 'wa_fila_retomada' && original) {
      if (entry.type !== 'table') fail('SCHEMA_NAO_MAPEADO');
      validarFilaDiagnostica(db);
      filaMigrada = true;
      continue;
    }
    if (!known.has(entry.name) || entry.type !== 'table') fail('SCHEMA_NAO_MAPEADO');
    existing.add(entry.name);
  }
  if (expectFila && !filaMigrada) fail('SCHEMA_NAO_MAPEADO');
  const result = new Map();
  for (const item of catalog) {
    if (!existing.has(item.nome)) continue;
    const prior = original?.get(item.nome) ?? null;
    const summary = await summarizeTable(db, item.nome, prior);
    if (item.decisao === 'I' && summary.columns.length === item.colunas.length &&
        item.colunas.every(name => summary.columns.includes(name)) &&
        (summary.pk.length !== item.pk.length || summary.pk.some((name, i) => name !== item.pk[i])))
      fail('SCHEMA_NAO_MAPEADO');
    result.set(item.nome, summary);
  }
  if (original) {
    for (const [name, before] of original) {
      const after = result.get(name);
      if (!after || before.rows !== after.rows || before.hash !== after.hash) fail('DADOS_PREEXISTENTES_ALTERADOS');
    }
  }
  return result;
}
export async function conferirSegundaPassagem(db, catalog, afterFirst, expectFila = false) {
  try { return await inventory(db, catalog, afterFirst, expectFila); }
  catch (error) {
    if (error.code === 'DADOS_PREEXISTENTES_ALTERADOS') fail('SEGUNDA_PASSAGEM_NAO_IDEMPOTENTE');
    throw error;
  }
}

function verifyDb(db) {
  const rows = [...db.prepare('PRAGMA integrity_check').iterate()];
  if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') fail('SQLITE_INVALIDO');
  if (db.prepare('PRAGMA foreign_key_check').get()) fail('SQLITE_INVALIDO');
}

async function migratePass(dest, outputRoot, receipt, verifyTarget) {
  const { abrirBanco } = await import('../src/banco.js');
  const { ContextoApp } = await import('../src/contexto-app.js');
  const { Desktop } = await import('../src/desktop.js');
  const { DesktopIA } = await import('../src/desktop-ia.js');
  const { Semantica } = await import('../src/semantica.js');
  const { ColetorCaixas } = await import('../src/caixas.js');
  const { prepararEsquemaInventario } = await import('../src/inventario.js');
  const { prepararEsquemaTranscricao } = await import('../src/transcricao.js');
  const { prepararMetadadosAudio } = await import('../src/audio-desktop-arquivos.js');
  const { prepararEsquemaFinanceiro } = await import('../src/financeiro.js');
  const { prepararEsquemaRascunho } = await import('../src/rascunho.js');
  const { prepararEsquemaPrecisao } = await import('../src/precisao.js');
  const { prepararWhatsAppLabels } = await import('../src/whatsapp-labels.js');
  const { prepararAcoesLume } = await import('../src/acoes-lume.js');
  const { prepararExecucoes } = await import('../src/execucao/esquema.js');
  const { prepararHistoricoWhatsApp } = await import('../src/transporte/historico.js');
  const { prepararVendasJev } = await import('../src/vendas/servico.js');
  const { prepararProjetosComerciais } = await import('../src/projetos-comerciais/esquema.js');
  const { prepararProcedenciaCiclo } = await import('../src/privacidade.js');
  const { FilaLaya } = await import('../src/laya/fila.js');
  await verifyTarget();
  const db = abrirBanco(dest);
  try {
    new ContextoApp(db); new Desktop(db);
    new DesktopIA(db, { gerar: async () => { throw new Error('indisponível'); },
      segredos: { estado: async () => ({ disponivel: false, configurada: false }), ler: async () => { throw new Error('indisponível'); } } });
    new Semantica(db, { extrair: async () => [] });
    new ColetorCaixas(db, { diretorioBase: join(outputRoot, 'caixas-descartaveis'),
      baixarMidia: async () => { throw new Error('indisponível'); } });
    prepararEsquemaInventario(db); prepararEsquemaTranscricao(db); prepararMetadadosAudio(db);
    prepararEsquemaFinanceiro(db); prepararEsquemaRascunho(db); prepararEsquemaPrecisao(db);
    prepararWhatsAppLabels(db); prepararAcoesLume(db); prepararExecucoes(db);
    prepararHistoricoWhatsApp(db); prepararVendasJev(db); prepararProjetosComerciais(db);
    prepararProcedenciaCiclo(db);
    new FilaLaya(db, { laya: { classificar: async () => ({}), status: () => ({}) } });
    db.exec('PRAGMA foreign_keys=ON');
    budget();
  } finally { try { db.close(); } catch { receipt.dbFechado = false; fail('SQLITE_INVALIDO'); } }
}

/** O filho devolve somente metadados; source jamais é entregue ao SQLite. */
export async function prepararCopiaDiagnostica({ source, outputRoot } = {}) {
  const receipt = { codigo: 'FALHA_INESPERADA', fase: 'validacao', origemIntacta: false,
    tabelasOriginais: 0, tabelasNovas: 0, divergencias: 0, dbFechado: true };
  if (typeof source !== 'string' || typeof outputRoot !== 'string' || !isAbsolute(source) ||
      !isAbsolute(outputRoot) || resolve(source) !== source || resolve(outputRoot) !== outputRoot) {
    receipt.codigo = 'ARGUMENTOS_INVALIDOS'; return receipt;
  }
  const dest = join(outputRoot, 'prepared.sqlite');
  let original = null;
  let rootIdentity = null, copyIdentity = null;
  let DatabaseSync, CATALOGO_V9;
  async function verifyTarget() {
    try {
      await safeAncestry(outputRoot, 'dir');
      const root = await lstat(outputRoot, { bigint: true });
      const copy = await lstat(dest, { bigint: true });
      if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== rootIdentity.dev || root.ino !== rootIdentity.ino ||
          !copy.isFile() || copy.isSymbolicLink() || copy.nlink !== 1n ||
          copy.dev !== copyIdentity.dev || copy.ino !== copyIdentity.ino) fail('DESTINO_INSEGURO');
    } catch { fail('DESTINO_INSEGURO'); }
  }
  async function readCopy(work) {
    let db;
    try { await verifyTarget(); db = new DatabaseSync(dest, { readOnly: true }); return await work(db); }
    finally { if (db) { try { db.close(); } catch { receipt.dbFechado = false; fail('SQLITE_INVALIDO'); } } }
  }
  async function finishOfflineCopy() {
    await verifyTarget();
    let db;
    try {
      db = new DatabaseSync(dest);
      const mode = db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode;
      if (mode !== 'delete') fail('SQLITE_INVALIDO');
    } finally {
      if (db) { try { db.close(); } catch { receipt.dbFechado = false; fail('SQLITE_INVALIDO'); } }
    }
    for (const suffix of ['-wal', '-shm']) {
      try { await lstat(`${dest}${suffix}`); fail('SQLITE_INVALIDO'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
    ({ CATALOGO_V9 } = await import('../src/backup-acervo-catalogo.js'));
    await validatePaths(source, outputRoot);
    rootIdentity = await lstat(outputRoot, { bigint: true });
    original = await sourceFingerprint(source);
    receipt.origemIntacta = true;
    receipt.fase = 'copia';
    await copyFile(source, dest, constants.COPYFILE_EXCL);
    const copyStat = await lstat(dest, { bigint: true });
    if (!copyStat.isFile() || copyStat.isSymbolicLink() || copyStat.nlink !== 1n) fail('DESTINO_INSEGURO');
    copyIdentity = copyStat;
    if ((await hashFile(dest)) !== original.hash) fail('COPIA_DIVERGENTE');
    await unchangedSource(source, original);
    receipt.fase = 'inventario';
    const before = await readCopy(async db => {
      verifyDb(db);
      const rows = await inventory(db, CATALOGO_V9);
      if (rows.has('lume_laya_fila')) {
        const changed = db.prepare("SELECT COUNT(*) n FROM lume_laya_fila WHERE estado='analisando'").get().n;
        if (changed > 0) { receipt.divergencias = Number(changed); fail('MIGRACAO_ALTERARIA_DADOS'); }
      }
      return rows;
    });
    receipt.tabelasOriginais = before.size;
    receipt.fase = 'migracao1';
    await migratePass(dest, outputRoot, receipt, verifyTarget);
    const afterFirst = await readCopy(async db => { verifyDb(db); return inventory(db, CATALOGO_V9, before, true); });
    receipt.tabelasNovas = afterFirst.size - before.size;
    receipt.fase = 'migracao2';
    await migratePass(dest, outputRoot, receipt, verifyTarget);
    await readCopy(async db => {
      verifyDb(db);
      await inventory(db, CATALOGO_V9, before, true);
      await conferirSegundaPassagem(db, CATALOGO_V9, afterFirst, true);
    });
    receipt.fase = 'auditoria';
    await readCopy(async db => {
      const { auditarEsquemaRestoreV9 } = await import('../src/backup-acervo-schema-v9.js');
      auditarEsquemaRestoreV9(db);
      for (const item of CATALOGO_V9.filter(row => row.decisao === 'G')) {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(item.nome) &&
            db.prepare(`SELECT 1 FROM ${q(item.nome)} LIMIT 1`).get()) fail('G_POVOADA');
      }
    });
    receipt.fase = 'fechamento';
    await finishOfflineCopy();
    await unchangedSource(source, original);
    receipt.codigo = 'COPIA_PREPARADA';
  } catch (error) {
    receipt.codigo = CODES.has(error?.code) ? error.code :
      ['PK_DIVERGENTE', 'FK_DIVERGENTE', 'UNIQUE_DIVERGENTE'].includes(error?.code)
        ? 'SCHEMA_NAO_MAPEADO' : 'FALHA_INESPERADA';
  } finally {
    if (original) {
      try { await unchangedSource(source, original); receipt.origemIntacta = true; }
      catch { receipt.origemIntacta = false; receipt.codigo = 'ORIGEM_MUDOU'; }
    }
  }
  if (!receipt.dbFechado && receipt.codigo === 'COPIA_PREPARADA') receipt.codigo = 'SQLITE_INVALIDO';
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  const internal = process.argv[2] === '--internal-worker';
  const args = parseArgs(process.argv.slice(internal ? 3 : 2));
  if (!args) {
    process.stdout.write(`${JSON.stringify({ codigo: 'ARGUMENTOS_INVALIDOS' })}\n`);
    process.exitCode = 1;
  } else if (internal) {
    let receipt;
    try { receipt = await prepararCopiaDiagnostica(args); }
    catch { receipt = { codigo: 'FALHA_INESPERADA', fase: 'validacao', origemIntacta: false,
      tabelasOriginais: 0, tabelasNovas: 0, divergencias: 0, dbFechado: false }; }
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = receipt.codigo === 'COPIA_PREPARADA' ? 0 : 1;
  } else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    const result = await supervisionarFilho({ comando: process.execPath,
      argumentos: [SCRIPT, '--internal-worker', '--source', args.source, '--output-root', args.outputRoot],
      outputRoot: args.outputRoot, signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.codigo === 'COPIA_PREPARADA' ? 0 : 1;
  }
}

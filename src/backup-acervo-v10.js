import { createHash } from 'node:crypto';
import {exigirPessoalSemConteudo,TABELAS_PESSOAIS} from './pessoal/preservacao.js';
import { DatabaseSync } from 'node:sqlite';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { criarSnapshot } from './backup-snapshot.js';
import { criarTempBackupPrivado } from './backup-private-temp.js';
import { codificarAcervoV10 } from './backup-acervo-codec.js';
import { CATALOGO_V10, CATALOGO_SHA256_V10, TABELAS_I_V10 } from './backup-acervo-catalogo-v10.js';
import { inventariarAnexosV10, quadrosAnexoV10 } from './backup-anexos-v10.js';

const MiB = 1024 * 1024;
const MAX_ROW = 4 * MiB;
const FTS_SHADOWS = new Set(['desktop_fontes_fts', 'desktop_fontes_fts_data', 'desktop_fontes_fts_idx', 'desktop_fontes_fts_content', 'desktop_fontes_fts_docsize', 'desktop_fontes_fts_config']);
const quoted = s => `"${s.replaceAll('"', '""')}"`;
const digest = b => createHash('sha256').update(b).digest('hex');
const frame = (cabecalho, payload = Buffer.alloc(0)) => ({ cabecalho, payload });

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function abort(signal) { if (signal?.aborted) { const error = new Error('Exportação cancelada'); error.name = 'AbortError'; throw error; } }
function typed(value) {
  if (value === null) return ['n'];
  if (typeof value === 'bigint') return ['i', value.toString()];
  if (typeof value === 'number' && Number.isFinite(value)) return ['r', value];
  if (typeof value === 'string' && value.isWellFormed()) return ['t', value];
  if (value instanceof Uint8Array) return ['b', Buffer.from(value).toString('base64')];
  fail('VALOR_SQL_INVALIDO', 'Valor SQLite sem representação v10');
}

function validateSchema(db,controleModule) {
  exigirPessoalSemConteudo(db);
  const controle=controleModule?.validarControleExclusao(db);
  if (controle?.ativo) fail('EXCLUSAO_ATIVA', 'Exclusão de conteúdo em andamento');
  const known = new Set(CATALOGO_V10.map(t => t.nome));
  for(const name of TABELAS_PESSOAIS)known.add(name);
  const tableTypes = new Map();
  for (const row of db.prepare('PRAGMA table_list').iterate()) if (row.schema === 'main') tableTypes.set(row.name, row.type);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").iterate()) {
    const fts = FTS_SHADOWS.has(row.name) &&
      (row.name === 'desktop_fontes_fts' ? tableTypes.get(row.name) === 'virtual' : tableTypes.get(row.name) === 'shadow');
    if (!known.has(row.name) && !fts && !controleModule?.NOMES_OBJETOS_CONTROLE_EXCLUSAO.includes(row.name))
      fail('SCHEMA_NAO_MAPEADO', `Tabela não mapeada: ${row.name}`);
  }
  for (const table of CATALOGO_V10) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.nome);
    if (!exists) { if (table.decisao === 'I' && table.nome !== 'ciclo_midias') fail('SCHEMA_INCOMPLETO', `Tabela I ausente: ${table.nome}`); continue; }
    if (table.decisao === 'X') continue;
    const columns = db.prepare(`PRAGMA table_info(${quoted(table.nome)})`).all();
    const nomes = new Set(columns.map(c => c.name));
    if (columns.length !== table.colunas.length || nomes.size !== table.colunas.length ||
        table.colunas.some(nome => !nomes.has(nome))) {
      fail('SCHEMA_NAO_MAPEADO', `Colunas divergentes: ${table.nome}`);
    }
    if (table.decisao === 'G') {
      if (db.prepare(`SELECT 1 FROM ${quoted(table.nome)} LIMIT 1`).get()) fail('TABELA_G_POVOADA', `Tabela G povoada: ${table.nome}`);
      continue;
    }
    const pk = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    if (pk.length !== table.pk.length || pk.some((name, i) => name !== table.pk[i])) fail('PK_DIVERGENTE', `PK divergente: ${table.nome}`);
  }
}

/** Origem SQLite v10; não aplica perfil nem publica pacote. */
export async function criarOrigemV10({ dbPath, arquivos, perfil, signal } = {}) {
  abort(signal);
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath)) fail('FONTE_INVALIDA', 'dbPath absoluto obrigatório');
  const sourceStat = await lstat(dbPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail('FONTE_INVALIDA', 'Fonte deve ser arquivo regular sem link');
  if (arquivos !== undefined && !Array.isArray(arquivos)) fail('ANEXO_INVENTARIO_INVALIDO', 'Inventário de anexos inválido');
  if (!perfil || Object.getPrototypeOf(perfil) !== Object.prototype) fail('PERFIL_INVALIDO', 'Perfil exige apenas dono de 0 a 80 caracteres Unicode');
  // A 0.7 ainda é um checkout separado em andamento. Se seu controle existir,
  // valide-o integralmente; sem o módulo, qualquer tabela extra falha fechada.
  let controleModule;
  try { controleModule=await import('./notetaker/exclusao-controle.js'); }
  catch(error){ if(error?.code!=='ERR_MODULE_NOT_FOUND')throw error; }
  const descriptors = Object.getOwnPropertyDescriptors(perfil);
  const descriptor = descriptors.dono;
  const owner = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  if (Reflect.ownKeys(descriptors).length !== 1 || typeof owner !== 'string' || !owner.isWellFormed() ||
      [...owner].length > 80 || owner.includes('\0')) {
    fail('PERFIL_INVALIDO', 'Perfil exige apenas dono de 0 a 80 caracteres Unicode');
  }
  let preflight;
  try {
    preflight = new DatabaseSync(dbPath, { readOnly: true });
    validateSchema(preflight,controleModule);
  } finally { preflight?.close(); }
  const dir = await criarTempBackupPrivado('lume-acervo-v10-');
  let db;
  let closed = false;
  const fechar = async () => {
    if (closed) return;
    closed = true;
    try { db?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  };
  try {
    const snapPath = path.join(dir, 'snapshot.sqlite');
    await criarSnapshot({ caminhoOrigem: dbPath, caminhoDestino: snapPath, gerarManifesto: false });
    abort(signal);
    db = new DatabaseSync(snapPath, { readOnly: true });
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') fail('INTEGRIDADE_FALHOU', 'Snapshot SQLite inválido');
    validateSchema(db,controleModule);
    const anexos = await inventariarAnexosV10(db, { dbPath, arquivos, signal });
    const anexoPorCaminho = new Map(anexos.map(a => [process.platform === 'win32' ? a.caminho.toLowerCase() : a.caminho, a]));
    let used = false;
    async function* frames() {
      abort(signal);
      yield frame({ tipo: 'inicio', versao: 10, catalogoSha256: CATALOGO_SHA256_V10, criadoEm: new Date().toISOString(), dono: owner });
      for (const [indice, table] of TABELAS_I_V10.entries()) {
        abort(signal);
        yield frame({ tipo: 'tabela', indice, nome: table.nome });
        const rowHash = createHash('sha256');
        let linhas = 0;
        if(table.nome==='ciclo_midias'&&!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ciclo_midias'").get()){
          yield frame({ tipo: 'fimTabela', linhas: 0, sha256: rowHash.digest('hex') });
          continue;
        }
        const sql = `SELECT ${table.colunas.map(quoted).join(',')} FROM ${quoted(table.nome)} ORDER BY ${table.pk.map(quoted).join(',')}`;
        const statement = db.prepare(sql);
        statement.setReadBigInts(true);
        for (const row of statement.iterate()) {
          abort(signal);
          const values = table.colunas.map(c => {
            if ((table.nome === 'transcricoes' && c === 'arquivo') ||
                (table.nome === 'notetaker_partes' && c === 'caminho') ||
                (table.nome === 'ciclo_midias' && c === 'caminho')) {
              if (typeof row[c] === 'string' && row[c]) {
                const anexo = anexoPorCaminho.get(process.platform === 'win32' ? row[c].toLowerCase() : row[c]);
                if (!anexo) fail('ANEXO_INVENTARIO_DIVERGENTE');
                return typed(`anexo:${anexo.id}`);
              }
            }
            return typed(row[c]);
          });
          const pkValues = table.pk.map(c => typed(row[c]));
          if (pkValues.some(v => v[0] === 'n')) fail('PK_INVALIDA', `PK nula: ${table.nome}`);
          const payload = Buffer.from(JSON.stringify({ v: values }), 'utf8');
          if (payload.length > MAX_ROW) fail('ROW_MAIOR_4MIB', `Row maior que 4 MiB: ${table.nome}`);
          linhas++;
          const length = Buffer.allocUnsafe(4); length.writeUInt32BE(payload.length);
          rowHash.update(length).update(payload);
          const chave = `${String(linhas).padStart(10, '0')}:${digest(JSON.stringify(pkValues))}`;
          yield frame({ tipo: 'row', chave }, payload);
        }
        yield frame({ tipo: 'fimTabela', linhas, sha256: rowHash.digest('hex') });
      }
      for (const anexo of anexos) for await (const part of quadrosAnexoV10(anexo, { signal })) yield part;
    }
    const origem = (async function* () {
      if (used || closed) fail('ORIGEM_FECHADA', 'Origem v10 já consumida ou fechada');
      used = true;
      try { for await (const part of codificarAcervoV10(frames(), { signal })) yield part; }
      finally { await fechar(); }
    })();
    return { origem, fechar, resumo: Object.freeze({ catalogoSha256: CATALOGO_SHA256_V10, tabelas: TABELAS_I_V10.length, anexos: anexos.length }) };
  } catch (error) { await fechar(); throw error; }
}

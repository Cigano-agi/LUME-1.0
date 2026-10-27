import { createHash } from 'node:crypto';
import {exigirPessoalSemConteudo,TABELAS_PESSOAIS} from './pessoal/preservacao.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { criarSnapshot } from './backup-snapshot.js';
import { codificarAcervoV9 } from './backup-acervo-codec.js';
import { CATALOGO_V9, CATALOGO_SHA256_V9, TABELAS_I_V9 } from './backup-acervo-catalogo.js';
import { NOMES_OBJETOS_CONTROLE_EXCLUSAO, validarControleExclusao } from './notetaker/exclusao-controle.js';

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
  fail('VALOR_SQL_INVALIDO', 'Valor SQLite sem representação v9');
}

function validateSchema(db) {
  exigirPessoalSemConteudo(db);
  const controle = validarControleExclusao(db);
  if (controle.ativo) fail('EXCLUSAO_ATIVA', 'Exclusão de conteúdo em andamento');
  const known = new Set(CATALOGO_V9.map(t => t.nome));
  for(const name of TABELAS_PESSOAIS)known.add(name);
  known.add('wa_fila_retomada'); // Extensao local posterior ao hash v9; jobs exigem v10.
  const tableTypes = new Map();
  for (const row of db.prepare('PRAGMA table_list').iterate()) if (row.schema === 'main') tableTypes.set(row.name, row.type);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").iterate()) {
    const fts = FTS_SHADOWS.has(row.name) &&
      (row.name === 'desktop_fontes_fts' ? tableTypes.get(row.name) === 'virtual' : tableTypes.get(row.name) === 'shadow');
    if (!known.has(row.name) && !fts && !NOMES_OBJETOS_CONTROLE_EXCLUSAO.includes(row.name))
      fail('SCHEMA_NAO_MAPEADO', `Tabela não mapeada: ${row.name}`);
  }
  for (const table of CATALOGO_V9) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.nome);
    if (!exists) { if (table.decisao === 'I') fail('SCHEMA_INCOMPLETO', `Tabela I ausente: ${table.nome}`); continue; }
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
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wa_fila_retomada'").get()){
    const cols=db.prepare('PRAGMA table_info(wa_fila_retomada)').all();
    if(cols.map(c=>c.name).join(',')!=='interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em'||
      cols.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name).join(',')!=='interrupcao_id,conversa_id')
      fail('SCHEMA_NAO_MAPEADO','Fila de retomada incompatível');
    const fk=db.prepare('PRAGMA foreign_key_list(wa_fila_retomada)').all();
    if(fk.length!==1||fk[0].table!=='wa_interrupcoes'||fk[0].from!=='interrupcao_id'||fk[0].to!=='id'||fk[0].on_delete!=='CASCADE')
      fail('SCHEMA_NAO_MAPEADO','Fila de retomada incompatível');
    if(db.prepare('SELECT 1 FROM wa_fila_retomada LIMIT 1').get())
      fail('USE_BACKUP_V10','A fila de recuperação contém trabalho; use backup v10 para preservá-lo.');
  }
  if (db.prepare("SELECT 1 FROM transcricoes WHERE arquivo IS NOT NULL AND arquivo <> '' LIMIT 1").get() ||
      db.prepare('SELECT 1 FROM notetaker_partes LIMIT 1').get()) {
    fail('ANEXOS_SEM_LOCK', 'Anexos presentes exigem lock, posse de raiz e inventário completos');
  }
}

/** Origem SQLite v9 sem anexos; não aplica perfil nem publica pacote. */
export async function criarOrigemV9({ dbPath, arquivos, perfil, signal } = {}) {
  abort(signal);
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath)) fail('FONTE_INVALIDA', 'dbPath absoluto obrigatório');
  const sourceStat = await lstat(dbPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) fail('FONTE_INVALIDA', 'Fonte deve ser arquivo regular sem link');
  if (arquivos !== undefined && (!Array.isArray(arquivos) || arquivos.length !== 0)) fail('ANEXOS_SEM_LOCK', 'Anexos não podem ser exportados nesta fatia');
  if (!perfil || Object.getPrototypeOf(perfil) !== Object.prototype) fail('PERFIL_INVALIDO', 'Perfil exige apenas dono de 0 a 80 caracteres Unicode');
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
    validateSchema(preflight);
  } finally { preflight?.close(); }
  const dir = await mkdtemp(path.join(tmpdir(), 'lume-acervo-v9-'));
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
    validateSchema(db);
    let used = false;
    async function* frames() {
      abort(signal);
      yield frame({ tipo: 'inicio', versao: 9, catalogoSha256: CATALOGO_SHA256_V9, criadoEm: new Date().toISOString(), dono: owner });
      for (const [indice, table] of TABELAS_I_V9.entries()) {
        abort(signal);
        yield frame({ tipo: 'tabela', indice, nome: table.nome });
        const rowHash = createHash('sha256');
        let linhas = 0;
        const sql = `SELECT ${table.colunas.map(quoted).join(',')} FROM ${quoted(table.nome)} ORDER BY ${table.pk.map(quoted).join(',')}`;
        const statement = db.prepare(sql);
        statement.setReadBigInts(true);
        for (const row of statement.iterate()) {
          abort(signal);
          const values = table.colunas.map(c => typed(row[c]));
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
    }
    const origem = (async function* () {
      if (used || closed) fail('ORIGEM_FECHADA', 'Origem v9 já consumida ou fechada');
      used = true;
      try { for await (const part of codificarAcervoV9(frames(), { signal })) yield part; }
      finally { await fechar(); }
    })();
    return { origem, fechar, resumo: Object.freeze({ catalogoSha256: CATALOGO_SHA256_V9, tabelas: TABELAS_I_V9.length, anexos: 0 }) };
  } catch (error) { await fechar(); throw error; }
}

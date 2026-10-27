import { createHash } from 'node:crypto';

const fail = message => { throw Object.assign(new Error(message), { code: 'INTEGRIDADE' }); };
const q = name => `"${String(name).replaceAll('"', '""')}"`;

export const CONTROLE_EXCLUSAO = Object.freeze({
  schemaVersion: 1,
  tabelaControle: 'notetaker_exclusao_controle_v1',
  tabelaRecibos: 'notetaker_exclusao_recibos_v1',
  indicePendente: 'notetaker_exclusao_uma_pendente_v1'
});

const TABLE_CONTROL = `CREATE TABLE notetaker_exclusao_controle_v1 (
  op_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1),
  sessao_id TEXT NOT NULL, perfil_id TEXT NOT NULL, db_dev TEXT NOT NULL, db_ino TEXT NOT NULL,
  selecao_assinatura TEXT NOT NULL, schema_assinatura TEXT NOT NULL,
  digest_sql_antes TEXT NOT NULL, manifesto_json TEXT NOT NULL
    CHECK(length(CAST(manifesto_json AS BLOB)) BETWEEN 2 AND 262144),
  manifesto_sha256 TEXT NOT NULL, fase TEXT NOT NULL CHECK(fase IN
    ('preparando','quarentena','conteudo_commitido','arquivos_pendentes','concluida','abortada','incerta')),
  criado_em TEXT NOT NULL
)`;
const INDEX_PENDING = `CREATE UNIQUE INDEX notetaker_exclusao_uma_pendente_v1
  ON notetaker_exclusao_controle_v1((1)) WHERE fase NOT IN ('concluida','abortada')`;
const TABLE_RECEIPT = `CREATE TABLE notetaker_exclusao_recibos_v1 (
  op_id TEXT PRIMARY KEY REFERENCES notetaker_exclusao_controle_v1(op_id) ON DELETE RESTRICT,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  sessao_id TEXT NOT NULL, perfil_id TEXT NOT NULL, db_dev TEXT NOT NULL, db_ino TEXT NOT NULL,
  selecao_assinatura TEXT NOT NULL, schema_assinatura TEXT NOT NULL,
  digest_sql_antes TEXT NOT NULL, digest_sql_depois TEXT NOT NULL,
  manifesto_sha256 TEXT NOT NULL, pks_removidas INTEGER NOT NULL CHECK(pks_removidas>=0),
  arquivos_total INTEGER NOT NULL CHECK(arquivos_total>=0),
  arquivos_pendentes INTEGER NOT NULL CHECK(arquivos_pendentes BETWEEN 0 AND arquivos_total),
  estado TEXT NOT NULL CHECK(estado IN('conteudo_commitido','arquivos_pendentes','concluida'))
    CHECK((estado='conteudo_commitido') OR (estado='arquivos_pendentes' AND arquivos_pendentes>0)
      OR (estado='concluida' AND arquivos_pendentes=0)),
  commit_em TEXT NOT NULL
)`;
const TRIGGERS = Object.freeze({
  notetaker_exclusao_controle_imutavel_v1: `CREATE TRIGGER notetaker_exclusao_controle_imutavel_v1
BEFORE UPDATE ON notetaker_exclusao_controle_v1
WHEN OLD.op_id IS NOT NEW.op_id OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.sessao_id IS NOT NEW.sessao_id OR OLD.perfil_id IS NOT NEW.perfil_id
  OR OLD.db_dev IS NOT NEW.db_dev OR OLD.db_ino IS NOT NEW.db_ino
  OR OLD.selecao_assinatura IS NOT NEW.selecao_assinatura
  OR OLD.schema_assinatura IS NOT NEW.schema_assinatura
  OR OLD.digest_sql_antes IS NOT NEW.digest_sql_antes
  OR OLD.manifesto_json IS NOT NEW.manifesto_json
  OR OLD.manifesto_sha256 IS NOT NEW.manifesto_sha256 OR OLD.criado_em IS NOT NEW.criado_em
BEGIN SELECT RAISE(ABORT,'controle de exclusao imutavel'); END`,
  notetaker_exclusao_controle_transicao_v1: `CREATE TRIGGER notetaker_exclusao_controle_transicao_v1
BEFORE UPDATE OF fase ON notetaker_exclusao_controle_v1
WHEN NOT (
  (OLD.fase='preparando' AND NEW.fase IN ('quarentena','abortada','incerta')) OR
  (OLD.fase='quarentena' AND NEW.fase IN ('conteudo_commitido','abortada','incerta')) OR
  (OLD.fase='conteudo_commitido' AND NEW.fase IN ('arquivos_pendentes','concluida','incerta')) OR
  (OLD.fase='arquivos_pendentes' AND NEW.fase IN ('concluida','incerta')) OR
  (OLD.fase=NEW.fase AND OLD.fase IN ('preparando','quarentena','conteudo_commitido','arquivos_pendentes'))
)
BEGIN SELECT RAISE(ABORT,'transicao de exclusao invalida'); END`,
  notetaker_exclusao_controle_sem_delete_v1: `CREATE TRIGGER notetaker_exclusao_controle_sem_delete_v1
BEFORE DELETE ON notetaker_exclusao_controle_v1
BEGIN SELECT RAISE(ABORT,'controle de exclusao retido'); END`,
  notetaker_exclusao_recibo_correlacao_v1: `CREATE TRIGGER notetaker_exclusao_recibo_correlacao_v1
BEFORE INSERT ON notetaker_exclusao_recibos_v1
WHEN NEW.estado<>'conteudo_commitido' OR NEW.arquivos_pendentes<>NEW.arquivos_total OR NOT EXISTS (
  SELECT 1 FROM notetaker_exclusao_controle_v1 c WHERE c.op_id=NEW.op_id AND c.fase='quarentena'
    AND c.schema_version=NEW.schema_version AND c.sessao_id=NEW.sessao_id AND c.perfil_id=NEW.perfil_id
    AND c.db_dev=NEW.db_dev AND c.db_ino=NEW.db_ino
    AND c.selecao_assinatura=NEW.selecao_assinatura AND c.schema_assinatura=NEW.schema_assinatura
    AND c.digest_sql_antes=NEW.digest_sql_antes AND c.manifesto_sha256=NEW.manifesto_sha256
)
BEGIN SELECT RAISE(ABORT,'recibo de exclusao sem correlacao'); END`,
  notetaker_exclusao_recibo_imutavel_v1: `CREATE TRIGGER notetaker_exclusao_recibo_imutavel_v1
BEFORE UPDATE ON notetaker_exclusao_recibos_v1
WHEN OLD.op_id IS NOT NEW.op_id OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.sessao_id IS NOT NEW.sessao_id OR OLD.perfil_id IS NOT NEW.perfil_id
  OR OLD.db_dev IS NOT NEW.db_dev OR OLD.db_ino IS NOT NEW.db_ino
  OR OLD.selecao_assinatura IS NOT NEW.selecao_assinatura OR OLD.schema_assinatura IS NOT NEW.schema_assinatura
  OR OLD.digest_sql_antes IS NOT NEW.digest_sql_antes OR OLD.digest_sql_depois IS NOT NEW.digest_sql_depois
  OR OLD.manifesto_sha256 IS NOT NEW.manifesto_sha256 OR OLD.pks_removidas IS NOT NEW.pks_removidas
  OR OLD.arquivos_total IS NOT NEW.arquivos_total OR OLD.commit_em IS NOT NEW.commit_em
BEGIN SELECT RAISE(ABORT,'recibo de exclusao imutavel'); END`,
  notetaker_exclusao_recibo_transicao_v1: `CREATE TRIGGER notetaker_exclusao_recibo_transicao_v1
BEFORE UPDATE OF estado,arquivos_pendentes ON notetaker_exclusao_recibos_v1
WHEN NOT (
  (OLD.estado='conteudo_commitido' AND NEW.arquivos_pendentes=OLD.arquivos_pendentes-1
    AND NEW.estado=CASE WHEN NEW.arquivos_pendentes=0 THEN 'concluida' ELSE 'arquivos_pendentes' END) OR
  (OLD.estado='arquivos_pendentes' AND NEW.arquivos_pendentes=OLD.arquivos_pendentes-1
    AND NEW.estado=CASE WHEN NEW.arquivos_pendentes=0 THEN 'concluida' ELSE 'arquivos_pendentes' END) OR
  (OLD.estado='conteudo_commitido' AND OLD.arquivos_total=0 AND NEW.arquivos_pendentes=0 AND NEW.estado='concluida')
)
BEGIN SELECT RAISE(ABORT,'progresso de exclusao invalido'); END`,
  notetaker_exclusao_recibo_sem_delete_v1: `CREATE TRIGGER notetaker_exclusao_recibo_sem_delete_v1
BEFORE DELETE ON notetaker_exclusao_recibos_v1
BEGIN SELECT RAISE(ABORT,'recibo de exclusao retido'); END`
});

export const DDL_CONTROLE_EXCLUSAO = Object.freeze([
  TABLE_CONTROL,
  INDEX_PENDING,
  TABLE_RECEIPT,
  ...Object.values(TRIGGERS)
]);

const EXPECTED_OBJECTS = Object.freeze({
  notetaker_exclusao_controle_v1: Object.freeze({ type: 'table', table: 'notetaker_exclusao_controle_v1', sql: TABLE_CONTROL }),
  sqlite_autoindex_notetaker_exclusao_controle_v1_1: Object.freeze({ type: 'index', table: 'notetaker_exclusao_controle_v1', sql: null }),
  notetaker_exclusao_uma_pendente_v1: Object.freeze({ type: 'index', table: 'notetaker_exclusao_controle_v1', sql: INDEX_PENDING }),
  notetaker_exclusao_recibos_v1: Object.freeze({ type: 'table', table: 'notetaker_exclusao_recibos_v1', sql: TABLE_RECEIPT }),
  sqlite_autoindex_notetaker_exclusao_recibos_v1_1: Object.freeze({ type: 'index', table: 'notetaker_exclusao_recibos_v1', sql: null }),
  ...Object.fromEntries(Object.entries(TRIGGERS).map(([name, sql]) =>
    [name, Object.freeze({ type: 'trigger', table: name.includes('_recibo_') ? 'notetaker_exclusao_recibos_v1' : 'notetaker_exclusao_controle_v1', sql })]))
});
export const NOMES_OBJETOS_CONTROLE_EXCLUSAO = Object.freeze(Object.keys(EXPECTED_OBJECTS));

export function validarControleExclusao(db) {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'notetaker_exclusao_%' OR tbl_name IN ('notetaker_exclusao_controle_v1','notetaker_exclusao_recibos_v1') ORDER BY name").all();
  if (!rows.length) return Object.freeze({ presente: false, ativo: false, controles: 0, recibos: 0 });
  if (rows.length !== NOMES_OBJETOS_CONTROLE_EXCLUSAO.length) fail('Conjunto parcial de controle de exclusao.');
  for (const row of rows) {
    const expected = EXPECTED_OBJECTS[row.name];
    if (!expected || row.type !== expected.type || row.tbl_name !== expected.table || row.sql !== expected.sql)
      fail(`Objeto de controle de exclusao divergente: ${row.name}.`);
  }
  const controls = db.prepare(`SELECT * FROM ${q(CONTROLE_EXCLUSAO.tabelaControle)} ORDER BY op_id`).all();
  const receipts = db.prepare(`SELECT * FROM ${q(CONTROLE_EXCLUSAO.tabelaRecibos)} ORDER BY op_id`).all();
  const receiptById = new Map(receipts.map(row => [row.op_id, row]));
  if (receiptById.size !== receipts.length || receipts.some(row => !controls.some(control => control.op_id === row.op_id)))
    fail('Recibo de exclusao orfao.');
  for (const control of controls) {
    if (!/^[a-f0-9]{64}$/.test(control.manifesto_sha256) ||
        createHash('sha256').update(control.manifesto_json).digest('hex') !== control.manifesto_sha256 ||
        !/^[a-f0-9]{64}$/.test(control.selecao_assinatura) || !/^[a-f0-9]{64}$/.test(control.schema_assinatura) ||
        !/^[a-f0-9]{64}$/.test(control.digest_sql_antes)) fail('Hashes do controle de exclusao invalidos.');
    const receipt = receiptById.get(control.op_id);
    const correlated = receipt && receipt.schema_version === control.schema_version && receipt.sessao_id === control.sessao_id &&
      receipt.perfil_id === control.perfil_id && receipt.db_dev === control.db_dev && receipt.db_ino === control.db_ino &&
      receipt.selecao_assinatura === control.selecao_assinatura && receipt.schema_assinatura === control.schema_assinatura &&
      receipt.digest_sql_antes === control.digest_sql_antes && receipt.manifesto_sha256 === control.manifesto_sha256;
    if (receipt && !correlated) fail('Recibo de exclusao sem correlacao duravel.');
    if (receipt && !/^[a-f0-9]{64}$/.test(receipt.digest_sql_depois)) fail('Digest terminal de exclusao invalido.');
    if (['preparando','quarentena','abortada'].includes(control.fase) && receipt)
      fail('Fase anterior ao commit possui recibo.');
    if (control.fase === 'conteudo_commitido' && (!correlated || receipt.estado !== 'conteudo_commitido' ||
        receipt.arquivos_pendentes !== receipt.arquivos_total)) fail('Commit de conteudo sem recibo inicial exato.');
    if (control.fase === 'arquivos_pendentes' && (!correlated || receipt.estado !== 'arquivos_pendentes' || receipt.arquivos_pendentes <= 0))
      fail('Progresso de arquivos sem recibo correlacionado.');
    if (control.fase === 'concluida' && (!correlated || receipt.estado !== 'concluida' || receipt.arquivos_pendentes !== 0))
      fail('Controle concluido sem recibo terminal correlacionado.');
  }
  const terminal = new Set(['concluida', 'abortada']);
  return Object.freeze({ presente: true, ativo: controls.some(row => !terminal.has(row.fase)),
    controles: controls.length, recibos: receipts.length });
}

export function exigirControleInativo(db, code = 'CONFLITO') {
  const state = validarControleExclusao(db);
  if (state.ativo) throw Object.assign(new Error('Exclusao de conteudo em andamento.'), { code });
  return state;
}

// Esquema local aditivo. A presença das tabelas não habilita captura nem leitura.
export {NOTETAKER_COLUNAS} from '../leitura-sql.js';

export function prepararNotetaker(db){
  db.exec(`CREATE TABLE IF NOT EXISTS notetaker_sessoes(
    id TEXT PRIMARY KEY, estado TEXT NOT NULL CHECK(estado IN ('preparada','gravando','pausada','encerrada','interrompida','excluida')),
    origem TEXT NOT NULL CHECK(origem IN ('importacao','captura')), entradas TEXT NOT NULL,
    consentimento_em TEXT, direitos_revogados_em TEXT, inicio_em TEXT NOT NULL, fim_em TEXT,
    revisao INTEGER NOT NULL DEFAULT 0, excluida_em TEXT,
    importacao_estado TEXT NOT NULL DEFAULT 'nao_iniciada', importacao_sha256 TEXT, importacao_bytes INTEGER,
    asr_estado TEXT NOT NULL DEFAULT 'nao_solicitado');
  CREATE UNIQUE INDEX IF NOT EXISTS notetaker_uma_ativa ON notetaker_sessoes((1)) WHERE estado IN ('gravando','pausada');
  CREATE TABLE IF NOT EXISTS notetaker_partes(
    id TEXT PRIMARY KEY, sessao_id TEXT NOT NULL REFERENCES notetaker_sessoes(id) ON DELETE CASCADE,
    entrada TEXT NOT NULL CHECK(entrada IN ('importacao','mic','sistema')),
    posicao INTEGER NOT NULL CHECK(posicao>=0), inicio_ms INTEGER NOT NULL CHECK(inicio_ms>=0),
    duracao_ms REAL NOT NULL CHECK(duracao_ms>0 AND duracao_ms<=60000),
    sha256 TEXT NOT NULL, caminho TEXT NOT NULL, estado TEXT NOT NULL CHECK(estado IN ('salva','indisponivel')),
    UNIQUE(sessao_id,entrada,posicao));
  CREATE TABLE IF NOT EXISTS notetaker_trechos(
    id TEXT PRIMARY KEY, parte_id TEXT NOT NULL REFERENCES notetaker_partes(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0), inicio_ms INTEGER NOT NULL CHECK(inicio_ms>=0),
    fim_ms INTEGER NOT NULL CHECK(fim_ms>=inicio_ms), texto_gerado TEXT NOT NULL,
    texto_corrigido TEXT, ator_correcao TEXT, revisao INTEGER NOT NULL DEFAULT 0,
    UNIQUE(parte_id,ordinal));
  CREATE TABLE IF NOT EXISTS notetaker_fontes(
    evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,
    trecho_id TEXT NOT NULL UNIQUE REFERENCES notetaker_trechos(id) ON DELETE CASCADE,
    sessao_id TEXT NOT NULL REFERENCES notetaker_sessoes(id) ON DELETE CASCADE,
    parte_id TEXT NOT NULL REFERENCES notetaker_partes(id) ON DELETE CASCADE,
    inicio_ms INTEGER NOT NULL, fim_ms INTEGER NOT NULL, audio_sha256 TEXT NOT NULL, revisao INTEGER NOT NULL DEFAULT 0);`);
  db.exec('SAVEPOINT notetaker_correcoes_schema');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS notetaker_correcoes(
      id INTEGER PRIMARY KEY,
      trecho_id TEXT NOT NULL REFERENCES notetaker_trechos(id) ON DELETE CASCADE,
      revisao INTEGER NOT NULL,
      texto_anterior TEXT NOT NULL,
      texto_novo TEXT NOT NULL,
      ator TEXT NOT NULL,
      corrigido_em TEXT NOT NULL,
      UNIQUE(trecho_id,revisao));
      CREATE INDEX IF NOT EXISTS notetaker_correcoes_trecho_id ON notetaker_correcoes(trecho_id,id);`);
    db.exec('RELEASE notetaker_correcoes_schema');
  } catch (error) {
    db.exec('ROLLBACK TO notetaker_correcoes_schema; RELEASE notetaker_correcoes_schema');
    throw error;
  }
}

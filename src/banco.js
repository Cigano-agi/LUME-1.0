// Persistencia duravel com o SQLite embutido do Node (node:sqlite). Zero dependencias
// externas: o baseline roda sem `npm install`, sem Postgres, sem Supabase.
//
// Procedencia: a ideia de deduplicar por (conversa, id de origem) vem de
// whatsapp-brain@fd40178 `src/db.ts`, que ja usava UNIQUE(chat_jid, wa_id).
// O resto do esquema e novo, porque o esquema antigo terminava em "synced com CRM"
// (achado A09) e nao em execucao/revisao/envio/aceite.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { prepararCompartilhamento } from './compartilhamento.js';
import { prepararExclusoes } from './exclusoes.js';
import { prepararNotetaker } from './notetaker/esquema.js';

const ESQUEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Cadastro minimo da fronteira de acesso. O id e estavel e aparece nos eventos;
-- a raiz e a unica pasta que o manifesto de execucao pode entregar ao worker.
CREATE TABLE IF NOT EXISTS projetos (
  id         TEXT PRIMARY KEY,
  cliente    TEXT NOT NULL,
  nome       TEXT NOT NULL,
  raiz       TEXT NOT NULL,
  criado_em  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversa_projetos (
  conversa_id TEXT NOT NULL,
  projeto_id  TEXT NOT NULL REFERENCES projetos(id),
  decidido_por TEXT NOT NULL,
  decidido_em TEXT NOT NULL,
  PRIMARY KEY (conversa_id, projeto_id)
);

-- Entrada crua. Gravada ANTES de transcrever, analisar ou chamar modelo (achado A03).
CREATE TABLE IF NOT EXISTS eventos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id  TEXT NOT NULL,
  origem_id    TEXT NOT NULL,
  direcao      TEXT NOT NULL CHECK (direcao IN ('entrada','saida')),
  autor_id     TEXT,
  autor_e_dono INTEGER NOT NULL DEFAULT 0,
  do_proprio_bot INTEGER NOT NULL DEFAULT 0,
  projeto_id   TEXT REFERENCES projetos(id),
  tipo         TEXT NOT NULL,
  bruto        TEXT NOT NULL,
  texto        TEXT,
  recebido_em  TEXT NOT NULL,
  dia_local    TEXT NOT NULL,
  UNIQUE (conversa_id, origem_id)
);
CREATE INDEX IF NOT EXISTS idx_eventos_conversa ON eventos (conversa_id, id);

-- Uma linha por etapa por evento. Nenhuma etapa some em log (achado A03).
CREATE TABLE IF NOT EXISTS etapas (
  evento_id            INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  etapa                TEXT NOT NULL,
  estado               TEXT NOT NULL CHECK (estado IN ('pendente','em_curso','concluida','falha','desistida')),
  tentativas           INTEGER NOT NULL DEFAULT 0,
  ultimo_erro          TEXT,
  resultado            TEXT,
  atualizado_em        TEXT NOT NULL,
  proxima_tentativa_em TEXT,
  lease_token          TEXT,
  lease_ate            TEXT,
  fonte_assinatura     TEXT,
  PRIMARY KEY (evento_id, etapa)
);
CREATE INDEX IF NOT EXISTS idx_etapas_fila ON etapas (etapa, estado, proxima_tentativa_em);

-- Saude por etapa. Nao existe "saudavel" global (achado A01).
CREATE TABLE IF NOT EXISTS saude (
  etapa             TEXT PRIMARY KEY,
  ultimo_sucesso_em TEXT,
  ultimo_erro_em    TEXT,
  ultimo_erro       TEXT
);

-- Autorizacao por identificador exato de conversa. Lista vazia nao libera ninguem (achado A07).
CREATE TABLE IF NOT EXISTS autorizacoes (
  conversa_id  TEXT PRIMARY KEY,
  escopo       TEXT NOT NULL CHECK (escopo IN ('dm','grupo')),
  modo         TEXT NOT NULL CHECK (modo IN ('ignorar','observar','rascunhar','atender','pausado')),
  decidido_por TEXT,
  decidido_em  TEXT NOT NULL,
  observacao   TEXT
);

-- Saidas preparadas. Envio so acontece com autorizacao reconferida na hora.
CREATE TABLE IF NOT EXISTS saidas (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id   TEXT NOT NULL,
  idempotencia  TEXT NOT NULL UNIQUE,
  corpo         TEXT NOT NULL,
  estado        TEXT NOT NULL CHECK (estado IN ('preparada','enviada','cancelada','incerta')),
  motivo        TEXT,
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

-- Recibo de entrega ao Punk. Sem recibo nao houve entrega (achado A04).
CREATE TABLE IF NOT EXISTS entregas_punk (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  referencia TEXT NOT NULL UNIQUE,
  destino    TEXT NOT NULL,
  estado     TEXT NOT NULL CHECK (estado IN ('confirmada','falha')),
  detalhe    TEXT,
  criado_em  TEXT NOT NULL
);

-- Batimento do processo principal, lido por um vigia de fora (achado A01/REL-03).
-- Estado do vigia, PERSISTIDO. Deduplicar em memoria nao serve: um vigia
-- rodado por cron/agendador sobe um processo novo a cada rodada e repetiria o
-- mesmo alarme para sempre. Descoberto no teste de queda real de 03/09/2026.
CREATE TABLE IF NOT EXISTS vigia_estado (
  componente    TEXT PRIMARY KEY,
  estado        TEXT NOT NULL CHECK (estado IN ('vivo','alarmado')),
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batimentos (
  componente TEXT PRIMARY KEY,
  pid        INTEGER,
  visto_em   TEXT NOT NULL
);
`;

export function abrirBanco(caminho = ":memory:") {
  if (caminho !== ":memory:") mkdirSync(dirname(caminho), { recursive: true });
  // A captura, o painel e eventos de ciclo de vida podem abrir o mesmo perfil
  // ao mesmo tempo. Aguarde uma transacao curta em vez de falhar no preparo do
  // esquema antes que os modulos consigam aplicar seu proprio busy_timeout.
  const db = new DatabaseSync(caminho, { timeout: 5000 });
  db.exec(ESQUEMA);
  const colunasEventos = db.prepare("PRAGMA table_info(eventos)").all().map((c) => c.name);
  if (!colunasEventos.includes("projeto_id")) {
    db.exec("ALTER TABLE eventos ADD COLUMN projeto_id TEXT REFERENCES projetos(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_eventos_projeto ON eventos (projeto_id, conversa_id, id)");
  const colunasEtapas = new Set(db.prepare('PRAGMA table_info(etapas)').all().map(c => c.name));
  for (const coluna of ['lease_token', 'lease_ate', 'fonte_assinatura']) {
    if (!colunasEtapas.has(coluna)) db.exec(`ALTER TABLE etapas ADD COLUMN ${coluna} TEXT`);
  }
  prepararCompartilhamento(db);
  prepararExclusoes(db);
  prepararNotetaker(db);
  return db;
}

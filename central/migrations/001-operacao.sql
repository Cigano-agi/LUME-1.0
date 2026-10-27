CREATE TABLE IF NOT EXISTS lume_convites (
  id uuid PRIMARY KEY,
  rotulo varchar(80) NOT NULL,
  codigo_hash char(64) UNIQUE NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  usado_em timestamptz,
  usado_por uuid,
  revogado_em timestamptz
);

CREATE TABLE IF NOT EXISTS lume_instalacoes (
  id uuid PRIMARY KEY,
  rotulo varchar(80) NOT NULL,
  token_hash char(64) UNIQUE NOT NULL,
  plataforma varchar(12) NOT NULL CHECK (plataforma IN ('win32','darwin')),
  arquitetura varchar(12) NOT NULL CHECK (arquitetura IN ('x64','arm64')),
  canal varchar(12) NOT NULL CHECK (canal IN ('beta','estavel')),
  versao varchar(64) NOT NULL,
  estado_atualizacao varchar(24) NOT NULL CHECK (estado_atualizacao IN ('em_dia','disponivel','baixando','pronta','erro')),
  codigo_erro varchar(48),
  whatsapp_estado varchar(24) NOT NULL CHECK (whatsapp_estado IN ('nao_informado','conectado','pareando','pausado','erro')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_contato_em timestamptz NOT NULL DEFAULT now(),
  revogado_em timestamptz
);

CREATE INDEX IF NOT EXISTS lume_instalacoes_ultimo_contato ON lume_instalacoes(ultimo_contato_em DESC);
CREATE INDEX IF NOT EXISTS lume_instalacoes_versao ON lume_instalacoes(canal,plataforma,arquitetura,versao);

CREATE TABLE IF NOT EXISTS lume_feedback (
  id uuid PRIMARY KEY,
  instalacao_id uuid NOT NULL REFERENCES lume_instalacoes(id) ON DELETE CASCADE,
  chave_cliente uuid NOT NULL,
  categoria varchar(16) NOT NULL CHECK (categoria IN ('erro','ideia','elogio')),
  etapa varchar(20) NOT NULL CHECK (etapa IN ('onboarding','hoje','conexao','organiza','ajustes')),
  relato varchar(2000) NOT NULL,
  utilidade varchar(20) CHECK (utilidade IN ('util','parcial','nao_util')),
  conteudo_hash char(64) NOT NULL,
  versao varchar(64) NOT NULL,
  plataforma varchar(12) NOT NULL,
  estado varchar(20) NOT NULL DEFAULT 'novo' CHECK (estado IN ('novo','em_analise','resolvido')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  excluido_em timestamptz,
  UNIQUE (instalacao_id,chave_cliente)
);

CREATE INDEX IF NOT EXISTS lume_feedback_triagem ON lume_feedback(estado,criado_em DESC) WHERE excluido_em IS NULL;
CREATE INDEX IF NOT EXISTS lume_feedback_retencao ON lume_feedback(criado_em) WHERE excluido_em IS NULL;

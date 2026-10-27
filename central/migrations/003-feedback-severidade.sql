ALTER TABLE lume_feedback ADD COLUMN IF NOT EXISTS severidade varchar(8) NOT NULL DEFAULT 'media' CHECK (severidade IN ('baixa','media','alta'));
CREATE INDEX IF NOT EXISTS lume_feedback_prioridade ON lume_feedback(severidade,estado,criado_em DESC) WHERE excluido_em IS NULL;

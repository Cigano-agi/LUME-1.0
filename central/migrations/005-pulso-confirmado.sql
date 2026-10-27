ALTER TABLE lume_instalacoes ADD COLUMN IF NOT EXISTS ultimo_pulso_em timestamptz;

-- Instalações anteriores à separação do feedback só avançavam ultimo_contato_em no pulso.
UPDATE lume_instalacoes SET ultimo_pulso_em=ultimo_contato_em
WHERE ultimo_pulso_em IS NULL AND ultimo_contato_em>criado_em;

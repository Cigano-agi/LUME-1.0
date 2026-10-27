/** Transport journals extend the existing sources/actions/stages, not a second task queue. */
export function prepararPessoal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pessoal_politicas(
      conversa_id TEXT PRIMARY KEY,categoria TEXT NOT NULL DEFAULT 'unknown',remoto INTEGER NOT NULL DEFAULT 0,
      pausada INTEGER NOT NULL DEFAULT 0,versao INTEGER NOT NULL DEFAULT 1,atualizado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pessoal_propostas(
      id TEXT PRIMARY KEY,conversa_id TEXT NOT NULL,evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
      acao_id TEXT,versao INTEGER NOT NULL,politica_hash TEXT NOT NULL,conteudo_hash TEXT NOT NULL,
      baloes TEXT NOT NULL,fontes TEXT NOT NULL,externas TEXT NOT NULL DEFAULT '[]',motivo TEXT NOT NULL,
      estado TEXT NOT NULL CHECK(estado IN('pendente','aprovada','cancelada','enviada','incerta','recusada')),
      criada_em TEXT NOT NULL,aprovada_em TEXT,aprovada_por TEXT,notificada INTEGER NOT NULL DEFAULT 0,
      UNIQUE(evento_id,versao,conteudo_hash));
    CREATE INDEX IF NOT EXISTS pessoal_propostas_estado ON pessoal_propostas(estado,criada_em);
    CREATE TABLE IF NOT EXISTS pessoal_proposta_saidas(
      proposta_id TEXT NOT NULL REFERENCES pessoal_propostas(id) ON DELETE CASCADE,
      ordem INTEGER NOT NULL,saida_id INTEGER NOT NULL REFERENCES saidas(id),wa_id TEXT NOT NULL,
      recibo TEXT NOT NULL DEFAULT 'preparada',atualizado_em TEXT NOT NULL,
      PRIMARY KEY(proposta_id,ordem),UNIQUE(saida_id),UNIQUE(wa_id));
    CREATE TABLE IF NOT EXISTS pessoal_vinculos(
      conversa_id TEXT NOT NULL,tipo TEXT NOT NULL CHECK(tipo IN('github','clickup')),recurso TEXT NOT NULL,
      PRIMARY KEY(conversa_id,tipo,recurso));
    CREATE TABLE IF NOT EXISTS telegram_entradas(
      bot_id TEXT NOT NULL,update_id INTEGER NOT NULL,dono_id TEXT NOT NULL,entrada TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendente',tentativas INTEGER NOT NULL DEFAULT 0,
      criada_em TEXT NOT NULL,erro TEXT,PRIMARY KEY(bot_id,update_id));
    CREATE TABLE IF NOT EXISTS telegram_saidas(
      id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,dono_id TEXT NOT NULL,texto TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'preparada',externo_id TEXT,criada_em TEXT NOT NULL,
      vinculo TEXT,erro TEXT);
    CREATE INDEX IF NOT EXISTS telegram_saidas_estado ON telegram_saidas(bot_id,dono_id,estado);
    CREATE TRIGGER IF NOT EXISTS pessoal_evento_novo AFTER INSERT ON eventos
    WHEN NEW.do_proprio_bot=0 BEGIN
      UPDATE pessoal_politicas SET versao=versao+1,
        pausada=CASE WHEN NEW.autor_e_dono=1 AND json_valid(NEW.bruto) AND json_extract(NEW.bruto,'$.tipoLote')='notify' THEN 1 ELSE pausada END
        WHERE conversa_id=NEW.conversa_id;
      UPDATE pessoal_propostas SET estado='cancelada',motivo='A conversa mudou; a resposta precisa ser preparada novamente.'
        WHERE conversa_id=NEW.conversa_id AND estado IN('pendente','aprovada');
      UPDATE saidas SET estado='cancelada',motivo='A conversa mudou.' WHERE estado='preparada' AND id IN(
        SELECT s.saida_id FROM pessoal_proposta_saidas s JOIN pessoal_propostas p ON p.id=s.proposta_id WHERE p.conversa_id=NEW.conversa_id AND p.estado='cancelada');
      INSERT OR IGNORE INTO etapas(evento_id,etapa,estado,atualizado_em,proxima_tentativa_em)
        SELECT NEW.id,'assistencia','pendente',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+12 seconds')
        WHERE NEW.direcao='entrada' AND json_valid(NEW.bruto) AND json_extract(NEW.bruto,'$.tipoLote')='notify'
          AND (SELECT valor FROM desktop_config WHERE chave='pessoal-enabled')='1';
    END;
    DROP TRIGGER IF EXISTS pessoal_evento_alterado;
    CREATE TRIGGER pessoal_evento_alterado AFTER UPDATE OF texto,permissao,bruto ON eventos BEGIN
      UPDATE pessoal_politicas SET versao=versao+1 WHERE conversa_id=NEW.conversa_id;
      UPDATE pessoal_propostas SET estado='cancelada',motivo='Uma fonte ou permissão mudou.' WHERE conversa_id=NEW.conversa_id AND estado IN('pendente','aprovada');
      UPDATE saidas SET estado='cancelada',motivo='Uma fonte ou permissão mudou.' WHERE estado='preparada' AND id IN(
        SELECT s.saida_id FROM pessoal_proposta_saidas s JOIN pessoal_propostas p ON p.id=s.proposta_id WHERE p.conversa_id=NEW.conversa_id AND p.estado='cancelada');
    END;
    CREATE TRIGGER IF NOT EXISTS pessoal_evento_removido BEFORE DELETE ON eventos BEGIN
      UPDATE pessoal_politicas SET versao=versao+1 WHERE conversa_id=OLD.conversa_id;
      UPDATE pessoal_propostas SET estado='cancelada',motivo='Uma fonte foi removida.' WHERE conversa_id=OLD.conversa_id AND estado IN('pendente','aprovada');
      UPDATE saidas SET estado='cancelada',motivo='Uma fonte foi removida.' WHERE estado='preparada' AND id IN(
        SELECT s.saida_id FROM pessoal_proposta_saidas s JOIN pessoal_propostas p ON p.id=s.proposta_id WHERE p.conversa_id=OLD.conversa_id);
    END;`);
  if(!db.prepare('PRAGMA table_info(pessoal_politicas)').all().some(c=>c.name==='atendimento'))
    db.exec("ALTER TABLE pessoal_politicas ADD COLUMN atendimento TEXT NOT NULL DEFAULT '{}'");
}

import { createHash } from 'node:crypto';
import { HASH_FONTE_SQL } from '../tarefas-esquema.js';

// Migração aditiva independente: nenhum ALTER nas tabelas legadas.
export function prepararExecucoes(db) {
  db.exec('SAVEPOINT lume_execucao_guardas_migracao');
  try {
    prepararEsquema(db);
    db.exec('RELEASE lume_execucao_guardas_migracao');
  } catch (error) {
    db.exec('ROLLBACK TO lume_execucao_guardas_migracao; RELEASE lume_execucao_guardas_migracao');
    throw error;
  }
}

function prepararEsquema(db) {
  db.exec(`SAVEPOINT lume_execucao_migracao;
    CREATE TABLE IF NOT EXISTS lume_execucao_migracoes (
      versao INTEGER PRIMARY KEY, aplicada_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lume_execucao_contextos (
      id TEXT PRIMARY KEY,
      acao_id TEXT NOT NULL REFERENCES lume_acoes(id) ON DELETE CASCADE,
      pacote TEXT NOT NULL, integridade TEXT NOT NULL,
      criado_em TEXT NOT NULL, expira_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lume_execucoes (
      id TEXT PRIMARY KEY,
      contexto_id TEXT NOT NULL REFERENCES lume_execucao_contextos(id) ON DELETE CASCADE,
      assistente TEXT NOT NULL CHECK(assistente IN ('claude','codex','hermes')),
      cliente_id TEXT NOT NULL,
      estado TEXT NOT NULL CHECK(estado IN ('aguardando_assistente','em_andamento','resultado_informado','verificado','revogada')),
      chave_inicio TEXT NOT NULL UNIQUE, assinatura_inicio TEXT NOT NULL,
      autorizada_em TEXT NOT NULL, atualizada_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lume_execucao_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execucao_id TEXT NOT NULL REFERENCES lume_execucoes(id) ON DELETE CASCADE,
      chave TEXT NOT NULL, assinatura TEXT NOT NULL,
      tipo TEXT NOT NULL, ator TEXT NOT NULL, dados TEXT NOT NULL, criado_em TEXT NOT NULL,
      UNIQUE(execucao_id,chave)
    );
    -- Autoridade local adicional. Nunca integra as tabelas de backup/exportação.
    -- Criar a tabela não concede nada às execuções que já existem.
    CREATE TABLE IF NOT EXISTS lume_execucao_contexto_grants (
      execucao_id TEXT PRIMARY KEY REFERENCES lume_execucoes(id) ON DELETE CASCADE,
      contexto_id TEXT NOT NULL REFERENCES lume_execucao_contextos(id) ON DELETE CASCADE,
      cliente_id TEXT NOT NULL,
      consentida_em TEXT NOT NULL, expira_em TEXT NOT NULL,
      assinatura_contexto TEXT NOT NULL,
      revisao_conector TEXT,
      invalidada INTEGER NOT NULL DEFAULT 0 CHECK(invalidada IN (0,1))
    );
    -- Guarda local de TODO snapshot, inclusive prévias e execuções sem grant.
    -- Não exporta autoridade. A fonte original não acompanha edições da ação.
    CREATE TABLE IF NOT EXISTS lume_execucao_contexto_guardas (
      contexto_id TEXT PRIMARY KEY REFERENCES lume_execucao_contextos(id) ON DELETE CASCADE,
      evento_id INTEGER,
      assinatura_contexto TEXT NOT NULL,
      invalidada_em TEXT,
      motivo TEXT
    );
    CREATE INDEX IF NOT EXISTS lume_execucao_guarda_fonte ON lume_execucao_contexto_guardas(evento_id);
    CREATE TRIGGER IF NOT EXISTS lume_execucao_grant_revogada
      AFTER UPDATE OF estado ON lume_execucoes WHEN new.estado='revogada'
      BEGIN UPDATE lume_execucao_contexto_grants SET invalidada=1 WHERE execucao_id=new.id; END;
    CREATE INDEX IF NOT EXISTS lume_execucao_contexto_acao ON lume_execucao_contextos(acao_id,criado_em);
    CREATE INDEX IF NOT EXISTS lume_execucao_contexto ON lume_execucoes(contexto_id,autorizada_em);
    INSERT OR IGNORE INTO lume_execucao_migracoes VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    RELEASE lume_execucao_migracao;`);
  if (!db.prepare('PRAGMA table_info(lume_execucao_contexto_grants)').all().some(c => c.name === 'revisao_conector')) {
    db.exec('ALTER TABLE lume_execucao_contexto_grants ADD COLUMN revisao_conector TEXT');
  }

  // Um perfil anterior não prova que nunca ocorreu A-B-A. Preserve seu histórico,
  // mas exija uma nova prévia. Nunca reescreva uma guarda já estabelecida.
  const legados = db.prepare(`SELECT c.*,a.evento_id FROM lume_execucao_contextos c
    JOIN lume_acoes a ON a.id=c.acao_id LEFT JOIN lume_execucao_contexto_guardas g ON g.contexto_id=c.id
    WHERE g.contexto_id IS NULL`).all();
  for (const c of legados) {
    const integridade = JSON.parse(c.integridade);
    const fonteAtual = db.prepare(`SELECT e.id FROM desktop_fontes e WHERE e.id=? AND ${HASH_FONTE_SQL}=?`).get(c.evento_id, integridade.fonte);
    // Backup mantém os hashes originais mesmo se a ação mudou de fonte.
    const candidatas = fonteAtual ? [fonteAtual] : db.prepare(`SELECT e.id FROM desktop_fontes e WHERE ${HASH_FONTE_SQL}=? LIMIT 2`).all(integridade.fonte);
    const original = candidatas.length === 1 ? candidatas[0] : null;
    db.prepare(`INSERT OR IGNORE INTO lume_execucao_contexto_guardas VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'migracao_sem_rastreio')`)
      .run(c.id, original?.id ?? null, createHash('sha256').update(JSON.stringify([c.id, c.pacote, c.integridade])).digest('hex'));
  }

  // Invalidar de forma durável: revogar/editar e depois repor o valor antigo
  // não ressuscita um consentimento. Estado/progresso da ação não o invalida.
  const invalidar = (filtro, motivo) => {
    const ids = `SELECT c.id FROM lume_execucao_contextos c JOIN lume_acoes a ON a.id=c.acao_id
      LEFT JOIN lume_execucao_contexto_guardas g ON g.contexto_id=c.id
      LEFT JOIN eventos e ON e.id=COALESCE(g.evento_id,a.evento_id) WHERE ${filtro}`;
    return `UPDATE lume_execucao_contexto_guardas SET invalidada_em=strftime('%Y-%m-%dT%H:%M:%fZ','now'),motivo='${motivo}'
      WHERE invalidada_em IS NULL AND contexto_id IN (${ids});
      UPDATE lume_execucao_contexto_grants SET invalidada=1 WHERE contexto_id IN (${ids});`;
  };
  for (const tabela of ['politicas_conversa', 'lume_acoes_conversas']) {
    for (const operacao of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = operacao === 'UPDATE' ? ['old', 'new'] : [operacao === 'INSERT' ? 'new' : 'old'];
      const campos = tabela === 'politicas_conversa' ? ['conversa_id', 'politica', 'atualizado_em'] : ['conversa_id', 'autorizada_em', 'inicio_evento_id'];
      const quando = operacao === 'UPDATE' ? `WHEN ${campos.map(c => `old.${c} IS NOT new.${c}`).join(' OR ')}` : '';
      db.exec(`DROP TRIGGER IF EXISTS lume_execucao_grant_${tabela}_${operacao};
        CREATE TRIGGER lume_execucao_grant_${tabela}_${operacao}
        AFTER ${operacao} ON ${tabela} ${quando} BEGIN ${refs.map(ref => invalidar(`e.conversa_id=${ref}.conversa_id`, tabela === 'politicas_conversa' ? 'politica_alterada' : 'consentimento_alterado')).join('\n')} END;`);
    }
  }
  // Procedência compartilhada também concede leitura em LEITURA_SQL. Uma
  // remoção seguida de reinserção não pode ressuscitar o consentimento antigo.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='f10_procedencias'").get()) {
    const campos = ['evento_id', 'fingerprint', 'pacote_id', 'projeto_id'];
    for (const [operacao, refs] of [['INSERT', ['new']], ['DELETE', ['old']], ['UPDATE', ['old', 'new']]]) {
      const quando = operacao === 'UPDATE' ? `WHEN ${campos.map(c => `old.${c} IS NOT new.${c}`).join(' OR ')}` : '';
      db.exec(`DROP TRIGGER IF EXISTS lume_execucao_grant_f10_procedencias_${operacao};
        CREATE TRIGGER lume_execucao_grant_f10_procedencias_${operacao}
        BEFORE ${operacao} ON f10_procedencias ${quando}
        BEGIN ${refs.map(ref => invalidar(`e.id=${ref}.evento_id`, 'procedencia_alterada')).join('\n')} END;`);
    }
  }
  const camposAcao = ['evento_id', 'fonte_assinatura', 'resumo', 'trecho', 'trecho_inicio', 'tipo', 'prazo_citado'];
  const camposFonte = ['texto', 'permissao', 'conversa_id', 'origem_id', 'recebido_em', 'projeto_id', 'origem_compartilhamento', 'autor_id', 'autor_e_dono'];
  for (const [tabela, campos, filtro] of [['lume_acoes', camposAcao, 'a.id=old.id'], ['eventos', camposFonte, 'e.id=old.id']]) {
    db.exec(`DROP TRIGGER IF EXISTS lume_execucao_grant_${tabela}_UPDATE;
      CREATE TRIGGER lume_execucao_grant_${tabela}_UPDATE
      BEFORE UPDATE OF ${campos.join(',')} ON ${tabela}
      WHEN ${campos.map(c => `old.${c} IS NOT new.${c}`).join(' OR ')}
      BEGIN ${invalidar(filtro, tabela === 'lume_acoes' ? 'acao_alterada' : 'fonte_alterada')} END;`);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcricoes'").get()) {
    for (const operacao of ['INSERT', 'UPDATE', 'DELETE']) {
      const refs = operacao === 'UPDATE' ? ['old', 'new'] : [operacao === 'INSERT' ? 'new' : 'old'];
      db.exec(`DROP TRIGGER IF EXISTS lume_execucao_grant_transcricoes_${operacao};
        CREATE TRIGGER lume_execucao_grant_transcricoes_${operacao}
        BEFORE ${operacao} ON transcricoes BEGIN ${refs.map(ref => invalidar(`e.conversa_id=${ref}.conversa_id AND e.origem_id=${ref}.origem_id`, 'transcricao_alterada')).join('\n')} END;`);
    }
  }
  db.exec(`CREATE TRIGGER IF NOT EXISTS lume_execucao_guarda_snapshot_UPDATE
    BEFORE UPDATE OF acao_id,pacote,integridade,criado_em,expira_em ON lume_execucao_contextos
    WHEN old.acao_id IS NOT new.acao_id OR old.pacote IS NOT new.pacote OR old.integridade IS NOT new.integridade
      OR old.criado_em IS NOT new.criado_em OR old.expira_em IS NOT new.expira_em
    BEGIN ${invalidar('c.id=old.id', 'snapshot_alterado')} END;
    CREATE TRIGGER IF NOT EXISTS lume_execucao_guarda_fonte_DELETE BEFORE DELETE ON eventos
    BEGIN DELETE FROM lume_execucao_contextos WHERE id IN
      (SELECT contexto_id FROM lume_execucao_contexto_guardas WHERE evento_id=old.id); END;`);
}

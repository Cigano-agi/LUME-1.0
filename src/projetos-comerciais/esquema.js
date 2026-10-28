import {garantirEsquema} from '../permissao.js';
import {prepararFontes} from '../fontes-desktop.js';
import {LEITURA_SQL} from '../leitura-sql.js';

// Ordem de inserção; apagar na ordem inversa. Nenhuma tabela contém grants.
export const PROJETOS_COMERCIAIS_BACKUP = ['lume_projetos_comerciais','lume_projetos_fontes','lume_projetos_historico'];
export const PROJETOS_COMERCIAIS_TABELAS = ['lume_projetos_revisoes','lume_projetos_importados_guardas',...PROJETOS_COMERCIAIS_BACKUP];

export function prepararProjetosComerciais(db){
  garantirEsquema(db);
  prepararFontes(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS lume_projetos_comerciais(
      id TEXT PRIMARY KEY, nome TEXT NOT NULL,
      natureza TEXT NOT NULL CHECK(natureza IN('acordo_citado','proposta','incerto')),
      estado TEXT NOT NULL CHECK(estado IN('rascunho','confirmado','arquivado')),
      chave TEXT NOT NULL UNIQUE, assinatura_criacao TEXT NOT NULL,
      bases_total INTEGER NOT NULL CHECK(bases_total BETWEEN 1 AND 32),
      criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lume_projetos_fontes(
      id TEXT PRIMARY KEY,
      projeto_id TEXT NOT NULL REFERENCES lume_projetos_comerciais(id) ON DELETE CASCADE,
      evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
      assinatura TEXT NOT NULL,
      inicio INTEGER NOT NULL CHECK(inicio>=0), tamanho INTEGER NOT NULL CHECK(tamanho>0),
      selecao TEXT NOT NULL CHECK(selecao IN('evento','trecho')),
      base INTEGER NOT NULL CHECK(base IN(0,1)),
      removida INTEGER NOT NULL DEFAULT 0 CHECK(removida IN(0,1)),
      invalidada INTEGER NOT NULL DEFAULT 0 CHECK(invalidada IN(0,1)),
      criada_em TEXT NOT NULL,
      UNIQUE(projeto_id,evento_id,selecao,inicio,tamanho));
    CREATE INDEX IF NOT EXISTS lume_projetos_fontes_evento ON lume_projetos_fontes(evento_id);
    CREATE TABLE IF NOT EXISTS lume_projetos_historico(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projeto_id TEXT NOT NULL REFERENCES lume_projetos_comerciais(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL CHECK(tipo IN('criado','confirmado','arquivado','restaurado','fonte_vinculada','fonte_desvinculada','importado_revisado')),
      fonte_id TEXT REFERENCES lume_projetos_fontes(id) ON DELETE SET NULL,
      quando TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS lume_projetos_historico_projeto ON lume_projetos_historico(projeto_id,id);
    CREATE TRIGGER IF NOT EXISTS lume_projetos_evento_apagado BEFORE DELETE ON eventos BEGIN
      DELETE FROM lume_projetos_comerciais WHERE id IN
        (SELECT projeto_id FROM lume_projetos_fontes WHERE evento_id=old.id AND base=1);
    END;
  `);
  // Invalidação persistente impede que conceder leitura de novo ressuscite um vínculo.
  const campos=['texto','tipo','direcao','permissao','conversa_id','origem_id','recebido_em','projeto_id','origem_compartilhamento','autor_id','autor_e_dono'];
  db.exec('DROP TRIGGER IF EXISTS lume_projetos_evento_alterado');
  db.exec(`CREATE TRIGGER IF NOT EXISTS lume_projetos_evento_alterado AFTER UPDATE OF ${campos.join(',')} ON eventos
    WHEN ${campos.map(c=>`old.${c} IS NOT new.${c}`).join(' OR ')} BEGIN
      UPDATE lume_projetos_fontes SET invalidada=1 WHERE evento_id=old.id;
    END;`);
  for(const [tabela,sufixo] of [['politicas_conversa','politica'],['f10_procedencias','procedencia']]){
    for(const [acao,nome] of [['UPDATE','alterada'],['DELETE','apagada']]){
      const coluna=tabela==='politicas_conversa'?'conversa_id':'evento_id',refs=acao==='UPDATE'?`old.${coluna},new.${coluna}`:`old.${coluna}`;
      const inicio=tabela==='politicas_conversa'?`conversa_id IN(${refs})`:`id IN(${refs})`;
      const afetadas=`e.id IN(WITH RECURSIVE afetados(id) AS (SELECT id FROM eventos WHERE ${inicio} UNION SELECT v.derivado_id FROM priv_vinculos v JOIN afetados a ON v.fonte_id=a.id) SELECT id FROM afetados)`;
      const revogar=`UPDATE lume_projetos_fontes SET invalidada=1 WHERE evento_id IN
        (SELECT e.id FROM desktop_fontes e WHERE ${afetadas} AND NOT COALESCE(${LEITURA_SQL},0));`;
      db.exec(`DROP TRIGGER IF EXISTS lume_projetos_${sufixo}_${nome}; CREATE TRIGGER lume_projetos_${sufixo}_${nome} AFTER ${acao} ON ${tabela} BEGIN ${revogar} END;`);
    }
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcricoes'").get()){
    for(const [acao,nome,ref] of [['UPDATE','alterada','old'],['DELETE','apagada','old'],['INSERT','inserida','new']]){
      db.exec(`CREATE TRIGGER IF NOT EXISTS lume_projetos_transcricao_${nome} AFTER ${acao} ON transcricoes BEGIN
        UPDATE lume_projetos_fontes SET invalidada=1 WHERE evento_id IN
          (SELECT id FROM eventos WHERE conversa_id=${ref}.conversa_id AND origem_id=${ref}.origem_id);
      END;`);
    }
  }
  prepararRevisoesProjetos(db);
  prepararImportados(db);
}

function prepararImportados(db){
  // SQLite exige reconstruir o CHECK; IDs, sequência e gatilhos existentes são preservados.
  if(!db.prepare("SELECT sql FROM sqlite_master WHERE name='lume_projetos_historico'").get().sql.includes("'importado_revisado'")){
    const triggers=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='lume_projetos_historico'").all();
    db.exec('SAVEPOINT migrar_historico_importados');
    try{
      const sequencia=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='lume_projetos_historico'").get()?.seq??0;
      db.exec(`CREATE TABLE lume_projetos_historico_novo(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projeto_id TEXT NOT NULL REFERENCES lume_projetos_comerciais(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL CHECK(tipo IN('criado','confirmado','arquivado','restaurado','fonte_vinculada','fonte_desvinculada','importado_revisado')),
        fonte_id TEXT REFERENCES lume_projetos_fontes(id) ON DELETE SET NULL,quando TEXT NOT NULL);
        INSERT INTO lume_projetos_historico_novo SELECT * FROM lume_projetos_historico;
        DROP TABLE lume_projetos_historico;
        ALTER TABLE lume_projetos_historico_novo RENAME TO lume_projetos_historico;
        CREATE INDEX lume_projetos_historico_projeto ON lume_projetos_historico(projeto_id,id);`);
      db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='lume_projetos_historico'").run(sequencia);
      for(const {sql} of triggers)db.exec(sql);
      db.exec('RELEASE migrar_historico_importados');
    }catch(e){db.exec('ROLLBACK TO migrar_historico_importados;RELEASE migrar_historico_importados');throw e;}
  }
  // Autoridade apenas deste perfil. Não exportar/importar este cache nem reconstruir
  // sua elegibilidade a partir de nomes, horários, hashes ou de uma prévia antiga.
  db.exec(`CREATE TABLE IF NOT EXISTS lume_projetos_importados_guardas(
    fonte_id TEXT PRIMARY KEY REFERENCES lume_projetos_fontes(id) ON DELETE CASCADE,
    versao TEXT NOT NULL DEFAULT(lower(hex(randomblob(16)))),
    bloqueada INTEGER NOT NULL DEFAULT 0 CHECK(bloqueada IN(0,1)));
    INSERT OR IGNORE INTO lume_projetos_importados_guardas(fonte_id,bloqueada)
      SELECT id,CASE WHEN invalidada=1 OR removida=1 THEN 1 ELSE 0 END FROM lume_projetos_fontes;
    CREATE TRIGGER IF NOT EXISTS lume_projetos_importados_inserida AFTER INSERT ON lume_projetos_fontes BEGIN
      INSERT INTO lume_projetos_importados_guardas(fonte_id,bloqueada) VALUES(new.id,MAX(new.invalidada,new.removida));
    END;
    CREATE TRIGGER IF NOT EXISTS lume_projetos_importados_alterada AFTER UPDATE ON lume_projetos_fontes BEGIN
      UPDATE lume_projetos_importados_guardas SET versao=lower(hex(randomblob(16))),
        bloqueada=MAX(bloqueada,CASE WHEN new.invalidada=1
          OR old.removida IS NOT new.removida OR old.evento_id IS NOT new.evento_id
          OR old.projeto_id IS NOT new.projeto_id OR old.assinatura IS NOT new.assinatura
          OR old.inicio IS NOT new.inicio OR old.tamanho IS NOT new.tamanho
          OR old.selecao IS NOT new.selecao OR old.base IS NOT new.base THEN 1 ELSE 0 END)
      WHERE fonte_id=old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS lume_projetos_importados_projeto AFTER UPDATE ON lume_projetos_comerciais BEGIN
      UPDATE lume_projetos_importados_guardas SET versao=lower(hex(randomblob(16)))
        WHERE fonte_id IN(SELECT id FROM lume_projetos_fontes WHERE projeto_id=old.id);
    END;`);
}

/** Cache de autoridade local, sem conteúdo ou grants; não integra backup/exportação. */
export function prepararRevisoesProjetos(db){
  db.exec(`CREATE TABLE IF NOT EXISTS lume_projetos_revisoes(
    evento_id INTEGER PRIMARY KEY REFERENCES eventos(id) ON DELETE CASCADE,
    versao TEXT NOT NULL DEFAULT(lower(hex(randomblob(16)))));
  `);
  const alterar=onde=>`UPDATE lume_projetos_revisoes SET versao=lower(hex(randomblob(16))) WHERE ${onde};`;
  const campos=['texto','tipo','direcao','permissao','conversa_id','origem_id','recebido_em','projeto_id','origem_compartilhamento','autor_id','autor_e_dono'];
  db.exec(`CREATE TRIGGER IF NOT EXISTS lume_projetos_revisao_evento AFTER UPDATE OF ${campos.join(',')} ON eventos
    WHEN ${campos.map(c=>`old.${c} IS NOT new.${c}`).join(' OR ')} BEGIN ${alterar('evento_id=old.id')} END;`);
  for(const [tabela,sufixo,coluna] of [['politicas_conversa','politica','conversa_id'],['f10_procedencias','procedencia','evento_id']]){
    for(const acao of ['UPDATE','DELETE']){
      const atributo=coluna==='evento_id'?'id':coluna;
      const onde=acao==='UPDATE'?`e.${atributo} IN(old.${coluna},new.${coluna})`:`e.${atributo}=old.${coluna}`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS lume_projetos_revisao_${sufixo}_${acao.toLowerCase()} AFTER ${acao} ON ${tabela}
        BEGIN ${alterar(`evento_id IN(SELECT e.id FROM desktop_fontes e WHERE ${onde} AND NOT COALESCE(${LEITURA_SQL},0))`)} END;`);
    }
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transcricoes'").get()){
    for(const acao of ['UPDATE','DELETE','INSERT']){
      const fontes=[];
      if(acao!=='INSERT')fontes.push('(conversa_id=old.conversa_id AND origem_id=old.origem_id)');
      if(acao!=='DELETE')fontes.push('(conversa_id=new.conversa_id AND origem_id=new.origem_id)');
      db.exec(`CREATE TRIGGER IF NOT EXISTS lume_projetos_revisao_transcricao_${acao.toLowerCase()} AFTER ${acao} ON transcricoes
        BEGIN ${alterar(`evento_id IN(SELECT id FROM eventos WHERE ${fontes.join(' OR ')})`)} END;`);
    }
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_acoes'").get()){
    const camposAcao=['evento_id','chave','fonte_assinatura','tipo','resumo','trecho','trecho_inicio','prazo_citado','autor_id','responsavel_id','estado'];
    db.exec(`CREATE TRIGGER IF NOT EXISTS lume_projetos_revisao_acao_alterada AFTER UPDATE OF ${camposAcao.join(',')} ON lume_acoes
      WHEN ${camposAcao.map(c=>`old.${c} IS NOT new.${c}`).join(' OR ')} BEGIN ${alterar('evento_id IN(old.evento_id,new.evento_id)')} END;
      CREATE TRIGGER IF NOT EXISTS lume_projetos_revisao_acao_apagada AFTER DELETE ON lume_acoes
      BEGIN ${alterar('evento_id=old.evento_id')} END;`);
  }
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_acoes_conversas'").get()){
    for(const acao of ['UPDATE','DELETE']){
      const onde=acao==='UPDATE'?'conversa_id IN(old.conversa_id,new.conversa_id)':'conversa_id=old.conversa_id';
      db.exec(`CREATE TRIGGER IF NOT EXISTS lume_projetos_revisao_organizar_${acao.toLowerCase()} AFTER ${acao} ON lume_acoes_conversas
        BEGIN ${alterar(`evento_id IN(SELECT id FROM eventos WHERE ${onde})`)} END;`);
    }
  }
}

import {ATIVIDADE_COLUNAS} from './atividade-apps.js';
import {randomUUID,createHash} from 'node:crypto';
import {exigirPessoalSemConteudo,TABELAS_PESSOAIS} from './pessoal/preservacao.js';
import {chaveExclusao,chaveConversa} from './exclusoes.js';
import {LEITURA_SQL} from './leitura-sql.js';
import {resolve} from 'node:path';
import {TABELAS_TAREFAS} from './tarefas-esquema.js';
import {ACOES_TABELAS} from './acoes-lume.js';
import {HASH_FONTE_SQL} from './tarefas-esquema.js';
import {NEGOCIOS_BACKUP,NEGOCIO_ATUAL_SQL} from './negocios-desktop.js';
import {TABELAS_COMANDOS} from './comandos-whatsapp.js';
import {TABELAS_WHATSAPP_LABELS} from './whatsapp-labels.js';
import {validarMetadadosAudio} from './audio-desktop-arquivos.js';
import {conferirAvaliacaoVendas} from './vendas/recorte.js';
import {NOTETAKER_COLUNAS} from './notetaker/esquema.js';

const POR_EVENTO=['itens_crm','transcricoes','eventos_financeiros','caixas_jobs'];
const POR_CONVERSA=['crm_execucoes','politicas_conversa','desktop_ia_conversas','lume_acoes_conversas','autorizacoes','saidas','conversa_projetos','f10_conversas','f10_conversas_importadas','lume_vendas_revisoes'];
const CONHECIDAS=new Set(['atividade_apps_dias','projetos','conversa_projetos','eventos','etapas','ciclo_midias','wa_fila_retomada','saude','autorizacoes','saidas','entregas_punk','vigia_estado','batimentos','politicas_conversa','desktop_config','desktop_ia_config','desktop_ia_conversas','desktop_ia_gastos','caixas_config','caixas_jobs','caixas_inventario','linha_tempo','itens_crm','crm_execucoes','eventos_financeiros','pessoas','pessoa_identificadores','rascunhos','conversas_app','falhas_ingestao','grupos_app','grupo_participantes','desktop_vetores','desktop_semantica_config','transcricoes','f10_projetos','f10_conversas','f10_origens','f10_procedencias','f10_recebidos','f10_revogadas','f10_conversas_importadas','priv_excluidos','priv_conversas_excluidas','priv_vinculos','priv_recibos']);
const checksum=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Contrato fechado compartilhado com backup; nomes nunca vêm do arquivo importado.
export const CICLO_COLUNAS=Object.freeze({
  lume_execucao_contextos:['id','acao_id','pacote','integridade','criado_em','expira_em'],
  lume_execucoes:['id','contexto_id','assistente','cliente_id','estado','chave_inicio','assinatura_inicio','autorizada_em','atualizada_em'],
  lume_execucao_eventos:['id','execucao_id','chave','assinatura','tipo','ator','dados','criado_em'],
  wa_cobertura:['id','estado','observado_em','ultimo_lote_em','ultimo_historico_em'],
  wa_interrupcoes:['id','inicio','fim','motivo'],
  wa_recuperacoes:['id','conversa_id','evento_id','modo','estado','pedido_em','atualizado_em','recibo','erro'],
  wa_retomadas:['interrupcao_id','conversa_id'],
  lume_vendas_avaliacoes:['id','conversa_id','assinatura','resultado','avaliado_em'],
  lume_projetos_comerciais:['id','nome','natureza','estado','chave','assinatura_criacao','bases_total','criado_em','atualizado_em'],
  lume_projetos_fontes:['id','projeto_id','evento_id','assinatura','inicio','tamanho','selecao','base','removida','invalidada','criada_em'],
  lume_projetos_historico:['id','projeto_id','tipo','fonte_id','quando'],
  lume_ciclo_importacoes:['tabela','registro_id','backup_sha256','importado_em','estado_original']
});
export const CICLO_TABELAS=Object.freeze(Object.keys(CICLO_COLUNAS));
export const cicloRegistroId=(t,r)=>t==='wa_retomadas'?JSON.stringify([r.interrupcao_id,r.conversa_id]):String(r.id);
export function prepararProcedenciaCiclo(db){
  db.exec(`CREATE TABLE IF NOT EXISTS lume_ciclo_importacoes(
    tabela TEXT NOT NULL,registro_id TEXT NOT NULL,backup_sha256 TEXT NOT NULL,
    importado_em TEXT NOT NULL,estado_original TEXT,PRIMARY KEY(tabela,registro_id));`);
  for(const tabela of CICLO_TABELAS.filter(t=>t!=='lume_ciclo_importacoes')){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tabela))continue;
    const referencia=tabela==='wa_retomadas'?'json_array(old.interrupcao_id,old.conversa_id)':'CAST(old.id AS TEXT)';
    db.exec(`CREATE TRIGGER IF NOT EXISTS ciclo_importacao_remove_${tabela} AFTER DELETE ON ${tabela} BEGIN
      DELETE FROM lume_ciclo_importacoes WHERE tabela='${tabela}' AND registro_id=${referencia}; END;`);
  }
}
for(const t of [...CICLO_TABELAS,'lume_execucao_migracoes','lume_execucao_contexto_grants','lume_execucao_contexto_guardas','lume_vendas_revisoes','lume_projetos_revisoes','lume_projetos_importados_guardas'])CONHECIDAS.add(t);
for(const t of TABELAS_TAREFAS)CONHECIDAS.add(t);
for(const t of ACOES_TABELAS)CONHECIDAS.add(t);
for(const t of NEGOCIOS_BACKUP)CONHECIDAS.add(t);
for(const t of TABELAS_COMANDOS)CONHECIDAS.add(t);
for(const t of TABELAS_WHATSAPP_LABELS)CONHECIDAS.add(t);
for(const t of Object.keys(NOTETAKER_COLUNAS))CONHECIDAS.add(t);
export class Privacidade {
  constructor(db,{arquivos=null}={}){this.db=db;this.arquivos=arquivos;this.previas=new Map();}
  tem(t){return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));}
  schemaConhecido({consultaAnexos=false}={}){if(!consultaAnexos)exigirPessoalSemConteudo(this.db);const conhecidas=consultaAnexos?new Set([...CONHECIDAS,...TABELAS_PESSOAIS]):CONHECIDAS;for(const {name} of this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())if(!conhecidas.has(name)&&!name.startsWith('sqlite_')&&!/^desktop_fontes_fts(?:_(?:data|idx|docsize|config))?$/.test(name)){
    // Nome do schema nunca interpolado antes de ser quoted.
    if(this.db.prepare('SELECT 1 FROM "'+name.replaceAll('"','""')+'" LIMIT 1').get())throw new Error('Há dados de uma extensão não mapeada. A exclusão foi interrompida para não deixar conteúdo sem cobertura.');
  }for(const t of CICLO_TABELAS)if(this.tem(t)&&this.db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name).sort().join('|')!==[...CICLO_COLUNAS[t]].sort().join('|'))throw new Error('O esquema do ciclo de conversas mudou. Atualize o mapeamento antes de exportar ou excluir.');
  if(this.tem('atividade_apps_dias')&&this.db.prepare('PRAGMA table_info(atividade_apps_dias)').all().map(c=>c.name).join(',')!==ATIVIDADE_COLUNAS.join(','))throw Error('O esquema de atividade mudou. Atualize o mapeamento de privacidade.');
  if(this.tem('wa_fila_retomada')){
    const cols=this.db.prepare('PRAGMA table_info(wa_fila_retomada)').all();
    if(cols.map(c=>c.name).join(',')!=='interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em'||
      cols.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name).join(',')!=='interrupcao_id,conversa_id')
      throw new Error('O esquema da fila de histórico mudou. Atualize o mapeamento antes de excluir.');
  }
  if(this.tem('ciclo_midias')&&this.db.prepare('PRAGMA table_info(ciclo_midias)').all().map(c=>c.name).sort().join('|')!==
    ['evento_id','caminho','sha256','mime','tamanho','criado_em'].sort().join('|'))throw new Error('O esquema dos originais de mídia mudou. Atualize o mapeamento antes de excluir.');
  // O catálogo reconhece a migração, mas v8 não pode exportar/excluir reunião.
  // Direitos e backup v9 serão tratados na 11-03; falhar fechado enquanto houver dados.
  if(this.tem('notetaker_sessoes')&&this.db.prepare('SELECT 1 FROM notetaker_sessoes LIMIT 1').get())throw new Error('Há sessões locais sem contrato de backup e exclusão v9.');}
  dadosCiclo(ids,{exportacao=false,tudo=false,conversa=''}={}){
    const escolhidos=new Set(ids),ler=t=>this.tem(t)?this.db.prepare(`SELECT ${CICLO_COLUNAS[t].join(',')} FROM ${t}`).all():[];
    const todasFontes=this.db.prepare('SELECT id,conversa_id FROM eventos').all(),conversas=new Set(todasFontes.filter(e=>escolhidos.has(e.id)).map(e=>e.conversa_id));
    if(conversa)conversas.add(conversa);
    const completo=tudo||exportacao&&!conversa&&todasFontes.every(e=>escolhidos.has(e.id));
    const json=value=>{try{return JSON.parse(value);}catch{return null;}};
    const acoes=this.tem('lume_acoes')?this.db.prepare('SELECT id,evento_id FROM lume_acoes').all():[],porAcao=new Map(acoes.map(a=>[a.id,a.evento_id]));
    const fontesContexto=new Map(this.tem('lume_execucao_contexto_guardas')?this.db.prepare('SELECT contexto_id,evento_id FROM lume_execucao_contexto_guardas').all().map(g=>[g.contexto_id,g.evento_id]):[]);
    const r={};
    r.lume_execucao_contextos=ler('lume_execucao_contextos').filter(c=>{
      const integridade=json(c.integridade),atualId=porAcao.get(c.acao_id);
      let fonteId=fontesContexto.get(c.id);
      if(!fontesContexto.has(c.id)){
        // Contexto recém-restaurado ainda não tem guarda local. O hash contém
        // identidade da mensagem; só uma correspondência inequívoca serve.
        const fontes=this.db.prepare(`SELECT e.id FROM desktop_fontes e WHERE ${HASH_FONTE_SQL}=? LIMIT 2`).all(integridade?.fonte??null);
        fonteId=fontes.length===1?fontes[0].id:null;
      }
      // Uma origem desconhecida não amplia a exclusão para outras conversas.
      // Nesses legados, segue o vínculo atual da ação ou a exclusão completa;
      // a exportação continua exigindo a fonte original íntegra abaixo.
      if(!completo&&!escolhidos.has(fonteId)&&!escolhidos.has(atualId))return false;
      if(!exportacao)return true;
      return escolhidos.has(atualId)&&escolhidos.has(fonteId)&&integridade?.fonte===this.db.prepare(`SELECT ${HASH_FONTE_SQL} assinatura FROM desktop_fontes e WHERE id=?`).get(fonteId)?.assinatura;
    });
    const contextos=new Set(r.lume_execucao_contextos.map(c=>c.id));
    r.lume_execucoes=ler('lume_execucoes').filter(x=>!exportacao&&completo||contextos.has(x.contexto_id));
    const execucoes=new Set(r.lume_execucoes.map(x=>x.id));
    r.lume_execucao_eventos=ler('lume_execucao_eventos').filter(e=>!exportacao&&completo||execucoes.has(e.execucao_id));
    // Cobertura/interrupções agregam todo o perfil; não há recorte por fonte.
    // Na exclusão de qualquer fonte, descartar esse resumo evita reter metadados sem escopo.
    const globais=completo||!exportacao&&(escolhidos.size>0||Boolean(conversa));
    r.wa_cobertura=globais?ler('wa_cobertura'):[];
    r.wa_interrupcoes=globais?ler('wa_interrupcoes'):[];
    r.wa_recuperacoes=ler('wa_recuperacoes').filter(x=>exportacao?escolhidos.has(x.evento_id)&&todasFontes.some(e=>e.id===x.evento_id&&e.conversa_id===x.conversa_id):completo||conversas.has(x.conversa_id)||escolhidos.has(x.evento_id));
    const interrupcoes=new Set(r.wa_interrupcoes.map(x=>x.id));
    r.wa_retomadas=ler('wa_retomadas').filter(x=>exportacao?interrupcoes.has(x.interrupcao_id)&&conversas.has(x.conversa_id)&&todasFontes.filter(e=>e.conversa_id===x.conversa_id).every(e=>escolhidos.has(e.id)):globais||conversas.has(x.conversa_id));
    r.lume_vendas_avaliacoes=ler('lume_vendas_avaliacoes').filter(x=>{
      if(!exportacao)return completo||conversas.has(x.conversa_id);
      const resultado=json(x.resultado),fontes=resultado?.fontes;
      if(!Array.isArray(fontes)||!fontes.length||!fontes.every(id=>escolhidos.has(id)))return false;
      const {fonteAlterada,contextoAlterado}=conferirAvaliacaoVendas(this.db,x,resultado);
      return !fonteAlterada&&!contextoAlterado;
    });
    const links=ler('lume_projetos_fontes');
    const fontePermitida=f=>escolhidos.has(f.evento_id)&&!f.removida&&!f.invalidada&&f.assinatura===this.db.prepare(`SELECT ${HASH_FONTE_SQL} assinatura FROM desktop_fontes e WHERE id=?`).get(f.evento_id)?.assinatura;
    r.lume_projetos_comerciais=ler('lume_projetos_comerciais').filter(p=>{
      const fontes=links.filter(f=>f.projeto_id===p.id);
      if(!exportacao)return completo||fontes.some(f=>f.base&&escolhidos.has(f.evento_id));
      const bases=fontes.filter(f=>f.base);return bases.length===p.bases_total&&bases.every(fontePermitida);
    });
    const projetos=new Set(r.lume_projetos_comerciais.map(p=>p.id));
    r.lume_projetos_fontes=links.filter(f=>exportacao?projetos.has(f.projeto_id)&&fontePermitida(f):projetos.has(f.projeto_id)||escolhidos.has(f.evento_id));
    const fontesProjeto=new Set(r.lume_projetos_fontes.map(f=>f.id));
    r.lume_projetos_historico=ler('lume_projetos_historico').filter(h=>exportacao?projetos.has(h.projeto_id)&&(h.fonte_id===null||fontesProjeto.has(h.fonte_id)):projetos.has(h.projeto_id)||fontesProjeto.has(h.fonte_id));
    const refs=new Set(Object.entries(r).flatMap(([t,rows])=>rows.map(row=>JSON.stringify([t,cicloRegistroId(t,row)]))));
    r.lume_ciclo_importacoes=ler('lume_ciclo_importacoes').filter(x=>!exportacao&&completo||refs.has(JSON.stringify([x.tabela,x.registro_id])));
    return r;
  }
  excluirCiclo(dados){
    for(const t of [...CICLO_TABELAS].reverse())if(this.tem(t))for(const row of dados[t]||[]){
      if(t==='lume_ciclo_importacoes')this.db.prepare('DELETE FROM lume_ciclo_importacoes WHERE tabela=? AND registro_id=?').run(row.tabela,row.registro_id);
      else if(t==='wa_retomadas')this.db.prepare('DELETE FROM wa_retomadas WHERE interrupcao_id=? AND conversa_id=?').run(row.interrupcao_id,row.conversa_id);
      else this.db.prepare(`DELETE FROM ${t} WHERE id=?`).run(row.id);
    }
  }
  selecionar({conversa='',fonte=null,tudo=false,origem=''}={}){
    if(typeof origem!=='string'||origem&&!/^[a-f0-9]{64}$/.test(origem)||typeof conversa!=='string'||conversa.length>200||typeof tudo!=='boolean'||fonte!==null&&(!Number.isSafeInteger(fonte)||fonte<1)||Number(Boolean(conversa))+Number(fonte!==null)+Number(tudo)+Number(Boolean(origem))!==1)throw new Error('Escolha uma fonte, uma conversa, uma origem ou todo o histórico.');
    const where=tudo?'1':fonte?'id=?':'conversa_id=?',args=tudo?[]:[fonte||conversa];
    const contribuicoes=origem?this.db.prepare('SELECT DISTINCT e.* FROM eventos e JOIN f10_procedencias p ON p.evento_id=e.id WHERE p.fingerprint=? ORDER BY e.id').all(origem):[];
    if(origem&&!this.db.prepare('SELECT 1 FROM f10_origens WHERE fingerprint=?').get(origem))throw new Error('Origem não encontrada.');
    const outra=id=>Boolean(this.db.prepare('SELECT 1 FROM f10_procedencias WHERE evento_id=? AND fingerprint<>?').get(id,origem));
    const preservados=new Set(contribuicoes.filter(e=>e.permissao!=='compartilhado'||outra(e.id)).map(e=>e.id));
    const base=origem?contribuicoes.filter(e=>!preservados.has(e.id)).map(e=>e.id):this.db.prepare(`SELECT id FROM eventos WHERE ${where}`).all(...args).map(r=>r.id),ids=new Set(base),fila=[...base];
    while(fila.length){const atual=fila.pop();for(const {derivado_id} of this.db.prepare('SELECT derivado_id FROM priv_vinculos WHERE fonte_id=?').all(atual))if(!ids.has(derivado_id)&&!(origem&&(preservados.has(derivado_id)||outra(derivado_id)))){ids.add(derivado_id);fila.push(derivado_id);}}
    return {filtro:{conversa,fonte,tudo,origem},ids:[...ids].sort((a,b)=>a-b),derivadas:ids.size-base.length,preservados:[...preservados],fontesOrigem:base.length};
  }
  mapa(filtro){
    this.schemaConhecido();const selection=this.selecionar(filtro);
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS priv_alvo(id INTEGER PRIMARY KEY);DELETE FROM priv_alvo');
    const ins=this.db.prepare('INSERT INTO priv_alvo VALUES(?)');for(const id of selection.ids)ins.run(id);
    const match=`EXISTS(SELECT 1 FROM eventos e JOIN priv_alvo a ON a.id=e.id WHERE e.conversa_id=t.conversa_id AND e.origem_id=t.origem_id)`;
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS priv_sugestoes(id TEXT PRIMARY KEY);DELETE FROM priv_sugestoes;CREATE TEMP TABLE IF NOT EXISTS priv_itens(id INTEGER PRIMARY KEY);DELETE FROM priv_itens');
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS priv_comandos(id INTEGER PRIMARY KEY);DELETE FROM priv_comandos');
    this.db.exec('CREATE TEMP TABLE IF NOT EXISTS priv_whatsapp_assoc(conta_id TEXT,conversa_id TEXT,message_id TEXT,label_id TEXT,PRIMARY KEY(conta_id,conversa_id,message_id,label_id));DELETE FROM priv_whatsapp_assoc;CREATE TEMP TABLE IF NOT EXISTS priv_whatsapp_labels(conta_id TEXT,label_id TEXT,PRIMARY KEY(conta_id,label_id));DELETE FROM priv_whatsapp_labels');
    if(this.tem('whatsapp_label_associacoes')){
      if(filtro.tudo)this.db.exec('INSERT INTO priv_whatsapp_assoc SELECT conta_id,conversa_id,message_id,label_id FROM whatsapp_label_associacoes');
      else if(filtro.conversa)this.db.prepare('INSERT INTO priv_whatsapp_assoc SELECT conta_id,conversa_id,message_id,label_id FROM whatsapp_label_associacoes WHERE conversa_id=?').run(filtro.conversa);
      else this.db.exec("INSERT INTO priv_whatsapp_assoc SELECT a.conta_id,a.conversa_id,a.message_id,a.label_id FROM whatsapp_label_associacoes a WHERE (a.message_id<>'' AND EXISTS(SELECT 1 FROM eventos e JOIN priv_alvo p ON p.id=e.id WHERE e.conversa_id=a.conversa_id AND e.origem_id=a.message_id)) OR (a.message_id='' AND EXISTS(SELECT 1 FROM eventos e JOIN priv_alvo p ON p.id=e.id WHERE e.conversa_id=a.conversa_id) AND NOT EXISTS(SELECT 1 FROM eventos e WHERE e.conversa_id=a.conversa_id AND e.id NOT IN(SELECT id FROM priv_alvo)))");
      if(filtro.tudo)this.db.exec('INSERT INTO priv_whatsapp_labels SELECT conta_id,label_id FROM whatsapp_labels');
      else this.db.exec(`INSERT INTO priv_whatsapp_labels SELECT DISTINCT a.conta_id,a.label_id FROM priv_whatsapp_assoc a WHERE NOT EXISTS(SELECT 1 FROM whatsapp_label_associacoes x WHERE x.conta_id=a.conta_id AND x.label_id=a.label_id AND NOT EXISTS(SELECT 1 FROM priv_whatsapp_assoc p WHERE p.conta_id=x.conta_id AND p.conversa_id=x.conversa_id AND p.message_id=x.message_id AND p.label_id=x.label_id))`);
    }
    if(this.tem('lume_comandos'))this.db.exec(`INSERT INTO priv_comandos SELECT id FROM lume_comandos WHERE evento_id IN(SELECT id FROM priv_alvo)`);
    if(this.tem('desktop_tarefas_sugestoes')){
      this.db.exec(`INSERT INTO priv_sugestoes SELECT s.id FROM desktop_tarefas_sugestoes s WHERE ${filtro.tudo?'1':`s.evento_id IN(SELECT id FROM priv_alvo) OR EXISTS(SELECT 1 FROM desktop_tarefas_fontes tf JOIN priv_alvo a ON a.id=tf.evento_id WHERE tf.sugestao_id=s.id)`};
        INSERT OR IGNORE INTO priv_itens SELECT item_id FROM desktop_tarefas_sugestoes WHERE id IN(SELECT id FROM priv_sugestoes) AND item_id IS NOT NULL`);
    }
    const matchCrm=`(${match} OR t.id IN(SELECT id FROM priv_itens))`;
    const contagens={eventos:selection.ids.length,notasDerivadas:selection.derivadas,...(selection.filtro.origem?{fontesOrigem:selection.fontesOrigem,originaisPreservados:selection.preservados.length}:{})};
    const arquivos=[];
    const midias=this.tem('ciclo_midias')?this.db.prepare('SELECT m.* FROM ciclo_midias m JOIN priv_alvo a ON a.id=m.evento_id ORDER BY m.evento_id').all():[];
    contagens.ciclo_midias=midias.length;
    arquivos.push(...midias.map(m=>m.caminho));
    for(const t of POR_EVENTO)if(this.tem(t)){
      contagens[t]=this.db.prepare(`SELECT COUNT(*) n FROM ${t} t WHERE ${t==='itens_crm'?matchCrm:match}`).get().n;
      const col=t==='transcricoes'?'arquivo':t==='caixas_jobs'?'arquivo_caminho':null;
      if(col)arquivos.push(...this.db.prepare(`SELECT ${col} caminho FROM ${t} t WHERE ${match} AND ${col} IS NOT NULL AND ${col}<>''`).all().map(x=>x.caminho));
    }
    if(this.tem('rascunhos'))contagens.rascunhos=this.db.prepare(`SELECT COUNT(*) n FROM rascunhos WHERE item_id IN(SELECT t.id FROM itens_crm t WHERE ${matchCrm})`).get().n;
    const sugestoes=this.tem('desktop_tarefas_sugestoes')?this.db.prepare('SELECT * FROM desktop_tarefas_sugestoes WHERE id IN(SELECT id FROM priv_sugestoes) ORDER BY id').all():[];
    const fontesTarefas=this.tem('desktop_tarefas_fontes')?this.db.prepare('SELECT * FROM desktop_tarefas_fontes WHERE sugestao_id IN(SELECT id FROM priv_sugestoes) ORDER BY sugestao_id,evento_id').all():[];
    contagens.desktop_tarefas_sugestoes=sugestoes.length;contagens.desktop_tarefas_fontes=fontesTarefas.length;
    const acoes=this.tem('lume_acoes')?this.db.prepare(`SELECT * FROM lume_acoes WHERE evento_id IN(SELECT id FROM priv_alvo) ORDER BY id`).all():[];
    const idsAcoes=new Set(acoes.map(a=>a.id));
    const historicoAcoes=this.tem('lume_acoes_historico')?this.db.prepare('SELECT * FROM lume_acoes_historico ORDER BY id').all().filter(h=>idsAcoes.has(h.acao_id)):[];
    contagens.lume_acoes=acoes.length;contagens.lume_acoes_historico=historicoAcoes.length;
    const negocios=this.tem('desktop_negocios')?this.db.prepare(`SELECT * FROM desktop_negocios ${filtro.tudo?'':'WHERE evento_id IN(SELECT id FROM priv_alvo)'} ORDER BY id`).all():[];
    const historicoNegocios=this.tem('desktop_negocios_historico')?this.db.prepare(`SELECT h.* FROM desktop_negocios_historico h JOIN desktop_negocios n ON n.id=h.negocio_id ${filtro.tudo?'':'WHERE n.evento_id IN(SELECT id FROM priv_alvo)'} ORDER BY h.negocio_id,h.revisao`).all():[];
    contagens.desktop_negocios=negocios.length;contagens.desktop_negocios_historico=historicoNegocios.length;
    const comandos=this.tem('lume_comandos')?this.db.prepare('SELECT * FROM lume_comandos WHERE id IN(SELECT id FROM priv_comandos) ORDER BY id').all():[];
    const comandosTarefas=this.tem('lume_comando_tarefas')?this.db.prepare('SELECT * FROM lume_comando_tarefas WHERE comando_id IN(SELECT id FROM priv_comandos) ORDER BY id').all():[];
    const comandosLembretes=this.tem('lume_comando_lembretes')?this.db.prepare('SELECT * FROM lume_comando_lembretes WHERE comando_id IN(SELECT id FROM priv_comandos) ORDER BY id').all():[];
    const tagsEntidades=this.tem('lume_tags_entidades')?this.db.prepare('SELECT * FROM lume_tags_entidades WHERE comando_id IN(SELECT id FROM priv_comandos) ORDER BY comando_id,tag_id,entidade_tipo,entidade_id').all():[];
    const tagIds=new Set(tagsEntidades.map(a=>a.tag_id));
    const tags=this.tem('lume_tags')?this.db.prepare('SELECT * FROM lume_tags ORDER BY id').all().filter(t=>tagIds.has(t.id)):[];
    Object.assign(contagens,{lume_comandos:comandos.length,lume_comando_tarefas:comandosTarefas.length,lume_comando_lembretes:comandosLembretes.length,lume_tags_entidades:tagsEntidades.length,lume_tags:tags.length});
    const whatsappAssociacoes=this.tem('whatsapp_label_associacoes')?this.db.prepare('SELECT a.* FROM whatsapp_label_associacoes a JOIN priv_whatsapp_assoc p USING(conta_id,conversa_id,message_id,label_id) ORDER BY a.conta_id,a.conversa_id,a.message_id,a.label_id').all():[];
    const whatsappLabels=this.tem('whatsapp_labels')?this.db.prepare('SELECT l.* FROM whatsapp_labels l JOIN priv_whatsapp_labels p USING(conta_id,label_id) ORDER BY l.conta_id,l.label_id').all():[];
    const whatsappObservacoes=this.tem('whatsapp_label_observacoes')?this.db.prepare(`SELECT o.* FROM whatsapp_label_observacoes o WHERE (o.tipo='associacao' AND EXISTS(SELECT 1 FROM priv_whatsapp_assoc p WHERE p.conta_id=o.conta_id AND p.conversa_id=o.conversa_id AND p.message_id=o.message_id AND p.label_id=o.label_id)) OR (o.tipo='definicao' AND EXISTS(SELECT 1 FROM priv_whatsapp_labels p WHERE p.conta_id=o.conta_id AND p.label_id=o.label_id)) ORDER BY o.id`).all():[];
    Object.assign(contagens,{whatsapp_label_associacoes:whatsappAssociacoes.length,whatsapp_labels:whatsappLabels.length,whatsapp_label_observacoes:whatsappObservacoes.length});
    if(this.tem('desktop_tarefas_analises'))contagens.desktop_tarefas_analises=this.db.prepare(`SELECT COUNT(*) n FROM desktop_tarefas_analises ${filtro.tudo?'':'WHERE evento_id IN(SELECT id FROM priv_alvo)'}`).get().n;
    for(const t of ['etapas','desktop_vetores','f10_procedencias'])if(this.tem(t))contagens[t]=this.db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE evento_id IN(SELECT id FROM priv_alvo)`).get().n;
    const caixas=this.tem('caixas_jobs')?this.db.prepare(`SELECT t.id FROM caixas_jobs t WHERE ${match}`).all().map(x=>x.id):[];
    for(const t of ['caixas_inventario','linha_tempo'])if(this.tem(t)){
      const rows=filtro.tudo?this.db.prepare(`SELECT * FROM ${t}`).all():caixas.flatMap(id=>this.db.prepare(`SELECT * FROM ${t} WHERE caixa_id=?`).all(id));contagens[t]=rows.length;
      if(t==='caixas_inventario')arquivos.push(...rows.map(r=>r.arquivo_conversa).filter(Boolean));
    }
    if(filtro.tudo){for(const t of POR_EVENTO)if(this.tem(t)){
      contagens[t]=this.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
      const col=t==='transcricoes'?'arquivo':t==='caixas_jobs'?'arquivo_caminho':null;if(col)arquivos.push(...this.db.prepare(`SELECT ${col} caminho FROM ${t} WHERE ${col} IS NOT NULL AND ${col}<>''`).all().map(r=>r.caminho));
    }if(this.tem('rascunhos'))contagens.rascunhos=this.db.prepare('SELECT COUNT(*) n FROM rascunhos').get().n;}
    contagens.falhas_ingestao=this.db.prepare('SELECT COUNT(*) n FROM falhas_ingestao').get().n;
    if(filtro.tudo&&this.tem('atividade_apps_dias'))contagens.atividade_apps_dias=this.db.prepare('SELECT COUNT(*) n FROM atividade_apps_dias').get().n;
    contagens.saude=this.db.prepare('SELECT COUNT(*) n FROM saude').get().n;
    contagens.entregas_punk=this.db.prepare('SELECT COUNT(*) n FROM entregas_punk').get().n;
    contagens.saidas=this.db.prepare(`SELECT COUNT(*) n FROM saidas ${filtro.tudo?'':'WHERE conversa_id IN(SELECT e.conversa_id FROM eventos e JOIN priv_alvo a ON a.id=e.id)'}`).get().n;
    const comparar=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p),preservar=new Set();
    if(!filtro.tudo){
      if(this.tem('ciclo_midias'))for(const row of this.db.prepare('SELECT caminho FROM ciclo_midias WHERE evento_id NOT IN(SELECT id FROM priv_alvo)').all())preservar.add(comparar(row.caminho));
      for(const [t,col] of [['transcricoes','arquivo'],['caixas_jobs','arquivo_caminho']])if(this.tem(t))for(const row of this.db.prepare(`SELECT ${col} caminho FROM ${t} t WHERE NOT(${match}) AND ${col} IS NOT NULL AND ${col}<>''`).all())preservar.add(comparar(row.caminho));
      if(this.tem('caixas_inventario'))for(const row of this.db.prepare('SELECT caixa_id,arquivo_conversa caminho FROM caixas_inventario WHERE arquivo_conversa IS NOT NULL').all())if(!caixas.includes(row.caixa_id)&&row.caminho)preservar.add(comparar(row.caminho));
    }
    if(filtro.tudo&&this.arquivos)arquivos.push(...this.arquivos.listarAnexos());
    const unicos=[...new Set(arquivos)],paths=unicos.filter(p=>!preservar.has(comparar(p))).sort();
    contagens.arquivosCompartilhadosPreservados=unicos.length-paths.length;
    if(paths.length&&!this.arquivos)throw new Error('Há anexos. Abra o perfil desktop com gestão de arquivos para excluí-los.');
    for(const path of paths)this.arquivos.conferir(path);
    const rows=this.db.prepare('SELECT e.* FROM eventos e JOIN priv_alvo a ON a.id=e.id ORDER BY e.id').all();
    const origem=selection.filtro.origem?this.db.prepare('SELECT * FROM f10_procedencias WHERE fingerprint=? ORDER BY evento_id,pacote_id,projeto_id').all(selection.filtro.origem):null;
    const ciclo=this.dadosCiclo([...selection.ids,...selection.preservados],{tudo:filtro.tudo,conversa:filtro.conversa});
    for(const [t,rs] of Object.entries(ciclo))contagens[t]=rs.length;
    return {...selection,contagens,arquivos:paths,caixas,ciclo,assinatura:checksum({rows,midias,contagens,paths,origem,preservados:selection.preservados,sugestoes,fontesTarefas,acoes,historicoAcoes,negocios,historicoNegocios,comandos,comandosTarefas,comandosLembretes,tagsEntidades,tags,whatsappAssociacoes,whatsappLabels,whatsappObservacoes,ciclo}),match,matchCrm};
  }
  preparar(filtro){const m=this.mapa(filtro),id=randomUUID();this.previas.clear();this.previas.set(id,{filtro:m.filtro,assinatura:m.assinatura,expira:Date.now()+300000});return {id,contagens:m.contagens,arquivos:m.arquivos,aviso:'Inclui conteúdo oculto, notas vinculadas, negócios e suas alterações registradas. Saídas preparadas das conversas atingidas, diagnósticos e registros locais de entrega ao Punk serão limpos. Cópias manuais, exports e backups externos permanecem. Captura e IA serão pausadas. Nome, aceite e credenciais do perfil permanecem.'};}
  excluir({id,confirmar}={}){
    const p=this.previas.get(id);if(!p||p.expira<Date.now())throw new Error('Prévia expirada. Confira novamente.');
    const palavra=p.filtro.origem?'REMOVER':'APAGAR';if(confirmar!==palavra)throw new Error(`Digite ${palavra} para confirmar.`);this.previas.delete(id);
    const m=this.mapa(p.filtro);if(m.assinatura!==p.assinatura)throw new Error('Os dados mudaram. Confira uma nova prévia antes de apagar.');
    const reciboId=randomUUID(),now=new Date().toISOString();let op=null,commit=false;
    this.db.exec('PRAGMA secure_delete=ON;BEGIN IMMEDIATE');
    try{
      // Confere novamente sob bloqueio de escrita (outro processo pode ter escrito).
      const atual=this.mapa(p.filtro);if(atual.assinatura!==p.assinatura)throw new Error('Os dados mudaram. Confira novamente.');
      op=this.arquivos?.preparar(reciboId,m.arquivos);
      this.excluirCiclo(atual.ciclo);
      if(m.filtro.origem){
        this.db.prepare('INSERT OR REPLACE INTO f10_revogadas VALUES(?,?)').run(m.filtro.origem,now);
        this.db.prepare('DELETE FROM f10_procedencias WHERE fingerprint=?').run(m.filtro.origem);
        this.db.prepare('DELETE FROM f10_recebidos WHERE fingerprint=?').run(m.filtro.origem);
        for(const id of m.preservados){
          const lista=this.db.prepare(`SELECT f.fingerprint,COALESCE(f.pessoa,o.pessoa) pessoa,COALESCE(f.maquina,o.maquina) maquina,f.exportado_em,f.importado_em,f.pacote_id,f.projeto_id FROM f10_procedencias f JOIN f10_origens o USING(fingerprint) WHERE f.evento_id=? ORDER BY f.fingerprint,f.pacote_id,f.projeto_id`).all(id);
          this.db.prepare('UPDATE eventos SET origem_compartilhamento=? WHERE id=?').run(lista.length?JSON.stringify(lista):null,id);
        }
      }
      const eventos=this.db.prepare('SELECT e.* FROM eventos e JOIN priv_alvo a ON a.id=e.id').all();
      const pessoasAlvo=new Set(eventos.flatMap(e=>[e.autor_id,e.conversa_id]).filter(Boolean));
      for(const e of eventos)this.db.prepare('INSERT OR IGNORE INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(e.conversa_id,e.origem_id),now);
      const convs=new Set(eventos.map(e=>e.conversa_id));if(m.filtro.conversa)convs.add(m.filtro.conversa);
      if(m.filtro.tudo)for(const c of this.db.prepare('SELECT id FROM conversas_app').all())convs.add(c.id);
      for(const c of convs)for(const r of this.db.prepare('SELECT participante_id FROM grupo_participantes WHERE grupo_id=?').all(c))pessoasAlvo.add(r.participante_id);
      for(const c of convs)this.db.prepare('INSERT OR IGNORE INTO priv_conversas_excluidas VALUES(?,?)').run(chaveConversa(c),now);
      if(this.tem('rascunhos'))this.db.prepare(`DELETE FROM rascunhos ${m.filtro.tudo?'':`WHERE item_id IN(SELECT t.id FROM itens_crm t WHERE ${m.matchCrm})`}`).run();
      if(this.tem('desktop_tarefas_sugestoes'))this.db.exec('DELETE FROM desktop_tarefas_sugestoes WHERE id IN(SELECT id FROM priv_sugestoes)');
      if(this.tem('desktop_negocios'))this.db.exec(`DELETE FROM desktop_negocios ${m.filtro.tudo?'':'WHERE evento_id IN(SELECT id FROM priv_alvo)'}`);
      if(this.tem('desktop_tarefas_analises'))this.db.exec(`DELETE FROM desktop_tarefas_analises ${m.filtro.tudo?'':'WHERE evento_id IN(SELECT id FROM priv_alvo)'}`);
      if(this.tem('lume_comandos'))this.db.exec(`DELETE FROM lume_tags_entidades WHERE comando_id IN(SELECT id FROM priv_comandos);
          DELETE FROM lume_comando_tarefas WHERE comando_id IN(SELECT id FROM priv_comandos);
          DELETE FROM lume_comando_lembretes WHERE comando_id IN(SELECT id FROM priv_comandos);
          DELETE FROM lume_comandos WHERE id IN(SELECT id FROM priv_comandos);
          DELETE FROM lume_tags WHERE NOT EXISTS(SELECT 1 FROM lume_tags_entidades a WHERE a.tag_id=lume_tags.id);`);
      if(this.tem('whatsapp_label_observacoes'))this.db.exec(`DELETE FROM whatsapp_label_observacoes WHERE (tipo='associacao' AND EXISTS(SELECT 1 FROM priv_whatsapp_assoc p WHERE p.conta_id=whatsapp_label_observacoes.conta_id AND p.conversa_id=whatsapp_label_observacoes.conversa_id AND p.message_id=whatsapp_label_observacoes.message_id AND p.label_id=whatsapp_label_observacoes.label_id)) OR (tipo='definicao' AND EXISTS(SELECT 1 FROM priv_whatsapp_labels p WHERE p.conta_id=whatsapp_label_observacoes.conta_id AND p.label_id=whatsapp_label_observacoes.label_id));DELETE FROM whatsapp_label_associacoes WHERE EXISTS(SELECT 1 FROM priv_whatsapp_assoc p WHERE p.conta_id=whatsapp_label_associacoes.conta_id AND p.conversa_id=whatsapp_label_associacoes.conversa_id AND p.message_id=whatsapp_label_associacoes.message_id AND p.label_id=whatsapp_label_associacoes.label_id);DELETE FROM whatsapp_labels WHERE EXISTS(SELECT 1 FROM priv_whatsapp_labels p WHERE p.conta_id=whatsapp_labels.conta_id AND p.label_id=whatsapp_labels.label_id);`);
      for(const t of ['linha_tempo','caixas_inventario'])if(this.tem(t)){if(m.filtro.tudo)this.db.exec(`DELETE FROM ${t}`);else for(const caixa of m.caixas)this.db.prepare(`DELETE FROM ${t} WHERE caixa_id=?`).run(caixa);}
      for(const t of POR_EVENTO)if(this.tem(t))this.db.prepare(`DELETE FROM ${t} AS t ${m.filtro.tudo?'':'WHERE '+(t==='itens_crm'?m.matchCrm:m.match)}`).run();
      if(this.tem('ciclo_midias'))this.db.exec('DELETE FROM ciclo_midias WHERE evento_id IN(SELECT id FROM priv_alvo)');
      // Saídas não têm vínculo por fonte: descartar todas das conversas atingidas.
      // Recibos do Punk/diagnósticos podem conter cópias em texto e não têm vínculo confiável.
      for(const c of convs)this.db.prepare('DELETE FROM saidas WHERE conversa_id=?').run(c);
      this.db.exec('DELETE FROM eventos WHERE id IN(SELECT id FROM priv_alvo);DELETE FROM falhas_ingestao;DELETE FROM saude;DELETE FROM entregas_punk');
      for(const c of convs){
        if(!this.db.prepare('SELECT 1 FROM eventos WHERE conversa_id=?').get(c)){
          for(const t of POR_CONVERSA)if(this.tem(t))this.db.prepare(`DELETE FROM ${t} WHERE conversa_id=?`).run(c);
          this.db.prepare('DELETE FROM grupos_app WHERE id=?').run(c);this.db.prepare('DELETE FROM conversas_app WHERE id=?').run(c);
        }else if(this.tem('crm_execucoes'))this.db.prepare('DELETE FROM crm_execucoes WHERE conversa_id=?').run(c);
      }
      if(m.filtro.tudo){
        this.db.prepare("DELETE FROM desktop_config WHERE chave='atividade_apps_v1'").run();
        for(const t of ['atividade_apps_dias','grupo_participantes','grupos_app','conversas_app',...POR_CONVERSA,'entregas_punk','vigia_estado','batimentos','f10_recebidos','f10_conversas','f10_projetos','projetos','caixas_config'])if(this.tem(t))this.db.exec(`DELETE FROM ${t}`);
      }
      // Origens sem contribuição deixam só a chave revogada, sem nome/conteúdo.
      this.db.prepare(`INSERT OR IGNORE INTO f10_revogadas SELECT fingerprint,? FROM f10_origens o WHERE NOT EXISTS(SELECT 1 FROM f10_procedencias p WHERE p.fingerprint=o.fingerprint)`).run(now);
      this.db.exec(`DELETE FROM f10_recebidos WHERE fingerprint IN(SELECT fingerprint FROM f10_revogadas);
        DELETE FROM f10_origens WHERE NOT EXISTS(SELECT 1 FROM f10_procedencias p WHERE p.fingerprint=f10_origens.fingerprint);`);
      if(this.tem('pessoa_identificadores')){
        if(m.filtro.tudo)this.db.exec('DELETE FROM pessoa_identificadores;UPDATE pessoas SET fundida_em=NULL;DELETE FROM pessoas');
        else{
          // Explicit protocol aliases can have been created by the same source.
          // Check each against remaining evidence before retaining its metadata.
          const aliases=this.db.prepare(`SELECT identificador FROM pessoa_identificadores
            WHERE pessoa_id=(SELECT pessoa_id FROM pessoa_identificadores WHERE identificador=?)`);
          for(const ident of [...pessoasAlvo])for(const alias of aliases.all(ident))pessoasAlvo.add(alias.identificador);
          const ps=new Set();for(const ident of pessoasAlvo){const r=this.db.prepare('SELECT pessoa_id FROM pessoa_identificadores WHERE identificador=?').get(ident);if(r)ps.add(r.pessoa_id);
            this.db.prepare('DELETE FROM pessoa_identificadores WHERE identificador=? AND NOT EXISTS(SELECT 1 FROM eventos e WHERE e.autor_id=identificador OR e.conversa_id=identificador) AND NOT EXISTS(SELECT 1 FROM grupo_participantes g WHERE g.participante_id=identificador)').run(ident);
            // Contact metadata can materialize a DM before any direct message.
            // Remove that copy when its last supporting identity/source is erased.
            this.db.prepare(`DELETE FROM conversas_app WHERE id=?
              AND NOT EXISTS(SELECT 1 FROM pessoa_identificadores p WHERE p.identificador=conversas_app.id)
              AND NOT EXISTS(SELECT 1 FROM eventos e WHERE e.autor_id=conversas_app.id OR e.conversa_id=conversas_app.id)
              AND NOT EXISTS(SELECT 1 FROM grupo_participantes g WHERE g.participante_id=conversas_app.id)`).run(ident);}
          for(const id of ps)this.db.prepare('DELETE FROM pessoas WHERE id=? AND NOT EXISTS(SELECT 1 FROM pessoa_identificadores p WHERE p.pessoa_id=pessoas.id) AND NOT EXISTS(SELECT 1 FROM pessoas outra WHERE outra.fundida_em=pessoas.id)').run(id);
        }
      }
      if(this.tem('desktop_ia_config'))this.db.exec('UPDATE desktop_ia_config SET habilitada=0,revisao=revisao+1;DELETE FROM desktop_ia_conversas');
      if(this.tem('desktop_tarefas_config'))this.db.exec('UPDATE desktop_tarefas_config SET ativa=0,erro=NULL,ultima_conversa_id=NULL;DELETE FROM desktop_tarefas_conversas');
      if(this.tem('desktop_semantica_config'))this.db.exec('UPDATE desktop_semantica_config SET ativa=0');
      this.db.prepare("INSERT INTO desktop_config VALUES('captura_pausada','1') ON CONFLICT(chave) DO UPDATE SET valor='1'").run();
      const contagens={...m.contagens,arquivos:m.arquivos.length};
      this.db.prepare('INSERT INTO priv_recibos VALUES(?,?,?,?)').run(reciboId,now,op?.pares.length?'arquivos_pendentes':'concluida',JSON.stringify(contagens));
      this.db.exec('COMMIT');commit=true;
      let arquivosPendentes=false;
      try{if(op)this.arquivos.finalizar(op);this.db.prepare("UPDATE priv_recibos SET estado='concluida' WHERE id=?").run(reciboId);}catch{arquivosPendentes=true;}
      let compactado=false;
      try{if(this.tem('desktop_fontes_fts'))this.db.exec("INSERT INTO desktop_fontes_fts(desktop_fontes_fts) VALUES('rebuild')");this.db.exec('VACUUM');const r=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();compactado=!r?.busy;}catch{}
      return {id:reciboId,criadoEm:now,contagens,arquivosPendentes,compactado,tudo:m.filtro.tudo,idsRemovidos:m.filtro.tudo?[]:m.ids,...(m.filtro.origem?{removidos:m.fontesOrigem,preservados:m.preservados.length,derivados:contagens,reimportacaoBloqueada:true,limite:'Cópias externas permanecem. Captura e IA pausadas.'}:{}),estado:arquivosPendentes?'arquivos_pendentes':'concluida',aviso:'Captura, indexação e IA pausadas. Mensagens apagadas não serão reingeridas neste perfil. Backups e cópias externas permanecem; não é apagamento forense do disco.'};
    }catch(e){if(!commit){this.db.exec('ROLLBACK');if(op)this.arquivos.reverter(op);}throw e;}
  }
  exportar({conversa='',incluirOcultas=false,confirmar=false}={}){
    if(confirmar!==true||typeof conversa!=='string'||conversa.length>200||typeof incluirOcultas!=='boolean')throw new Error('Confirme o recorte da exportação pessoal.');
    this.schemaConhecido();
    const where=[incluirOcultas?'1':LEITURA_SQL],args=[];if(conversa){where.push('e.conversa_id=?');args.push(conversa);}
    const eventos=this.db.prepare(`SELECT e.id,e.conversa_id,COALESCE(c.nome,e.conversa_id) conversa_nome,e.origem_id,e.autor_id,e.autor_e_dono,e.tipo,e.texto,e.recebido_em,e.permissao,e.origem_compartilhamento FROM eventos e LEFT JOIN conversas_app c ON c.id=e.conversa_id WHERE ${where.join(' AND ')} ORDER BY e.id`).all(...args);
    const ids=new Set(eventos.map(e=>e.id)),pares=new Set(eventos.map(e=>JSON.stringify([e.conversa_id,e.origem_id]))),derivados={};
    for(const t of ['itens_crm','transcricoes','eventos_financeiros'])if(this.tem(t))derivados[t]=this.db.prepare(`SELECT * FROM ${t}`).all().filter(r=>pares.has(JSON.stringify([r.conversa_id,r.origem_id]))).map(({arquivo,...r})=>r);
    for(const r of derivados.transcricoes||[])if(r.audio_metadados_json!=null){
      if(typeof r.audio_metadados_json!=='string'||r.audio_metadados_json.length>1024*1024)throw new Error('Metadados de áudio local inválidos.');
      const m=JSON.parse(r.audio_metadados_json);validarMetadadosAudio(m);
      if(!m||m.fonte.conversaId!==r.conversa_id||m.fonte.origemId!==r.origem_id||(m.trechos.length?m.trechos.map(t=>t.texto.trim()).join(' '):'(sem fala)')!==r.texto_original)throw new Error('Metadados de áudio local incompatíveis com a fonte.');
    }
    if(this.tem('desktop_tarefas_sugestoes')){
      const fontes=this.db.prepare('SELECT * FROM desktop_tarefas_fontes').all(),porSugestao=new Map();
      for(const f of fontes){if(!porSugestao.has(f.sugestao_id))porSugestao.set(f.sugestao_id,[]);porSugestao.get(f.sugestao_id).push(f);}
      const todas=this.db.prepare('SELECT * FROM desktop_tarefas_sugestoes').all(),permitida=s=>ids.has(s.evento_id)&&s.fontes_total>0&&porSugestao.get(s.id)?.length===s.fontes_total&&porSugestao.get(s.id).every(f=>ids.has(f.evento_id));
      derivados.desktop_tarefas_sugestoes=todas.filter(permitida);
      const incluidos=new Set(derivados.desktop_tarefas_sugestoes.map(s=>s.id));
      derivados.desktop_tarefas_fontes=fontes.filter(f=>incluidos.has(f.sugestao_id));
      const bloqueados=new Set(todas.filter(s=>!permitida(s)).map(s=>s.item_id).filter(Boolean));
      if(derivados.itens_crm)derivados.itens_crm=derivados.itens_crm.filter(i=>!bloqueados.has(i.id));
    }
    if(this.tem('lume_acoes')){
      derivados.lume_acoes=this.db.prepare(`SELECT a.* FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id WHERE a.fonte_assinatura=${HASH_FONTE_SQL} ORDER BY a.id`).all().filter(a=>ids.has(a.evento_id));
      const acoesIds=new Set(derivados.lume_acoes.map(a=>a.id));
      derivados.lume_acoes_historico=this.db.prepare('SELECT * FROM lume_acoes_historico ORDER BY id').all().filter(h=>acoesIds.has(h.acao_id));
    }
    if(this.tem('desktop_negocios')){
      derivados.desktop_negocios=this.db.prepare(`SELECT n.* FROM desktop_negocios n JOIN desktop_fontes e ON e.id=n.evento_id WHERE ${incluirOcultas?'1':NEGOCIO_ATUAL_SQL}`).all().filter(n=>ids.has(n.evento_id));
      const permitidos=new Set(derivados.desktop_negocios.map(n=>n.id));
      derivados.desktop_negocios_historico=this.db.prepare('SELECT * FROM desktop_negocios_historico ORDER BY negocio_id,revisao').all().filter(h=>permitidos.has(h.negocio_id));
    }
    const comandos=this.tem('lume_comandos')?this.db.prepare('SELECT * FROM lume_comandos ORDER BY id').all().filter(c=>ids.has(c.evento_id)):[];
    const comandosIds=new Set(comandos.map(c=>c.id));
    derivados.lume_comandos=comandos;
    derivados.lume_comando_tarefas=this.tem('lume_comando_tarefas')?this.db.prepare('SELECT * FROM lume_comando_tarefas ORDER BY id').all().filter(r=>comandosIds.has(r.comando_id)):[];
    derivados.lume_comando_lembretes=this.tem('lume_comando_lembretes')?this.db.prepare('SELECT * FROM lume_comando_lembretes ORDER BY id').all().filter(r=>comandosIds.has(r.comando_id)):[];
    derivados.lume_tags_entidades=this.tem('lume_tags_entidades')?this.db.prepare('SELECT * FROM lume_tags_entidades ORDER BY comando_id,tag_id').all().filter(r=>comandosIds.has(r.comando_id)):[];
    const tagIds=new Set(derivados.lume_tags_entidades.map(r=>r.tag_id));
    derivados.lume_tags=this.tem('lume_tags')?this.db.prepare('SELECT * FROM lume_tags ORDER BY id').all().filter(r=>tagIds.has(r.id)):[];
    derivados.whatsapp_label_associacoes=this.tem('whatsapp_label_associacoes')?this.db.prepare('SELECT * FROM whatsapp_label_associacoes ORDER BY conta_id,conversa_id,message_id,label_id').all().filter(a=>eventos.some(e=>e.conversa_id===a.conversa_id&&(a.message_id===''||e.origem_id===a.message_id))):[];
    const externos=new Set(derivados.whatsapp_label_associacoes.map(a=>JSON.stringify([a.conta_id,a.label_id])));
    derivados.whatsapp_labels=this.tem('whatsapp_labels')?this.db.prepare('SELECT * FROM whatsapp_labels ORDER BY conta_id,label_id').all().filter(l=>externos.has(JSON.stringify([l.conta_id,l.label_id]))):[];
    derivados.whatsapp_label_observacoes=this.tem('whatsapp_label_observacoes')?this.db.prepare('SELECT * FROM whatsapp_label_observacoes ORDER BY id').all().filter(o=>o.tipo==='definicao'?externos.has(JSON.stringify([o.conta_id,o.label_id])):derivados.whatsapp_label_associacoes.some(a=>a.conta_id===o.conta_id&&a.conversa_id===o.conversa_id&&a.message_id===o.message_id&&a.label_id===o.label_id)):[];
    Object.assign(derivados,this.dadosCiclo([...ids],{exportacao:true,conversa}));
    const conteudo={versao:'assessor-exportacao-pessoal-v1',exportadoEm:new Date().toISOString(),recorte:{conversa,incluirOcultas},eventos,derivados,vinculos:this.db.prepare('SELECT * FROM priv_vinculos').all().filter(v=>ids.has(v.fonte_id)&&ids.has(v.derivado_id)),aviso:'Exportação legível, sem criptografia. Não contém sessão, chaves, anexos binários ou envelope do transporte. Use o backup para restaurar o acervo.'};
    if(Buffer.byteLength(JSON.stringify(conteudo))>128*1024*1024)throw new Error('Exportação acima de 128 MB. Exporte uma conversa por vez.');
    return {nome:`assessor-exportacao-${randomUUID()}.json`,conteudo};
  }
  estado(){return {total:this.db.prepare('SELECT COUNT(*) n FROM eventos').get().n,conversas:this.db.prepare('SELECT c.id,c.nome,COUNT(e.id) total FROM conversas_app c LEFT JOIN eventos e ON e.conversa_id=c.id GROUP BY c.id ORDER BY c.nome').all(),recibos:this.db.prepare('SELECT * FROM priv_recibos ORDER BY criado_em DESC LIMIT 10').all().map(r=>({...r,contagens:JSON.parse(r.contagens)}))};}
}

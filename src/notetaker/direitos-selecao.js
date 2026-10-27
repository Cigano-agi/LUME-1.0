import { createHash } from 'node:crypto';
import { CATALOGO_V9 } from '../backup-acervo-catalogo.js';
import { CATALOGO_V10 } from '../backup-acervo-catalogo-v10.js';
import { NOTETAKER_COLUNAS } from '../leitura-sql.js';
import { assinaturaFonte } from '../tarefas-esquema.js';
import { conferirPerfilTeste, conferirBancoPerfil } from './perfil-teste.js';
import { UUID } from './contrato.js';
import { NOMES_OBJETOS_CONTROLE_EXCLUSAO, exigirControleInativo, validarControleExclusao } from './exclusao-controle.js';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const CODIGOS=new Set(['ENTRADA','FECHADO','DIREITO','AUSENTE','CONFLITO','INTEGRIDADE','LIMITE']);
const normalizar=e=>{if(CODIGOS.has(e?.code))throw e;fail('INTEGRIDADE','Recorte da sessão inconsistente.');};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const C=new Map(CATALOGO_V9.map(x=>[x.nome,x.colunas]));
const ETAPAS_V10=CATALOGO_V10.find(x=>x.nome==='etapas').colunas;
const CICLO_MIDIAS_V10=CATALOGO_V10.find(x=>x.nome==='ciclo_midias').colunas;
const col=t=>C.get(t)??NOTETAKER_COLUNAS[t];
const colunasRecorte=(db,t)=>t==='etapas'&&db.prepare('PRAGMA table_info(etapas)').all().map(x=>x.name).join('|')===ETAPAS_V10.join('|')
  ? ETAPAS_V10:col(t);
const MAX_ROWS=100000, MAX_ROW=4*1024*1024, MAX_TOTAL=256*1024*1024;
const TEMP={eventos:'d3_eventos',acoes:'d3_acoes',contextos:'d3_contextos',sugestoes:'d3_sugestoes',projetos:'d3_projetos',comandos:'d3_comandos',hashes:'d3_hashes'};
const PROJECAO=Object.freeze({
  notetaker_sessoes:col('notetaker_sessoes').filter(x=>!['direitos_revogados_em','excluida_em'].includes(x)),
  notetaker_partes:col('notetaker_partes'),notetaker_trechos:col('notetaker_trechos'),
  notetaker_fontes:col('notetaker_fontes'),notetaker_correcoes:col('notetaker_correcoes'),
  eventos:col('eventos'),priv_vinculos:col('priv_vinculos'),conversas_app:col('conversas_app'),
  itens_crm:col('itens_crm'),rascunhos:col('rascunhos'),
  transcricoes:col('transcricoes').filter(x=>x!=='arquivo'),eventos_financeiros:col('eventos_financeiros'),
  desktop_tarefas_sugestoes:col('desktop_tarefas_sugestoes'),
  desktop_tarefas_fontes:col('desktop_tarefas_fontes').filter(x=>x!=='assinatura'),
  desktop_negocios:col('desktop_negocios').filter(x=>x!=='assinatura'),
  desktop_negocios_historico:col('desktop_negocios_historico'),
  lume_acoes:col('lume_acoes').filter(x=>!['chave','fonte_assinatura'].includes(x)),
  lume_acoes_historico:col('lume_acoes_historico'),
  lume_execucao_contextos:['id','acao_id','criado_em','expira_em','pacote','rotulo'],
  lume_execucoes:col('lume_execucoes').filter(x=>!['cliente_id','chave_inicio','assinatura_inicio'].includes(x)),
  lume_execucao_eventos:col('lume_execucao_eventos').filter(x=>!['chave','assinatura'].includes(x)),
  lume_projetos_comerciais:col('lume_projetos_comerciais').filter(x=>!['chave','assinatura_criacao'].includes(x)),
  lume_projetos_fontes:col('lume_projetos_fontes').filter(x=>x!=='assinatura'),
  lume_projetos_historico:col('lume_projetos_historico'),
  lume_comandos:col('lume_comandos').filter(x=>x!=='idempotencia'),
  lume_comando_tarefas:col('lume_comando_tarefas'),lume_comando_lembretes:col('lume_comando_lembretes'),
  lume_tags_entidades:col('lume_tags_entidades'),lume_tags:col('lume_tags').filter(x=>x!=='chave')
});
const CAMPOS_FONTE=['permissao','conversa_id','origem_id','recebido_em','projeto_id',
  'origem_compartilhamento','autor_id','autor_e_dono','transcricao_meta'];
const FONTE_SELECT=['texto',...CAMPOS_FONTE].join(',');

function fonteHistoricaIntegra(db,eventoId,trecho,integridade,vinculo) {
  if(!vinculo?.fonte||typeof vinculo.fonte!=='object'||CAMPOS_FONTE.some(k=>!Object.hasOwn(vinculo.fonte,k)))return false;
  const d=db.prepare(`SELECT ${FONTE_SELECT} FROM desktop_fontes WHERE id=?`).get(eventoId);
  if(!d||CAMPOS_FONTE.some(k=>d[k]!==vinculo.fonte[k]))return false;
  if(vinculo.revisao===trecho.revisao)return assinaturaFonte(d)===integridade.fonte;
  let revisao=vinculo.revisao,anterior=null;
  for(const c of db.prepare(`SELECT revisao,texto_anterior,texto_novo FROM notetaker_correcoes
    WHERE trecho_id=? AND revisao>? ORDER BY revisao`).iterate(trecho.id,vinculo.revisao)){
    if(anterior===null){
      if(assinaturaFonte({texto:c.texto_anterior,...vinculo.fonte})!==integridade.fonte)return false;
      anterior=c.texto_anterior;
    }
    if(c.revisao!==++revisao||c.texto_anterior!==anterior||typeof c.texto_novo!=='string')return false;
    anterior=c.texto_novo;
  }
  return revisao===trecho.revisao&&anterior===d.texto;
}
function acaoHistoricaIntegra(db,acaoId,assinatura) {
  const row=db.prepare(`SELECT a.id,a.evento_id,a.resumo,a.trecho,a.trecho_inicio,a.tipo,a.prazo_citado,a.estado,a.responsavel_id,
    e.tipo fonte_tipo,p.autorizada_em,p.inicio_evento_id,
    (SELECT politica FROM politicas_conversa WHERE conversa_id=e.conversa_id) politica,
    (SELECT atualizado_em FROM politicas_conversa WHERE conversa_id=e.conversa_id) politica_em
    FROM lume_acoes a JOIN eventos e ON e.id=a.evento_id
    LEFT JOIN lume_acoes_conversas p ON p.conversa_id=e.conversa_id WHERE a.id=?`).get(acaoId);
  if(!row)return false;
  const {estado,responsavel_id,fonte_tipo,...conteudo}=row;
  return sha(conteudo)===assinatura;
}

function verificarSchema(db) {
  validarControleExclusao(db);
  if(db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('FECHADO','FK desativada.');
  if(db.prepare('PRAGMA foreign_key_check').get())fail('INTEGRIDADE','FK inconsistente.');
  for(const t of Object.keys(NOTETAKER_COLUNAS))
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))fail('INTEGRIDADE','Schema notetaker ausente.');
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").iterate()) {
    if(name.startsWith('sqlite_')||NOMES_OBJETOS_CONTROLE_EXCLUSAO.includes(name)||/^desktop_fontes_fts(?:_(?:data|idx|docsize|config))?$/.test(name))continue;
    const q='"'+name.replaceAll('"','""')+'"';
    if(!C.has(name)&&name!=='ciclo_midias'){
      if(db.prepare(`SELECT 1 FROM ${q} LIMIT 1`).get())fail('INTEGRIDADE','Extensão povoada sem contrato.');
      continue;
    }
    const atual=db.prepare(`PRAGMA table_info(${q})`).all().map(r=>r.name).sort().join('|');
    const esperado=name==='ciclo_midias'?CICLO_MIDIAS_V10:colunasRecorte(db,name);
    if(atual!==[...esperado].sort().join('|')&&db.prepare(`SELECT 1 FROM ${q} LIMIT 1`).get())
      fail('INTEGRIDADE','Coluna povoada sem contrato.');
  }
}

function construir(db,sessaoId,perfil) {
  if(typeof sessaoId!=='string'||!UUID.test(sessaoId))fail('ENTRADA','ID de sessão inválido.');
  const root=conferirPerfilTeste({notetakerExperimento:true,...perfil});
  conferirBancoPerfil(db,root); verificarSchema(db);
  const s=db.prepare(`SELECT ${col('notetaker_sessoes').join(',')} FROM notetaker_sessoes WHERE id=?`).get(sessaoId);
  if(!s)fail('AUSENTE','Sessão ausente.');
  if(!s.consentimento_em||s.direitos_revogados_em||s.excluida_em||s.estado==='excluida')fail('DIREITO','Direitos fechados.');
  if(['gravando','pausada'].includes(s.estado)||s.importacao_estado==='em_curso'||s.asr_estado==='em_curso')
    fail('CONFLITO','Sessão em curso.');
  const rows={notetaker_sessoes:[s]}, aux={},contagens={notetaker_sessoes:1},impactos=[];
  const bloqueios={exportacao:[],exclusao:[]}, vistos={exportacao:new Set(),exclusao:new Set()};
  const total={bytes:Buffer.byteLength(JSON.stringify(s))};
  const block=(tipo,classe,motivo,id)=>{
    const chave=JSON.stringify([classe,motivo,id]);
    if(vistos[tipo].has(chave))return;
    if(bloqueios[tipo].length>=MAX_ROWS)fail('LIMITE','Bloqueios acima do limite.');
    vistos[tipo].add(chave);bloqueios[tipo].push({classe,motivo,...(id===undefined?{}:{id})});
  };
  const ler=(t,where='1',params=[],order='rowid',alias=t)=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))return rows[t]=[];
    const arr=[];
    for(const r of db.prepare(`SELECT ${colunasRecorte(db,t).map(x=>alias+'.'+x).join(',')} FROM ${t} ${alias} WHERE ${where} ORDER BY ${order}`).iterate(...params)){
      const n=Buffer.byteLength(JSON.stringify(r));
      if(n>MAX_ROW||(total.bytes+=n)>MAX_TOTAL||arr.length>=MAX_ROWS)fail('LIMITE','Recorte acima do limite.');
      arr.push(r);
    }
    rows[t]=arr;contagens[t]=arr.length;return arr;
  };
  const auxiliar=(t,w='1',p=[],o='rowid',a=t)=>{const r=ler(t,w,p,o,a);aux[t]=r;delete rows[t];return r;};
  for(const [classe,nome] of Object.entries(TEMP)) db.exec(`CREATE TEMP TABLE ${nome}(id ${['acoes','contextos','sugestoes','projetos','hashes'].includes(classe)?'TEXT':'INTEGER'} PRIMARY KEY)`);
  const ins=(nome,sql,p=[])=>db.prepare(`INSERT OR IGNORE INTO ${nome}(id) ${sql}`).run(...p);
  const partes=ler('notetaker_partes','sessao_id=?',[sessaoId],'posicao,id');
  const trechos=ler('notetaker_trechos','parte_id IN (SELECT id FROM notetaker_partes WHERE sessao_id=?)',[sessaoId],'parte_id,ordinal,id');
  const fontes=ler('notetaker_fontes','sessao_id=?',[sessaoId],'evento_id');
  const correcoes=ler('notetaker_correcoes','trecho_id IN (SELECT t.id FROM notetaker_trechos t JOIN notetaker_partes p ON p.id=t.parte_id WHERE p.sessao_id=?)',[sessaoId],'trecho_id,revisao,id');
  for(const p of partes)if(p.caminho!==p.id+'.wav'||!Number.isSafeInteger(p.posicao)||p.posicao<0||
    !Number.isFinite(p.duracao_ms)||p.duracao_ms<=0||!/^[a-f0-9]{64}$/.test(p.sha256))fail('INTEGRIDADE','Parte local inválida.');
  for(const p of partes)if(p.estado!=='salva')block('exportacao','original_indisponivel','estado',p.id);
  const porTrecho=new Map();for(const c of correcoes){if(!porTrecho.has(c.trecho_id))porTrecho.set(c.trecho_id,[]);porTrecho.get(c.trecho_id).push(c);}
  for(const t of trechos){
    const historico=porTrecho.get(t.id)??[];
    if(historico.length!==t.revisao||!Number.isSafeInteger(t.revisao)||t.revisao<0)fail('INTEGRIDADE','Revisão local inválida.');
    let anterior=t.texto_gerado;
    for(let n=0;n<historico.length;n++){
      const c=historico[n];
      if(c.revisao!==n+1||c.texto_anterior!==anterior||typeof c.texto_novo!=='string')fail('INTEGRIDADE','Cadeia de correções inválida.');
      anterior=c.texto_novo;
    }
    if(anterior!==(t.texto_corrigido??t.texto_gerado))fail('INTEGRIDADE','Texto corrigido incompatível.');
  }
  const ps=new Map(partes.map(x=>[x.id,x])),ts=new Map(trechos.map(x=>[x.id,x])),ligados=new Set();
  for(const f of fontes){
    const p=ps.get(f.parte_id),t=ts.get(f.trecho_id),e=db.prepare('SELECT id,conversa_id,origem_id,tipo,permissao,texto FROM eventos WHERE id=?').get(f.evento_id);
    if(!p||!t||t.parte_id!==p.id||!e||e.tipo!=='notetaker_trecho'||e.permissao!=='notetaker_local'||
      e.conversa_id!==`local:notetaker:${sessaoId}`||e.origem_id!==`trecho:${p.id}:${t.ordinal}`||
      e.texto!==(t.texto_corrigido??t.texto_gerado)||f.revisao!==t.revisao||f.inicio_ms!==t.inicio_ms||
      f.fim_ms!==t.fim_ms||f.fim_ms>p.duracao_ms||f.audio_sha256!==p.sha256||ligados.has(t.id))
      fail('INTEGRIDADE','Fonte local sem vínculo íntegro.');
    ligados.add(t.id);
  }
  if(trechos.some(t=>!ligados.has(t.id))||db.prepare(`SELECT 1 FROM eventos e LEFT JOIN notetaker_fontes f ON f.evento_id=e.id
      WHERE e.conversa_id=? AND f.evento_id IS NULL LIMIT 1`).get(`local:notetaker:${sessaoId}`))
    fail('INTEGRIDADE','Trecho ou evento órfão.');
  const gravarHash=db.prepare(`INSERT OR IGNORE INTO ${TEMP.hashes}(id) VALUES(?)`);
  for(const f of fontes){
    const atual=db.prepare(`SELECT ${FONTE_SELECT} FROM desktop_fontes WHERE id=?`).get(f.evento_id);
    if(atual)gravarHash.run(assinaturaFonte(atual));
    const metadados=Object.fromEntries(CAMPOS_FONTE.map(k=>[k,atual?.[k]??null]));
    for(const c of porTrecho.get(f.trecho_id)??[])
      gravarHash.run(assinaturaFonte({texto:c.texto_anterior,...metadados}));
  }
  ins(TEMP.eventos,`WITH RECURSIVE alcance(id) AS (SELECT evento_id FROM notetaker_fontes WHERE sessao_id=?
    UNION SELECT v.derivado_id FROM priv_vinculos v JOIN alcance a ON a.id=v.fonte_id
      JOIN eventos d ON d.id=v.derivado_id AND d.tipo='nota') SELECT id FROM alcance LIMIT 100001`,[sessaoId]);
  const eventos=ler('eventos',`id IN (SELECT id FROM ${TEMP.eventos})`,[],'id'),eids=new Set(eventos.map(x=>x.id));
  const originais=new Set(fontes.map(x=>x.evento_id));
  for(const e of eventos)if(!originais.has(e.id)&&e.tipo!=='nota'){
    block('exportacao','derivado_desconhecido','tipo',e.id);block('exclusao','derivado_desconhecido','tipo',e.id);
  }
  for(const r of db.prepare(`SELECT v.derivado_id FROM priv_vinculos v JOIN ${TEMP.eventos} a ON a.id=v.fonte_id
    JOIN eventos d ON d.id=v.derivado_id WHERE d.tipo<>'nota'`).iterate()){
    block('exportacao','derivado_desconhecido','tipo',r.derivado_id);
    block('exclusao','derivado_desconhecido','tipo',r.derivado_id);
  }
  const vinculos=ler('priv_vinculos',`derivado_id IN (SELECT id FROM ${TEMP.eventos})`,[],'derivado_id,fonte_id');
  for(const v of vinculos)if(!eids.has(v.fonte_id)){
    block('exportacao','derivado_misto','fonte_externa',v.derivado_id);
    impactos.push({classe:'derivado_misto',id:v.derivado_id,efeito:'remover_derivado_inteiro_preservar_original_externo'});
  }
  ler('conversas_app',`id IN (SELECT conversa_id FROM eventos WHERE id IN (SELECT id FROM ${TEMP.eventos}) AND tipo='nota')
    AND NOT EXISTS (SELECT 1 FROM eventos e WHERE e.conversa_id=conversas_app.id AND e.id NOT IN (SELECT id FROM ${TEMP.eventos}))`,[],'id');
  return completar({db,sessaoId,rows,aux,contagens,impactos,bloqueios,block,ler,auxiliar,ins,eids,partes,trechos,fonte:fontes,eventos,total});
}

// A continuação conserva o mesmo snapshot e as tabelas TEMP desta chamada.
function completar({db,sessaoId,rows,aux,contagens,impactos,bloqueios,block,ler,auxiliar,ins,eids,partes,trechos,fonte,eventos,total}) {
  const has=t=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
  const temp=TEMP;
  const get=(t,w='1',a=[],o='rowid',alias=t)=>has(t)?ler(t,w,a,o,alias):[];
  const auxget=(t,w='1',a=[],o='rowid',alias=t)=>has(t)?auxiliar(t,w,a,o,alias):[];
  if(has('lume_acoes')) ins(temp.acoes,`SELECT id FROM lume_acoes WHERE evento_id IN (SELECT id FROM ${temp.eventos})`);
  const acoes=get('lume_acoes',`id IN (SELECT id FROM ${temp.acoes})`,[],'id');
  get('lume_acoes_historico',`acao_id IN (SELECT id FROM ${temp.acoes})`,[],'acao_id,id');
  if(has('lume_execucao_contextos')) {
    if(!has('lume_execucao_contexto_guardas') && db.prepare('SELECT 1 FROM lume_execucao_contextos LIMIT 1').get())
      fail('INTEGRIDADE','Contexto sem guarda de origem.');
    ins(temp.contextos,`SELECT c.id FROM lume_execucao_contextos c WHERE c.acao_id IN (SELECT id FROM ${temp.acoes})
      OR EXISTS(SELECT 1 FROM lume_execucao_contexto_guardas g JOIN ${temp.eventos} e ON e.id=g.evento_id WHERE g.contexto_id=c.id)`);
  }
  const contextos=get('lume_execucao_contextos',`id IN (SELECT id FROM ${temp.contextos})`,[],'id');
  const guardas=auxget('lume_execucao_contexto_guardas',`contexto_id IN (SELECT id FROM ${temp.contextos})`,[],'contexto_id');
  auxget('lume_execucao_contexto_grants',`contexto_id IN (SELECT id FROM ${temp.contextos})`,[],'contexto_id');
  const gs=new Map(guardas.map(g=>[g.contexto_id,g]));
  const ff=new Map(fonte.map(f=>[f.evento_id,f])),ps=new Map(partes.map(p=>[p.id,p])),ts=new Map(trechos.map(t=>[t.id,t]));
  for(const c of contextos){
    const g=gs.get(c.id),a=db.prepare('SELECT evento_id FROM lume_acoes WHERE id=?').get(c.acao_id);
    if(!g||!Number.isSafeInteger(g.evento_id)||!eids.has(g.evento_id)||g.assinatura_contexto!==sha([c.id,c.pacote,c.integridade])){
      block('exportacao','contexto_ambiguo','guarda',c.id);block('exclusao','contexto_ambiguo','guarda',c.id);continue;
    }
    if(!a||!eids.has(a.evento_id)){
      block('exportacao','contexto_rebind','acao_externa',c.id);
      impactos.push({classe:'contexto_rebind',id:c.id,efeito:'remover_contexto_preservar_acao_externa'});
    }
    let i,pacote;try{i=JSON.parse(c.integridade);pacote=JSON.parse(c.pacote);}catch{
      block('exportacao','contexto_ambiguo','integridade',c.id);block('exclusao','contexto_ambiguo','integridade',c.id);continue;
    }
    if(!pacote||typeof pacote!=='object'||pacote.id!==c.id||pacote.acao_id!==c.acao_id||
       pacote.fonte_retorno?.evento_id!==g.evento_id||!Array.isArray(pacote.fontes)||
       pacote.fontes.length<1||pacote.fontes.some(x=>x.evento_id!==g.evento_id)||!Array.isArray(pacote.timeline)){
      block('exportacao','contexto_ambiguo','pacote',c.id);
      block('exclusao','contexto_ambiguo','pacote',c.id);continue;
    }
    if(a&&eids.has(a.evento_id)&&!acaoHistoricaIntegra(db,c.acao_id,i?.acao))
      block('exportacao','contexto_alterado','acao',c.id);
    const v=i?.vinculo_notetaker,f=ff.get(g.evento_id),p=ps.get(f?.parte_id),t=ts.get(f?.trecho_id);
    if(!v||!f||!p||!t||v.evento_id!==g.evento_id||v.sessao_id!==sessaoId||
      v.parte_id!==p.id||v.trecho_id!==t.id||v.posicao!==p.posicao||
      v.inicio_ms!==f.inicio_ms||v.fim_ms!==f.fim_ms||v.audio_sha256!==p.sha256||
      !Number.isSafeInteger(v.revisao)||v.revisao<0||v.revisao>t.revisao){
      block('exportacao','contexto_ambiguo','origem_congelada',c.id);
      block('exclusao','contexto_ambiguo','origem_congelada',c.id);continue;
    }
    if(!fonteHistoricaIntegra(db,g.evento_id,t,i,v)){
      block('exportacao','contexto_ambiguo','cadeia_ou_assinatura',c.id);
      block('exclusao','contexto_ambiguo','cadeia_ou_assinatura',c.id);
    }
  }
  // Esta varredura fica no SQL e materializa só candidatos sem guarda; hash não vira autoridade.
  if(has('lume_execucao_contextos')&&has('lume_execucao_contexto_guardas'))
    for(const r of db.prepare(`SELECT c.id FROM lume_execucao_contextos c
      LEFT JOIN lume_execucao_contexto_guardas g ON g.contexto_id=c.id
      WHERE (g.contexto_id IS NULL OR g.evento_id IS NULL) AND
      (CASE WHEN json_valid(c.integridade)=1 THEN json_extract(c.integridade,'$.vinculo_notetaker.sessao_id') END=?
       OR CASE WHEN json_valid(c.integridade)=1 THEN json_extract(c.integridade,'$.fonte') END IN
         (SELECT id FROM ${temp.hashes}))`).iterate(sessaoId)){
      block('exportacao','contexto_ambiguo','guarda_ausente',r.id);
      block('exclusao','contexto_ambiguo','guarda_ausente',r.id);
    }
  const execucoes=get('lume_execucoes',`contexto_id IN (SELECT id FROM ${temp.contextos})`,[],'contexto_id,id');
  get('lume_execucao_eventos',`execucao_id IN (SELECT id FROM lume_execucoes WHERE contexto_id IN (SELECT id FROM ${temp.contextos}))`,[],'execucao_id,id');
  if(has('desktop_tarefas_sugestoes'))ins(temp.sugestoes,`SELECT s.id FROM desktop_tarefas_sugestoes s WHERE
    s.evento_id IN (SELECT id FROM ${temp.eventos}) OR EXISTS(SELECT 1 FROM desktop_tarefas_fontes f
    JOIN ${temp.eventos} e ON e.id=f.evento_id WHERE f.sugestao_id=s.id)`);
  const sugestoes=get('desktop_tarefas_sugestoes',`id IN (SELECT id FROM ${temp.sugestoes})`,[],'id');
  const sugestaoFontes=get('desktop_tarefas_fontes',`sugestao_id IN (SELECT id FROM ${temp.sugestoes})`,[],'sugestao_id,evento_id');
  const porSug=new Map();for(const f of sugestaoFontes){if(!porSug.has(f.sugestao_id))porSug.set(f.sugestao_id,[]);porSug.get(f.sugestao_id).push(f);}
  for(const s of sugestoes){
    const fs=porSug.get(s.id)??[];
    if(fs.length!==s.fontes_total||!fs.some(f=>f.evento_id===s.evento_id)){
      block('exportacao','sugestao_ambigua','contagem',s.id);block('exclusao','sugestao_ambigua','contagem',s.id);
    } else if(!eids.has(s.evento_id)||fs.some(f=>!eids.has(f.evento_id))){
      block('exportacao','sugestao_mista','fonte_externa',s.id);
      impactos.push({classe:'sugestao_mista',id:s.id,efeito:'remover_sugestao_preservar_original_externo'});
    }
    for(const f of fs){const d=db.prepare(`SELECT ${FONTE_SELECT} FROM desktop_fontes WHERE id=?`).get(f.evento_id);
      if(!d||f.assinatura!==assinaturaFonte(d))block('exportacao','sugestao_alterada','assinatura',s.id);
    }
  }
  if(has('lume_projetos_fontes'))ins(temp.projetos,`SELECT DISTINCT projeto_id FROM lume_projetos_fontes WHERE evento_id IN (SELECT id FROM ${temp.eventos})`);
  const projetos=get('lume_projetos_comerciais',`id IN (SELECT id FROM ${temp.projetos})`,[],'id');
  const projetosFontes=get('lume_projetos_fontes',`projeto_id IN (SELECT id FROM ${temp.projetos})`,[],'projeto_id,id');
  get('lume_projetos_historico',`projeto_id IN (SELECT id FROM ${temp.projetos})`,[],'projeto_id,id');
  const porProjeto=new Map();for(const f of projetosFontes){if(!porProjeto.has(f.projeto_id))porProjeto.set(f.projeto_id,[]);porProjeto.get(f.projeto_id).push(f);}
  for(const p of projetos){
    const fs=porProjeto.get(p.id)??[],bases=fs.filter(f=>f.base);
    if(bases.length!==p.bases_total){block('exportacao','projeto_ambiguo','bases',p.id);block('exclusao','projeto_ambiguo','bases',p.id);}
    if(fs.some(f=>!eids.has(f.evento_id))){
      block('exportacao','projeto_misto','fonte_externa',p.id);
      impactos.push({classe:'projeto_misto',id:p.id,efeito:bases.some(f=>eids.has(f.evento_id))?'trigger_remove_projeto_inteiro':'remover_vinculo_preservar_projeto'});
    }
    for(const f of fs){const d=db.prepare(`SELECT ${FONTE_SELECT} FROM desktop_fontes WHERE id=?`).get(f.evento_id);
      if(!d||f.assinatura!==assinaturaFonte(d)||f.invalidada||f.removida)
        block('exportacao','projeto_alterado','fonte',p.id);
    }
  }
  const par=`EXISTS(SELECT 1 FROM eventos e JOIN ${temp.eventos} alvo ON alvo.id=e.id
    WHERE e.conversa_id=t.conversa_id AND e.origem_id=t.origem_id)`;
  const itens=get('itens_crm',`${par} OR t.id IN (SELECT item_id FROM desktop_tarefas_sugestoes WHERE id IN (SELECT id FROM ${temp.sugestoes}) AND item_id IS NOT NULL)`,[],'id','t');
  for(const item of itens)if(!eids.has(db.prepare('SELECT e.id FROM eventos e WHERE e.conversa_id=? AND e.origem_id=?').get(item.conversa_id,item.origem_id)?.id)){
    block('exportacao','item_externo','sugestao_mista',item.id);
    block('exclusao','item_externo','uso_externo',item.id);
  }
  get('rascunhos',`item_id IN (SELECT id FROM itens_crm t WHERE ${par} OR t.id IN
    (SELECT item_id FROM desktop_tarefas_sugestoes WHERE id IN (SELECT id FROM ${temp.sugestoes}) AND item_id IS NOT NULL))`,[],'id');
  const trans=get('transcricoes',par,[],'id','t');
  get('eventos_financeiros',par,[],'id','t');
  const caixas=auxget('caixas_jobs',par,[],'id','t');
  if(caixas.length){
    block('exportacao','caixa_sem_projecao','conteudo_ligado');
    block('exclusao','caixa_sem_projecao','conteudo_ligado');
    for(const c of caixas)impactos.push({classe:'caixa',id:c.id,efeito:'requer_contrato_de_arquivo_e_derivados'});
  }
  if(trans.some(x=>x.arquivo)||caixas.some(x=>x.arquivo_caminho)){
    block('exportacao','arquivo_externo','path_binario');block('exclusao','arquivo_externo','path_binario');
  }
  const negocios=get('desktop_negocios',`evento_id IN (SELECT id FROM ${temp.eventos})`,[],'id');
  get('desktop_negocios_historico',`negocio_id IN (SELECT id FROM desktop_negocios WHERE evento_id IN (SELECT id FROM ${temp.eventos}))`,[],'negocio_id,revisao');
  if(has('lume_comandos'))ins(temp.comandos,`SELECT id FROM lume_comandos WHERE evento_id IN (SELECT id FROM ${temp.eventos})`);
  const comandos=get('lume_comandos',`id IN (SELECT id FROM ${temp.comandos})`,[],'id');
  const comandoPorId=new Map(comandos.map(c=>[c.id,c])),eventoPorId=new Map(eventos.map(e=>[e.id,e]));
  for(const c of comandos){
    const origem=eventoPorId.get(c.evento_id);
    if(!origem||c.conversa_id!==origem.conversa_id||c.origem_id!==origem.origem_id||
      origem.autor_e_dono!==1||origem.permissao!=='minha'){
      block('exportacao','comando_origem_ambigua','par',c.id);
      block('exclusao','comando_origem_ambigua','par',c.id);
      impactos.push({classe:'comando_origem_ambigua',id:c.id,efeito:'revisar_origem_antes_de_remover'});
    }
  }
  for(const tabela of ['lume_comando_tarefas','lume_comando_lembretes']){
    const efeitos=get(tabela,`comando_id IN (SELECT id FROM ${temp.comandos})`,[],'id');
    for(const efeito of efeitos){
      const c=comandoPorId.get(efeito.comando_id);
      if(c&&efeito.conversa_id===c.conversa_id&&efeito.origem_id===c.origem_id)continue;
      block('exportacao','efeito_origem_ambigua',tabela,efeito.id);
      block('exclusao','efeito_origem_ambigua',tabela,efeito.id);
      impactos.push({classe:'efeito_origem_ambigua',id:efeito.id,efeito:'revisar_par_antes_de_remover'});
    }
  }
  const associacoes=get('lume_tags_entidades',`comando_id IN (SELECT id FROM ${temp.comandos})`,[],'tag_id,entidade_tipo,entidade_id,comando_id');
  const recorteEventos=(where,args)=>{
    if(!db.prepare(`SELECT 1 FROM eventos alvo WHERE ${where} LIMIT 1`).get(...args))return 'ambiguo';
    return db.prepare(`SELECT 1 FROM eventos alvo WHERE ${where} AND alvo.id NOT IN
      (SELECT id FROM ${temp.eventos}) LIMIT 1`).get(...args)?'externo':'interno';
  };
  const alvoTag=(a,c)=>{
    if(typeof a.entidade_id!=='string'||!a.entidade_id)return 'ambiguo';
    if(a.entidade_tipo==='mensagem')return recorteEventos('alvo.conversa_id=? AND alvo.origem_id=?',[a.conversa_id,a.entidade_id]);
    if(a.entidade_tipo==='conversa')return recorteEventos('alvo.conversa_id=?',[a.entidade_id]);
    if(a.entidade_tipo==='contato')return recorteEventos(`((COALESCE(alvo.autor_e_dono,0)=0 AND alvo.autor_id=?)
      OR alvo.conversa_id=?)`,[a.entidade_id,a.entidade_id]);
    if(a.entidade_tipo==='tarefa'||a.entidade_tipo==='lembrete'){
      const tabela=a.entidade_tipo==='tarefa'?'lume_comando_tarefas':'lume_comando_lembretes';
      if(!has(tabela))return 'ambiguo';
      const alvo=db.prepare(`SELECT comando_id,conversa_id,origem_id FROM ${tabela} WHERE CAST(id AS TEXT)=?`).get(a.entidade_id);
      if(!alvo)return 'ambiguo';
      if(alvo.comando_id!==c.id)return 'externo';
      return alvo.conversa_id===c.conversa_id&&alvo.origem_id===c.origem_id?'interno':'ambiguo';
    }
    if(a.entidade_tipo==='negocio'){
      if(!has('desktop_negocios'))return 'ambiguo';
      const alvo=db.prepare('SELECT evento_id,assinatura FROM desktop_negocios WHERE id=?').get(a.entidade_id);
      if(!alvo)return 'ambiguo';
      if(!eids.has(alvo.evento_id))return 'externo';
      const fonteAtual=db.prepare(`SELECT ${FONTE_SELECT} FROM desktop_fontes WHERE id=?`).get(alvo.evento_id);
      return fonteAtual&&alvo.assinatura===assinaturaFonte(fonteAtual)?'interno':'ambiguo';
    }
    return 'ambiguo';
  };
  for(const a of associacoes){
    const c=comandoPorId.get(a.comando_id);
    if(!c||a.conversa_id!==c.conversa_id||a.origem_id!==c.origem_id){
      block('exportacao','tag_origem_ambigua','par',a.tag_id);
      block('exclusao','tag_origem_ambigua','par',a.tag_id);
      impactos.push({classe:'tag_origem_ambigua',id:a.tag_id,efeito:'revisar_vinculo_preservar_alvo'});
      continue;
    }
    const alvo=alvoTag(a,c);
    if(alvo==='interno')continue;
    const classe=alvo==='externo'?'tag_mista':'tag_alvo_ambiguo';
    block('exportacao',classe,'alvo',a.tag_id);
    if(alvo==='ambiguo')block('exclusao',classe,'alvo',a.tag_id);
    impactos.push({classe,id:a.tag_id,efeito:alvo==='externo'?'preservar_alvo_externo':'revisar_alvo_antes_de_remover'});
  }
  const tags=get('lume_tags',`id IN (SELECT tag_id FROM lume_tags_entidades WHERE comando_id IN (SELECT id FROM ${temp.comandos}))`,[],'id');
  for(const tag of tags)if(db.prepare(`SELECT 1 FROM lume_tags_entidades WHERE tag_id=?
    AND comando_id NOT IN (SELECT id FROM ${temp.comandos}) LIMIT 1`).get(tag.id)){
    block('exportacao','tag_mista','comando_externo',tag.id);
    impactos.push({classe:'tag_mista',id:tag.id,efeito:'preservar_tag_compartilhada'});
  }
  auxget('f10_procedencias',`evento_id IN (SELECT id FROM ${temp.eventos})`,[],'evento_id,fingerprint,pacote_id,projeto_id');
  if(aux.f10_procedencias?.length){
    block('exportacao','procedencia_externa','origem_criptografica');
    block('exclusao','procedencia_externa','origem_criptografica');
  }
  for(const t of ['desktop_tarefas_analises','etapas','desktop_vetores','lume_laya_fila','lume_projetos_revisoes'])
    auxget(t,`evento_id IN (SELECT id FROM ${temp.eventos})`,[],'evento_id');
  // O manifesto C1 inventaria WAV do notetaker, mas ainda não inventaria
  // originais do ciclo WhatsApp. A cascata SQL não pode deixar arquivo órfão.
  if(has('ciclo_midias')&&db.prepare(`SELECT 1 FROM ciclo_midias WHERE evento_id IN (SELECT id FROM ${temp.eventos}) LIMIT 1`).get()){
    block('exportacao','familia_externa','recorte_sem_contrato');
    block('exclusao','familia_externa','recorte_sem_contrato');
  }
  auxget('lume_projetos_importados_guardas',`fonte_id IN (SELECT id FROM lume_projetos_fontes WHERE projeto_id IN (SELECT id FROM ${temp.projetos}))`,[],'fonte_id');
  auxget('wa_recuperacoes',`evento_id IN (SELECT id FROM ${temp.eventos}) OR conversa_id=?`,[`local:notetaker:${sessaoId}`],'id');
  auxget('lume_vendas_avaliacoes','conversa_id=?',[`local:notetaker:${sessaoId}`],'id');
  if(aux.wa_recuperacoes?.length||aux.lume_vendas_avaliacoes?.length){
    block('exportacao','familia_externa','recorte_sem_contrato');
    block('exclusao','familia_externa','recorte_sem_contrato');
  }
  for(const t of ['whatsapp_label_associacoes','whatsapp_label_observacoes','wa_retomadas',
    'crm_execucoes','desktop_tarefas_conversas','lume_acoes_conversas','politicas_conversa',
    'autorizacoes','lume_laya_agenda','f10_conversas','conversa_projetos'])
    if(has(t)&&db.prepare(`SELECT 1 FROM ${t} WHERE conversa_id=? LIMIT 1`).get(`local:notetaker:${sessaoId}`)){
      block('exportacao','familia_sem_projecao',t);
      block('exclusao','familia_sem_projecao',t);
    }
  if(has('lume_ciclo_importacoes')){
    const encontrados=[];
    const buscar=db.prepare(`SELECT ${col('lume_ciclo_importacoes').join(',')} FROM lume_ciclo_importacoes WHERE tabela=? AND registro_id=?`);
    for(const t of ['lume_execucao_contextos','lume_execucoes','lume_execucao_eventos',
      'lume_projetos_comerciais','lume_projetos_fontes','lume_projetos_historico'])
      for(const row of rows[t]??[]){const r=buscar.get(t,String(row.id));if(r)encontrados.push(r);}
    aux.lume_ciclo_importacoes=encontrados;contagens.lume_ciclo_importacoes=encontrados.length;
    if(encontrados.length){
      block('exportacao','procedencia_importada','linha_sem_projecao');
      block('exclusao','procedencia_importada','linha_sem_projecao');
    }
  }
  for(const t of ['saidas','falhas_ingestao','entregas_punk','linha_tempo','caixas_inventario','saude'])
    if(has(t)&&db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get())block('exclusao','global_sem_proveniencia',t);
  const assinatura=sha({sessaoId,rows,aux,bloqueios,impactos});
  const ids={eventos:eventos.map(x=>x.id),acoes:acoes.map(x=>x.id),contextos:contextos.map(x=>x.id),
    execucoes:execucoes.map(x=>x.id),sugestoes:sugestoes.map(x=>x.id),projetos:projetos.map(x=>x.id),
    partes:partes.map(x=>x.id),trechos:trechos.map(x=>x.id),comandos:comandos.map(x=>x.id)};
  const orcamento={linhas:[...Object.values(rows),...Object.values(aux)].reduce((n,r)=>n+r.length,0),bytes:total.bytes,
    maxLinhas:MAX_ROWS,maxBytesLinha:MAX_ROW,maxBytesTotal:MAX_TOTAL};
  return {mapa:{schema:1,sessaoId,revisao:rows.notetaker_sessoes[0].revisao,assinatura,ids,contagens,impactos,bloqueios,
    cobertura:{estado:rows.notetaker_sessoes[0].estado,importacao:rows.notetaker_sessoes[0].importacao_estado,asr:rows.notetaker_sessoes[0].asr_estado}},rows,aux,orcamento};
}

// Privado para módulos de domínio do notetaker; o chamador possui a transação.
// Não exportado pelo barrel HTTP/MCP. A função pública continua dona do snapshot isolado.
export function construirRecorteInterno(db,sessaoId,perfil={}) {
  if(!db?.isTransaction)fail('CONFLITO','Transação do chamador obrigatória.');
  return construir(db,sessaoId,perfil);
}

function leitura(db,fn){
  if(db.isTransaction)fail('CONFLITO','Transação externa aberta.');
  db.exec('BEGIN');
  try{return fn();}catch(e){normalizar(e);}finally{db.exec('ROLLBACK');}
}
export function selecionarDireitosSessao(db,sessaoId,opcoesPerfil={}){
  exigirControleInativo(db);
  return leitura(db,()=>construir(db,sessaoId,opcoesPerfil).mapa);
}
export function* iterarExportacaoSessao(db,mapa,opcoesPerfil={}){
  if(!mapa||mapa.schema!==1||typeof mapa.sessaoId!=='string'||typeof mapa.assinatura!=='string')fail('ENTRADA','Mapa inválido.');
  if(db.isTransaction)fail('CONFLITO','Transação externa aberta.');
  exigirControleInativo(db);
  db.exec('BEGIN');
  try{
    const atual=construir(db,mapa.sessaoId,opcoesPerfil);
    if(atual.mapa.assinatura!==mapa.assinatura)fail('CONFLITO','Recorte mudou.');
    if(atual.mapa.bloqueios.exportacao.length)fail('INTEGRIDADE','Exportação bloqueada.');
    let bytes=0;
    for(const t of Object.keys(PROJECAO))for(const row of atual.rows[t]??[]){
      const registro=projetar(t,row),n=Buffer.byteLength(JSON.stringify(registro));
      if(n>MAX_ROW||(bytes+=n)>MAX_TOTAL)fail('LIMITE','Projeção acima do limite.');
      yield {tabela:t,registro};
    }
  }catch(e){normalizar(e);}finally{db.exec('ROLLBACK');}
}
export function validarPublicacaoSessao(db,mapa,opcoesPerfil,finalizar){
  if(!mapa||mapa.schema!==1||typeof mapa.sessaoId!=='string'||typeof mapa.assinatura!=='string'||
    typeof finalizar!=='function'||finalizar.constructor?.name==='AsyncFunction')
    fail('ENTRADA','Publicação inválida.');
  if(db.isTransaction)fail('CONFLITO','Transação externa aberta.');
  exigirControleInativo(db);
  try{db.exec('BEGIN IMMEDIATE');}catch{fail('CONFLITO','Banco ocupado.');}
  try{
    let atual;
    try{atual=construir(db,mapa.sessaoId,opcoesPerfil).mapa;}catch(e){normalizar(e);}
    if(atual.assinatura!==mapa.assinatura)fail('CONFLITO','Recorte mudou.');
    if(atual.bloqueios.exportacao.length)fail('INTEGRIDADE','Exportação bloqueada.');
    const resultado=finalizar();
    if(resultado&&typeof resultado.then==='function')fail('ENTRADA','Finalização assíncrona recusada.');
    return resultado;
  }finally{db.exec('ROLLBACK');}
}
function projetar(t,row){
  if(t==='lume_execucao_contextos'){
    let pacote;try{pacote=JSON.parse(row.pacote);}catch{fail('INTEGRIDADE','Pacote histórico inválido.');}
    const chaves=['tarefa','resumo','fontes','avisos','timeline','criado_em'];
    return {id:row.id,acao_id:row.acao_id,criado_em:row.criado_em,expira_em:row.expira_em,
      pacote:Object.fromEntries(chaves.filter(k=>Object.hasOwn(pacote,k)).map(k=>[k,pacote[k]])),rotulo:'historico_sem_autorizacao'};
  }
  return Object.fromEntries(PROJECAO[t].map(k=>[k,row[k]]));
}

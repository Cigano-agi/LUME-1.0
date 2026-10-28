import {createHash,randomUUID} from 'node:crypto';
import {LEITURA_SQL,LEITURA_PESSOAL_SQL,leituraFonteSql} from './leitura-sql.js';
import {prepararValidadeOrganizacao,derivacaoOrganizacaoAtual,comLeituraOrganizacao} from './pessoal/organizacao-validade.js';
import {assinaturaFonte,HASH_FONTE_SQL} from './tarefas-esquema.js';
import {prepararFontes} from './fontes-desktop.js';
import {fonteAcionavelReuniao,retornoFonteReuniao,chaveAcaoReuniao} from './notetaker/vinculos.js';

const TIPOS=new Set(['compromisso','pendencia']);
const CAMPOS=['fonte','tipo','resumo','trecho','prazo_citado'];
const texto=(v,min,max)=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
const chave=(partes)=>createHash('sha256').update(JSON.stringify(partes)).digest('hex');
const prefixoCorrecao='{"tipo":"correcao_resumo",';
const prefixoResponsabilidade='{"tipo":"responsabilidade",';
export const RESPONSAVEL_LOCAL='local:owner';
function motivoHistoricoValido(motivo){
  if(typeof motivo!=='string')return false;
  if(motivo.startsWith(prefixoResponsabilidade)){
    if(motivo.length>200)return false;
    try{const dado=JSON.parse(motivo);return Object.keys(dado).sort().join('|')==='anterior|novo|tipo'&&dado.tipo==='responsabilidade'&&[null,RESPONSAVEL_LOCAL].includes(dado.anterior)&&[null,RESPONSAVEL_LOCAL].includes(dado.novo)&&dado.anterior!==dado.novo;}catch{return false;}
  }
  if(!motivo.startsWith(prefixoCorrecao))return motivo.length<=500;
  if(motivo.length>1200)return false;
  try{const dado=JSON.parse(motivo);return Object.keys(dado).sort().join('|')==='anterior|novo|tipo'&&dado.tipo==='correcao_resumo'&&texto(dado.anterior,1,500)&&texto(dado.novo,1,500);}catch{return false;}
}
export const ACOES_TABELAS=['lume_acoes_conversas','lume_acoes','lume_acoes_historico','lume_laya_fila'];
export const ACOES_BACKUP=['lume_acoes','lume_acoes_historico'];

export function validarBackupAcoes(t){
  const falha=()=>{throw new Error('Ações da 0.6 incompatíveis no backup.');};
  const idsEventos=new Set(t.eventos.map(e=>e.id)),idsAcoes=new Set(),identidades=new Set(),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),data=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
  for(const a of t.lume_acoes){
    const identidade=JSON.stringify([a.evento_id,a.chave]);
    if(!texto(a.id,1,200)||idsAcoes.has(a.id)||!idsEventos.has(a.evento_id)||!hash(a.chave)||identidades.has(identidade)||!hash(a.fonte_assinatura)||!TIPOS.has(a.tipo)||!texto(a.resumo,1,500)||!texto(a.trecho,8,300)||!Number.isInteger(a.trecho_inicio)||a.trecho_inicio<0||typeof a.prazo_citado!=='string'||a.prazo_citado.length>200||a.autor_id!==null&&typeof a.autor_id!=='string'||a.responsavel_id!==null&&typeof a.responsavel_id!=='string'||!['sugerido','confirmado','estacionado','resolvido','descartado'].includes(a.estado)||!data(a.criada_em)||!data(a.atualizada_em)||a.estado==='estacionado'&&(!data(a.lembrar_em)||!texto(a.fuso,1,100))||a.estado!=='estacionado'&&(a.lembrar_em!==null||a.fuso!==null)||a.aviso_para!==null&&(!data(a.aviso_para)||!data(a.aviso_em)||!['pendente','mostrado','falhou','sem-confirmacao','cancelado'].includes(a.aviso_resultado))||a.aviso_para===null&&(a.aviso_em!==null||a.aviso_resultado!==null))falha();
    idsAcoes.add(a.id);identidades.add(identidade);
  }
  const idsHistorico=new Set();
  for(const h of t.lume_acoes_historico){
    if(!Number.isSafeInteger(h.id)||h.id<1||idsHistorico.has(h.id)||!idsAcoes.has(h.acao_id)||!['sugerido','confirmado','estacionado','resolvido','descartado'].includes(h.estado_anterior)||!['sugerido','confirmado','estacionado','resolvido','descartado'].includes(h.estado_novo)||!data(h.alterada_em)||!motivoHistoricoValido(h.motivo)||(h.motivo.startsWith(prefixoCorrecao)||h.motivo.startsWith(prefixoResponsabilidade))&&h.estado_anterior!==h.estado_novo)falha();
    idsHistorico.add(h.id);
  }
}

export function prepararAcoesLume(db){
  prepararFontes(db);
  db.exec(`CREATE TABLE IF NOT EXISTS lume_acoes_conversas(
      conversa_id TEXT PRIMARY KEY, autorizada_em TEXT NOT NULL, inicio_evento_id INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS lume_acoes(
      id TEXT PRIMARY KEY,
      evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
      chave TEXT NOT NULL,
      fonte_assinatura TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN('compromisso','pendencia')),
      resumo TEXT NOT NULL,
      trecho TEXT NOT NULL,
      trecho_inicio INTEGER NOT NULL,
      prazo_citado TEXT NOT NULL,
      autor_id TEXT,
      responsavel_id TEXT,
      estado TEXT NOT NULL DEFAULT 'sugerido' CHECK(estado IN('sugerido','confirmado','estacionado','resolvido','descartado')),
      lembrar_em TEXT,
      fuso TEXT,
      aviso_para TEXT,
      aviso_em TEXT,
      aviso_resultado TEXT,
      criada_em TEXT NOT NULL,
      atualizada_em TEXT NOT NULL,
      UNIQUE(evento_id,chave)
    );
    CREATE TABLE IF NOT EXISTS lume_acoes_historico(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      acao_id TEXT NOT NULL REFERENCES lume_acoes(id) ON DELETE CASCADE,
      estado_anterior TEXT NOT NULL,
      estado_novo TEXT NOT NULL,
      alterada_em TEXT NOT NULL,
      motivo TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lume_acoes_estado ON lume_acoes(estado,atualizada_em);
    CREATE INDEX IF NOT EXISTS lume_acoes_evento ON lume_acoes(evento_id);`);
  const colunas=new Set(db.prepare('PRAGMA table_info(lume_acoes)').all().map(c=>c.name));
  for(const coluna of ['aviso_para','aviso_em','aviso_resultado'])if(!colunas.has(coluna))db.exec(`ALTER TABLE lume_acoes ADD COLUMN ${coluna} TEXT`);
  if(!db.prepare('PRAGMA table_info(lume_acoes_conversas)').all().some(c=>c.name==='inicio_evento_id')){
    db.exec('ALTER TABLE lume_acoes_conversas ADD COLUMN inicio_evento_id INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE lume_acoes_conversas SET inicio_evento_id=(SELECT COALESCE(MAX(id),0) FROM eventos)');
  }
}

export function conferirCandidatasAcoes(candidatas,fonte){
  if(!Array.isArray(candidatas)||candidatas.length>32)throw new Error('Lista de ações inválida.');
  if(!fonte||!Number.isSafeInteger(fonte.id)||!texto(fonte.texto,1,100000))throw new Error('Fonte de ação inválida.');
  const assinatura=assinaturaFonte(fonte),vistas=new Set();
  return candidatas.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join('|')!==CAMPOS.slice().sort().join('|')||
      item.fonte!=='E'+fonte.id||!TIPOS.has(item.tipo)||!texto(item.resumo,1,500)||!texto(item.trecho,8,300)||
      typeof item.prazo_citado!=='string'||item.prazo_citado.length>200||item.prazo_citado&&!item.trecho.includes(item.prazo_citado))
      throw new Error('Ação sem fonte literal verificável.');
    const inicio=fonte.texto.indexOf(item.trecho);
    if(inicio<0||fonte.texto.indexOf(item.trecho,inicio+1)!==-1)throw new Error('Trecho ausente ou repetido na fonte.');
    const identidade=chave([fonte.id,assinatura,item.tipo,inicio,item.trecho]);
    if(vistas.has(identidade))throw new Error('Ação duplicada na mesma fonte.');
    vistas.add(identidade);
    return {chave:identidade,fonte_assinatura:assinatura,tipo:item.tipo,resumo:item.resumo.trim(),trecho:item.trecho,
      trecho_inicio:inicio,prazo_citado:item.prazo_citado,autor_id:fonte.autor_id??null,responsavel_id:null};
  });
}

// Lista e contagens compartilham a mesma fronteira; conversa é identidade exata,
// aplicada no banco antes de qualquer limite. Não há interpretação de mensagens novas.
function consultaAcoesLume(db,{estado='sugerido',conversa,agora=new Date(),local=false}={}){
  prepararValidadeOrganizacao(db);
  if(!['ativos','minhas','sugerido','confirmado','estacionado','resolvido','descartado'].includes(estado)||
    conversa!==undefined&&!texto(conversa,1,200))throw new Error('Filtro de ações inválido.');
  const minhas=estado==='minhas',ativos=estado==='ativos'||minhas;
  const parametros=[ativos?agora.toISOString():estado];
  if(conversa!==undefined)parametros.push(conversa);
  const sql=`FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id
    ${local?'LEFT JOIN conversas_app c ON c.id=e.conversa_id':
      'LEFT JOIN lume_acoes_conversas p ON p.conversa_id=e.conversa_id JOIN conversas_app c ON c.id=e.conversa_id'}
    WHERE lume_organizacao_atual('acao',a.id)=1 AND ${ativos?"(a.estado IN ('sugerido','confirmado') OR (a.estado='estacionado' AND a.lembrar_em<=?))":"a.estado=?"}
    ${minhas?"AND a.responsavel_id='local:owner'":''}
    AND ${local?"e.tipo='notetaker_trecho'":"e.tipo<>'notetaker_trecho'"}
    AND a.fonte_assinatura=${HASH_FONTE_SQL} AND ${local?leituraFonteSql(db):`(
      (p.conversa_id IS NOT NULL AND ${LEITURA_SQL}) OR
      (${LEITURA_PESSOAL_SQL} AND e.permissao<>'compartilhado' AND NOT EXISTS
        (SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id)))`}
    ${conversa!==undefined?'AND e.conversa_id=?':''}`;
  return {sql,parametros,ativos};
}
function fonteAcaoPermitidaSql(db){return `(
  (e.tipo='notetaker_trecho' AND ${leituraFonteSql(db)}) OR
  (e.tipo<>'notetaker_trecho' AND (
    (p.conversa_id IS NOT NULL AND ${LEITURA_SQL}) OR
    (e.permissao<>'compartilhado' AND ${LEITURA_PESSOAL_SQL} AND NOT EXISTS
      (SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id)))))`;}

function comFonteLocal(db,row){
  if(!derivacaoOrganizacaoAtual(db,'acao',row.id))return null;
  if(row.fonte_tipo!=='notetaker_trecho'){
    const {fonte_tipo,...original}=row;
    return original;
  }
  const fonte=fonteAcionavelReuniao(db,row.evento_id,{anchor:row.trecho});
  const acao=typeof row.id==='string'?db.prepare('SELECT chave,fonte_assinatura,tipo,trecho_inicio,trecho FROM lume_acoes WHERE id=?').get(row.id):null;
  const chaveAtual=acao&&chaveAcaoReuniao(db,row.evento_id,acao);
  return fonte&&chaveAtual===acao.chave?{...row,...retornoFonteReuniao(fonte),autor_id:null}:null;
}

const ordemAcoes=ativos=>`${ativos?"CASE a.estado WHEN 'confirmado' THEN 0 WHEN 'sugerido' THEN 1 ELSE 2 END,":""}a.atualizada_em DESC,a.id DESC`;
function* linhasLocais(db,consulta,colunas){
  let ultimo='';
  while(true){
    const lote=db.prepare(`SELECT ${colunas},a.id cursor_id ${consulta.sql} AND a.id>? ORDER BY a.id LIMIT 64`).all(...consulta.parametros,ultimo);
    if(!lote.length)break;
    for(const row of lote){ultimo=row.cursor_id;yield row;}
    if(lote.length<64)break;
  }
}
function paginasLocais(db,consulta,colunas,ordem,limite=Infinity){
  const itens=[];let offset=0;
  while(itens.length<limite){
    const lote=db.prepare(`SELECT ${colunas} ${consulta.sql} ORDER BY ${ordem} LIMIT 64 OFFSET ?`).all(...consulta.parametros,offset);
    if(!lote.length)break;
    offset+=lote.length;
    for(const row of lote){const valido=comFonteLocal(db,row);if(valido)itens.push(valido);if(itens.length>=limite)break;}
    if(lote.length<64)break;
  }
  return itens;
}

function projetarExecucoesDaLista(db,acoes,execucoes){
  if(!acoes.length)return acoes;
  const ids=JSON.stringify(acoes.map(a=>a.id));
  if(execucoes){
    const states=new Map(execucoes.resumoParaAcoes(acoes.map(a=>a.id)).map(({acao_id,...rest})=>[acao_id,rest]));
    return acoes.map(a=>({...a,execucao_ui:states.get(a.id)||{estado:'indisponivel'}}));
  }
  const available=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_execucoes'").get();
  if(!available)return acoes.map(a=>({...a,execucao_ui:{estado:'nenhuma'}}));
  // A missing service must not turn an existing execution into a fresh Resolver.
  const present=new Set(db.prepare(`SELECT DISTINCT c.acao_id FROM lume_execucoes x
    JOIN lume_execucao_contextos c ON c.id=x.contexto_id WHERE c.acao_id IN (SELECT value FROM json_each(?))`).all(ids).map(row=>row.acao_id));
  return acoes.map(a=>({...a,execucao_ui:{estado:present.has(a.id)?'indisponivel':'nenhuma'}}));
}

export function contarAcoesLumePorConversa(db,opcoes){return comLeituraOrganizacao(db,()=>contarPorConversa(db,opcoes));}
function contarPorConversa(db,{conversa,agora=new Date()}={}){
  const {sql,parametros}=consultaAcoesLume(db,{estado:'ativos',conversa,agora});
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_acoes'").get())return [];
  const contagens=new Map(db.prepare(`SELECT e.conversa_id,COUNT(*) total ${sql} GROUP BY e.conversa_id`).all(...parametros)
    .map(x=>[x.conversa_id,x.total]));
  const local=consultaAcoesLume(db,{estado:'ativos',conversa,agora,local:true});
  for(const row of linhasLocais(db,local,'a.id,a.evento_id,a.trecho,e.tipo fonte_tipo,e.conversa_id'))
    if(comFonteLocal(db,row))contagens.set(row.conversa_id,(contagens.get(row.conversa_id)||0)+1);
  return [...contagens].map(([conversa_id,total])=>({conversa_id,total}));
}

export function resumoAcoesLume(db,opcoes){return comLeituraOrganizacao(db,()=>resumo(db,opcoes));}
function resumo(db,{agora=new Date()}={}){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_acoes'").get())return {total:0,itens:[]};
  const {sql,parametros}=consultaAcoesLume(db,{estado:'ativos',agora});
  const totalWa=db.prepare(`SELECT COUNT(*) total ${sql}`).get(...parametros).total;
  const wa=db.prepare(`SELECT a.id,a.estado,a.tipo,a.resumo,a.lembrar_em,e.id evento_id,e.conversa_id,c.nome conversa_nome,e.recebido_em
    ${sql} ORDER BY CASE a.estado WHEN 'confirmado' THEN 0 WHEN 'sugerido' THEN 1 ELSE 2 END,e.recebido_em DESC,a.id DESC LIMIT 3`).all(...parametros);
  const local=consultaAcoesLume(db,{estado:'ativos',agora,local:true});
  let totalLocal=0;
  for(const row of linhasLocais(db,local,'a.id,a.evento_id,a.trecho,e.tipo fonte_tipo'))if(comFonteLocal(db,row))totalLocal++;
  const locais=paginasLocais(db,local,'a.id,a.estado,a.tipo,a.resumo,a.trecho,a.lembrar_em,e.id evento_id,e.tipo fonte_tipo,e.conversa_id,c.nome conversa_nome,e.recebido_em',"CASE a.estado WHEN 'confirmado' THEN 0 WHEN 'sugerido' THEN 1 ELSE 2 END,e.recebido_em DESC,a.id DESC",3);
  const rank=x=>({confirmado:0,sugerido:1}[x.estado]??2);
  const itens=[...wa,...locais].sort((a,b)=>rank(a)-rank(b)||b.recebido_em.localeCompare(a.recebido_em)||b.id.localeCompare(a.id)).slice(0,3)
    .map(({recebido_em,trecho,...row})=>row);
  return {total:totalWa+totalLocal,itens};
}

export class AcoesLume {
  constructor(db,{agora=()=>new Date()}={}){this.db=db;this.agora=agora;this.execucoes=null;prepararAcoesLume(db);}
  definirExecucoes(execucoes){if(!execucoes||typeof execucoes.resumoParaAcoes!=='function')throw new TypeError('Serviço de execução inválido.');this.execucoes=execucoes;}
  obter(id){
    return comLeituraOrganizacao(this.db,()=>this._obter(id));
  }
  _obter(id){
    if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new Error('Identificador de ação inválido.');
    const row=this.db.prepare(`SELECT a.*,e.tipo fonte_tipo,e.conversa_id,c.nome conversa_nome,e.origem_id,e.recebido_em FROM lume_acoes a
      JOIN desktop_fontes e ON e.id=a.evento_id LEFT JOIN lume_acoes_conversas p ON p.conversa_id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id
      WHERE a.id=? AND a.fonte_assinatura=${HASH_FONTE_SQL} AND (
        (e.tipo='notetaker_trecho' AND ${leituraFonteSql(this.db)}) OR
        (e.tipo<>'notetaker_trecho' AND c.id IS NOT NULL AND (
          (p.conversa_id IS NOT NULL AND ${LEITURA_SQL}) OR
          (e.permissao<>'compartilhado' AND ${LEITURA_PESSOAL_SQL} AND NOT EXISTS
            (SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id)))))`).get(id);
    const current=row?comFonteLocal(this.db,row):null;
    return current?projetarExecucoesDaLista(this.db,[current],this.execucoes)[0]:null;
  }
  conversas({busca=''}={}){
    if(typeof busca!=='string'||busca.length>100)throw new Error('Busca de conversa inválida.');
    const termo=busca.trim().toLocaleLowerCase('pt-BR');
    return this.db.prepare(`SELECT c.id,c.nome,CASE WHEN p.conversa_id IS NULL THEN 0 ELSE 1 END autorizada
      FROM conversas_app c LEFT JOIN lume_acoes_conversas p ON p.conversa_id=c.id
      ORDER BY c.nome COLLATE NOCASE,c.id`).all().filter(c=>!termo||c.nome.toLocaleLowerCase('pt-BR').includes(termo)||c.id.toLocaleLowerCase('pt-BR').includes(termo)).slice(0,50);
  }
  autorizar({conversa,permitida}={}){
    if(typeof conversa!=='string'||!conversa||conversa.length>200||typeof permitida!=='boolean')throw new Error('Escolha uma conversa e a permissão local.');
    if(conversa.startsWith('local:notetaker:'))throw new Error('Reunião local não é conversa WhatsApp.');
    if(permitida){
      if(!this.db.prepare('SELECT 1 FROM conversas_app WHERE id=?').get(conversa))throw new Error('Conversa inexistente.');
      this.db.prepare('INSERT INTO lume_acoes_conversas(conversa_id,autorizada_em,inicio_evento_id) VALUES(?,?,(SELECT COALESCE(MAX(id),0) FROM eventos)) ON CONFLICT(conversa_id) DO NOTHING').run(conversa,this.agora().toISOString());
    }else{
      this.db.exec('BEGIN IMMEDIATE');
      try{this.db.prepare('DELETE FROM lume_acoes WHERE evento_id IN(SELECT id FROM eventos WHERE conversa_id=?)').run(conversa);
        if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_laya_fila'").get())this.db.prepare('DELETE FROM lume_laya_fila WHERE conversa_id=?').run(conversa);
        this.db.prepare('DELETE FROM lume_acoes_conversas WHERE conversa_id=?').run(conversa);this.db.exec('COMMIT');}
      catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    return {conversa,permitida};
  }
  registrar({eventoId,candidatas}={}){
    if(!Number.isSafeInteger(eventoId)||eventoId<1)throw new Error('Fonte de ação inválida.');
    this.db.exec('SAVEPOINT acoes_registrar');
    try{
      const fonte=this.db.prepare(`SELECT e.* FROM desktop_fontes e LEFT JOIN lume_acoes_conversas a ON a.conversa_id=e.conversa_id
        WHERE e.id=? AND (
          (a.conversa_id IS NOT NULL AND ${LEITURA_SQL}) OR
          (e.tipo<>'notetaker_trecho' AND e.permissao<>'compartilhado' AND ${LEITURA_PESSOAL_SQL}
            AND NOT EXISTS(SELECT 1 FROM f10_procedencias fp WHERE fp.evento_id=e.id)) OR
          (e.tipo='notetaker_trecho' AND ${leituraFonteSql(this.db)}))`).get(eventoId);
      if(!fonte)throw new Error('Fonte ausente ou sem permissão para organizar.');
      if(fonte.tipo==='notetaker_trecho'&&!fonteAcionavelReuniao(this.db,eventoId))throw new Error('Fonte local sem original ou revisão válida.');
      const itens=conferirCandidatasAcoes(candidatas,fonte),now=this.agora().toISOString();let novos=0;
      for(const item of itens){
        if(fonte.tipo==='notetaker_trecho')item.chave=chaveAcaoReuniao(this.db,eventoId,item);
        if(!item.chave)throw new Error('Vínculo da fonte local indisponível.');
        const antigo=this.db.prepare('SELECT id,estado FROM lume_acoes WHERE evento_id=? AND chave=?').get(eventoId,item.chave);
        if(antigo){if(antigo.estado==='sugerido'&&!this.db.prepare('SELECT 1 FROM lume_acoes_historico WHERE acao_id=? AND substr(motivo,1,?)=? LIMIT 1').get(antigo.id,prefixoCorrecao.length,prefixoCorrecao))this.db.prepare('UPDATE lume_acoes SET resumo=?,prazo_citado=?,atualizada_em=? WHERE id=?').run(item.resumo,item.prazo_citado,now,antigo.id);continue;}
        this.db.prepare(`INSERT INTO lume_acoes(id,evento_id,chave,fonte_assinatura,tipo,resumo,trecho,trecho_inicio,prazo_citado,autor_id,responsavel_id,criada_em,atualizada_em)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),eventoId,item.chave,item.fonte_assinatura,item.tipo,item.resumo,item.trecho,item.trecho_inicio,item.prazo_citado,item.autor_id,item.responsavel_id,now,now);
        novos++;
      }
      this.db.exec('RELEASE acoes_registrar');return {novos,total:itens.length};
    }catch(error){this.db.exec('ROLLBACK TO acoes_registrar;RELEASE acoes_registrar');throw error;}
  }
  contar({estado='sugerido',conversa}={}){
    return comLeituraOrganizacao(this.db,()=>this._contar({estado,conversa}));
  }
  _contar({estado,conversa}){
    const filtros={estado,conversa,agora:this.agora()};
    const {sql,parametros}=consultaAcoesLume(this.db,filtros);
    const totalWa=this.db.prepare(`SELECT COUNT(*) total ${sql}`).get(...parametros).total;
    const local=consultaAcoesLume(this.db,{...filtros,local:true});
    let totalLocal=0;
    for(const row of linhasLocais(this.db,local,'a.id,a.evento_id,a.trecho,e.tipo fonte_tipo'))
      if(comFonteLocal(this.db,row))totalLocal++;
    return totalWa+totalLocal;
  }
  listar({estado='sugerido',limite=50,pagina=1,conversa}={}){
    return comLeituraOrganizacao(this.db,()=>this._listar({estado,limite,pagina,conversa}));
  }
  _listar({estado,limite,pagina,conversa}){
    if(!Number.isInteger(limite)||limite<1||limite>100||!Number.isSafeInteger(pagina)||pagina<1||limite*pagina>1000000)throw new Error('Filtro de ações inválido.');
    const ate=limite*pagina;
    const filtros={estado,conversa,agora:this.agora()};
    const {sql,parametros,ativos}=consultaAcoesLume(this.db,filtros),ordem=ordemAcoes(ativos);
    const wa=this.db.prepare(`SELECT a.*,e.conversa_id,c.nome conversa_nome,e.origem_id,e.recebido_em ${sql}
      ORDER BY ${ordem} LIMIT ?`).all(...parametros,ate);
    const local=consultaAcoesLume(this.db,{...filtros,local:true});
    const locais=paginasLocais(this.db,local,'a.*,e.tipo fonte_tipo,e.conversa_id,c.nome conversa_nome,e.origem_id,e.recebido_em',ordem,ate);
    const rank=x=>({confirmado:0,sugerido:1}[x.estado]??2);
    const selected=[...wa,...locais].sort((a,b)=>(ativos?rank(a)-rank(b):0)||b.atualizada_em.localeCompare(a.atualizada_em)||b.id.localeCompare(a.id)).slice(ate-limite,ate);
    return projetarExecucoesDaLista(this.db,selected,this.execucoes);
  }
  corrigir({id,resumo}={}){
    if(typeof id!=='string'||!id||!texto(resumo,1,500))throw new Error('Escreva uma descrição de até 500 caracteres.');
    const novo=resumo.trim();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare(`SELECT a.*,e.tipo fonte_tipo FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id
        LEFT JOIN lume_acoes_conversas p ON p.conversa_id=e.conversa_id WHERE a.id=?
        AND a.fonte_assinatura=${HASH_FONTE_SQL} AND ${fonteAcaoPermitidaSql(this.db)}`).get(id);
      const atual=row&&comFonteLocal(this.db,row);
      if(!atual)throw new Error('A fonte mudou, foi excluída ou perdeu permissão. Confira antes de corrigir.');
      if(atual.resumo===novo){this.db.exec('COMMIT');return {id,resumo:novo,alterado:false};}
      const agora=this.agora().toISOString(),motivo=JSON.stringify({tipo:'correcao_resumo',anterior:atual.resumo,novo});
      if(!motivoHistoricoValido(motivo))throw new Error('Descrição inválida para o histórico.');
      this.db.prepare('UPDATE lume_acoes SET resumo=?,atualizada_em=? WHERE id=?').run(novo,agora,id);
      this.db.prepare('INSERT INTO lume_acoes_historico(acao_id,estado_anterior,estado_novo,alterada_em,motivo) VALUES(?,?,?,?,?)').run(id,atual.estado,atual.estado,agora,motivo);
      this.db.exec('COMMIT');return {id,resumo:novo,alterado:true};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  definirMinha({id,minha}={}){
    if(typeof id!=='string'||!id||typeof minha!=='boolean')throw new Error('Escolha se esta ação é sua.');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare(`SELECT a.*,e.tipo fonte_tipo FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id
        LEFT JOIN lume_acoes_conversas p ON p.conversa_id=e.conversa_id WHERE a.id=?
        AND a.fonte_assinatura=${HASH_FONTE_SQL} AND ${fonteAcaoPermitidaSql(this.db)}`).get(id);
      const atual=row&&comFonteLocal(this.db,row);
      if(!atual)throw new Error('A fonte mudou, foi excluída ou perdeu permissão. Confira antes de atribuir.');
      if(atual.responsavel_id!==null&&atual.responsavel_id!==RESPONSAVEL_LOCAL)throw new Error('Esta ação já tem outro responsável definido.');
      const novo=minha?RESPONSAVEL_LOCAL:null;
      if(atual.responsavel_id===novo){this.db.exec('COMMIT');return {id,minha,alterado:false};}
      const agora=this.agora().toISOString(),motivo=JSON.stringify({tipo:'responsabilidade',anterior:atual.responsavel_id,novo});
      this.db.prepare('UPDATE lume_acoes SET responsavel_id=?,atualizada_em=? WHERE id=?').run(novo,agora,id);
      this.db.prepare('INSERT INTO lume_acoes_historico(acao_id,estado_anterior,estado_novo,alterada_em,motivo) VALUES(?,?,?,?,?)').run(id,atual.estado,atual.estado,agora,motivo);
      this.db.exec('COMMIT');return {id,minha,alterado:true};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  revisar({id,acao,lembrarEm=null,fuso=null,motivo=''}={}){
    const destino={confirmar:'confirmado',estacionar:'estacionado',resolver:'resolvido',descartar:'descartado',reabrir:'confirmado'}[acao];
    if(typeof id!=='string'||!id||!destino||!texto(motivo,0,500)||motivo.startsWith(prefixoCorrecao)||motivo.startsWith(prefixoResponsabilidade))throw new Error('Revisão de ação inválida.');
    const agora=this.agora().toISOString();
    if(acao==='estacionar'){
      if(typeof lembrarEm!=='string'||!Number.isFinite(Date.parse(lembrarEm))||new Date(lembrarEm).toISOString()!==lembrarEm||Date.parse(lembrarEm)<=Date.parse(agora)||typeof fuso!=='string'||!fuso)throw new Error('Escolha data, hora e fuso válidos para lembrar.');
      try{new Intl.DateTimeFormat('pt-BR',{timeZone:fuso});}catch{throw new Error('Fuso inválido para o lembrete.');}
    }else if(lembrarEm!==null||fuso!==null)throw new Error('Data de lembrete só é aceita ao estacionar.');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare(`SELECT a.*,e.tipo fonte_tipo FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id
        LEFT JOIN lume_acoes_conversas p ON p.conversa_id=e.conversa_id WHERE a.id=?
        AND a.fonte_assinatura=${HASH_FONTE_SQL} AND ${fonteAcaoPermitidaSql(this.db)}`).get(id);
      const atual=row&&comFonteLocal(this.db,row);
      if(!atual)throw new Error('A fonte mudou, foi excluída ou perdeu permissão. Confira antes de agir.');
      const permitidas={sugerido:['confirmar','estacionar','descartar'],confirmado:['estacionar','resolver','descartar'],estacionado:['confirmar','estacionar','resolver','descartar'],resolvido:['reabrir'],descartado:['reabrir']};
      if(!permitidas[atual.estado].includes(acao))throw new Error('Esta transição de ação exige outra revisão.');
      if(acao==='estacionar'&&atual.estado==='estacionado'&&atual.lembrar_em===lembrarEm&&atual.fuso===fuso){this.db.exec('COMMIT');return {id,estado:destino,lembrarEm};}
      this.db.prepare(`UPDATE lume_acoes SET estado=?,lembrar_em=?,fuso=?,atualizada_em=?,
        aviso_para=CASE WHEN ?='estacionar' THEN NULL ELSE aviso_para END,
        aviso_em=CASE WHEN ?='estacionar' THEN NULL ELSE aviso_em END,
        aviso_resultado=CASE WHEN ?='estacionar' THEN NULL ELSE aviso_resultado END WHERE id=?`)
        .run(destino,acao==='estacionar'?lembrarEm:null,acao==='estacionar'?fuso:null,agora,acao,acao,acao,id);
      this.db.prepare('INSERT INTO lume_acoes_historico(acao_id,estado_anterior,estado_novo,alterada_em,motivo) VALUES(?,?,?,?,?)').run(id,atual.estado,destino,agora,motivo);
      this.db.exec('COMMIT');return {id,estado:destino,lembrarEm:acao==='estacionar'?lembrarEm:null};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}

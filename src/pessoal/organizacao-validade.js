import {createHash} from 'node:crypto';
import {LEITURA_SQL,LEITURA_PESSOAL_SQL} from '../leitura-sql.js';
import {assinaturaFonte} from '../tarefas-esquema.js';
import {evidenciaIdentidadeAfirmativa} from './organizacao-identidade.js';
import {avaliarAtribuicao,alvoIdentificado,identidadesUnicasDoProjeto} from './organizacao-atribuicao.js';

const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const parse=v=>{try{return JSON.parse(v);}catch{return null;}};
// Results live only inside one synchronous read snapshot. No cached decision
// survives a return, exception, later write, rollback or permission revocation.
const leituras=new WeakMap();
export function comLeituraOrganizacao(db,ler){
  if(leituras.has(db)){const valor=ler();if(valor&&typeof valor.then==='function')throw new TypeError('Leitura de organização deve ser síncrona.');return valor;}
  db.exec('SAVEPOINT lume_organizacao_leitura');leituras.set(db,new Map());
  try{const valor=ler();if(valor&&typeof valor.then==='function')throw new TypeError('Leitura de organização deve ser síncrona.');return valor;}
  finally{leituras.delete(db);db.exec('RELEASE lume_organizacao_leitura');}
}
export function memoLeituraOrganizacao(db,key,ler){const cache=leituras.get(db);if(!cache)return ler();if(cache.has(key))return cache.get(key);const valor=ler();if(cache.size<10000)cache.set(key,valor);return valor;}
export const configOrganizacao=(db,key)=>memoLeituraOrganizacao(db,'config:'+key,()=>parse(db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get('lume-1-organizacao-'+key)?.valor));
export function autorizacaoOrganizacao(db,id){
  return memoLeituraOrganizacao(db,'auth:'+id,()=>autorizacaoSemCache(db,id));
}
function autorizacaoSemCache(db,id){
  const p=db.prepare('SELECT remoto,atendimento FROM pessoal_politicas WHERE conversa_id=?').get(id),a=db.prepare('SELECT modo FROM autorizacoes WHERE conversa_id=?').get(id),ia=db.prepare('SELECT * FROM desktop_ia_conversas WHERE conversa_id=?').get(id);
  const atendimento=p?parse(p.atendimento):{},escopo=configOrganizacao(db,'escopo');
  const excluida=Boolean(p&&!atendimento||atendimento?.excluida||a?.modo==='ignorar'||ia?.permitida===0||p?.remoto===0),todas=escopo?.tipo==='todas'&&!excluida;
  return {remoto:!excluida&&(todas||p?.remoto===1),excluida,ignorada:a?.modo==='ignorar',permitida:!excluida&&(todas||ia?.permitida===1),todas,
    escopo:escopo?.revisao??null,decididoEm:ia?.decidido_em??null,revisao:configOrganizacao(db,'revisao:'+id)};
}
export function fonteOrganizacao(db,id){
  return memoLeituraOrganizacao(db,'fonte:'+id,()=>fonteSemCache(db,id));
}
function fonteSemCache(db,id){
  const all=configOrganizacao(db,'escopo')?.tipo==='todas';
  const e=db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND ${all?LEITURA_PESSOAL_SQL:LEITURA_SQL}`).get(id);
  if(!e)return null;const a=autorizacaoOrganizacao(db,e.conversa_id);
  return a.remoto&&a.permitida&&!a.excluida&&!a.ignorada?e:null;
}
export function guardaFonte(db,e,alvo=false){return memoLeituraOrganizacao(db,'guarda:'+e.id+':'+alvo,()=>({eventoId:e.id,assinatura:assinaturaFonte(e),autorizacao:digest(autorizacaoOrganizacao(db,e.conversa_id)),revisao:configOrganizacao(db,'fonte-revisao:'+e.id),alvo,
  correcoes:alvo?null:digest(['vinculo:','organizacoes:','temperatura:'].map(k=>configOrganizacao(db,k+e.id)))}));}
export function revisaoProjeto(db,id){return db.prepare("SELECT COALESCE(MAX(id),0) n FROM lume_projetos_historico WHERE projeto_id=? AND tipo IN('confirmado','arquivado','restaurado','fonte_desvinculada','importado_revisado')").get(id).n;}
export function contextoOrganizacaoAtual(db,prova){
  if(!prova||!Array.isArray(prova.fontes)||prova.fontes.length>64)return false;
  for(const f of prova.fontes){const e=fonteOrganizacao(db,f.eventoId);if(!e||digest(guardaFonte(db,e,f.alvo))!==digest(f))return false;}
  for(const p of prova.projetos||[]){
    const atual=db.prepare('SELECT nome,estado FROM lume_projetos_comerciais WHERE id=?').get(p.id);
    if(!atual||atual.nome!==p.nome||atual.estado!==p.estado||revisaoProjeto(db,p.id)!==p.revisao)return false;
    for(const f of p.fontes||[])if(!db.prepare('SELECT 1 FROM lume_projetos_fontes WHERE id=? AND projeto_id=? AND evento_id=? AND inicio=? AND tamanho=? AND removida=0 AND invalidada=0').get(f.id,p.id,f.eventoId,f.inicio,f.tamanho))return false;
  }return true;
}
export function resultadoOrganizacaoAtual(db,eventoId,prova=null){
  return memoLeituraOrganizacao(db,'resultado:'+eventoId+':'+(prova?digest(prova):''),()=>resultadoSemCache(db,eventoId,prova));
}
function resultadoSemCache(db,eventoId,prova){
  try{
    const r=prova||parse(db.prepare("SELECT resultado FROM etapas WHERE evento_id=? AND etapa='organizacao_chatgpt' AND estado='concluida'").get(eventoId)?.resultado),e=fonteOrganizacao(db,eventoId);
    if(!r||!e||r.assinatura!==assinaturaFonte(e)||r.autorizacao!==digest(autorizacaoOrganizacao(db,e.conversa_id)))return null;
    const contrato=configOrganizacao(db,'contrato-atual');if(contrato&&r.contrato!==contrato)return null;
    return !r.contexto||contextoOrganizacaoAtual(db,r.contexto)?r:null;
  }catch{return null;}
}
function atribuicaoVinculoAtual(db,id,marker,resultado){
  const link=db.prepare('SELECT projeto_id,evento_id,inicio,tamanho FROM lume_projetos_fontes WHERE id=?').get(id);
  if(!link)return false;
  const alvo={texto:fonteOrganizacao(db,link.evento_id)?.texto,inicio:link.inicio,tamanho:link.tamanho};
  const candidatos=(resultado.contexto?.projetos||[]).map(p=>({...p,fontes:p.fontes.map(f=>({...f,texto:fonteOrganizacao(db,f.eventoId)?.texto}))}));
  const candidato=candidatos.find(p=>p.id===link.projeto_id);if(!candidato)return false;
  const prova=marker.evidenciasVinculo,unicas=prova?.limitado?[]:identidadesUnicasDoProjeto(candidato.id,candidatos);
  // Old markers did not record which evidence the model chose. Do not invent
  // that choice from another base which happens to exist in the project.
  if(!prova)return alvoIdentificado(alvo,unicas);
  if(prova.projetoId!==link.projeto_id||prova.alvo?.eventoId!==link.evento_id||prova.alvo.inicio!==link.inicio||prova.alvo.tamanho!==link.tamanho||
    !Array.isArray(prova.fontes)||!prova.fontes.length||prova.fontes.length>4)return false;
  const evidencias=[];
  for(const f of prova.fontes){
    const fonte=fonteOrganizacao(db,f.eventoId);
    if(!fonte||f.eventoId===link.evento_id||!candidato.fontes.some(c=>c.eventoId===f.eventoId&&f.inicio>=c.inicio&&f.inicio+f.tamanho<=c.inicio+c.tamanho)||
      !evidenciaIdentidadeAfirmativa(fonte.texto,f.inicio,f.tamanho).elegivel)return false;
    evidencias.push({texto:fonte.texto,inicio:f.inicio,tamanho:f.tamanho});
  }
  return avaliarAtribuicao({alvo,evidencias,identidadesUnicas:unicas}).elegivel;
}
export function derivacaoOrganizacaoAtual(db,tipo,id,{externo=false,scope=null,ids=null}={}){
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_config'").get())return true;
    const marker=configOrganizacao(db,(tipo==='projeto'?'projeto-inferido:':tipo==='vinculo'?'vinculo-inferido:':'acao-inferida:')+id);
    if(!marker)return true;
    if(marker.manual===true)return true;
    const resultado=resultadoOrganizacaoAtual(db,marker.eventoId,marker.contexto?marker:null);if(!resultado)return false;
    const evidencias=tipo==='projeto'?db.prepare('SELECT evento_id,inicio,tamanho FROM lume_projetos_fontes WHERE projeto_id=? AND base=1 AND removida=0 AND invalidada=0').all(id):
      tipo==='vinculo'?db.prepare('SELECT evento_id,inicio,tamanho FROM lume_projetos_fontes WHERE id=? AND removida=0 AND invalidada=0').all(id):
      db.prepare('SELECT evento_id,trecho_inicio AS inicio,trecho FROM lume_acoes WHERE id=?').all(id);
    if(!evidencias.length||evidencias.some(f=>!evidenciaIdentidadeAfirmativa(fonteOrganizacao(db,f.evento_id)?.texto,f.inicio,f.tamanho??f.trecho?.length).elegivel))return false;
    if(tipo==='vinculo'&&!atribuicaoVinculoAtual(db,id,marker,resultado))return false;
    if(ids&&(resultado.contexto?.fontes||[{eventoId:marker.eventoId}]).some(f=>!ids.has(f.eventoId)))return false;
    if(externo)for(const f of resultado.contexto?.fontes||[{eventoId:marker.eventoId}]){
      const e=db.prepare(`SELECT e.* FROM desktop_fontes e WHERE e.id=? AND ${LEITURA_SQL}`).get(f.eventoId);if(!e)return false;
      if(scope&&(scope.kind==='today'?e.dia_local!==scope.date:scope.kind==='projects'?!scope.ids?.includes(e.projeto_id):scope.kind==='conversations'?!scope.ids?.includes(e.conversa_id):scope.kind!=='all'))return false;
    }
    return true;
  }catch{return false;}
}
/** Connection-local SQL boundary: not persisted in schemas/backups or grants. */
const preparadas=new WeakSet();
export function prepararValidadeOrganizacao(db){
  if(preparadas.has(db))return;
  db.function('lume_organizacao_atual',(tipo,id)=>derivacaoOrganizacaoAtual(db,tipo,id)?1:0);
  db.function('lume_organizacao_externa',(tipo,id,scope)=>derivacaoOrganizacaoAtual(db,tipo,id,{externo:true,scope:parse(scope)||{kind:'invalid'}})?1:0);preparadas.add(db);
}

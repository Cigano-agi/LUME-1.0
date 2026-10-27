import {createHash,randomUUID} from 'node:crypto';
import {assinaturaFonte} from '../tarefas-esquema.js';
import {avisosFonte} from '../fontes-desktop.js';
import {prepararRevisoesProjetos} from './esquema.js';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const falha=(mensagem,codigo)=>Object.assign(new Error(mensagem),{codigo});
const validadeMs=5*60*1000;
function campos(pedido,permitidos){
  if(!pedido||typeof pedido!=='object'||Array.isArray(pedido)||Object.keys(pedido).some(k=>!permitidos.includes(k)))
    throw falha('Confira os campos da seleção de ações.','PROJETO_INVALIDO');
}
function selecaoAtual(service,acaoIds,{iniciar=false}={}){
  const {db}=service;
  const tabelas=['lume_acoes','lume_acoes_conversas','lume_acoes_historico'];
  if(tabelas.some(nome=>!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nome)))
    throw falha('Ainda não há ações revistas para selecionar.','ACOES_INDISPONIVEIS');
  const acoes=[],fontes=[],identidades=[];
  for(const id of acaoIds){
    const a=db.prepare('SELECT * FROM lume_acoes WHERE id=?').get(id);
    const e=a?service._evento(a.evento_id):null;
    const permissao=e?db.prepare('SELECT * FROM lume_acoes_conversas WHERE conversa_id=?').get(e.conversa_id):null;
    if(!a||!e||!permissao||a.fonte_assinatura!==assinaturaFonte(e))
      throw falha('Uma ação perdeu a fonte ou a permissão. Selecione novamente.','FONTE_INDISPONIVEL');
    const revisao=db.prepare('SELECT MAX(id) id FROM lume_acoes_historico WHERE acao_id=?').get(id).id;
    const confirmada=db.prepare("SELECT 1 FROM lume_acoes_historico WHERE acao_id=? AND estado_novo='confirmado' AND estado_anterior<>'confirmado' LIMIT 1").get(id);
    if(a.estado!=='confirmado'||!confirmada)
      throw falha('Selecione somente ações confirmadas na revisão local.','ACAO_NAO_REVISADA');
    const f=service._selecao({eventoId:a.evento_id,trecho:a.trecho,inicio:a.trecho_inicio});
    if(fontes.some(anterior=>anterior.eventoId===f.eventoId&&anterior.inicio<f.inicio+f.tamanho&&f.inicio<anterior.inicio+anterior.tamanho))
      throw falha('Há trechos sobrepostos na seleção. Confira quais ações pertencem ao projeto.','SELECAO_AMBIGUA');
    if(iniciar)db.prepare('INSERT OR IGNORE INTO lume_projetos_revisoes(evento_id) VALUES(?)').run(e.id);
    const versao=db.prepare('SELECT versao FROM lume_projetos_revisoes WHERE evento_id=?').get(e.id)?.versao;
    if(!versao)throw falha('A fonte da prévia foi removida. Selecione novamente.','PREVIA_DESATUALIZADA');
    fontes.push(f);
    identidades.push([id,a.chave,a.estado,a.tipo,a.fonte_assinatura,a.trecho_inicio,a.trecho,revisao,permissao.autorizada_em,permissao.inicio_evento_id,versao]);
    acoes.push({id,tipo:a.tipo,estado:a.estado,eventoId:e.id,conversaId:e.conversa_id,origemId:e.origem_id,
      recebidoEm:e.recebido_em,autorId:e.autor_id??null,trecho:a.trecho,inicio:a.trecho_inicio,
      avisos:avisosFonte(e),transcricao:Boolean(e.transcricao_meta)});
  }
  return {acoes,fontes,assinatura:hash(identidades)};
}

/** Seleção humana de ações existentes. Nenhuma classificação ou chamada de modelo. */
export function previaDeAcoes(service,pedido={}){
  campos(pedido,['acaoIds']);
  if(!Array.isArray(pedido.acaoIds)||pedido.acaoIds.length<1||pedido.acaoIds.length>32||
    pedido.acaoIds.some(id=>!uuid(id))||new Set(pedido.acaoIds).size!==pedido.acaoIds.length)
    throw falha('Selecione de 1 a 32 ações diferentes.','PROJETO_INVALIDO');
  prepararRevisoesProjetos(service.db);
  const acaoIds=[...pedido.acaoIds].sort(),agora=service.agora().getTime();
  const selecao=service._transacao(()=>selecaoAtual(service,acaoIds,{iniciar:true}));
  for(const [id,p] of service.previasAcoes)if(p.expiraEm<=agora)service.previasAcoes.delete(id);
  while(service.previasAcoes.size>=16)service.previasAcoes.delete(service.previasAcoes.keys().next().value);
  const id=randomUUID(),expiraEm=agora+validadeMs;
  service.previasAcoes.set(id,{acaoIds,assinatura:selecao.assinatura,expiraEm});
  return {id,expiraEm:new Date(expiraEm).toISOString(),acoes:selecao.acoes,natureza:'incerto',
    acordoVerificado:false,automacao:false};
}

/** O adaptador autentica sessão/termos e exige gesto de criação separado da revisão de ação. */
export function criarRascunhoDeAcoes(service,pedido={}){
  campos(pedido,['previaId','nome','natureza','confirmar']);
  const {previaId,nome,natureza='incerto',confirmar}=pedido;
  if(confirmar!==true)throw falha('Confirme a seleção e a criação do rascunho.','CONFIRMACAO_NECESSARIA');
  if(typeof nome!=='string'||!nome.trim()||nome.length>160||!['incerto','proposta','acordo_citado'].includes(natureza))
    throw falha('Informe o nome e a natureza do rascunho.','PROJETO_INVALIDO');
  const previa=service.previasAcoes.get(previaId);
  if(!previa||previa.expiraEm<=service.agora().getTime()){
    service.previasAcoes.delete(previaId);
    throw falha('Abra uma nova prévia das ações antes de criar o rascunho.','PREVIA_EXPIRADA');
  }
  // A prévia é descartável, local e não atravessa reinício. O projeto salvo e sua
  // chave determinística atravessam; repetir com nova prévia não desfaz a revisão.
  service.previasAcoes.delete(previaId);
  return service._transacao(()=>{
    const antes=selecaoAtual(service,previa.acaoIds);
    if(antes.assinatura!==previa.assinatura)
      throw falha('As ações mudaram. Confira uma nova prévia.','PREVIA_DESATUALIZADA');
    const fontes=antes.acoes.map(a=>({eventoId:a.eventoId,trecho:a.trecho,inicio:a.inicio}));
    const bases=[...antes.fontes].sort((a,b)=>a.eventoId-b.eventoId||a.inicio-b.inicio||a.tamanho-b.tamanho);
    const chave=hash(['acoes_revisadas_v1',nome.trim(),natureza,bases]);
    const projeto=service.criarRascunho({nome,fontes,natureza,chave});
    // Revalidação após a escrita também cobre invalidação de vínculo e fontes.
    if(selecaoAtual(service,previa.acaoIds).assinatura!==antes.assinatura||!service.obter(projeto.id))
      throw falha('A fonte ou a revisão mudou durante a criação.','PREVIA_DESATUALIZADA');
    return projeto;
  });
}

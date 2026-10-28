import {lacunaFonte} from './contexto.js';
import {guardaFonte,contextoOrganizacaoAtual,revisaoProjeto} from './organizacao-validade.js';
import {restricoesIdentidade} from './organizacao-identidade.js';

const parse=v=>{try{return JSON.parse(v);}catch{return null;}};
export const VERSAO_CONTEXTO='bases-antes-contexto-distante-1';
const normal=v=>String(v).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\d]+/gu,' ').trim();
const genericos=new Set('projeto projetos trabalho trabalhos cliente clientes equipe grupo conversa mensagem vamos fazer enviar mandar preparar material revisao revisar preciso precisa sobre para como esse essa este esta isso uma com dos das'.split(' '));
const termos=v=>new Set(normal(v).split(' ').filter(t=>t.length>=4&&!genericos.has(t)));
const contem=(texto,nome)=>Boolean(nome)&&(' '+normal(texto)+' ').includes(' '+normal(nome)+' ');
function relevancia(p,alvo,imediatos){
  const objeto=termos(p.fontes.filter(f=>f.base).map(f=>f.trecho).join(' '));
  const comum=t=>[...termos(t)].filter(x=>objeto.has(x)).length;
  return (contem(alvo,p.nome)?100:0)+(contem(imediatos,p.nome)?40:0)+4*comum(alvo)+comum(imediatos);
}

/** Bounded, same-conversation context. It grants no permission of its own. */
export class ContextoOrganizacao {
  constructor(org){this.org=org;this.db=org.db;}
  guardar(e,alvo=false){
    return guardaFonte(this.db,e,alvo);
  }
  atual(prova){
    return contextoOrganizacaoAtual(this.db,prova);
  }
  revisaoProjeto(id){return revisaoProjeto(this.db,id);}
  montar(e){
    const anteriorOuAtual=f=>f&&(f.recebido_em<e.recebido_em||f.recebido_em===e.recebido_em&&f.id<=e.id);
    const fontes=new Map(),guards=new Map(),candidatos=[],limites=new Set();let caracteres=e.texto.length;
    const adicionar=(f)=>{
      if(fontes.has(f?.id))return true;
      if(!f||f.conversa_id!==e.conversa_id||lacunaFonte(f)||f.do_proprio_bot||fontes.size>=12||caracteres+f.texto.length>16000)return false;
      fontes.set(f.id,f);guards.set(f.id,this.guardar(f));caracteres+=f.texto.length;return true;
    };
    fontes.set(e.id,e);guards.set(e.id,this.guardar(e,true));
    const anteriores=this.db.prepare('SELECT id FROM eventos WHERE conversa_id=? AND (recebido_em<? OR recebido_em=? AND id<?) ORDER BY recebido_em DESC,id DESC LIMIT 30').all(e.conversa_id,e.recebido_em,e.recebido_em,e.id);
    const recentes=anteriores.map(row=>this.org.fonte(row.id,{remoto:true})).filter(f=>f&&!lacunaFonte(f)&&!f.do_proprio_bot);
    // Keep the immediate thread, then reserve space for complete project bases.
    for(const f of recentes.slice(0,2))if(!adicionar(f))limites.add('caracteres');
    const ids=this.db.prepare(`SELECT f.projeto_id FROM lume_projetos_fontes f JOIN eventos e ON e.id=f.evento_id
      JOIN lume_projetos_comerciais p ON p.id=f.projeto_id WHERE e.conversa_id=? AND f.invalidada=0 AND f.removida=0 AND p.estado<>'arquivado'
      AND (e.recebido_em<? OR e.recebido_em=? AND e.id<=?)
      GROUP BY f.projeto_id ORDER BY MAX(e.recebido_em) DESC,MAX(e.id) DESC LIMIT 24`).all(e.conversa_id,e.recebido_em,e.recebido_em,e.id);
    if(ids.length===24)limites.add('busca');
    const imediatos=recentes.slice(0,2).filter(f=>fontes.has(f.id)).map(f=>f.texto).join(' ');
    const elegiveis=ids.map((row,ordem)=>({p:this.org.projetos.obter(row.projeto_id),ordem})).filter(x=>x.p)
      .map(x=>({...x,pontos:relevancia(x.p,e.texto,imediatos)})).sort((a,b)=>b.pontos-a.pontos||a.ordem-b.ordem);
    const basesOmitidas=new Set();
    for(const {p} of elegiveis){
      if(candidatos.length>=8){limites.add('candidatos');break;}
      const bases=p.fontes.filter(f=>f.base),eventos=bases.map(f=>this.org.fonte(f.eventoId,{remoto:true}));
      if(eventos.some(f=>!anteriorOuAtual(f)))continue;
      if(!bases.length||eventos.some(f=>!f||f.conversa_id!==e.conversa_id||lacunaFonte(f)))continue;
      // Names inferred from older context carry its complete permission lineage.
      const automatic=this.org.config('projeto-inferido:'+p.id),lineage=[];
      if(automatic){
        const raw=parse(this.db.prepare("SELECT resultado FROM etapas WHERE evento_id=? AND etapa='organizacao_chatgpt' AND estado='concluida'").get(automatic.eventoId)?.resultado);
        if(!raw||raw.contexto&&!this.atual(raw.contexto))continue;
        lineage.push(...(raw.contexto?.fontes||[]));
      }
      const faltantes=[...new Map(eventos.filter(f=>!fontes.has(f.id)).map(f=>[f.id,f])).values()];
      const limite=new Set([...guards.keys(),...eventos.map(f=>f.id),...lineage.map(f=>f.eventoId)]).size>64?'linhagem':
        fontes.size+faltantes.length>12?'fontes':caracteres+faltantes.reduce((sum,f)=>sum+f.texto.length,0)>16000?'caracteres':null;
      if(limite){limites.add(limite);for(const f of faltantes)basesOmitidas.add(f.id);continue;}
      for(const f of eventos)adicionar(f);
      for(const g of lineage)if(!guards.has(g.eventoId))guards.set(g.eventoId,g);
      const refs=p.fontes.filter(f=>anteriorOuAtual(fontes.get(f.eventoId))&&(!this.org.vinculoManual(f.eventoId,f.inicio,f.tamanho)||this.org.vinculoManual(f.eventoId,f.inicio,f.tamanho)?.projetoId===p.id))
        .map(f=>({id:f.id,eventoId:f.eventoId,trecho:f.trecho,inicio:f.inicio,tamanho:f.tamanho})).slice(0,8);
      if(!refs.length)continue;
      candidatos.push({id:p.id,nome:p.nome,estado:p.estado,revisao:this.revisaoProjeto(p.id),fontes:refs});
    }
    // Distant recent messages use only the remainder. Do not partially reinsert
    // an oversized project's bases after its atomic selection was refused.
    for(const f of recentes.slice(0,8)){if(fontes.size>=12)break;if(!basesOmitidas.has(f.id))adicionar(f);}
    const contexto=[...fontes.values()].filter(f=>f.id!==e.id).sort((a,b)=>a.recebido_em.localeCompare(b.recebido_em)||a.id-b.id).map(f=>({eventoId:f.id,autorId:f.autor_id,data:f.recebido_em,texto:f.texto}));
    const prova={fontes:[...guards.values()],projetos:candidatos.map(({id,nome,estado,revisao,fontes})=>({id,nome,estado,revisao,fontes:fontes.map(({id,eventoId,inicio,tamanho})=>({id,eventoId,inicio,tamanho}))}))};
    const correcoes=[...fontes.values()].flatMap(f=>this.org.correcoesVinculo(f.id).map(v=>({eventoId:f.id,trecho:v.trecho,projetoId:v.projetoId})));
    const restricoes=[...fontes.values()].flatMap(f=>restricoesIdentidade(f.texto).map(r=>({eventoId:f.id,...r}))).slice(0,24);
    return {fontes,prova,candidatos,input:{eventoId:e.id,tipoConversa:e.conversa_id.endsWith('@g.us')?'grupo':'pessoa',autorId:e.autor_id,
      data:e.recebido_em,texto:e.texto,contexto,projetos:candidatos,correcoes,contextoParcial:true,...(limites.size?{limitesContexto:[...limites]}:{}),...(restricoes.length?{restricoesIdentidade:restricoes}:{})}};
  }
}

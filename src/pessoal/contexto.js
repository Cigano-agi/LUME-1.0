import {AcoesLume} from '../acoes-lume.js';
import {LEITURA_SQL,LEITURA_PESSOAL_SQL} from '../leitura-sql.js';
import {assinaturaFonte,prepararTarefas} from '../tarefas-esquema.js';
import {unidadesConsulta,trechoRelevante} from '../trechos-recuperacao.js';
import {fundirRankings} from '../semantica.js';
import {aguardar} from './leitura-limitada.js';

const JANELA=200;
export const validarConversa=id=>{
  if(typeof id!=='string'||!id.trim()||id.length>200||/[\x00-\x1f]/u.test(id))throw new Error('Conversa exata inválida.');
  return id;
};
export function leituraPessoalSql(db,remoto=false){
  if(typeof remoto!=='boolean')throw new Error('Destino de contexto inválido.');
  if(!remoto)return LEITURA_PESSOAL_SQL;
  const existe=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desktop_ia_conversas'").get();
  return existe?`(${LEITURA_SQL} AND EXISTS(SELECT 1 FROM desktop_ia_conversas p WHERE p.conversa_id=e.conversa_id AND p.permitida=1))`:'0';
}
export function lacunaFonte(e){
  let transcricao=null;
  if(e.transcricao_meta){try{transcricao=JSON.parse(e.transcricao_meta);}catch{return 'transcricao_invalida';}}
  if(transcricao&&transcricao.estado!=='transcrito')return `${e.tipo==='documento'?'documento':'audio'}_${['erro','vazio','indisponivel'].includes(transcricao.estado)?transcricao.estado:'pendente'}`;
  if(e.tipo==='audio'&&!transcricao)return 'audio_pendente';
  if(typeof e.texto!=='string'||!e.texto.trim()||/<(?:anexado|attached):|^\[(?:áudio|audio|mídia|midia):/iu.test(e.texto))return e.tipo==='audio'?'audio_pendente':'midia_sem_texto';
  return null;
}
const CAMPOS='e.id,e.conversa_id,e.origem_id,e.tipo,e.texto,e.permissao,e.recebido_em,e.projeto_id,e.origem_compartilhamento,e.autor_id,e.autor_e_dono,e.do_proprio_bot,e.transcricao_meta';
const fontePublica=(e,texto=e.texto)=>({id:e.id,conversaId:e.conversa_id,texto,autor:e.autor_e_dono===1?'Você':e.autor_id??'Não identificado',data:e.recebido_em,assinatura:assinaturaFonte(e),tipo:e.tipo,
  ...(e.tipo==='documento'&&e.transcricao_meta?{conteudo:JSON.parse(e.transcricao_meta).modelo?.endsWith(':parcial')?'documento_extraido_parcial':'documento_extraido'}:{}),
  ...(e.tipo==='imagem'?{conteudo:'legenda_apenas_imagem_nao_interpretada'}:{})});

// Only bounded candidate windows reach the application. Existing FTS is optional:
// this service never rebuilds an index or loads the full archive on a question.
export class ContextoPessoal {
  constructor(db){this.db=db;prepararTarefas(db);this.acoes=new AcoesLume(db);}
  async recuperarHibrido({pergunta='',conversaId=null,remoto=false,semantica=null,signal}={}){
    const lexical=this.recuperar({pergunta,conversaId,remoto});
    lexical.modo='textual';
    const revalidar=()=>{
      signal?.throwIfAborted();
      lexical.fontes=lexical.fontes.filter(f=>{
        const atual=this.db.prepare(`SELECT ${CAMPOS} FROM desktop_fontes e WHERE e.id=? AND ${leituraPessoalSql(this.db,remoto)}`).get(f.id);
        return atual&&(!conversaId||atual.conversa_id===conversaId)&&!lacunaFonte(atual)&&assinaturaFonte(atual)===f.assinatura;
      }).slice(0,12);
      lexical.acoes=this.pendencias({conversaId,remoto});
      return lexical;
    };
    if(!semantica?.ativa()||!semantica.pronta())return revalidar();
    const deadline=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
    try {
      const hits=await aguardar(semantica.buscar({pergunta,conversa:conversaId,ate:new Date().toISOString().slice(0,10)},
        {remoto,limite:10,limiteVetores:500}),deadline);
      if(!semantica.ativa())throw Error('Busca pausada.');
      const densas=[];
      for(const hit of hits){
        const e=this.db.prepare(`SELECT ${CAMPOS} FROM desktop_fontes e WHERE e.id=? AND ${leituraPessoalSql(this.db,remoto)} AND length(COALESCE(e.texto,''))<=100000`).get(hit.id);
        if(!e||conversaId&&e.conversa_id!==conversaId||lacunaFonte(e)||assinaturaFonte(e)!==assinaturaFonte(hit))continue;
        densas.push({...fontePublica(e,String(hit.trecho||e.texto).slice(0,1800)),truncada:true});
      }
      lexical.fontes=fundirRankings(lexical.fontes,densas,12).map(({rrf,...fonte})=>fonte);
      lexical.modo=densas.length?'hibrido':'textual';
      lexical.lacunas.push({tipo:'janela_semantica_parcial',vetores:500});
      return revalidar();
    }catch {
      signal?.throwIfAborted();lexical.lacunas.push({tipo:'semantica_indisponivel'});return revalidar();
    }
  }
  recuperar({pergunta='',conversaId=null,remoto=false}={}){
    if(typeof pergunta!=='string'||pergunta.length>2000)throw new Error('Pergunta inválida.');
    if(conversaId!==null)validarConversa(conversaId);
    const leitura=leituraPessoalSql(this.db,remoto),args=conversaId?[conversaId]:[];
    const filtro=conversaId?'WHERE conversa_id=?':'';
    const recentes=this.db.prepare(`WITH candidatos AS MATERIALIZED (SELECT id FROM eventos ${filtro} ORDER BY recebido_em DESC,id DESC LIMIT ${JANELA})
      SELECT ${CAMPOS} FROM candidatos k JOIN desktop_fontes e ON e.id=k.id
      WHERE ${leitura} AND length(COALESCE(e.texto,''))<=100000 ORDER BY e.recebido_em DESC,e.id DESC LIMIT 20`).all(...args);
    const unidades=unidadesConsulta(pergunta),temFts=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='desktop_fontes_fts' AND type='table'").get();
    let lexicais=[];
    if(unidades.length&&temFts){
      const consulta=unidades.map(u=>'"'+u.tokens.join(' ')+'"').join(' OR ');
      lexicais=this.db.prepare(`WITH candidatos AS MATERIALIZED (SELECT f.rowid FROM desktop_fontes_fts f
        ${conversaId?'JOIN eventos o ON o.id=f.rowid':''} WHERE desktop_fontes_fts MATCH ? ${conversaId?'AND o.conversa_id=?':''} LIMIT ${JANELA})
        SELECT ${CAMPOS} FROM candidatos k JOIN desktop_fontes e ON e.id=k.rowid WHERE ${leitura}
        AND length(COALESCE(e.texto,''))<=100000 ORDER BY e.recebido_em DESC,e.id DESC LIMIT 10`).all(consulta,...args);
    }else if(unidades.length){
      lexicais=recentes.filter(e=>unidades.some(u=>e.texto?.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().includes(u.tokens.join(' ')))).slice(0,10);
    }
    const linhas=[...new Map([...recentes.slice(0,10),...lexicais,...recentes].map(e=>[e.id,e])).values()];
    const fontes=[],lacunas=[];let tamanho=0;
    for(const e of linhas){
      const motivo=lacunaFonte(e);
      if(motivo){lacunas.push({eventoId:e.id,conversaId:e.conversa_id,tipo:motivo});continue;}
      if(fontes.length>=20||tamanho>=24000)break;
      const recorte=trechoRelevante(e.texto,unidades,Math.min(1800,24000-tamanho));
      const texto=recorte?.trecho??e.texto;
      fontes.push({...fontePublica(e,texto),truncada:texto!==e.texto});tamanho+=texto.length;
    }
    if(!fontes.length)lacunas.push({tipo:'sem_fontes_permitidas'});
    // Coverage is explicitly partial, even if a bounded window happens to be full.
    lacunas.push({tipo:'cobertura_parcial',janela:JANELA,indiceLexical:Boolean(temFts)});
    return {fontes,acoes:this.pendencias({conversaId,remoto}),lacunas,conversaId};
  }
  resolverConversa({nome,remoto=false}={}){
    validarConversa(nome);
    const leitura=leituraPessoalSql(this.db,remoto);
    const normal=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().trim();
    this.db.function('lume_nome_pessoal',{deterministic:true},normal);
    let candidatos=this.db.prepare(`SELECT c.id,c.nome FROM conversas_app c WHERE (c.id=? OR lume_nome_pessoal(c.nome)=?)
      AND EXISTS(SELECT 1 FROM desktop_fontes e WHERE e.conversa_id=c.id AND ${leitura}) ORDER BY c.id LIMIT 21`).all(nome,normal(nome));
    if(!candidatos.length&&/^[\p{L}\s'-]+$/u.test(nome)){
      const prefixo=normal(nome).replace(/[\\%_]/g,x=>'\\'+x)+' %';
      candidatos=this.db.prepare(`SELECT c.id,c.nome FROM conversas_app c WHERE lume_nome_pessoal(c.nome) LIKE ? ESCAPE '\\'
        AND EXISTS(SELECT 1 FROM desktop_fontes e WHERE e.conversa_id=c.id AND ${leitura}) ORDER BY c.id LIMIT 21`).all(prefixo);
    }
    return {conversaId:candidatos.length===1?candidatos[0].id:null,ambigua:candidatos.length>1,candidatos:candidatos.slice(0,20),truncada:candidatos.length>20};
  }
  registrarDemanda({eventoId,resumo,trecho,tipo='pendencia'}={}){
    if(!Number.isSafeInteger(eventoId)||eventoId<1)throw new Error('Fonte de ação inválida.');
    const e=this.db.prepare(`SELECT ${CAMPOS} FROM desktop_fontes e WHERE e.id=? AND ${LEITURA_PESSOAL_SQL}`).get(eventoId);
    if(!e||lacunaFonte(e))throw new Error('Fonte indisponível ou áudio ainda sem transcrição.');
    const resultado=this.acoes.registrar({eventoId,candidatas:[{fonte:'E'+eventoId,resumo,trecho,tipo,prazo_citado:''}]});
    const row=this.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=? AND fonte_assinatura=? AND tipo=? AND trecho=? LIMIT 1').get(eventoId,assinaturaFonte(e),tipo,trecho);
    return {...resultado,acaoId:row?.id??null};
  }
  acompanhar(acaoId,{remoto=false,conversaId=null}={}){
    if(conversaId!==null)validarConversa(conversaId);
    const acao=this.acoes.obter(acaoId);if(!acao)return null;
    if(conversaId!==null&&acao.conversa_id!==conversaId)return null;
    const e=this.db.prepare(`SELECT ${CAMPOS} FROM desktop_fontes e WHERE e.id=? AND ${leituraPessoalSql(this.db,remoto)}`).get(acao.evento_id);
    if(!e||lacunaFonte(e))return null;
    const historico=this.db.prepare('SELECT estado_anterior,estado_novo,alterada_em,motivo FROM lume_acoes_historico WHERE acao_id=? ORDER BY id DESC LIMIT 20').all(acaoId);
    return {acao,fonte:fontePublica(e,e.texto.slice(0,1800)),historico};
  }
  pendencias({conversaId=null,remoto=false,limite=20}={}){
    if(conversaId!==null)validarConversa(conversaId);
    if(!Number.isInteger(limite)||limite<1||limite>20)throw new Error('Limite inválido.');
    const leitura=leituraPessoalSql(this.db,remoto),args=conversaId?[conversaId]:[];
    const rows=this.db.prepare(`WITH candidatas AS MATERIALIZED (SELECT a.id,a.evento_id FROM lume_acoes a
      ${conversaId?'JOIN eventos o ON o.id=a.evento_id WHERE o.conversa_id=? AND':'WHERE'} a.estado IN ('sugerido','confirmado','estacionado') ORDER BY a.atualizada_em DESC,a.id DESC LIMIT ${JANELA})
      SELECT a.id FROM candidatas a JOIN desktop_fontes e ON e.id=a.evento_id WHERE ${leitura} LIMIT ${JANELA}`).all(...args);
    const acoes=[];
    for(const r of rows){const atual=this.acoes.obter(r.id);if(atual)acoes.push(atual);if(acoes.length>=limite)break;}
    return acoes;
  }
}

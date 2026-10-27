import {LEITURA_PESSOAL_SQL as LEITURA_SQL} from './leitura-sql.js';
import {SUGESTAO_ATUAL_SQL} from './tarefas-esquema.js';
import {criarNomeVisivel} from './nomes-conversa.js';
import {regraPrioridade} from './prioridade-desktop.js';
import {normalizarTag} from './comandos-whatsapp.js';
import {contarAcoesLumePorConversa} from './acoes-lume.js';

const NOMES='LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id';
const ACOES=`FROM itens_crm i JOIN eventos e ON e.conversa_id=i.conversa_id AND e.origem_id=i.origem_id
 WHERE i.estado='aberto' AND ${LEITURA_SQL}
 AND NOT EXISTS(SELECT 1 FROM desktop_tarefas_sugestoes s WHERE s.item_id=i.id AND NOT ${SUGESTAO_ATUAL_SQL})`;
const normalizar=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
function paginaValida(pagina){if(!Number.isSafeInteger(pagina)||pagina<1)throw Error('Página de conversas inválida.');}
function paginar(total,pagina,porPagina){const paginas=Math.max(1,Math.ceil(total/porPagina));return{total,numero:Math.min(pagina,paginas),paginas,porPagina};}
const leituraComo=alias=>LEITURA_SQL.replace(/\be\./gu,`${alias}.`);
function chaveTag(valor){
  if(valor===undefined||valor===null||valor==='')return'';
  if(typeof valor!=='string')throw Error('Tag inválida.');
  const tag=normalizarTag(valor);if(!tag.valida)throw Error('Tag inválida.');return tag.chave;
}

export function listarConversas(db,{q='',filtro='todas',pagina=1,tag=''}={}){
  paginaValida(pagina);
  if(typeof q!=='string'||q.length>200||!['todas','acoes','oportunidades'].includes(filtro))throw Error('Escolha um filtro de conversas válido.');
  const chave=chaveTag(tag),args=[];
  const porTag=chave?` AND EXISTS(SELECT 1 FROM lume_tags_entidades te
    JOIN lume_tags lt ON lt.id=te.tag_id
    JOIN lume_comandos lc ON lc.id=te.comando_id
    JOIN eventos origem ON origem.id=lc.evento_id AND origem.conversa_id=lc.conversa_id AND origem.origem_id=lc.origem_id
    WHERE te.entidade_tipo='conversa' AND te.entidade_id=e.conversa_id AND te.estado='ativa'
      AND lt.chave=? AND ${leituraComo('origem')})`:'';
  if(chave)args.push(chave);
  const acoes=new Map(db.prepare(`SELECT e.conversa_id,COUNT(*) acoes,SUM(i.tipo='lead') oportunidades ${ACOES}${porTag} GROUP BY e.conversa_id`).all(...args).map(r=>[r.conversa_id,r]));
  const atuais=new Map(contarAcoesLumePorConversa(db).map(r=>[r.conversa_id,r.total]));
  const nomeVisivel=criarNomeVisivel(db);
  let conversas=db.prepare(`SELECT e.conversa_id id,COALESCE(g.nome,c.nome,e.conversa_id) nome,
    COUNT(*) mensagens,COUNT(DISTINCT NULLIF(e.autor_id,'')) pessoas,MAX(e.recebido_em) ultimaMensagemEm
    FROM eventos e ${NOMES} WHERE ${LEITURA_SQL}${porTag} GROUP BY e.conversa_id`).all(...args)
    .map(c=>{const acoesLegadas=acoes.get(c.id)?.acoes||0,acoes06=atuais.get(c.id)||0;
      return {...c,nome:nomeVisivel(c.nome,c.id),acoes:acoesLegadas+acoes06,acoesLegadas,acoes06,oportunidades:acoes.get(c.id)?.oportunidades||0};});
  const consulta=normalizar(q.trim());
  conversas=conversas.filter(c=>(!consulta||normalizar(c.nome).includes(consulta))&&(filtro==='todas'||c[filtro]>0));
  conversas.sort((a,b)=>b.acoes-a.acoes||String(b.ultimaMensagemEm||'').localeCompare(String(a.ultimaMensagemEm||''))||a.id.localeCompare(b.id));
  const p=paginar(conversas.length,pagina,12);
  return{conversas:conversas.slice((p.numero-1)*p.porPagina,p.numero*p.porPagina),pagina:p};
}

export function detalheConversa(db,{conversa,paginaAcoes=1,paginaPessoas=1}={}){
  paginaValida(paginaAcoes);paginaValida(paginaPessoas);
  if(typeof conversa!=='string'||!conversa||conversa.length>200)throw Error('Escolha uma conversa válida.');
  const resumo=db.prepare(`SELECT e.conversa_id id,COALESCE(g.nome,c.nome,e.conversa_id) nome,COUNT(*) mensagens,
    COUNT(DISTINCT NULLIF(e.autor_id,'')) pessoas,MAX(e.recebido_em) ultimaMensagemEm
    FROM eventos e ${NOMES} WHERE e.conversa_id=? AND ${LEITURA_SQL} GROUP BY e.conversa_id`).get(conversa);
  if(!resumo)throw Error('Conversa indisponível neste recorte.');
  const nomeVisivel=criarNomeVisivel(db);resumo.nome=nomeVisivel(resumo.nome,resumo.id);
  const totais=db.prepare(`SELECT COUNT(*) acoes,COALESCE(SUM(i.tipo='lead'),0) oportunidades ${ACOES} AND e.conversa_id=?`).get(conversa);
  const acoes06=contarAcoesLumePorConversa(db,{conversa})[0]?.total||0;
  const a=paginar(totais.acoes,paginaAcoes,5),p=paginar(resumo.pessoas,paginaPessoas,6);
  const regra=regraPrioridade('oportunidades');
  const tarefas=db.prepare(`SELECT i.id,i.tipo,i.resumo,i.quando,e.id evento_id ${ACOES} AND e.conversa_id=? ORDER BY ${regra.sql} LIMIT ? OFFSET ?`).all(conversa,a.porPagina,(a.numero-1)*a.porPagina);
  const pessoas=db.prepare(`SELECT e.autor_id id,MAX(e.autor_e_dono) dono,COUNT(*) mensagens,MAX(e.id) fonte_id
    FROM eventos e WHERE e.conversa_id=? AND ${LEITURA_SQL} AND e.autor_id IS NOT NULL AND e.autor_id<>''
    GROUP BY e.autor_id ORDER BY mensagens DESC,e.autor_id LIMIT ? OFFSET ?`).all(conversa,p.porPagina,(p.numero-1)*p.porPagina)
    .map(p=>{const nome=nomeVisivel(null,p.id);return{...p,nome:p.dono?'Você':nome==='Contato sem nome'?'Nome não disponível':nome};});
  return{...resumo,...totais,acoes:totais.acoes+acoes06,acoesLegadas:totais.acoes,acoes06,tarefas,pessoas,paginaAcoes:a,paginaPessoas:p,ordem:regra.explicacao};
}

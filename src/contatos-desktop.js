import {createHash} from 'node:crypto';
import {LEITURA_PESSOAL_SQL as LEITURA_SQL} from './leitura-sql.js';
import {NEGOCIO_ATUAL_SQL} from './negocios-desktop.js';
import {qualidadeFonte} from './consulta-transcricao.js';
import {normalizarTag} from './comandos-whatsapp.js';
import {HASH_FONTE_SQL} from './tarefas-esquema.js';
import {criarNomeVisivel,nomeWhatsappValido} from './nomes-conversa.js';

const direta=id=>typeof id==='string'&&/^[^@\s]+@(lid|s\.whatsapp\.net|c\.us)$/.test(id);
const normalizar=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
const isolado=id=>'a:'+createHash('sha256').update(id).digest('hex');

function criarResolvedorContato(db,{exigirJid=false}={}){
  let pessoas=new Map(),identidades=new Map();
  try{
    pessoas=new Map(db.prepare('SELECT id,nome_exibicao,nome_cru,fundida_em FROM pessoas').all().map(p=>[Number(p.id),p]));
    identidades=new Map(db.prepare('SELECT identificador,pessoa_id FROM pessoa_identificadores WHERE ativo=1').all().map(p=>[p.identificador,Number(p.pessoa_id)]));
  }catch{/* banco anterior ao cadastro: identificadores validos continuam isolados */}
  const raizes=new Map();
  function raiz(id){
    const caminho=new Set();let atual=id;
    while(atual!=null&&!raizes.has(atual)){
      if(caminho.has(atual)||!pessoas.has(atual)){atual=null;break;}
      caminho.add(atual);const proxima=pessoas.get(atual).fundida_em;
      if(proxima==null)break;atual=Number(proxima);
    }
    const resultado=raizes.has(atual)?raizes.get(atual):atual;
    for(const p of caminho)raizes.set(p,resultado);
    return resultado;
  }
  return identificador=>{
    if(typeof identificador!=='string'||!identificador||exigirJid&&!direta(identificador))return null;
    const pessoa=identidades.has(identificador)?raiz(identidades.get(identificador)):null;
    return {id:pessoa==null?isolado(identificador):'p:'+pessoa,pessoa:pessoa==null?null:pessoas.get(pessoa)};
  };
}

// Resolucao deliberadamente exata: o JID inteiro e a unica chave aceita. Nome,
// telefone parcial e conversa parecida nunca participam da identidade projetada.
export function criarResolvedorContatoPorIdentificador(db){
  const resolver=criarResolvedorContato(db,{exigirJid:true});
  return identificador=>resolver(identificador)?.id??null;
}
export function resolverContatoPorIdentificador(db,identificador){
  return criarResolvedorContatoPorIdentificador(db)(identificador);
}
function paginar(total,numero,tamanho){
  if(!Number.isSafeInteger(numero)||numero<1)throw Error('Escolha uma página válida.');
  const paginas=Math.max(1,Math.ceil(total/tamanho));
  return{total,numero:Math.min(numero,paginas),paginas,porPagina:tamanho};
}
const recortar=(lista,p)=>lista.slice((p.numero-1)*p.porPagina,p.numero*p.porPagina);
const leituraComo=alias=>LEITURA_SQL.replace(/\be\./gu,`${alias}.`);
function chaveTag(valor){
  if(valor===undefined||valor===null||valor==='')return'';
  if(typeof valor!=='string')throw Error('Tag inválida.');
  const tag=normalizarTag(valor);if(!tag.valida)throw Error('Tag inválida.');return tag.chave;
}

function contatosDaTag(db,chave){
  if(!chave)return null;
  const resolver=criarResolvedorContato(db,{exigirJid:true});
  const linhas=db.prepare(`SELECT DISTINCT te.entidade_id
    FROM lume_tags_entidades te
    JOIN lume_tags lt ON lt.id=te.tag_id
    JOIN lume_comandos lc ON lc.id=te.comando_id
    JOIN eventos origem ON origem.id=lc.evento_id AND origem.conversa_id=lc.conversa_id AND origem.origem_id=lc.origem_id
    WHERE te.entidade_tipo='contato' AND te.estado='ativa' AND lt.chave=? AND ${leituraComo('origem')}
      AND EXISTS(SELECT 1 FROM eventos alvo WHERE ${leituraComo('alvo')}
        AND ((COALESCE(alvo.autor_e_dono,0)=0 AND alvo.autor_id=te.entidade_id)
          OR alvo.conversa_id=te.entidade_id))`).all(chave);
  return new Set(linhas.map(linha=>resolver(linha.entidade_id)?.id).filter(Boolean));
}

// A projeção nasce das fontes permitidas. O cadastro só resolve vínculos exatos.
// Nenhum nome, número parecido ou participação num grupo cria um vínculo.
function projetar(db,{inicio=null,fim=null}={}){
  const identidade=criarResolvedorContato(db);
  const nomeVisivel=criarNomeVisivel(db);
  const linhas=db.prepare(`SELECT e.autor_id,e.conversa_id,COALESCE(e.autor_e_dono,0) dono,
    COUNT(*) mensagens,MAX(e.recebido_em) ultimaMensagemEm
    FROM eventos e WHERE ${LEITURA_SQL} GROUP BY e.autor_id,e.conversa_id,COALESCE(e.autor_e_dono,0)`).all();
  const donos=new Set(linhas.filter(l=>l.dono&&l.autor_id).map(l=>identidade(l.autor_id).id));
  const nomes=new Map(db.prepare(`SELECT e.conversa_id id,COALESCE(g.nome,c.nome,e.conversa_id) nome
    FROM eventos e LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id
    WHERE ${LEITURA_SQL} GROUP BY e.conversa_id`).all().map(c=>[c.id,nomeVisivel(c.nome,c.id)]));
  const contatos=new Map();
  for(const linha of linhas){
    const candidatos=new Set();
    if(!linha.dono&&linha.autor_id)candidatos.add(linha.autor_id);
    if(direta(linha.conversa_id))candidatos.add(linha.conversa_id);
    const contados=new Set();
    for(const identificador of candidatos){
      const {id,pessoa}=identidade(identificador);if(donos.has(id))continue;
      let c=contatos.get(id);
      if(!c){const conhecido=nomeVisivel(pessoa?.nome_exibicao||pessoa?.nome_cru,identificador);
        c={id,nome:nomeWhatsappValido(conhecido,identificador)?conhecido:'',identificadores:new Set(),conversas:new Map(),mensagens:0,ultimaMensagemEm:null,mensagensPeriodo:0,fonteId:null,fonteEm:null,compromissoPendenteComprovado:false,compromissoFonteId:null};contatos.set(id,c);}
      c.identificadores.add(identificador);
      if(!c.nome&&direta(identificador)&&nomeWhatsappValido(nomes.get(identificador),identificador))c.nome=nomes.get(identificador);
      if(contados.has(id))continue;contados.add(id);
      c.mensagens+=linha.mensagens;
      if(!c.ultimaMensagemEm||linha.ultimaMensagemEm>c.ultimaMensagemEm)c.ultimaMensagemEm=linha.ultimaMensagemEm;
      let conversa=c.conversas.get(linha.conversa_id);
      if(!conversa){conversa={id:linha.conversa_id,nome:nomes.get(linha.conversa_id),mensagens:0};c.conversas.set(linha.conversa_id,conversa);}
      conversa.mensagens+=linha.mensagens;
    }
  }
  if(fim){
    // One bounded aggregate and one source lookup for the whole window, not a query per card.
    const windowSql=`FROM eventos e WHERE ${LEITURA_SQL} AND e.recebido_em<=? ${inicio?'AND e.recebido_em>=?':''}`;
    const args=inicio?[fim,inicio]:[fim];
    const counts=db.prepare(`SELECT e.autor_id,e.conversa_id,COALESCE(e.autor_e_dono,0) dono,COUNT(*) total ${windowSql}
      GROUP BY e.autor_id,e.conversa_id,COALESCE(e.autor_e_dono,0)`).all(...args);
    const sources=db.prepare(`SELECT autor_id,conversa_id,dono,id,recebido_em FROM (
      SELECT e.autor_id,e.conversa_id,COALESCE(e.autor_e_dono,0) dono,e.id,e.recebido_em,
      ROW_NUMBER() OVER(PARTITION BY e.autor_id,e.conversa_id,COALESCE(e.autor_e_dono,0) ORDER BY e.recebido_em DESC,e.id DESC) rn
      ${windowSql}) WHERE rn=1`).all(...args);
    const sourceMap=new Map(sources.map(row=>[JSON.stringify([row.autor_id,row.conversa_id,row.dono]),row]));
    for(const row of counts){
      const candidates=new Set();
      if(!row.dono&&row.autor_id)candidates.add(row.autor_id);
      if(direta(row.conversa_id))candidates.add(row.conversa_id);
      const seen=new Set(),source=sourceMap.get(JSON.stringify([row.autor_id,row.conversa_id,row.dono]));
      for(const identifier of candidates){
        const id=identidade(identifier)?.id,c=contatos.get(id);
        if(!c||seen.has(id))continue;
        seen.add(id);c.mensagensPeriodo+=row.total;
        if(source&&(!c.fonteEm||source.recebido_em>c.fonteEm||source.recebido_em===c.fonteEm&&source.id>c.fonteId)){
          c.fonteId=source.id;c.fonteEm=source.recebido_em;
        }
      }
    }
    // A pending commitment requires its current literal source and current read permission.
    // The exact author or direct-chat recipient is the only person relation.
    const commitments=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_acoes'").get()?db.prepare(`SELECT a.evento_id,e.autor_id,e.conversa_id,COALESCE(e.autor_e_dono,0) dono
      FROM lume_acoes a JOIN desktop_fontes e ON e.id=a.evento_id
      JOIN lume_acoes_conversas allowed ON allowed.conversa_id=e.conversa_id
      WHERE a.tipo='compromisso' AND a.estado IN ('confirmado','estacionado')
      AND e.tipo<>'notetaker_trecho' AND a.fonte_assinatura=${HASH_FONTE_SQL} AND ${LEITURA_SQL}`).all():[];
    for(const row of commitments){
      const candidates=new Set();
      if(!row.dono&&row.autor_id)candidates.add(row.autor_id);
      if(direta(row.conversa_id))candidates.add(row.conversa_id);
      for(const identifier of candidates){
        const c=contatos.get(identidade(identifier)?.id);
        if(c&&!donos.has(c.id)){
          c.compromissoPendenteComprovado=true;
          if(c.compromissoFonteId===null||row.evento_id>c.compromissoFonteId)c.compromissoFonteId=row.evento_id;
        }
      }
    }
  }
  return contatos;
}
const resumo=c=>({id:c.id,nome:c.nome||'Nome não disponível',mensagens:c.mensagens,conversas:c.conversas.size,ultimaMensagemEm:c.ultimaMensagemEm,
  mensagensPeriodo:c.mensagensPeriodo,fonteId:c.fonteId,compromissoPendenteComprovado:c.compromissoPendenteComprovado,compromissoFonteId:c.compromissoFonteId});

function projetosDaPagina(servico,contatos,projetados){
  if(!servico||typeof servico.resumosConfirmadosPorContatos!=='function'||!contatos.length)return contatos;
  try{
    const entradas=contatos.map(c=>({id:c.id,identificadores:[...projetados.get(c.id).identificadores]}));
    const resumos=servico.resumosConfirmadosPorContatos(entradas);
    if(!(resumos instanceof Map))return contatos;
    return contatos.map(c=>resumos.has(c.id)?{...c,projetoComprovado:resumos.get(c.id)}:c);
  }catch{return contatos;/* omitir relação incerta sem esconder as pessoas */}
}

export function listarContatos(db,{q='',pagina=1,tag='',periodo='semana',agora=new Date(),projetosComerciais=null}={}){
  paginar(0,pagina,12);
  if(typeof q!=='string'||q.length>200)throw Error('Digite um nome com até 200 caracteres.');
  if(!['semana','30dias','tudo'].includes(periodo)||!(agora instanceof Date)||!Number.isFinite(agora.getTime()))throw Error('Escolha um período válido.');
  const fim=agora.toISOString(),inicio=periodo==='tudo'?null:new Date(agora.getTime()-(periodo==='semana'?7:30)*86400000).toISOString();
  const consulta=normalizar(q.trim()),permitidos=contatosDaTag(db,chaveTag(tag));
  const projetados=projetar(db,{inicio,fim});
  const contatos=[...projetados.values()].map(resumo)
    .filter(c=>(!permitidos||permitidos.has(c.id))&&(!consulta||normalizar(c.nome).includes(consulta)));
  contatos.sort((a,b)=>Number(b.compromissoPendenteComprovado)-Number(a.compromissoPendenteComprovado)||b.mensagensPeriodo-a.mensagensPeriodo||
    String(b.ultimaMensagemEm||'').localeCompare(String(a.ultimaMensagemEm||''))||a.nome.localeCompare(b.nome,'pt-BR')||a.id.localeCompare(b.id));
  const p=paginar(contatos.length,pagina,12);
  return{contatos:projetosDaPagina(projetosComerciais,recortar(contatos,p),projetados),pagina:p,periodo,janela:{inicio,fim},ordem:'Compromisso confirmado com fonte atual, mensagens no período e última interação.'};
}

export function detalheContato(db,{contato,paginaConversas=1,paginaMensagens=1,paginaNegocios=1,projetosComerciais=null}={}){
  for(const p of [paginaConversas,paginaMensagens,paginaNegocios])paginar(0,p,6);
  if(typeof contato!=='string'||!/^(p:[1-9]\d*|a:[a-f0-9]{64})$/.test(contato)||contato.length>80)throw Error('Escolha um contato válido.');
  const c=projetar(db).get(contato);if(!c)throw Error('Contato indisponível. Atualize suas conversas.');
  const identificadores=[...c.identificadores].sort(),dms=identificadores.filter(direta);
  // json_each evita limites de parâmetros sem interpolar identificadores no SQL.
  const vinculo=`((COALESCE(e.autor_e_dono,0)=0 AND e.autor_id IN(SELECT value FROM json_each(?))) OR e.conversa_id IN(SELECT value FROM json_each(?)))`;
  const parametros=[JSON.stringify(identificadores),JSON.stringify(dms)];
  const p=paginar(c.mensagens,paginaMensagens,8),conversas=[...c.conversas.values()].sort((a,b)=>b.mensagens-a.mensagens||a.id.localeCompare(b.id));
  const pc=paginar(conversas.length,paginaConversas,6);
  const mensagens=db.prepare(`SELECT e.id,e.tipo,e.origem_id,e.conversa_id,substr(e.texto,1,220) texto,e.recebido_em,e.autor_e_dono
    FROM desktop_fontes e WHERE ${LEITURA_SQL} AND ${vinculo} ORDER BY e.recebido_em DESC,e.id DESC LIMIT ? OFFSET ?`).all(...parametros,p.porPagina,(p.numero-1)*p.porPagina)
    .map(m=>({...m,...qualidadeFonte(db,m),conversa_nome:c.conversas.get(m.conversa_id)?.nome}));
  const from=`FROM desktop_negocios n JOIN desktop_fontes e ON e.id=n.evento_id WHERE ${NEGOCIO_ATUAL_SQL} AND ${vinculo}`;
  const pn=paginar(db.prepare(`SELECT COUNT(*) total ${from}`).get(...parametros).total,paginaNegocios,6);
  const negocios=db.prepare(`SELECT n.id,n.evento_id,n.titulo,n.etapa,n.valor_centavos,n.proximo_contato ${from}
    ORDER BY n.atualizado_em DESC,n.id LIMIT ? OFFSET ?`).all(...parametros,pn.porPagina,(pn.numero-1)*pn.porPagina);
  const basico=projetosDaPagina(projetosComerciais,[resumo(c)],new Map([[c.id,c]]))[0];
  return{...basico,identificadores,conversas:recortar(conversas,pc),mensagens,negocios,paginaConversas:pc,paginaMensagens:p,paginaNegocios:pn};
}

import {recorte} from './recuperacao.js';
import {LEITURA_PESSOAL_SQL as LEITURA_SQL,PROJETO_SQL} from './leitura-sql.js';
import {criarNomeVisivel} from './nomes-conversa.js';

const NOMES='LEFT JOIN grupos_app g ON g.id=e.conversa_id LEFT JOIN conversas_app c ON c.id=e.conversa_id';
const normalizar=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('pt-BR');
export function filtroGrafo({periodo='tudo',projeto=''}={},agora=new Date()){
  const filtro=recorte({pergunta:'mapa',periodo,projeto},agora);
  const where=[LEITURA_SQL,'e.dia_local<=?'],args=[filtro.ate];
  if(filtro.desde){where.push('e.dia_local>=?');args.push(filtro.desde);}
  if(projeto){where.push(PROJETO_SQL);args.push(projeto,projeto,projeto);}
  return {where,args,filtro};
}
export function grafoDesktop(db,{q='',periodo='tudo',projeto='',foco='',pagina=1}={},agora=new Date()){
  if(typeof q!=='string'||q.length>200||typeof foco!=='string'||foco.length>202||(foco&&!/^[cp]:.+$/s.test(foco)))throw Error('Filtro do mapa inválido.');
  if(!Number.isSafeInteger(pagina)||pagina<1)throw Error('Página do mapa inválida.');
  const {where,args,filtro}=filtroGrafo({periodo,projeto},agora);
  const tipo=foco.slice(0,2),identificador=foco.slice(2);
  if(foco){where.push(tipo==='c:'?'e.conversa_id=?':'e.autor_id=?');args.push(identificador);}
  const sql=where.join(' AND '),consulta=normalizar(q.trim());
  const nomeVisivel=criarNomeVisivel(db),nomesPessoas=new Map();
  const nomePessoa=(id,dono)=>{
    if(dono)return 'Você';
    if(!nomesPessoas.has(id))nomesPessoas.set(id,nomeVisivel(null,id));
    return nomesPessoas.get(id);
  };
  // Aggregate only readable rows. Search is accent-insensitive over these visible titles.
  let todas=db.prepare(`SELECT e.conversa_id id,COALESCE(g.nome,c.nome,e.conversa_id) nome,
    COUNT(*) mensagens,COUNT(DISTINCT NULLIF(e.autor_id,'')) participantes,
    SUM(e.autor_id IS NULL OR e.autor_id='') semAutor,MAX(e.recebido_em) ultimaMensagemEm
    ${consulta?',json_group_array(DISTINCT json_array(e.autor_id,COALESCE(e.autor_e_dono,0))) autoresBusca':''}
    FROM eventos e ${NOMES} WHERE ${sql} GROUP BY e.conversa_id ORDER BY ultimaMensagemEm DESC,e.conversa_id`).all(...args)
    .map(c=>({...c,nome:nomeVisivel(c.nome,c.id)}));
  const pessoasEncontradas=new Map();
  if(consulta){
    // Same ACL, dates, project and exact focus precede the name lookup. Search
    // uses the same indexed aggregate, avoiding a second pass over the corpus.
    const corresponde=new Map();
    for(const c of todas){
      for(const [id,dono] of JSON.parse(c.autoresBusca)){
        if(!id)continue;const chave=JSON.stringify([id,dono]);
        if(!corresponde.has(chave))corresponde.set(chave,normalizar(nomePessoa(id,dono)).includes(consulta)||id===q.trim());
        if(!corresponde.get(chave))continue;
        if(!pessoasEncontradas.has(c.id))pessoasEncontradas.set(c.id,new Set());
        pessoasEncontradas.get(c.id).add(id);
      }
      delete c.autoresBusca; // Hidden/unpaged author IDs are never part of the response.
    }
    todas=todas.filter(c=>normalizar(c.nome+' '+c.id).includes(consulta)||pessoasEncontradas.has(c.id));
  }
  const total=todas.reduce((t,c)=>({mensagens:t.mensagens+c.mensagens,conversas:t.conversas+1,ligacoes:t.ligacoes+c.participantes,semAutor:t.semAutor+c.semAutor}),{mensagens:0,conversas:0,ligacoes:0,semAutor:0});
  const porPagina=tipo==='c:'?18:12,quantidade=tipo==='c:'?(todas[0]?.participantes||0):todas.length;
  const paginas=Math.max(1,Math.ceil(quantidade/porPagina));pagina=Math.min(pagina,paginas);
  const conversas=tipo==='c:'?todas:todas.slice((pagina-1)*porPagina,pagina*porPagina);
  const pessoas=new Map(),arestas=[];
  const autores=db.prepare(`SELECT e.autor_id,MAX(e.autor_e_dono) dono,COUNT(*) mensagens,MAX(e.id) fonte_id
    FROM eventos e WHERE ${sql} AND e.conversa_id=? AND e.autor_id IS NOT NULL AND e.autor_id<>''
    GROUP BY e.autor_id ORDER BY CASE WHEN e.autor_id IN(SELECT value FROM json_each(?)) THEN 0 ELSE 1 END,
      mensagens DESC,e.autor_id LIMIT ? OFFSET ?`);
  for(const c of conversas){
    for(const a of autores.all(...args,c.id,JSON.stringify([...(pessoasEncontradas.get(c.id)??[])]),tipo==='c:'?18:3,tipo==='c:'?(pagina-1)*18:0)){
      const id='p:'+a.autor_id,anterior=pessoas.get(id);
      pessoas.set(id,{id,autor_id:a.autor_id,nome:nomePessoa(a.autor_id,a.dono),tipo:'pessoa',mensagens:(anterior?.mensagens||0)+a.mensagens});
      arestas.push({origem:id,destino:'c:'+c.id,autor_id:a.autor_id,conversa_id:c.id,mensagens:a.mensagens,fonte_id:a.fonte_id});
    }
  }
  const nos=[...conversas.map(c=>({...c,conversa_id:c.id,id:'c:'+c.id,tipo:'conversa'})),...pessoas.values()];
  const projetos=db.prepare('SELECT id,nome FROM f10_projetos UNION SELECT id,nome FROM projetos WHERE id NOT IN (SELECT id FROM f10_projetos) ORDER BY nome').all();
  return {nos,arestas,total,projetos,recorte:{periodo,projeto,desde:filtro.desde,ate:filtro.ate},
    foco:nos.find(n=>n.id===foco)||null,
    pagina:{numero:pagina,paginas,porPagina,total:quantidade,tipo:tipo==='c:'?'participantes':'conversas'},
    exibido:{conversas:conversas.length,ligacoes:arestas.length,limiteParticipantes:tipo==='c:'?18:3},limiteConversas:12};
}
export function fontesGrafo(db,{conversa,autor,periodo='tudo',projeto='',antes=Number.MAX_SAFE_INTEGER}={}){
  if(typeof conversa!=='string'||!conversa||conversa.length>200||typeof autor!=='string'||!autor||autor.length>200)throw Error('Escolha uma ligação válida.');
  if(!Number.isSafeInteger(antes)||antes<1)throw Error('Página de fontes inválida.');
  const {where,args}=filtroGrafo({periodo,projeto});
  const ids=db.prepare(`SELECT e.id FROM eventos e WHERE ${where.join(' AND ')} AND e.conversa_id=? AND e.autor_id=? AND e.id<? ORDER BY e.id DESC LIMIT 11`).all(...args,conversa,autor,antes);
  return {ids:ids.slice(0,10).map(e=>e.id),proximoAntes:ids.length>10?ids[9].id:null};
}

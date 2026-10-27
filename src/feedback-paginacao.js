const opcoes={etapa:new Set(['onboarding','hoje','conexao','organiza','ajustes']),severidade:new Set(['alta','media','baixa']),estado:new Set(['novo','em_analise','resolvido']),plataforma:new Set(['win32','darwin'])};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const erro=()=>Object.assign(new Error('FILTRO_FEEDBACK_INVALIDO'),{codigo:'FILTRO_FEEDBACK_INVALIDO',status:400});

export const TAMANHO_PAGINA_FEEDBACK=20;

export function codificarCursorFeedback(item){
  return Buffer.from(JSON.stringify({em:item.criadoEm,id:item.id})).toString('base64url');
}

export function normalizarListaFeedback(entrada={}){
  if(!entrada||typeof entrada!=='object'||Array.isArray(entrada)||Object.keys(entrada).some(key=>!['etapa','severidade','estado','versao','plataforma','cursor'].includes(key)))throw erro();
  const filtro={};
  for(const [key,permitidos]of Object.entries(opcoes)){
    const value=entrada[key];
    if(value!==undefined&&value!==''&&(typeof value!=='string'||!permitidos.has(value)))throw erro();
    filtro[key]=value||null;
  }
  const versao=entrada.versao;
  if(versao!==undefined&&versao!==''&&(typeof versao!=='string'||!/^[0-9A-Za-z._-]{1,40}$/.test(versao)))throw erro();
  filtro.versao=versao||null;
  const cursor=entrada.cursor;
  if(cursor!==undefined&&cursor!==''){
    if(typeof cursor!=='string'||cursor.length>180||!/^[A-Za-z0-9_-]+$/.test(cursor))throw erro();
    let parsed;
    try{parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw erro();}
    if(Buffer.from(JSON.stringify(parsed)).toString('base64url')!==cursor||!parsed||Object.keys(parsed).sort().join(',')!=='em,id'||typeof parsed.em!=='string'||!Number.isFinite(Date.parse(parsed.em))||new Date(parsed.em).toISOString()!==parsed.em||typeof parsed.id!=='string'||!uuid.test(parsed.id))throw erro();
    filtro.cursor={em:parsed.em,id:parsed.id};
  }else filtro.cursor=null;
  return filtro;
}

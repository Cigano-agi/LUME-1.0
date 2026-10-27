const VERSAO=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const erro=(codigo,status=500)=>Object.assign(new Error(codigo),{codigo,status});
const naoConfigurada=()=>erro('CENTRAL_NAO_CONFIGURADA',503);
const segredo=(env,nome)=>{
  const valor=env[nome];
  if(typeof valor!=='string'||valor.length<32||valor.length>512)throw naoConfigurada();
  return valor;
};

export function origemPublica(valor,{producao=false}={}){
  let url;
  try{url=new URL(valor);}catch{throw naoConfigurada();}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.origin!==valor||url.username||url.password||(!local&&url.protocol!=='https:')||(producao&&local))throw naoConfigurada();
  return url.origin;
}

export function validarAmbienteCentral(env=process.env,{publicacao=false}={}){
  const producao=env.VERCEL_ENV==='production'||env.NODE_ENV==='production';
  const databaseUrl=env.DATABASE_URL;
  let banco;
  try{banco=new URL(databaseUrl);}catch{throw naoConfigurada();}
  if(!['postgres:','postgresql:'].includes(banco.protocol)||!banco.hostname)throw naoConfigurada();
  if(producao&&!['require','verify-full'].includes(banco.searchParams.get('sslmode')))throw naoConfigurada();
  const adminSecret=segredo(env,'LUME_ADMIN_SECRET');
  const tokenPepper=segredo(env,'LUME_TOKEN_PEPPER');
  if(adminSecret===tokenPepper)throw naoConfigurada();
  if(typeof env.LUME_BETA_VERSION!=='string'||!VERSAO.test(env.LUME_BETA_VERSION))throw naoConfigurada();
  const publicOrigin=origemPublica(env.LUME_PUBLIC_ORIGIN,{producao});
  const retentionDays=Number(env.LUME_RETENTION_DAYS);
  if(!Number.isInteger(retentionDays)||retentionDays<30||retentionDays>365)throw naoConfigurada();
  if(publicacao){
    if(env.LUME_RETENTION_APPROVED!=='APROVADA')throw erro('RETENCAO_NAO_APROVADA');
    if(env.LUME_RATE_LIMIT_APPROVED!=='CONFIGURADO')throw erro('RATE_LIMIT_NAO_CONFIGURADO');
    if(env.LUME_RELEASE_ENV_APPROVED!=='APROVADO')throw erro('AMBIENTE_NAO_APROVADO');
  }
  return {databaseUrl,adminSecret,tokenPepper,betaVersion:env.LUME_BETA_VERSION,publicOrigin,retentionDays};
}

export function exigirOrigem(req,esperada){
  const recebida=req?.headers?.origin;
  if(typeof recebida!=='string'||recebida!==esperada)throw Object.assign(new Error('ORIGEM_NAO_PERMITIDA'),{codigo:'ORIGEM_NAO_PERMITIDA',status:403});
}

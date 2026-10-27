import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { origemPublica, validarAmbienteCentral } from '../api/_central/config.js';

const erro=(codigo)=>Object.assign(new Error(codigo),{codigo});
const respostaJson=async resposta=>{
  if(!resposta?.ok)throw erro(`CENTRAL_HTTP_${Number(resposta?.status)||0}`);
  try{return await resposta.json();}catch{throw erro('CENTRAL_RESPOSTA_INVALIDA');}
};
const cookieSessao=resposta=>{
  const bruto=typeof resposta.headers?.getSetCookie==='function'?resposta.headers.getSetCookie()[0]:resposta.headers?.get?.('set-cookie');
  const cookie=typeof bruto==='string'?bruto.split(';',1)[0]:'';
  if(!/^lume_admin=[A-Za-z0-9._-]+$/.test(cookie))throw erro('CENTRAL_SESSAO_INVALIDA');
  return cookie;
};

export function validarClienteCentral(env=process.env){
  const baseUrl=origemPublica(env.LUME_CENTRAL_URL,{producao:env.NODE_ENV==='production'});
  const adminSecret=env.LUME_ADMIN_SECRET;
  if(typeof adminSecret!=='string'||adminSecret.length<32||adminSecret.length>512)throw erro('LUME_ADMIN_SECRET_INVALIDO');
  return {baseUrl,adminSecret};
}

export async function criarConviteRemoto(rotulo,{env=process.env,fetchImpl=fetch}={}){
  if(typeof rotulo!=='string'||!rotulo.trim()||rotulo.trim().length>80)throw erro('ROTULO_INVALIDO');
  const {baseUrl,adminSecret}=validarClienteCentral(env);
  const login=await fetchImpl(`${baseUrl}/api/v1/admin/sessao`,{
    method:'POST',headers:{'content-type':'application/json',origin:baseUrl},
    body:JSON.stringify({senha:adminSecret}),redirect:'error'
  });
  await respostaJson(login);
  const cookie=cookieSessao(login);
  const resposta=await fetchImpl(`${baseUrl}/api/v1/admin/convites`,{
    method:'POST',headers:{'content-type':'application/json',origin:baseUrl,cookie},
    body:JSON.stringify({rotulo:rotulo.trim()}),redirect:'error'
  });
  const convite=await respostaJson(resposta);
  if(typeof convite.codigo!=='string'||!/^LUME-[A-F0-9]{24}$/.test(convite.codigo)||typeof convite.id!=='string')throw erro('CENTRAL_RESPOSTA_INVALIDA');
  return {id:convite.id,rotulo:rotulo.trim(),codigo:convite.codigo};
}

export async function verificarCentralRemota({env=process.env,fetchImpl=fetch}={}){
  const baseUrl=origemPublica(env.LUME_CENTRAL_URL,{producao:env.NODE_ENV==='production'});
  const resposta=await fetchImpl(`${baseUrl}/api/v1/central/saude`,{headers:{accept:'application/json'},redirect:'error'});
  const saude=await respostaJson(resposta);
  if(saude.ok!==true||saude.banco!=='pronto'||saude.schema!=='005-pulso-confirmado')throw erro('CENTRAL_NAO_PRONTA');
  return {ok:true,baseUrl,schema:saude.schema};
}

export async function revogarConviteRemoto(id,{env=process.env,fetchImpl=fetch}={}){
  if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw erro('CONVITE_ID_INVALIDO');
  const {baseUrl,adminSecret}=validarClienteCentral(env);
  const login=await fetchImpl(`${baseUrl}/api/v1/admin/sessao`,{
    method:'POST',headers:{'content-type':'application/json',origin:baseUrl},body:JSON.stringify({senha:adminSecret}),redirect:'error'
  });
  await respostaJson(login);
  const resposta=await fetchImpl(`${baseUrl}/api/v1/admin/convites/${id}/revogar`,{
    method:'POST',headers:{origin:baseUrl,cookie:cookieSessao(login)},redirect:'error'
  });
  const resultado=await respostaJson(resposta);
  if(resultado.revogado!==true)throw erro('CENTRAL_RESPOSTA_INVALIDA');
  return {id,revogado:true};
}

export async function preflightCentral({env=process.env,raiz=resolve(import.meta.dirname,'..')}={}){
  const config=validarAmbienteCentral(env,{publicacao:true});
  if(config.retentionDays!==90)throw erro('RETENCAO_DIVERGENTE');
  if(typeof env.CRON_SECRET!=='string'||env.CRON_SECRET.length<32||env.CRON_SECRET.length>512||[env.LUME_ADMIN_SECRET,env.LUME_TOKEN_PEPPER].includes(env.CRON_SECRET))throw erro('CRON_SECRET_INVALIDO');
  const centralUrl=origemPublica(env.LUME_CENTRAL_URL,{producao:true});
  if(centralUrl!==config.publicOrigin)throw erro('CENTRAL_URL_DIVERGENTE');
  const obrigatorios=[
    'vercel.json','api/central.js','scripts/build-vercel-site.mjs','scripts/central-migrar.mjs','scripts/central-migrations-lib.mjs','central/migrations/001-operacao.sql','central/migrations/002-feedback.sql','central/migrations/003-feedback-severidade.sql','central/migrations/004-feedback-contato.sql','central/migrations/005-pulso-confirmado.sql',
    'central/site/index.html','central/site/central.js','central/site/central.css'
  ];
  await Promise.all(obrigatorios.map(item=>access(resolve(raiz,item),constants.R_OK)));
  const migrations=(await readdir(resolve(raiz,'central/migrations'))).filter(nome=>/^\d{3}-[a-z0-9-]+\.sql$/.test(nome)).sort();
  if(migrations[0]!=='001-operacao.sql'||!migrations.includes('002-feedback.sql')||!migrations.includes('003-feedback-severidade.sql')||!migrations.includes('004-feedback-contato.sql')||!migrations.includes('005-pulso-confirmado.sql'))throw erro('MIGRACOES_INVALIDAS');
  const vercel=JSON.parse(await readFile(resolve(raiz,'vercel.json'),'utf8'));
  const esperadas=new Map([
    ['/api/v1/instalacoes/registrar','/api/central?action=registrar'],
    ['/api/v1/instalacoes/pulso','/api/central?action=pulso'],
    ['/api/v1/feedback','/api/central?action=feedback'],
    ['/api/v1/central/saude','/api/central?action=saude'],
    ['/api/v1/central/retencao','/api/central?action=retencao'],
    ['/api/v1/admin/sessao','/api/central?action=sessao'],
    ['/api/v1/admin/instalacoes','/api/central?action=listar'],
    ['/api/v1/admin/feedback','/api/central?action=listar-feedback'],
    ['/api/v1/admin/feedback/:id/revisar','/api/central?action=revisar-feedback&id=:id'],
    ['/api/v1/admin/feedback/:id/excluir','/api/central?action=excluir-feedback&id=:id'],
    ['/api/v1/admin/convites','/api/central?action=convite'],
    ['/api/v1/admin/convites/:id/revogar','/api/central?action=revogar-convite&id=:id'],
    ['/api/v1/admin/instalacoes/:id/revogar','/api/central?action=revogar&id=:id']
  ]);
  const rotas=new Map((vercel.rewrites||[]).map(item=>[item.source,item.destination]));
  for(const rota of esperadas.keys())if(!rotas.has(rota))throw erro('ROTAS_CENTRAL_INCOMPLETAS');
  for(const [rota,destino] of esperadas)if(rotas.get(rota)!==destino)throw erro('ROTAS_CENTRAL_INCORRETAS');
  if(!Array.isArray(vercel.crons)||vercel.crons.length!==1||vercel.crons[0].path!=='/api/v1/central/retencao'||vercel.crons[0].schedule!=='0 5 * * *')throw erro('RETENCAO_AGENDAMENTO_INVALIDO');
  return {ok:true,origem:config.publicOrigin,versao:config.betaVersion,retencaoDias:config.retentionDays,migrations};
}

export async function executarRetencao({repositorio,dias,agora=new Date(),aplicar=false,confirmacao}={}){
  if(!Number.isInteger(dias)||dias<30||dias>365)throw erro('RETENCAO_INVALIDA');
  if(!(agora instanceof Date)||!Number.isFinite(agora.getTime()))throw erro('DATA_INVALIDA');
  const limite=new Date(agora.getTime()-dias*86400000).toISOString();
  const candidatos=await repositorio.resumirRetencao(limite);
  if(!aplicar)return {aplicado:false,limite,candidatos};
  if(confirmacao!=='APLICAR_RETENCAO')throw erro('CONFIRMACAO_RETENCAO_AUSENTE');
  const removidos=await repositorio.aplicarRetencao(limite);
  return {aplicado:true,limite,candidatos,removidos};
}

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64=valor=>Buffer.from(valor).toString('base64url');
const igual=(a,b)=>{
  const x=Buffer.from(String(a)),y=Buffer.from(String(b));
  return x.length===y.length&&timingSafeEqual(x,y);
};
const assinar=(valor,segredo)=>createHmac('sha256',segredo).update(valor).digest('base64url');

export function criarSessaoAdmin(segredo,agora=Date.now()){
  if(typeof segredo!=='string'||segredo.length<24)throw new Error('LUME_ADMIN_SECRET não configurado');
  const payload=b64(JSON.stringify({exp:agora+8*60*60*1000}));
  return `${payload}.${assinar(payload,segredo)}`;
}

export function sessaoAdminValida(cookie,segredo,agora=Date.now()){
  if(typeof cookie!=='string'||typeof segredo!=='string'||segredo.length<24)return false;
  const valor=cookie.split(';').map(item=>item.trim()).find(item=>item.startsWith('lume_admin='))?.slice(11);
  if(!valor)return false;
  const [payload,assinatura,...resto]=valor.split('.');
  if(resto.length||!payload||!assinatura||!igual(assinatura,assinar(payload,segredo)))return false;
  try{return Number(JSON.parse(Buffer.from(payload,'base64url').toString('utf8')).exp)>agora;}catch{return false;}
}

export function senhaAdminValida(recebida,esperada){
  return typeof recebida==='string'&&typeof esperada==='string'&&esperada.length>=24&&igual(recebida,esperada);
}

export const cookieAdmin=token=>`lume_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`;
export const limparCookieAdmin='lume_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';

export function cabecalhos(res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
}
export function json(res,status,corpo){cabecalhos(res);res.status(status).json(corpo);}
export function corpoSeguro(req,maximo=4096){
  const tamanho=Number(req.headers['content-length']||0);
  if(Number.isFinite(tamanho)&&tamanho>maximo)throw Object.assign(new Error('CORPO_MUITO_GRANDE'),{codigo:'CORPO_MUITO_GRANDE',status:413});
  const corpo=req.body;
  if(!corpo||typeof corpo!=='object'||Array.isArray(corpo))throw Object.assign(new Error('CORPO_INVALIDO'),{codigo:'CORPO_INVALIDO',status:400});
  if(Buffer.byteLength(JSON.stringify(corpo),'utf8')>maximo)throw Object.assign(new Error('CORPO_MUITO_GRANDE'),{codigo:'CORPO_MUITO_GRANDE',status:413});
  return corpo;
}
export function bearer(req){
  const valor=req.headers.authorization;
  return typeof valor==='string'&&valor.startsWith('Bearer ')?valor.slice(7):'';
}

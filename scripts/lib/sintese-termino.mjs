// Pure bookkeeping: natural EOS at the budget boundary is not truncation.
function tokenId(value){
  if(typeof value==='bigint')return value>=0n&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):null;
  return Number.isSafeInteger(value)&&value>=0?value:null;
}
export function terminoGeracao({tokensSaida,ultimoToken,eosTokenIds,expirou,limiteTokens}){
  if(!Number.isSafeInteger(tokensSaida)||tokensSaida<0||!Number.isSafeInteger(limiteTokens)||limiteTokens<=0||typeof expirou!=='boolean')throw TypeError('SINTESE_TERMINO_INVALIDO');
  const last=tokenId(ultimoToken),ids=Array.isArray(eosTokenIds)?eosTokenIds:[eosTokenIds];
  const terminouEmEos=tokensSaida>0&&last!==null&&ids.some(id=>tokenId(id)!==null&&tokenId(id)===last);
  const teto=tokensSaida>limiteTokens||(tokensSaida===limiteTokens&&!terminouEmEos);
  return {interrompida:expirou||teto,motivo:expirou?'tempo':teto?'tokens':null,ultimoToken:last,terminouEmEos};
}

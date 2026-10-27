const normalize=value=>value.normalize('NFD').replace(/[\u0300-\u036f]/gu,'').toLocaleLowerCase('pt-BR');
const COMMERCIAL_STATUS=/\b(?:marque|registre|anuncie|declare|confirme)\b.{0,80}\bcomo\s+(?:recebid[oa]|pag[oa]|assinad[oa]|aceit[oa]|concluid[oa]|ganh[oa])\b/u;

export function descartarMudancaDeEstado(trecho){
  return typeof trecho==='string'&&COMMERCIAL_STATUS.test(normalize(trecho));
}

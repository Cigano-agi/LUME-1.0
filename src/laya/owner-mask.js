// Apenas entrada do modelo: a fonte e o trecho exibido continuam literais.
export function mascararDonoParaModelo(texto,nomeDono){
  if(typeof texto!=='string'||typeof nomeDono!=='string'||!nomeDono.trim())throw new Error('NOME_DO_DONO_INVALIDO');
  const variacoes={a:'[aàáâãäå]',c:'[cç]',e:'[eèéêë]',i:'[iìíîï]',n:'[nñ]',o:'[oòóôõö]',u:'[uùúûü]'};
  const nome=nomeDono.trim().normalize('NFD').replace(/[\u0300-\u036f]/gu,'').toLocaleLowerCase('pt-BR')
    .split('').map(letra=>/\s/u.test(letra)?'\\s+':variacoes[letra]||letra.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('');
  const padrao=new RegExp(`(^|[^\\p{L}\\p{N}])${nome}(?=$|[^\\p{L}\\p{N}])`,'giu');
  return texto.replace(padrao,(_todo,prefixo)=>`${prefixo}Dono`);
}

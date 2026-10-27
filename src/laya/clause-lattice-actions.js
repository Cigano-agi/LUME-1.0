// Extração experimental. Não é importada pelo fluxo distribuído do Lume.
import {proporClausulas} from './clause-lattice.js';
import {mascararDonoParaModelo} from './owner-mask.js';
import {avaliarCabecaDominio} from './domain-head.js';

export async function extrairAcoesLattice({texto,fonte,canal,autor,nomeDono,model,embed}){
  if(typeof texto!=='string'||!texto.trim()||texto.length>2000||
    !/^E[1-9]\d*$/u.test(fonte??'')||!['dm','grupo'].includes(canal)||
    !['proprio','outro','terceiro'].includes(autor)||typeof nomeDono!=='string'||
    !nomeDono.trim()||nomeDono.length>80||typeof embed!=='function')
    throw Error('LAYA_LATTICE_ENTRADA_INVALIDA');
  if(autor==='terceiro')return {candidatas:[]};
  const mask=value=>model.inputTemplate.endsWith('owner-v2')?mascararDonoParaModelo(value,nomeDono):value;
  const author=autor==='proprio'?'proprio':'outro',channel=canal==='grupo'?'grupo':'dm';
  const candidatas=[];
  for(const trecho of proporClausulas({texto,canal,autor,nomeDono})){
    const input=`Autor: ${author}. Canal: ${channel}. Mensagem: ${mask(texto)} Trecho para decidir: ${mask(trecho.trecho)}`;
    const feature=await embed(input,model.maxTokens);
    const intended=trecho.tipo==='pendencia'?'pedido':'compromisso';
    if(!avaliarCabecaDominio(model,feature,intended).aceita)continue;
    candidatas.push({fonte,tipo:trecho.tipo,resumo:trecho.trecho,trecho:trecho.trecho,
      inicio:trecho.inicio,fim:trecho.fim,prazo_citado:''});
  }
  return {candidatas};
}

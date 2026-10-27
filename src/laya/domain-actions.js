import {proporTrechos} from './segmentacao.js';
import {mascararDonoParaModelo} from './owner-mask.js';
import {avaliarCabecaDominio} from './domain-head.js';
import {descartarMudancaDeEstado} from './state-guard.js';
export {descartarMudancaDeEstado} from './state-guard.js';

const normalizar=value=>value.normalize('NFD').replace(/[\u0300-\u036f]/gu,'').toLocaleLowerCase('pt-BR');
const VERBO_DIRETO=/^[\s,:-]+(?:confirme|confira|verifique|consulte|valide|envie|prepare|marque|peca|pergunte|revise|veja|reserve|organize|cheque|solicite|agende|responda|anexe|avise|ligue|atualize)\b/u;

export function pedidoDiretoAoDono({candidate,canal,autor,nomeDono}){
  if(canal!=='grupo'||autor!=='outro'||candidate?.tipo!=='pendencia'||typeof candidate.trecho!=='string'||typeof nomeDono!=='string')return false;
  const trecho=normalizar(candidate.trecho).trim(),dono=normalizar(nomeDono).trim();
  return Boolean(dono)&&trecho.startsWith(dono)&&VERBO_DIRETO.test(trecho.slice(dono.length))&&!descartarMudancaDeEstado(candidate.trecho);
}

// embed returns the mean pooled encoder vector. The only output is a literal,
// source-bound suggestion; responsibility and completion remain human decisions.
export async function extrairAcoesDominio({texto,fonte,canal,autor,nomeDono,model,embed}){
  if(typeof texto!=='string'||!texto.trim()||texto.length>2000||
    !/^E[1-9]\d*$/.test(fonte??'')||!['dm','grupo'].includes(canal)||
    !['proprio','outro','terceiro'].includes(autor)||typeof nomeDono!=='string'||
    !nomeDono.trim()||nomeDono.length>80||typeof embed!=='function')
    throw Error('LAYA_ENTRADA_ACOES_INVALIDA');
  if(autor==='terceiro')return {candidatas:[]};
  const candidates=proporTrechos({texto,canal,autor,nomeDono});
  const mask=value=>model.inputTemplate.endsWith('owner-v2')?mascararDonoParaModelo(value,nomeDono):value;
  const author=autor==='proprio'?'proprio':'outro';
  const channel=canal==='grupo'?'grupo':'dm';
  const result=[];
  for(const candidate of candidates){
    if(descartarMudancaDeEstado(candidate.trecho))continue;
    if(pedidoDiretoAoDono({candidate,canal,autor,nomeDono})){
      result.push({fonte,tipo:candidate.tipo,resumo:candidate.trecho,trecho:candidate.trecho,prazo_citado:''});
      continue;
    }
    const input=`Autor: ${author}. Canal: ${channel}. Mensagem: ${mask(texto)} Trecho para decidir: ${mask(candidate.trecho)}`;
    const feature=await embed(input,model.maxTokens);
    const intended=candidate.tipo==='pendencia'?'pedido':'compromisso';
    if(avaliarCabecaDominio(model,feature,intended).aceita)
      result.push({fonte,tipo:candidate.tipo,resumo:candidate.trecho,trecho:candidate.trecho,prazo_citado:''});
  }
  return {candidatas:result};
}

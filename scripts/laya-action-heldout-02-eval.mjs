// Single preserved run. Refuses to overwrite the result after it is inspected.
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {casos} from './laya-action-heldout-02.mjs';
import {proporTrechos} from '../src/laya/segmentacao.js';

const output=resolve(process.argv[2]||'work/laya-action-heldout-02-result.json');
if(existsSync(output))throw Error('Resultado já existe; preservar a primeira medição.');
const palavras=trecho=>trecho.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/[a-z0-9]+/g)||[];
function sobreposicao(a,b){
  const aa=palavras(a),bb=palavras(b),usadas=new Set();let comum=0;
  for(const termo of aa){const idx=bb.findIndex((valor,i)=>valor===termo&&!usadas.has(i));if(idx>=0){usadas.add(idx);comum++;}}
  return Math.min(comum/Math.max(aa.length,1),comum/Math.max(bb.length,1));
}
const detalhes=[];let tp=0,fp=0,fn=0,criticosFp=0,criticosFn=0,criticosEsperados=0,criticosTp=0;
for(const caso of casos){
  const propostas=proporTrechos(caso),usadas=new Set(),acertos=[];
  if(caso.critico)criticosEsperados+=caso.esperadas.length;
  for(const esperada of caso.esperadas){
    let melhor=-1,pontuacao=0;
    for(let i=0;i<propostas.length;i++){
      if(usadas.has(i)||propostas[i].tipo!==esperada.tipo)continue;
      const atual=sobreposicao(esperada.trecho,propostas[i].trecho);
      if(atual>pontuacao){pontuacao=atual;melhor=i;}
    }
    if(melhor>=0&&pontuacao>=0.5){usadas.add(melhor);tp++;if(caso.critico)criticosTp++;acertos.push({esperada,proposta:propostas[melhor],pontuacao});}
    else{fn++;if(caso.critico)criticosFn++;}
  }
  const extras=propostas.filter((_,i)=>!usadas.has(i));fp+=extras.length;if(caso.critico)criticosFp+=extras.length;
  detalhes.push({id:caso.id,critico:caso.critico,texto:caso.texto,esperadas:caso.esperadas,propostas,acertos,extras});
}
const ratio=(a,b)=>Math.round(a/(b||1)*1000)/1000;
const resumo={casos:casos.length,criticos:casos.filter(c=>c.critico).length,acoesEsperadas:tp+fn,criticosEsperados,tp,fp,fn,criticosTp,criticosFp,criticosFn,precisao:ratio(tp,tp+fp),recall:ratio(tp,tp+fn),recallCritico:ratio(criticosTp,criticosEsperados),metodo:'mesmo tipo; casamento um a um; cobertura de tokens >= 0,5 nos dois trechos',motor:'segmentação determinística; Laya não avaliado neste ensaio'};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({data:new Date().toISOString(),resumo,detalhes},null,2));
console.log(JSON.stringify({output,resumo}));

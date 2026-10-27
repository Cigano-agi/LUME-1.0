// Avaliação única do corpus congelado. Sem ajustes de limiar após observar o resultado.
import { casos } from './laya-action-heldout-01.mjs';
import { proporTrechos } from '../src/laya/segmentacao.js';

const palavras=trecho=>trecho.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/[a-z0-9]+/g)||[];
function sobreposicao(a,b){
  const aa=palavras(a),bb=palavras(b),usadas=new Set();let comum=0;
  for(const termo of aa){const idx=bb.findIndex((valor,i)=>valor===termo&&!usadas.has(i));if(idx>=0){usadas.add(idx);comum++;}}
  return Math.min(comum/Math.max(aa.length,1),comum/Math.max(bb.length,1));
}

const detalhes=[];let tp=0,fp=0,fn=0,exatos=0,criticosFp=0,criticosFn=0;
for(const caso of casos){
  const propostas=proporTrechos(caso),usadas=new Set(),acertos=[];
  for(const esperada of caso.esperadas){
    let melhor=-1,pontuacao=0;
    for(let i=0;i<propostas.length;i++){
      if(usadas.has(i)||propostas[i].tipo!==esperada.tipo)continue;
      const atual=sobreposicao(esperada.trecho,propostas[i].trecho);
      if(atual>pontuacao){pontuacao=atual;melhor=i;}
    }
    if(melhor>=0&&pontuacao>=0.5){
      usadas.add(melhor);tp++;
      if(esperada.trecho===propostas[melhor].trecho)exatos++;
      acertos.push({esperada,proposta:propostas[melhor],pontuacao});
    }else {fn++;if(caso.critico)criticosFn++;}
  }
  const extras=propostas.filter((_,i)=>!usadas.has(i));fp+=extras.length;
  if(caso.critico)criticosFp+=extras.length;
  detalhes.push({id:caso.id,critico:caso.critico,esperadas:caso.esperadas,propostas,acertos,extras});
}
const arredondar=n=>Math.round(n*1000)/1000;
const resumo={casos:casos.length,acoesEsperadas:casos.reduce((s,c)=>s+c.esperadas.length,0),tp,fp,fn,precisao:arredondar(tp/(tp+fp||1)),recall:arredondar(tp/(tp+fn||1)),exatos,criticosFp,criticosFn,metodo:'mesmo tipo; casamento um a um; cobertura de tokens >= 0,5 nos dois trechos'};
console.log(JSON.stringify({resumo,detalhes},null,2));

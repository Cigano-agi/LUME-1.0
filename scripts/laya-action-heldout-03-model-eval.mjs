// First model run on the frozen synthetic corpus. Does not change the public quality gate.
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {casos} from './laya-action-heldout-03.mjs';
import {proporTrechos} from '../src/laya/segmentacao.js';
import {carregarRuntime} from '../src/laya/runtime.js';

const modelDir=resolve(process.argv[2]||'work/laya-onnx');
const output=resolve(process.argv[3]||'work/laya-action-heldout-03-model-result.json');
if(existsSync(output))throw Error('Resultado já existe; preservar a primeira medição.');
const palavras=trecho=>trecho.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().match(/[a-z0-9]+/g)||[];
function sobreposicao(a,b){
  const aa=palavras(a),bb=palavras(b),usadas=new Set();let comum=0;
  for(const termo of aa){const idx=bb.findIndex((valor,i)=>valor===termo&&!usadas.has(i));if(idx>=0){usadas.add(idx);comum++;}}
  return Math.min(comum/Math.max(aa.length,1),comum/Math.max(bb.length,1));
}
const runtime=await carregarRuntime(modelDir),rows=[];
try{
  for(const caso of casos)for(const proposta of proporTrechos(caso)){
    const gold=caso.esperadas.filter(e=>e.tipo===proposta.tipo).map(e=>({e,score:sobreposicao(e.trecho,proposta.trecho)})).sort((a,b)=>b.score-a.score)[0];
    const expected=gold?.score>=0.5?(proposta.tipo==='pendencia'?'pedido':'compromisso'):null;
    const result=await runtime.infer(proposta.trecho,{debug:true});
    rows.push({id:caso.id,critico:caso.critico,trecho:proposta.trecho,expected,raw:result.avaliacao.prevista,policy:result.categoria,reason:result.motivo,latencyMs:result.duracaoMs,probabilities:result.avaliacao.probabilities});
  }
}finally{await runtime.close();}
const distribution=Object.fromEntries(['pedido','compromisso','informacao','ambiguo'].map(k=>[k,rows.filter(r=>r.raw===k).length]));
const resumo={cases:casos.length,proposedSpans:rows.length,rawCorrect:rows.filter(r=>r.raw===r.expected).length,policyCorrect:rows.filter(r=>r.policy===r.expected).length,policyEmitted:rows.filter(r=>r.policy).length,distribution,medianMs:[...rows].sort((a,b)=>a.latencyMs-b.latencyMs)[Math.floor(rows.length/2)]?.latencyMs??null,publicGate:'abstention remains mandatory'};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({date:new Date().toISOString(),resumo,rows},null,2));
console.log(JSON.stringify({output,resumo}));

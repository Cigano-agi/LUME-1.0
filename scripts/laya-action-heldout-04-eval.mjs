// First full-pipeline baseline on frozen corpus 04. Never changes the app gate.
import {writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {casos} from './laya-action-heldout-04.mjs';
import {proporTrechos} from '../src/laya/segmentacao.js';
import {carregarRuntime} from '../src/laya/runtime.js';
import {aplicarPortaDeQualidade} from '../src/laya/policy.js';

const modelDir=resolve(process.argv[2]||'work/laya-onnx');
const output=resolve(process.argv[3]||'work/laya-action-heldout-04-result.json');
if(existsSync(output))throw Error('Resultado já existe; preservar a primeira medição.');
const normalizar=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR').match(/[a-z0-9]+/g)||[];
function sobreposicao(a,b){
  const aa=normalizar(a),bb=normalizar(b),usadas=new Set();let comum=0;
  for(const termo of aa){const i=bb.findIndex((v,j)=>v===termo&&!usadas.has(j));if(i>=0){comum++;usadas.add(i);}}
  return Math.min(comum/Math.max(aa.length,1),comum/Math.max(bb.length,1));
}
const tipo=valor=>({pendencia:'pedido',compromisso:'compromisso'})[valor]||null;
const acao=valor=>['pedido','compromisso'].includes(valor)?valor:null;
function contar(caso,propostas,chave){
  const usadas=new Set();let tp=0,criticosTp=0;
  for(const gold of caso.esperadas){
    let melhor=-1,score=0;
    for(let i=0;i<propostas.length;i++){
      if(usadas.has(i)||propostas[i][chave]!==tipo(gold.tipo))continue;
      const atual=sobreposicao(gold.trecho,propostas[i].trecho);
      if(atual>score){score=atual;melhor=i;}
    }
    if(melhor>=0&&score>=0.5){usadas.add(melhor);tp++;if(caso.critico)criticosTp++;}
  }
  return {tp,fp:propostas.filter((p,i)=>p[chave]&&!usadas.has(i)).length,fn:caso.esperadas.length-tp,criticosTp,criticosEsperados:caso.critico?caso.esperadas.length:0};
}
const soma=(a,b)=>Object.fromEntries(Object.keys(a).map(k=>[k,a[k]+b[k]]));
const zero={tp:0,fp:0,fn:0,criticosTp:0,criticosEsperados:0};
const metricas=x=>({...x,precisao:x.tp/(x.tp+x.fp)||0,recall:x.tp/(x.tp+x.fn)||0,recallCritico:x.criticosTp/(x.criticosEsperados||1)});
const runtime=await carregarRuntime(modelDir),detalhes=[];
const totais={segmentacao:zero,bruto:zero,politica:zero,publico:zero};
try{
  for(const caso of casos){
    const propostas=[];
    for(const proposta of proporTrechos(caso)){
      const r=await runtime.infer(proposta.trecho,{debug:true});
      const publico=aplicarPortaDeQualidade(r);
      propostas.push({...proposta,segmentacao:tipo(proposta.tipo),bruto:acao(r.avaliacao.prevista),politica:acao(r.categoria),publico:acao(publico.categoria),classeBruta:r.avaliacao.prevista,latenciaMs:r.duracaoMs,probabilidades:r.avaliacao.probabilities});
    }
    const medidas=Object.fromEntries(Object.keys(totais).map(chave=>[chave,contar(caso,propostas,chave)]));
    for(const chave of Object.keys(totais))totais[chave]=soma(totais[chave],medidas[chave]);
    detalhes.push({id:caso.id,critico:caso.critico,texto:caso.texto,esperadas:caso.esperadas,propostas,medidas});
  }
}finally{await runtime.close();}
const latencias=detalhes.flatMap(c=>c.propostas.map(p=>p.latenciaMs)).sort((a,b)=>a-b);
const resumo={casos:casos.length,criticos:casos.filter(c=>c.critico).length,corpusSha256:createHash('sha256').update(JSON.stringify(casos)).digest('hex'),propostas:latencias.length,latenciaMedianaPorTrechoMs:latencias[Math.floor(latencias.length/2)]??null,etapas:Object.fromEntries(Object.entries(totais).map(([k,v])=>[k,metricas(v)])),metodo:'mesmo tipo, um a um, sobreposição bilateral de tokens >= 0,5',limite:'sintético; latência só de inferência por trecho; porta pública em abstenção; sem prova de estados comerciais'};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({data:new Date().toISOString(),resumo,detalhes},null,2),{flag:'wx'});
console.log(JSON.stringify({output,resumo}));

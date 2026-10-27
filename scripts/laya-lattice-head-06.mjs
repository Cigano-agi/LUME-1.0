// Pesquisa local: encoder Laya + cabeça treinada sobre candidatos de cláusulas.
// Usa apenas corpora conhecidos 01–13; nunca altera a porta pública.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {verificarModelo} from '../src/laya/integrity.js';
import {parseTokenizerJson,encodeWithData} from '../src/laya/vendor/tokenizer.js';
import {proporClausulas} from '../src/laya/clause-lattice.js';
import {mascararDonoParaModelo} from '../src/laya/owner-mask.js';
import {casos as um} from './laya-action-heldout-01.mjs';
import {casos as dois} from './laya-action-heldout-02.mjs';
import {casos as tres} from './laya-action-heldout-03.mjs';
import {casos as quatro} from './laya-action-heldout-04.mjs';
import {casos as sete} from './laya-action-train-07.mjs';
import {casos as oito} from './laya-action-heldout-08.mjs';
import {casos as cinco} from './laya-action-heldout-05.mjs';
import {casos as seis} from './laya-action-heldout-06.mjs';
import {casos as nove} from './laya-action-heldout-09.mjs';
import {casos as dez} from './laya-action-heldout-10.mjs';
import {casos as onze} from './laya-action-heldout-11.mjs';
import {casos as doze} from './laya-action-heldout-12.mjs';
import {casos as treze} from './laya-action-heldout-13.mjs';

const modelDir=resolve(process.argv[2]||'work/laya-onnx');
const output=resolve(process.argv[3]||'work/laya-lattice-head-06-development.json');
if(existsSync(output))throw Error('Resultado já existe; preserve a primeira medição.');
const inicio=performance.now();
const classes=['none','pedido','compromisso'];
const normalizar=text=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR').match(/[a-z0-9]+/g)||[];
function sobreposicao(a,b){
  const aa=normalizar(a),bb=normalizar(b),usadas=new Set();let comum=0;
  for(const termo of aa){const i=bb.findIndex((v,j)=>v===termo&&!usadas.has(j));if(i>=0){comum++;usadas.add(i);}}
  return Math.min(comum/Math.max(aa.length,1),comum/Math.max(bb.length,1));
}
const tipo=t=>({pendencia:'pedido',compromisso:'compromisso'})[t]||null;
const fingerprint=c=>createHash('sha256').update(c.corpus+':'+c.id).digest()[0];
const conhecidos=[[1,um],[2,dois],[3,tres],[4,quatro],[5,cinco],[6,seis],[7,sete],[8,oito],[9,nove],[10,dez],[11,onze],[12,doze],[13,treze]]
  .flatMap(([corpus,rows])=>rows.map(c=>({...c,corpus})));
const treinoCasos=conhecidos.filter(c=>fingerprint(c)%5!==0);
const validacaoCasos=conhecidos.filter(c=>fingerprint(c)%5===0);
const textoDe=(c,trecho)=>`Autor: ${c.autor}. Canal: ${c.canal}. Mensagem: ${mascararDonoParaModelo(c.texto,'Fabrício')} Trecho para decidir: ${mascararDonoParaModelo(trecho,'Fabrício')}`;
function candidatos(c){return proporClausulas(c).map((p,i)=>({caseId:c.id,corpus:c.corpus,trecho:p.trecho,tipo:tipo(p.tipo),textoModelo:textoDe(c,p.trecho),indice:i,critico:c.critico}));}
function exemplosTreino(c){
  const propostas=candidatos(c),usadas=new Set();
  const examples=propostas.map(p=>{
    let melhor=-1,score=0;
    for(let i=0;i<c.esperadas.length;i++){
      if(usadas.has(i)||p.tipo!==tipo(c.esperadas[i].tipo))continue;
      const s=sobreposicao(p.trecho,c.esperadas[i].trecho);
      if(s>score){score=s;melhor=i;}
    }
    if(melhor>=0&&score>=0.5){usadas.add(melhor);return{...p,label:p.tipo};}
    return{...p,label:'none'};
  });
  for(let i=0;i<c.esperadas.length;i++)if(!usadas.has(i)){
    const gold=c.esperadas[i];examples.push({caseId:c.id,corpus:c.corpus,trecho:gold.trecho,tipo:tipo(gold.tipo),textoModelo:textoDe(c,gold.trecho),label:tipo(gold.tipo),critico:c.critico,gold:true});
  }
  if(!c.esperadas.length&&!propostas.length)examples.push({caseId:c.id,corpus:c.corpus,trecho:c.texto,tipo:'none',textoModelo:textoDe(c,c.texto),label:'none',critico:c.critico,negativeWhole:true});
  return examples;
}
const train=treinoCasos.flatMap(exemplosTreino),validation=validacaoCasos.flatMap(candidatos);
if(!train.some(x=>x.label==='none')||!train.some(x=>x.label==='pedido')||!train.some(x=>x.label==='compromisso'))throw Error('Treino sem todas as classes.');
const manifest=await verificarModelo(modelDir);
const tokenizer=parseTokenizerJson(JSON.parse(await readFile(join(modelDir,'tokenizer.json'),'utf8')));
const ort=await import('onnxruntime-node');
const encoder=await ort.InferenceSession.create(join(modelDir,'encoder.onnx'),{executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all',logSeverityLevel:3});
const cache=new Map();
async function embed(text){
  if(cache.has(text))return cache.get(text);
  const tokens=encodeWithData(tokenizer,text).slice(0,250),ids=[tokenizer.ids.cls,...tokens,tokenizer.ids.sep];
  const input=new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,ids.length]);
  const mask=new ort.Tensor('int64',BigInt64Array.from(ids.map(()=>1n)),[1,ids.length]);
  const hidden=await encoder.run({input_ids:input,attention_mask:mask});
  const values=hidden.last_hidden_state.data,dim=hidden.last_hidden_state.dims.at(-1),vector=new Float32Array(dim);
  for(let t=1;t<ids.length-1;t++)for(let j=0;j<dim;j++)vector[j]+=values[t*dim+j];
  for(let j=0;j<dim;j++)vector[j]/=Math.max(1,ids.length-2);
  cache.set(text,vector);return vector;
}
try{for(const sample of [...train,...validation])sample.vector=await embed(sample.textoModelo);}
finally{await encoder.release();}
const embeddingsMs=Math.round(performance.now()-inicio);
const dim=train[0].vector.length,mean=new Float64Array(dim),scale=new Float64Array(dim);
for(const row of train)for(let j=0;j<dim;j++)mean[j]+=row.vector[j]/train.length;
for(const row of train)for(let j=0;j<dim;j++)scale[j]+=(row.vector[j]-mean[j])**2/train.length;
for(let j=0;j<dim;j++)scale[j]=Math.max(Math.sqrt(scale[j]),0.03);
for(const row of [...train,...validation]){
  row.feature=new Float32Array(dim);
  for(let j=0;j<dim;j++)row.feature[j]=Math.max(-5,Math.min(5,(row.vector[j]-mean[j])/scale[j]));
  delete row.vector;
}
const weights=classes.map(()=>new Float64Array(dim)),bias=new Float64Array(classes.length);
const counts=classes.map(name=>train.filter(x=>x.label===name).length);
const classWeight=counts.map(n=>train.length/(classes.length*n));
function probabilities(row){
  const logits=weights.map((w,k)=>{let z=bias[k];for(let j=0;j<dim;j++)z+=w[j]*row.feature[j];return z;});
  const max=Math.max(...logits),values=logits.map(v=>Math.exp(v-max)),sum=values.reduce((a,b)=>a+b,0);
  return values.map(v=>v/sum);
}
for(let epoch=0;epoch<350;epoch++){
  const grads=classes.map(()=>new Float64Array(dim)),biasGrad=new Float64Array(classes.length);
  for(const row of train){
    const p=probabilities(row),label=classes.indexOf(row.label),weight=classWeight[label];
    for(let k=0;k<classes.length;k++){
      const delta=(p[k]-Number(k===label))*weight;
      biasGrad[k]+=delta;
      for(let j=0;j<dim;j++)grads[k][j]+=delta*row.feature[j];
    }
  }
  const rate=0.08/Math.sqrt(1+epoch/50);
  for(let k=0;k<classes.length;k++){
    for(let j=0;j<dim;j++)weights[k][j]-=rate*(grads[k][j]/train.length+0.04*weights[k][j]);
    bias[k]-=rate*biasGrad[k]/train.length;
  }
}
for(const row of validation){
  row.probs=probabilities(row);
  row.predicted=classes[row.probs.indexOf(Math.max(...row.probs))];
  row.score=row.probs[classes.indexOf(row.tipo)];
  delete row.feature;
}
function medir(cases,rows,threshold){
  const detalhes=[],total={tp:0,fp:0,fn:0,criticosTp:0,criticosEsperados:0,falsosPositivosCriticos:0};
  for(const c of cases){
    const propostas=rows.filter(p=>p.caseId===c.id&&p.corpus===c.corpus&&p.predicted===p.tipo&&p.score>=threshold),usadas=new Set();let tp=0,criticosTp=0;
    for(const gold of c.esperadas){
      let melhor=-1,score=0;
      for(let i=0;i<propostas.length;i++){
        if(usadas.has(i)||propostas[i].tipo!==tipo(gold.tipo))continue;
        const atual=sobreposicao(gold.trecho,propostas[i].trecho);
        if(atual>score){score=atual;melhor=i;}
      }
      if(melhor>=0&&score>=0.5){usadas.add(melhor);tp++;if(c.critico)criticosTp++;}
    }
    const fp=propostas.length-usadas.size,fn=c.esperadas.length-tp;
    total.tp+=tp;total.fp+=fp;total.fn+=fn;total.criticosTp+=criticosTp;total.criticosEsperados+=c.critico?c.esperadas.length:0;
    total.falsosPositivosCriticos+=c.critico?fp:0;
    detalhes.push({id:c.id,critico:c.critico,esperadas:c.esperadas.length,propostas:propostas.map(p=>({tipo:p.tipo,trecho:p.trecho,score:Number(p.score.toFixed(4))})),tp,fp,fn});
  }
  return{...total,precision:total.tp/(total.tp+total.fp)||0,recall:total.tp/(total.tp+total.fn)||0,criticalRecall:total.criticosTp/(total.criticosEsperados||1),detalhes};
}
let escolha=null;
for(let i=35;i<=95;i+=5){
  const threshold=i/100,m=medir(validacaoCasos,validation,threshold);
  if(m.precision<0.8||m.falsosPositivosCriticos>0)continue;
  if(!escolha||m.criticalRecall>escolha.criticalRecall||m.criticalRecall===escolha.criticalRecall&&m.recall>escolha.recall)escolha={threshold,criticalRecall:m.criticalRecall,recall:m.recall};
}
const threshold=escolha?.threshold??0.95;
const validacao=medir(validacaoCasos,validation,threshold);
const detail=validacao.detalhes;
delete validacao.detalhes;
const model={schema:'lume-laya-domain-head-v1',encoderRevision:manifest.revision,classes,maxTokens:250,inputTemplate:'author-channel-message-span-owner-v2',mean:[...mean],scale:[...scale],weights:weights.map(row=>[...row]),bias:[...bias],threshold,approvedForProduct:false};
const summary={modelRevision:manifest.revision,modelSha256:createHash('sha256').update(JSON.stringify(model)).digest('hex'),corpora01to13Sha256:createHash('sha256').update(JSON.stringify(conhecidos)).digest('hex'),trainCases:treinoCasos.length,validationCases:validacaoCasos.length,trainExamples:train.length,validationCandidates:validation.length,dimension:dim,threshold,thresholdMetValidationGate:Boolean(escolha),validation:validacao,embeddingsMs,totalMs:Math.round(performance.now()-inicio),method:'Development only: Laya ONNX encoder + local three-class head trained with clause-lattice candidates; synthetic corpora 01–13, case-wise hash split',approvedForProduct:false,limitations:'Validation uses synthetic cases from known corpora; no blind, authorized real-world, installed-app or target-device gate.'};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({date:new Date().toISOString(),summary,model,detail},null,2),{flag:'wx'});
console.log(JSON.stringify({output,summary}));

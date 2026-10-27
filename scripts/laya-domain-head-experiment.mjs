// Offline research only: train a small binary head on frozen synthetic corpora 01/02.
// Corpus 03 is evaluation only. Nothing here changes the app or its quality gate.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {verificarModelo} from '../src/laya/integrity.js';
import {parseTokenizerJson,encodeWithData} from '../src/laya/vendor/tokenizer.js';
import {casos as corpus01} from './laya-action-heldout-01.mjs';
import {casos as corpus02} from './laya-action-heldout-02.mjs';
import {casos as corpus03} from './laya-action-heldout-03.mjs';

const modelDir=resolve(process.argv[2]||'work/laya-onnx');
const output=resolve(process.argv[3]||'work/laya-domain-head-01-result.json');
if(existsSync(output))throw Error('Resultado já existe; preservar a primeira medição.');
const manifest=await verificarModelo(modelDir);
const data=parseTokenizerJson(JSON.parse(await readFile(join(modelDir,'tokenizer.json'),'utf8')));
const ort=await import('onnxruntime-node');
const encoder=await ort.InferenceSession.create(join(modelDir,'encoder.onnx'),{executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all',logSeverityLevel:3});
const input=(caseItem,trecho)=>`autor ${caseItem.autor}; canal ${caseItem.canal}; texto ${trecho}`;
const examples=(cases,prefix)=>cases.flatMap(c=>c.esperadas.length
  ?c.esperadas.map((e,i)=>({id:`${prefix}:${c.id}:${i}`,text:input(c,e.trecho),label:1,critico:c.critico}))
  :[{id:`${prefix}:${c.id}:zero`,text:input(c,c.texto),label:0,critico:c.critico}]);
const training=examples(corpus01,'01').concat(examples(corpus02,'02'));
const testing=examples(corpus03,'03');
const cache=new Map();
async function embed(text){
  if(cache.has(text))return cache.get(text);
  const tokens=encodeWithData(data,text).slice(0,250),ids=[data.ids.cls,...tokens,data.ids.sep];
  const tensor=new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,ids.length]);
  const mask=new ort.Tensor('int64',BigInt64Array.from(ids.map(()=>1n)),[1,ids.length]);
  const hidden=await encoder.run({input_ids:tensor,attention_mask:mask});
  const values=hidden.last_hidden_state.data,dim=hidden.last_hidden_state.dims.at(-1),vector=new Float32Array(dim);
  for(let t=1;t<ids.length-1;t++)for(let j=0;j<dim;j++)vector[j]+=values[t*dim+j];
  for(let j=0;j<dim;j++)vector[j]/=Math.max(1,ids.length-2);
  cache.set(text,vector);return vector;
}
try{
  for(const sample of training.concat(testing))sample.vector=await embed(sample.text);
}finally{await encoder.release();}

// Validation is selected only from the training corpora. Corpus 03 never chooses parameters.
const hash=id=>parseInt(createHash('sha256').update(id).digest('hex').slice(0,8),16);
const fit=training.filter(x=>hash(x.id)%5!==0),validation=training.filter(x=>hash(x.id)%5===0);
const dim=fit[0].vector.length,mean=new Float64Array(dim),scale=new Float64Array(dim);
for(const x of fit)for(let j=0;j<dim;j++)mean[j]+=x.vector[j]/fit.length;
for(const x of fit)for(let j=0;j<dim;j++)scale[j]+=(x.vector[j]-mean[j])**2/fit.length;
for(let j=0;j<dim;j++)scale[j]=Math.max(Math.sqrt(scale[j]),0.03);
const normalize=x=>{const v=new Float32Array(dim);for(let j=0;j<dim;j++)v[j]=Math.max(-5,Math.min(5,(x.vector[j]-mean[j])/scale[j]));return v;};
for(const x of training.concat(testing))x.feature=normalize(x);
const weights=new Float64Array(dim),positive=fit.filter(x=>x.label).length,negative=fit.length-positive;
let bias=0;
const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));
const score=x=>{let z=bias;for(let j=0;j<dim;j++)z+=weights[j]*x.feature[j];return sigmoid(z);};
for(let epoch=0;epoch<300;epoch++){
  const grad=new Float64Array(dim);let gb=0;
  for(const x of fit){const factor=(score(x)-x.label)*(x.label?fit.length/(2*positive):fit.length/(2*negative));gb+=factor;for(let j=0;j<dim;j++)grad[j]+=factor*x.feature[j];}
  const lr=0.12/Math.sqrt(1+epoch/30);
  for(let j=0;j<dim;j++)weights[j]-=lr*(grad[j]/fit.length+0.02*weights[j]);
  bias-=lr*gb/fit.length;
}
const metrics=(rows,threshold)=>{const tp=rows.filter(x=>x.label&&score(x)>=threshold).length,fp=rows.filter(x=>!x.label&&score(x)>=threshold).length,fn=rows.filter(x=>x.label&&score(x)<threshold).length,tn=rows.filter(x=>!x.label&&score(x)<threshold).length;return{tp,fp,fn,tn,precision:tp/(tp+fp)||0,recall:tp/(tp+fn)||0};};
let choice={threshold:0.5,recall:-1};
for(let i=5;i<=95;i+=5){const threshold=i/100,m=metrics(validation,threshold);if(m.precision>=0.8&&m.recall>choice.recall)choice={threshold,recall:m.recall};}
const rows=testing.map(x=>({id:x.id,label:x.label,critico:x.critico,score:score(x)}));
const summary={modelRevision:manifest.revision,train:fit.length,validation:validation.length,test:testing.length,dimension:dim,threshold:choice.threshold,validationMetrics:metrics(validation,choice.threshold),testMetrics:metrics(testing,choice.threshold),criticalMetrics:metrics(testing.filter(x=>x.critico),choice.threshold),source:'frozen Laya ONNX encoder + local logistic head; synthetic labels only',approved:false};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({date:new Date().toISOString(),summary,rows},null,2));
console.log(JSON.stringify({output,summary}));

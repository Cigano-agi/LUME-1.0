// Primeira medição do corpus sintético 11 com o extrator real. Nunca muda o gate público.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {casos} from './laya-action-heldout-11.mjs';
import {scoreActions} from './laya-eval-actions-lib.mjs';
import {verificarModelo} from '../src/laya/integrity.js';
import {validarCabecaDominio} from '../src/laya/domain-head.js';
import {parseTokenizerJson,encodeWithData} from '../src/laya/vendor/tokenizer.js';
import {extrairAcoesDominio} from '../src/laya/domain-actions.js';

const modelDir=resolve(process.argv[2]||'work/laya-onnx');
const artifactPath=resolve(process.argv[3]||'work/laya-domain-head-05-development.json');
const output=resolve(process.argv[4]||'work/laya-action-heldout-11-result.json');
if(existsSync(output))throw Error('RESULTADO_EXISTENTE: preserve a primeira medição.');
const corpusSha256=createHash('sha256').update(JSON.stringify(casos)).digest('hex');
if(corpusSha256!=='a4eefe03ce2739a56c1f525bb34e9c379360f1b1c1f0213272d95ba89e00c6c3')throw Error('CORPUS_11_ALTERADO');
const artifact=JSON.parse(await readFile(artifactPath,'utf8'));
const model=artifact.model;
if(model?.approvedForProduct!==false||artifact.summary?.modelSha256!==createHash('sha256').update(JSON.stringify(model)).digest('hex'))throw Error('CABECA_NAO_E_CANDIDATA_DE_PESQUISA');
const manifest=await verificarModelo(modelDir);
validarCabecaDominio(model,manifest.revision);
const tokenizer=parseTokenizerJson(JSON.parse(await readFile(join(modelDir,'tokenizer.json'),'utf8')));
if(tokenizer?.ids?.cls!==2||tokenizer?.ids?.sep!==1)throw Error('TOKENIZADOR_INVALIDO');
const loadStart=performance.now(),cpuStart=process.cpuUsage();
const ort=await import('onnxruntime-node');
const encoder=await ort.InferenceSession.create(join(modelDir,'encoder.onnx'),{executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all',logSeverityLevel:3});
const loadMs=Math.round(performance.now()-loadStart);
let peakRss=process.memoryUsage().rss;
const timings=[],caseResults=[];
async function embed(text,maxTokens){
  const tokens=encodeWithData(tokenizer,text).slice(0,maxTokens),ids=[tokenizer.ids.cls,...tokens,tokenizer.ids.sep];
  const inputIds=new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,ids.length]);
  const mask=new ort.Tensor('int64',BigInt64Array.from(ids.map(()=>1n)),[1,ids.length]);
  const hidden=await encoder.run({input_ids:inputIds,attention_mask:mask});
  const values=hidden.last_hidden_state.data,dim=hidden.last_hidden_state.dims.at(-1),feature=new Float32Array(dim);
  if(dim!==model.mean.length)throw Error('DIMENSAO_DO_MODELO_INVALIDA');
  for(let t=1;t<ids.length-1;t++)for(let j=0;j<dim;j++)feature[j]+=values[t*dim+j];
  for(let j=0;j<dim;j++)feature[j]/=Math.max(1,ids.length-2);
  return feature;
}
try{
  for(const [index,caso] of casos.entries()){
    const start=performance.now();
    const {candidatas}=await extrairAcoesDominio({texto:caso.texto,fonte:`E${index+1}`,canal:caso.canal,autor:caso.autor,nomeDono:'Fabrício',model,embed});
    const score=scoreActions(caso.esperadas,candidatas);
    timings.push(performance.now()-start);
    peakRss=Math.max(peakRss,process.memoryUsage().rss);
    caseResults.push({id:caso.id,critical:caso.critico,expected:caso.esperadas,actual:candidatas.map(({tipo,trecho})=>({tipo,trecho})),tp:score.tp,fp:score.fp,fn:score.fn});
  }
}finally{await encoder.release();}
const totals=caseResults.reduce((acc,row)=>{
  acc.tp+=row.tp;acc.fp+=row.fp;acc.fn+=row.fn;
  if(row.critical){acc.criticalTp+=row.tp;acc.criticalExpected+=row.expected.length;acc.criticalFp+=row.fp;if(!row.expected.length&&row.fp)acc.criticalNegativeFp+=row.fp;}
  return acc;
},{tp:0,fp:0,fn:0,criticalTp:0,criticalExpected:0,criticalFp:0,criticalNegativeFp:0});
timings.sort((a,b)=>a-b);
const pct=p=>Math.round(timings[Math.min(timings.length-1,Math.ceil(timings.length*p)-1)]);
const cpu=process.cpuUsage(cpuStart),encoderSize=(await stat(join(modelDir,'encoder.onnx'))).size;
const modelFiles=await readdir(modelDir,{withFileTypes:true});
const modelBundleBytes=(await Promise.all(modelFiles.filter(file=>file.isFile()).map(file=>stat(join(modelDir,file.name))))).reduce((total,file)=>total+file.size,0);
const summary={schema:'lume-laya-heldout-11-result-v1',createdAt:new Date().toISOString(),corpusSha256,
  modelSha256:artifact.summary.modelSha256,modelRevision:manifest.revision,modelApprovedForProduct:false,
  cases:casos.length,criticalCases:casos.filter(x=>x.critico).length,...totals,
  precision:totals.tp/(totals.tp+totals.fp)||0,recall:totals.tp/(totals.tp+totals.fn)||0,
  criticalRecall:totals.criticalTp/(totals.criticalExpected||1),
  loadMs,messageMs:{p50:pct(.5),p95:pct(.95),count:timings.length},
  cpuMs:Math.round((cpu.user+cpu.system)/1000),peakRssBytes:peakRss,encoderBytes:encoderSize,modelBundleBytes,
  publicActionsEmitted:0,limits:'Corpus sintético. Estados comerciais, fila, interface e computadores piloto exigem provas separadas.'};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({summary,cases:caseResults},null,2),{flag:'wx'});
console.log(JSON.stringify({output,summary}));

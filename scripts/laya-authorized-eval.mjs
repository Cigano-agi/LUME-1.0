// Avaliação local de um conjunto explicitamente selecionado e anotado pelo titular.
// Não abre o banco do Lume, não treina, não imprime mensagens e não altera a porta do produto.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {dividirAnotacoes} from './laya-annotations-lib.mjs';
import {verificarModelo} from '../src/laya/integrity.js';
import {parseTokenizerJson,encodeWithData} from '../src/laya/vendor/tokenizer.js';
import {validarCabecaDominio} from '../src/laya/domain-head.js';
import {extrairAcoesDominio} from '../src/laya/domain-actions.js';

const [inputArg,modelArg,outputArg,confirmation,mode,...extra]=process.argv.slice(2);
const selfTest=mode==='--self-test-synthetic';
if(!inputArg||!modelArg||!outputArg||confirmation!=='--confirm-local-eval'||extra.length||mode&&!selfTest)throw Error('Uso: node scripts/laya-authorized-eval.mjs ANOTACOES.json MODELO.json work/laya-private/resultado.json --confirm-local-eval [--self-test-synthetic]');
const input=resolve(inputArg),modelPath=resolve(modelArg),output=resolve(outputArg),base=resolve('work/laya-private');
const rel=relative(base,output);
if(!rel||rel.startsWith('..')||isAbsolute(rel)||!output.endsWith('.json')||existsSync(output))throw Error('SAIDA_PRIVADA_INVALIDA_OU_EXISTENTE');

const data=JSON.parse(await readFile(input,'utf8'));
const partition=dividirAnotacoes(data);
const validSample=selfTest
  ? partition.dataKind==='synthetic'
  : partition.dataKind==='real_authorized'&&partition.summary.readyForBlindEvaluation&&partition.test.length>=100&&partition.test.filter(x=>x.critical).length>=20;
if(!validSample)throw Error('CONJUNTO_REAL_AUTORIZADO_INSUFICIENTE');
// Se o nome do dono constar no texto original de um grupo, a revisão manual o substitui por “Dono”.
// Mensagens de grupo sem menção ao dono também são exemplos válidos.

const artifact=JSON.parse(await readFile(modelPath,'utf8'));
const model=artifact.model;
if(model?.schema!=='lume-laya-domain-head-v1'||!['author-channel-message-span-v1','author-channel-message-span-owner-v2'].includes(model?.inputTemplate)||model?.approvedForProduct!==false||
  artifact.summary?.modelSha256!==createHash('sha256').update(JSON.stringify(model)).digest('hex')||
  !Array.isArray(model.classes)||model.classes.join(',')!=='none,pedido,compromisso'||!Number.isFinite(model.threshold))throw Error('MODELO_DE_AVALIACAO_INVALIDO');
const modelDir=resolve('work/laya-onnx'),manifest=await verificarModelo(modelDir);
if(model.encoderRevision!==manifest.revision)throw Error('REVISAO_DO_MODELO_DIVERGENTE');
validarCabecaDominio(model,manifest.revision);
const tokenizer=parseTokenizerJson(JSON.parse(await readFile(join(modelDir,'tokenizer.json'),'utf8')));
const ort=await import('onnxruntime-node');
const encoder=await ort.InferenceSession.create(join(modelDir,'encoder.onnx'),{executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all',logSeverityLevel:3});
const started=performance.now(),times=[];
const normalizar=text=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR').match(/[a-z0-9]+/g)||[];
function overlap(a,b){
  const aa=normalizar(a),bb=normalizar(b),used=new Set();let common=0;
  for(const word of aa){const i=bb.findIndex((x,j)=>x===word&&!used.has(j));if(i>=0){common++;used.add(i);}}
  return Math.min(common/Math.max(aa.length,1),common/Math.max(bb.length,1));
}
// third_party representa conteúdo encaminhado/importado, que o runtime agora
// reconhece pelo envelope local e descarta antes de inferir.
const mapAuthor={self:'proprio',other:'outro',third_party:'terceiro'};
const mapChannel={dm:'dm',group:'grupo'};
const mapType={pendencia:'pedido',compromisso:'compromisso'};
const expectedType={request:'pedido',promise:'compromisso'};
async function embed(text,maxTokens){
  const started=performance.now();
  const tokens=encodeWithData(tokenizer,text).slice(0,maxTokens),ids=[tokenizer.ids.cls,...tokens,tokenizer.ids.sep];
  const inputIds=new ort.Tensor('int64',BigInt64Array.from(ids.map(BigInt)),[1,ids.length]);
  const mask=new ort.Tensor('int64',BigInt64Array.from(ids.map(()=>1n)),[1,ids.length]);
  const hidden=await encoder.run({input_ids:inputIds,attention_mask:mask});
  const values=hidden.last_hidden_state.data,dim=hidden.last_hidden_state.dims.at(-1),feature=new Float32Array(dim);
  if(dim!==model.mean.length)throw Error('DIMENSAO_DO_MODELO_INVALIDA');
  for(let t=1;t<ids.length-1;t++)for(let j=0;j<dim;j++)feature[j]+=values[t*dim+j];
  for(let j=0;j<dim;j++)feature[j]/=Math.max(1,ids.length-2);
  times.push(performance.now()-started);
  return feature;
}
let tp=0,fp=0,fn=0,criticalTp=0,criticalExpected=0,criticalFp=0;
const errors=[];
try{
  for(const [index,item] of partition.test.entries()){
    const {candidatas:accepted}=await extrairAcoesDominio({texto:item.text,fonte:'E'+(index+1),canal:mapChannel[item.channel],autor:mapAuthor[item.author],nomeDono:'Dono',model,embed});
    const used=new Set();let hit=0;
    for(const action of item.actions){
      let best=-1,score=0;
      for(let i=0;i<accepted.length;i++){
        if(used.has(i)||mapType[accepted[i].tipo]!==expectedType[action.type])continue;
        const current=overlap(action.span,accepted[i].trecho);
        if(current>score){score=current;best=i;}
      }
      if(best>=0&&score>=0.5){used.add(best);hit++;}
    }
    const extra=accepted.length-used.size,missing=item.actions.length-hit;
    tp+=hit;fp+=extra;fn+=missing;
    if(item.critical){criticalTp+=hit;criticalExpected+=item.actions.length;criticalFp+=extra;}
    if(extra||missing)errors.push({testIndex:index,extra,missing,critical:item.critical});
  }
}finally{await encoder.release();}
times.sort((a,b)=>a-b);
const percentile=p=>times.length?Math.round(times[Math.min(times.length-1,Math.ceil(times.length*p)-1)]):null;
const result={schema:'lume-laya-local-eval-v1',dataKind:partition.dataKind,selfTest,date:new Date().toISOString(),sourceSha256:partition.sourceSha256,modelSha256:artifact.summary.modelSha256,
  testItems:partition.test.length,criticalItems:partition.test.filter(x=>x.critical).length,tp,fp,fn,criticalTp,criticalExpected,criticalFp,
  precision:tp/(tp+fp)||0,recall:tp/(tp+fn)||0,criticalRecall:criticalTp/(criticalExpected||1),
  candidateInferenceMs:{p50:percentile(.5),p95:percentile(.95),count:times.length},totalMs:Math.round(performance.now()-started),
  errors,approvedForProduct:false,limits:'Ações somente; sem classificação de pagamento/aceite/conclusão, latência até a tela ou prova em dispositivo piloto.'};
await mkdir(dirname(output),{recursive:true});
const rootReal=await realpath('.'),baseReal=await realpath(base),dirReal=await realpath(dirname(output));
const inside=(parent,child)=>{const r=relative(parent,child);return r===''||!r.startsWith('..')&&!isAbsolute(r);};
if(!inside(rootReal,baseReal)||!inside(baseReal,dirReal))throw Error('SAIDA_FORA_DO_WORK_PRIVADO');
await writeFile(output,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({written:true,dataKind:result.dataKind,selfTest,testItems:result.testItems,tp,fp,fn,criticalTp,criticalExpected,criticalFp,precision:result.precision,recall:result.recall,criticalRecall:result.criticalRecall,candidateInferenceMs:result.candidateInferenceMs,approvedForProduct:false}));

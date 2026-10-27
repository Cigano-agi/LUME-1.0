import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { carregarRuntime } from '../src/laya/runtime.js';
import { cases, gates } from './laya-cases.mjs';
const modelDir=resolve(process.argv[2]??'work/laya-onnx');
const output=resolve(process.argv[3]??'work/laya-benchmark.json');
const started=performance.now();
const runtime=await carregarRuntime(modelDir);
const loadMs=Math.round(performance.now()-started);
const results=[];
try {
 for(const item of cases){
   const cold=performance.now();
   const a=await runtime.infer(item.texto,{debug:true});
   const wallMs=Math.round(performance.now()-cold);
   const b=await runtime.infer(item.texto,{debug:true,reverse:true});
   results.push({...item,result:a,reverse:b.avaliacao.prevista,wallMs,correct:a.avaliacao.prevista===item.expected,stable:a.avaliacao.prevista===b.avaliacao.prevista});
   console.log(item.id,a.avaliacao.prevista,a.abstencao?'abstém':'sugere',wallMs);
 }
} finally {await runtime.close();}
const emitted=results.filter(x=>!x.result.abstencao);
const latency=results.slice(1).map(x=>x.wallMs).sort((a,b)=>a-b);
const summary={accuracy:results.filter(x=>x.correct).length/results.length, emittedAccuracy:emitted.length?emitted.filter(x=>x.correct).length/emitted.length:null, coverage:emitted.length/results.length, orderStability:results.filter(x=>x.stable).length/results.length, sensitiveEmissions:results.filter(x=>/^n0[1-6]$/.test(x.id)&&!x.result.abstencao).length, loadMs,firstMs:results[0].wallMs,p50Ms:latency[Math.floor(latency.length*.50)],p95Ms:latency[Math.floor(latency.length*.95)],rssMb:Math.round(process.memoryUsage().rss/1048576)};
const approved=summary.accuracy>=gates.accuracy&&summary.emittedAccuracy>=gates.emittedAccuracy&&summary.coverage>=gates.coverage&&summary.orderStability>=gates.orderStability&&summary.sensitiveEmissions===0;
const artifact={date:new Date().toISOString(),modelDir,synthetic:true,externalRequests:0,gates,approved,summary,results};
await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(artifact,null,2));
console.log(JSON.stringify({approved,summary},null,2));

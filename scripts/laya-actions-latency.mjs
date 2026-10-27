// Synthetic development benchmark. Never changes the release policy or reads WhatsApp.
import {readFile,writeFile,link,mkdtemp,readdir,unlink,rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,dirname,join,resolve} from 'node:path';
import {carregarRuntime} from '../src/laya/runtime.js';
import {casos} from './laya-action-heldout-09.mjs';

const workDir=resolve('work'),source=resolve(process.argv[2]||join(workDir,'laya-onnx'));
const artifact=JSON.parse(await readFile(join(workDir,'laya-domain-head-05-development.json'),'utf8'));
const model={...artifact.model,approvedForProduct:true};
const modelSha256=createHash('sha256').update(JSON.stringify(model)).digest('hex');
const temporary={...artifact,model,summary:{...artifact.summary,approvedForProduct:true,modelSha256}};
const files=['encoder.onnx','encoder.onnx.data','head.onnx','head.onnx.data','tokenizer.json','rl_agent_config.json','lume-laya-manifest.json','LICENSE','MODEL-CARD.md'];
const tempDir=await mkdtemp(join(workDir,'laya-speed-'));
let runtime;
try{
  for(const name of files)await link(join(source,name),join(tempDir,name));
  await writeFile(join(tempDir,'domain-head.json'),JSON.stringify(temporary));
  const start=performance.now();
  runtime=await carregarRuntime(tempDir,{domainPolicy:{approvedForActions:true,modelSha256}});
  const loadMs=Math.round(performance.now()-start),rows=[];
  for(const item of casos){
    const startCase=performance.now();
    const output=await runtime.inferirAcoes({texto:item.texto,fonte:'E1',canal:item.canal,autor:item.autor,nomeDono:'Fabrício'});
    rows.push({id:item.id,ms:Math.round(performance.now()-startCase),actions:output.candidatas.length});
  }
  const ordered=rows.map(row=>row.ms).sort((a,b)=>a-b),p=q=>ordered[Math.ceil(q*ordered.length)-1];
  console.log(JSON.stringify({synthetic:true,approvalInjectedOnlyForMeasurement:true,loadMs,p50Ms:p(.5),p95Ms:p(.95),maxMs:p(1),sample:rows.length,rssMb:Math.round(process.memoryUsage().rss/1048576),rows}));
}finally{
  try{await runtime?.close();}finally{
    if(dirname(tempDir)!==workDir||!basename(tempDir).startsWith('laya-speed-'))throw Error('Diretório temporário fora do work.');
    for(const name of await readdir(tempDir))if([...files,'domain-head.json'].includes(name))await unlink(join(tempDir,name));
    await rmdir(tempDir);
  }
}

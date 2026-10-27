// Explicit real-model evaluation. Not part of npm test; never downloads files.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {ArquivosModeloLocal} from '../src/modelo-local-arquivos.js';
import {pedidoRascunhoLocal,pedidoRascunhoDireto} from './fixtures/local-writer-prompts.js';
const [cacheDir,manifestFile,casesFile,outDir,variant='baseline']=process.argv.slice(2);
if(!cacheDir||!manifestFile||!casesFile||!outDir||!['baseline','direct'].includes(variant))throw Error('Uso: node test/local-writer.eval.mjs CACHE MANIFESTO CASOS SAIDA baseline|direct');
const manifest=JSON.parse(readFileSync(manifestFile,'utf8')),cases=JSON.parse(readFileSync(casesFile,'utf8'));
if(!Array.isArray(cases)||!cases.length||cases.length>30)throw Error('Escolha de um a trinta casos sintéticos.');
const prompt=variant==='direct'?pedidoRascunhoDireto:pedidoRascunhoLocal;
for(const c of cases)prompt(c);
let attempts=0;globalThis.fetch=async()=>{attempts++;throw Error('NETWORK_FORBIDDEN');};
const cache=new ArquivosModeloLocal({diretorio:cacheDir,manifesto:manifest});await cache.verificar();
const {pipeline}=await import('@huggingface/transformers');let generator;
const output=resolve(outDir);mkdirSync(output,{recursive:true});
const report={model:manifest.model,revision:manifest.revision,prompt:variant,dtype:'q4',device:'cpu',threads:4,cases:[],fetches:0,
  inputHash:createHash('sha256').update(JSON.stringify(cases.map(prompt))).digest('hex'),manifestHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
writeFileSync(join(output,'inputs.json'),JSON.stringify({cases,manifest,prompts:cases.map(prompt)},null,2));
try{
 const start=performance.now();generator=await pipeline('text-generation',cache.diretorio,{dtype:'q4',device:'cpu',local_files_only:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}});report.loadMs=performance.now()-start;
 for(const c of cases){const start=performance.now();const result=await generator(prompt(c),{max_new_tokens:variant==='direct'?128:160,do_sample:false,tokenizer_encode_kwargs:{enable_thinking:false}});const generated=result[0].generated_text;
   report.cases.push({id:c.id,criterio:c.criterio,text:typeof generated==='string'?generated:generated.at(-1).content,ms:performance.now()-start});
   writeFileSync(join(output,'results.json'),JSON.stringify({...report,fetches:attempts},null,2));console.log('CASE_COMPLETE',c.id);
 }
 report.fetches=attempts;report.date=new Date().toISOString();writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2));
 if(attempts)throw Error('Houve tentativa de rede durante a avaliação.');
 console.log('LOCAL_EVAL_COMPLETE',report.cases.length);
}finally{await generator?.dispose();}

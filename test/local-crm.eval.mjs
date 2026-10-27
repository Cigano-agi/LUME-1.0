// Explicit CPU evaluation, synthetic fixtures only; no downloads or application profile.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {freemem,totalmem,cpus} from 'node:os';
import {ArquivosModeloLocal} from '../src/modelo-local-arquivos.js';
import {pedidoRascunhoDireto} from './fixtures/local-writer-prompts.js';
import {pedidoPropostasLocal,conferirPropostasLocal} from '../src/propostas-local-contrato.js';
const [cacheDir,manifestFile,casesFile,outDir,mode]=process.argv.slice(2);
if(!cacheDir||!manifestFile||!casesFile||!outDir||!['draft','proposal'].includes(mode))throw Error('Uso: node test/local-crm.eval.mjs CACHE MANIFESTO CASOS SAIDA draft|proposal');
const manifest=JSON.parse(readFileSync(manifestFile,'utf8')),cases=JSON.parse(readFileSync(casesFile,'utf8'));
if(!Array.isArray(cases)||!cases.length||cases.length>30)throw Error('Escolha até 30 casos sintéticos.');
const make=mode==='draft'?pedidoRascunhoDireto:pedidoPropostasLocal,prompts=cases.map(make),out=resolve(outDir);mkdirSync(out,{recursive:true});
if(freemem()<6*1024**3)throw Error('Menos de 6 GiB livres; avaliação não iniciada.');
let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('NETWORK_FORBIDDEN');};
const cache=new ArquivosModeloLocal({diretorio:cacheDir,manifesto:manifest});await cache.verificar();
const report={date:new Date().toISOString(),model:manifest.model,revision:manifest.revision,mode,dtype:'q4',device:'cpu',threads:4,hardware:{cpu:cpus()[0]?.model,totalRAM:totalmem(),freeRAM:freemem()},cases:[],fetches:0,peakRSS:process.memoryUsage().rss,inputHash:createHash('sha256').update(JSON.stringify(prompts)).digest('hex')};
writeFileSync(join(out,'inputs.json'),JSON.stringify({manifest,cases,prompts},null,2));
const save=()=>writeFileSync(join(out,'results.json'),JSON.stringify({...report,fetches},null,2));
let generator;const sample=()=>{report.peakRSS=Math.max(report.peakRSS,process.memoryUsage().rss);},timer=setInterval(sample,500);
try{
 const {pipeline}=await import('@huggingface/transformers'),start=performance.now();
 generator=await pipeline('text-generation',cache.diretorio,{dtype:'q4',device:'cpu',local_files_only:true,session_options:{intraOpNumThreads:4,interOpNumThreads:1}});report.loadMs=performance.now()-start;sample();save();console.log('MODEL_LOADED',Math.round(report.loadMs));
 for(let i=0;i<cases.length;i++){
  const c=cases[i],start=performance.now(),value=await generator(prompts[i],{max_new_tokens:mode==='draft'?128:384,do_sample:false,tokenizer_encode_kwargs:{enable_thinking:false}}),generated=value[0].generated_text,text=typeof generated==='string'?generated:generated.at(-1).content;
  const row={id:c.id,criterio:c.criterio,text,ms:performance.now()-start};
  if(mode==='proposal'){try{row.parsed=conferirPropostasLocal(text,c.fontes);row.contractValid=true;const n=row.parsed.negocios[0];row.expectedFieldsMatch=row.parsed.negocios.length===c.esperado.negocios&&(c.esperado.negocios===0||n.etapa===c.esperado.etapa&&n.valor_centavos===c.esperado.valor_centavos);}catch(e){row.contractValid=false;row.error=e.message;}}
  report.cases.push(row);sample();save();console.log('CASE_COMPLETE',c.id,Math.round(row.ms));
 }
 report.completed=true;report.fetches=fetches;save();if(fetches)throw Error('Houve tentativa de rede');console.log('LOCAL_CRM_EVAL_COMPLETE',cases.length);
}catch(e){report.error=e.message;save();throw e;}finally{clearInterval(timer);await generator?.dispose();}

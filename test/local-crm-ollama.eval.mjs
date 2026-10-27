// Development evaluation against a separate, local-only Ollama process.
// The owner daemon is never a default endpoint. No model is pulled by this harness.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {pedidoRascunhoDireto} from './fixtures/local-writer-prompts.js';
import {pedidoPropostasLocal,conferirPropostasLocal,ESQUEMA_PROPOSTAS} from '../src/propostas-local-contrato.js';
const [stateFile,casesFile,outDir,mode]=process.argv.slice(2);
if(!stateFile||!casesFile||!outDir||!['draft','proposal'].includes(mode))throw Error('Uso: node test/local-crm-ollama.eval.mjs ESTADO_SERVIDOR CASOS SAIDA draft|proposal');
const state=JSON.parse(readFileSync(stateFile,'utf8')),cases=JSON.parse(readFileSync(casesFile,'utf8')),url=new URL(state.url),model='qwen3:4b-instruct-2507-q4_K_M';
if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.port==='11434'||state.cloud!==false||!Number.isInteger(state.pid)||!Array.isArray(state.initialModels)||state.initialModels.length)throw Error('Use somente o processo isolado de avaliação.');
if(!Array.isArray(cases)||!cases.length||cases.length>30)throw Error('Escolha até 30 casos sintéticos.');
const make=mode==='draft'?pedidoRascunhoDireto:pedidoPropostasLocal,prompts=cases.map(make),out=resolve(outDir);mkdirSync(out,{recursive:true});
const localFetch=globalThis.fetch;let calls=0;
globalThis.fetch=async(input,opts)=>{const u=new URL(input);if(u.origin!==url.origin)throw Error('EXTERNAL_NETWORK_FORBIDDEN');calls++;return localFetch(input,opts);};
const api=async(path,body)=>{const r=await fetch(url.origin+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)}:{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('HTTP '+r.status);const v=await r.json();if(v.error)throw Error(v.error);return v;};
const tags=await api('/api/tags'),tag=tags.models.find(m=>m.name===model);if(!tag)throw Error('Modelo local não preparado.');
const report={date:new Date().toISOString(),model,digest:tag.digest,mode,structuredOutput:mode==='proposal',runtime:'ollama',serverVersion:(await api('/api/version')).version,isolatedServer:{pid:state.pid,port:url.port,cloud:false},cases:[],clientExternalRequests:0,localRequests:0,inputHash:createHash('sha256').update(JSON.stringify(prompts)).digest('hex')};
writeFileSync(join(out,'inputs.json'),JSON.stringify({cases,prompts,model:tag,format:mode==='proposal'?ESQUEMA_PROPOSTAS:null},null,2));
const save=()=>writeFileSync(join(out,'results.json'),JSON.stringify({...report,localRequests:calls},null,2));
try{
 for(let i=0;i<cases.length;i++){
  const c=cases[i],start=performance.now(),v=await api('/api/chat',{model,messages:prompts[i],...(mode==='proposal'?{format:ESQUEMA_PROPOSTAS}:{}),stream:false,think:false,keep_alive:'5m',options:{temperature:0,seed:42,num_ctx:4096,num_predict:mode==='draft'?128:384,num_thread:4}});
  const row={id:c.id,criterio:c.criterio,text:v.message.content,ms:performance.now()-start,doneReason:v.done_reason,promptTokens:v.prompt_eval_count,outputTokens:v.eval_count,loadMs:v.load_duration/1e6,promptMs:v.prompt_eval_duration/1e6,generationMs:v.eval_duration/1e6};
  if(mode==='proposal'){try{row.parsed=conferirPropostasLocal(row.text,c.fontes);row.contractValid=true;const n=row.parsed.negocios[0];row.expectedFieldsMatch=row.parsed.negocios.length===c.esperado.negocios&&(c.esperado.negocios===0||n.etapa===c.esperado.etapa&&n.valor_centavos===c.esperado.valor_centavos);}catch(e){row.contractValid=false;row.error=e.message;}}
  report.cases.push(row);report.residency=await api('/api/ps');save();console.log('CASE_COMPLETE',c.id,Math.round(row.ms));
 }
 report.completed=true;save();console.log('LOCAL_OLLAMA_EVAL_COMPLETE',cases.length);
}catch(e){report.error=e.message;save();throw e;}
finally{await api('/api/generate',{model,keep_alive:0}).catch(()=>{});}

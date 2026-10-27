// Development-only, frozen prompt, no downloads, no tools or application profile.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {prepararReferenciasProposta,esquemaReferenciasProposta,pedidoReferenciasProposta,conferirReferenciasProposta,INSTRUCAO_REFERENCIAS} from '../src/propostas-local-referencias.js';
const [statePath,casesPath,dest]=process.argv.slice(2);
if(!statePath||!casesPath||!dest)throw Error('Uso: node test/local-propostas-referencias.eval.mjs ESTADO CASOS SAIDA');
const state=JSON.parse(readFileSync(statePath,'utf8')),cases=JSON.parse(readFileSync(casesPath,'utf8')),url=new URL(state.url),out=resolve(dest);
if(url.hostname!=='127.0.0.1'||url.protocol!=='http:'||url.port==='11434'||state.cloud!==false||state.digest!=='0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0'||!Number.isInteger(state.pid))throw Error('Use only the isolated evaluation server.');
if(!Array.isArray(cases)||!cases.length||cases.length>30)throw Error('Invalid evaluation set.');
if(existsSync(join(out,'results.json')))throw Error('Existing results must not be overwritten.');
const inputs=cases.map(c=>{const pacote=prepararReferenciasProposta(c.fontes),messages=pedidoReferenciasProposta(pacote),format=esquemaReferenciasProposta(pacote);
 // Conservative UTF-8 byte upper bound, leaving room for template and 640 output tokens.
 if(Buffer.byteLength(JSON.stringify(messages),'utf8')>8192-640-512)throw Error('Context too large; do not truncate sources silently.');
 return {id:c.id,pacote,messages,format};});
mkdirSync(out,{recursive:true});writeFileSync(join(out,'inputs.json'),JSON.stringify({cases,inputs},null,2));
const originalFetch=globalThis.fetch;let calls=0;
globalThis.fetch=(input,opts)=>{if(new URL(input).origin!==url.origin)throw Error('EXTERNAL_NETWORK_FORBIDDEN');calls++;return originalFetch(input,opts);};
const api=async(path,body)=>{const r=await fetch(url.origin+path,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(body?180000:10000)});if(!r.ok)throw Error('HTTP '+r.status);const value=await r.json();if(value.error)throw Error(value.error);return value;};
const tag=(await api('/api/tags')).models.find(m=>m.name===state.model);if(tag?.digest!==state.digest)throw Error('Model digest mismatch.');
const hash=s=>createHash('sha256').update(s).digest('hex');
const report={date:new Date().toISOString(),model:state.model,digest:tag.digest,runtime:'ollama',version:(await api('/api/version')).version,promptHash:hash(INSTRUCAO_REFERENCIAS),contractHash:hash(readFileSync('src/propostas-local-referencias.js')),casesHash:hash(readFileSync(casesPath)),numCtx:8192,numPredict:640,temperature:0,seed:42,cases:[],clientExternalRequests:0};
const save=()=>writeFileSync(join(out,'results.json'),JSON.stringify({...report,localRequests:calls},null,2));
const pairs=items=>items.map(n=>[n.etapa,n.valor_centavos]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
try{
 for(let i=0;i<cases.length;i++){
  const c=cases[i],input=inputs[i],start=performance.now();
  const v=await api('/api/chat',{model:state.model,messages:input.messages,format:input.format,stream:false,think:false,keep_alive:'5m',options:{temperature:0,seed:42,num_ctx:8192,num_predict:640,num_thread:4}});
  const row={id:c.id,text:v.message.content,ms:performance.now()-start,doneReason:v.done_reason,promptTokens:v.prompt_eval_count,outputTokens:v.eval_count,loadMs:v.load_duration/1e6,generationMs:v.eval_duration/1e6};
  try{if(v.done_reason!=='stop')throw Error('Generation incomplete.');row.parsed=conferirReferenciasProposta(row.text,input.pacote,c.fontes);row.contractValid=true;
   const expected=c.esperado.itens??(c.esperado.negocios?[c.esperado]:[]);row.expectedFieldsMatch=row.parsed.negocios.length===c.esperado.negocios&&JSON.stringify(pairs(row.parsed.negocios))===JSON.stringify(pairs(expected));
  }catch(e){row.contractValid=false;row.error=e.message;}
  report.cases.push(row);report.residency=await api('/api/ps');save();console.log('CASE_COMPLETE',c.id,Math.round(row.ms),row.contractValid,row.expectedFieldsMatch);
 }
 report.completed=true;save();console.log('REFERENCES_EVAL_COMPLETE',cases.length);
}catch(e){report.error=e.message;save();throw e;}
finally{await api('/api/generate',{model:state.model,keep_alive:0}).catch(()=>{});}

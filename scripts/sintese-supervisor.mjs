#!/usr/bin/env node
// Process deadline complements the cooperative, per-token generation limit.
import {spawn} from 'node:child_process';
import {lstat,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {argumentosSintese} from './sintese-probe.mjs';
import {gravarAtomico} from './contexto-probe.mjs';
const argv=process.argv.slice(2),opts=argumentosSintese(argv);
const path=resolve(opts['--output'])+'.processo.json';
for(const target of [path,resolve(opts['--output'])]){
  try{await lstat(target);throw Error('SINTESE_SAIDA_EXISTENTE');}catch(e){if(e.code!=='ENOENT')throw e;}
}
const limiteMs=17*60*1000,started=performance.now(),data=new Date().toISOString();
const child=spawn(process.execPath,[fileURLToPath(new URL('./sintese-probe.mjs',import.meta.url)),...argv],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='',timeout=false,spawnError=null;
child.stdout.on('data',b=>{process.stdout.write(b);stdout=(stdout+b.toString('utf8')).slice(-65536);});
child.stderr.on('data',b=>{process.stderr.write(b);stderr=(stderr+b.toString('utf8')).slice(-65536);});
const timer=setTimeout(()=>{timeout=true;child.kill('SIGKILL');},limiteMs);
child.on('error',error=>{spawnError=String(error.message).slice(0,1000);});
const exit=await new Promise(resolveExit=>child.once('close',(code,signal)=>resolveExit({code,signal})));
clearTimeout(timer);
let reciboCompleto=false,erroRecibo=null;
try{const recibo=JSON.parse(await readFile(opts['--output'],'utf8'));reciboCompleto=recibo.completo===true&&recibo.aprovado===false;}catch(e){erroRecibo=String(e.message).slice(0,500);}
const result={schema:'lume-sintese-processo-v1',data,limiteMs,duracaoMs:performance.now()-started,timeout,spawnError,...exit,reciboCompleto,erroRecibo,stdout,stderr,aprovado:false};
await gravarAtomico(path,result);
if(timeout||spawnError||exit.code!==0||!reciboCompleto)process.exitCode=1;

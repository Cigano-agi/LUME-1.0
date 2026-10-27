// Research-only harness: six fixed fictional windows, at most two declared attempts.
// Never import in the app. No profile argument, external inference or product wiring.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,open} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {cpus,totalmem,platform,release,freemem} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PIN} from './sintese-dev-download.mjs';
import {sha256Arquivo} from './lib/sintese-local-runtime.mjs';
import {LIMITES,HIPOTESES,expandir} from './lib/sintese-dev-composicao.mjs';
import {CASOS} from './lib/sintese-dev-casos.mjs';
import {ambienteMinimo,argumentosServidor,requisicao,interpretarSSE,portaLivre,processo,conferirArtefatos,encerrarProcesso} from './lib/sintese-dev-runtime.mjs';

const app=resolve(dirname(import.meta.filename),'..'),root=join(app,'work/beta06-sintese-dev');
const args=process.argv.slice(2),tentativa=Number(args[0]);
if(args.length!==2||![1,2].includes(tentativa)||args[1]!=='--cpu-exclusiva-confirmada')throw Error('USE: node scripts/sintese-dev-benchmark.mjs 1|2 --cpu-exclusiva-confirmada (avisar coordenador antes)');
if(tentativa===2){const first=JSON.parse(await readFile(join(root,'attempt-1/result.json'),'utf8'));if(!first.casos?.length)throw Error('DEV_SEGUNDA_TENTATIVA_SEM_PRIMEIRA');}
const dir=join(root,`attempt-${tentativa}`);await mkdir(dir); // EEXIST prevents rerun/overwrite.
const save=async(name,value)=>writeFile(join(dir,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const result={schema:'lume-sintese-development-v1',startedAt:new Date().toISOString(),tentativa,hipotese:HIPOTESES[tentativa],
  corpus:'ficticio novo de desenvolvimento, conhecido ao implementador; nao cego',pin:PIN,limites:LIMITES,
  host:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemBytes:totalmem(),freeMemBeforeBytes:freemem(),platform:platform(),release:release(),node:process.version},
  qualidade:'Nao aprovada. Estrutura/literalidade sao verificacoes separadas da semantica e dos gates de release.',casos:[]};
let child,observer,exited=false,watchdog,loadStart,serverReadyAt;
let logs=[],logBytes=0,memory=[],observerRaw='',observerErr='';
let fatal;
try{
  await save('cases.json',CASOS);result.casesSha256=await sha256Arquivo(join(dir,'cases.json'));
  result.code={};const sources={};
  for(const file of ['scripts/sintese-dev-benchmark.mjs','scripts/sintese-dev-download.mjs','scripts/lib/sintese-dev-runtime.mjs','scripts/lib/sintese-dev-composicao.mjs','scripts/lib/sintese-dev-casos.mjs','scripts/lib/sintese-local-runtime.mjs','src/sintese-contexto/contrato.js']){result.code[file]=await sha256Arquivo(join(app,file));sources[file]=await readFile(join(app,file),'utf8');}
  await save('code-snapshot.json',sources);
  await save('preflight.json',result);
  await mkdir(join(root,'temp'),{recursive:true});
  result.artifacts=await conferirArtefatos(root,PIN);
  const exe=join(root,'runtime/llama-server.exe'),env=ambienteMinimo(root);
  result.version=await processo(exe,['--version'],{env,cwd:root});
  if(result.version.code!==0)throw Error('DEV_RUNTIME_VERSION_FAILED');
  const port=await portaLivre(),nonce=randomBytes(32).toString('hex'),argv=argumentosServidor(join(root,PIN.model.filename),port,nonce);
  result.argv=argv.map(v=>v===nonce?'[ephemeral loopback authentication]':v);
  await save('launch.json',{argv:result.argv,version:result.version,artifacts:result.artifacts});
  loadStart=performance.now();
  child=spawn(exe,argv,{windowsHide:true,shell:false,cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.once('error',e=>{fatal=e;exited=true;});
  child.once('close',(code,signal)=>{exited=true;result.serverExit={code,signal};});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logBytes+=b.length;if(logBytes<=8*1024**2)logs.push(b);else{fatal=Error('DEV_LOG_LIMIT');child.kill();}});
  if(!child.pid)throw Error('DEV_SPAWN_FAILED');
  result.serverPid=child.pid;
  const memoryCommand=`$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${child.pid}); $self=[Diagnostics.Process]::GetCurrentProcess(); while(!$p.HasExited) { $p.Refresh(); $self.Refresh(); [Console]::WriteLine(('{"utc":"'+[DateTime]::UtcNow.ToString('o')+'","workingSetBytes":'+$p.WorkingSet64+',"peakWorkingSetSoBytes":'+$p.PeakWorkingSet64+',"privateBytes":'+$p.PrivateMemorySize64+',"cpuMs":'+$p.TotalProcessorTime.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)+',"observerWorkingSetBytes":'+$self.WorkingSet64+'}')); Start-Sleep -Milliseconds 500 }`;
  observer=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',memoryCommand],{windowsHide:true,shell:false,env,stdio:['ignore','pipe','pipe']});
  observer.stdout.on('data',b=>{observerRaw+=b;});observer.stderr.on('data',b=>{observerErr+=b;});observer.on('error',e=>{observerErr+=String(e);});
  watchdog=setTimeout(()=>{fatal=Error('DEV_WALL_TIMEOUT');child.kill();},8*60000);
  const url=`http://127.0.0.1:${port}`,headers={'Authorization':`Bearer ${nonce}`,'Content-Type':'application/json'};
  const localFetch=(path,options={})=>fetch(url+path,{...options,headers,redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??120000)});
  while(true){
    if(exited)throw fatal??Error('DEV_SERVER_EXITED');
    if(performance.now()-loadStart>120000)throw Error('DEV_LOAD_TIMEOUT');
    try{const r=await localFetch('/health',{timeoutMs:1000});if(r.ok)break;}catch{}
    await delay(200);
  }
  serverReadyAt=performance.now();result.serverLoadMs=serverReadyAt-loadStart;
  async function post(path,value){const r=await localFetch(path,{method:'POST',body:JSON.stringify(value)});if(!r.ok)throw Error('DEV_HTTP_'+r.status+':'+(await r.text()).slice(0,300));return r.json();}
  for(const c of CASOS){
    if(fatal||exited)throw fatal??Error('DEV_SERVER_EXITED');
    const request=requisicao(c.fontes,tentativa);await save(c.id+'-request.json',request);
    const template=await post('/apply-template',{messages:request.messages,add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false}});
    const tokenization=await post('/tokenize',{content:template.prompt,add_special:false});
    await save(c.id+'-template.json',template);await save(c.id+'-tokens.json',tokenization);
    const tokens=tokenization.tokens.length;
    if(tokens>LIMITES.entradaTokens)throw Error('DEV_TOKEN_LIMIT');
    const row={id:c.id,inputTokens:tokens,rubrica:c.rubrica,startUtc:new Date().toISOString()};result.casos.push(row);
    const started=performance.now(),handle=await open(join(dir,c.id+'-raw.sse'),'wx');
    let raw='',firstContentMs=null;
    try{
      const response=await localFetch('/v1/chat/completions',{method:'POST',body:JSON.stringify(request)});
      if(!response.ok){raw=await response.text();await handle.write(raw);throw Error('DEV_HTTP_'+response.status);}
      const decoder=new TextDecoder();
      for await(const b of response.body){
        await handle.write(b);raw+=decoder.decode(b,{stream:true});
        if(Buffer.byteLength(raw)>2*1024**2)throw Error('DEV_STREAM_LIMIT');
        if(firstContentMs===null){for(const line of raw.split('\n')){if(!line.startsWith('data:')||line.includes('[DONE]'))continue;try{const e=JSON.parse(line.slice(5));if(e.choices?.[0]?.delta?.content){firstContentMs=performance.now()-started;break;}}catch{}}}
      }
      raw+=decoder.decode();row.elapsedMs=performance.now()-started;row.ttFirstContentMs=firstContentMs;row.fromServerStartMs=performance.now()-loadStart;
      const decoded=interpretarSSE(raw);row.raw=decoded.raw;row.lastEvent=decoded.eventos.at(-1);
      row.usage=decoded.eventos.findLast(e=>e.usage)?.usage??null;row.timings=decoded.eventos.findLast(e=>e.timings)?.timings??null;
      try{row.validated=expandir(row.raw,c.fontes);row.structureValid=true;}catch(e){row.structureValid=false;row.validationError=String(e.message);}
    }catch(e){row.elapsedMs=performance.now()-started;row.ttFirstContentMs=firstContentMs;row.error=String(e.message);throw e;}
    finally{await handle.close();await save(c.id+'-result.json',row);}
    console.log(JSON.stringify({id:row.id,inputTokens:row.inputTokens,ttFirstContentMs:row.ttFirstContentMs,elapsedMs:row.elapsedMs,structureValid:row.structureValid}));
  }
  result.coldFirstResultMs=result.casos[0]?.fromServerStartMs??null;
}catch(e){result.error=String(e.stack??e);process.exitCode=1;}
finally{
  clearTimeout(watchdog);
  for(const p of [child,observer])try{await encerrarProcesso(p);}catch(error){
    (result.cleanupErrors??=[]).push(String(error.message));process.exitCode=1;
  }
  await save('server.log',Buffer.concat(logs).toString('utf8'));
  await save('memory-raw.ndjson',observerRaw);await save('memory-observer.stderr.txt',observerErr);
  for(const line of observerRaw.trim().split(/\r?\n/)){if(!line)continue;try{memory.push(JSON.parse(line));}catch{}}
  result.memory={samples:memory.length,samplingMs:500,serverPeakWorkingSetSoBytes:memory.length?Math.max(...memory.map(m=>m.peakWorkingSetSoBytes)):null,
    serverWorkingSetSampleMaxBytes:memory.length?Math.max(...memory.map(m=>m.workingSetBytes)):null,serverPrivateSampleMaxBytes:memory.length?Math.max(...memory.map(m=>m.privateBytes)):null,
    observerWorkingSetMaxBytes:memory.length?Math.max(...memory.map(m=>m.observerWorkingSetBytes)):null,driverPeakRssBytes:process.resourceUsage().maxRSS*1024,
    limits:'Server native process peak observed before termination; 500ms observer can miss final peak. Excludes OS, Electron and other apps. Driver and observer peaks are separate, not simultaneous totals.'};
  result.finishedAt=new Date().toISOString();result.host.freeMemAfterBytes=freemem();await save('result.json',result);
  console.log(JSON.stringify({attempt:tentativa,error:result.error??null,memory:result.memory,result:join(dir,'result.json')}));
}

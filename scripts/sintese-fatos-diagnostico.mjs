// Single-use research diagnostic. No app integration, downloads or private input.
import {spawn} from 'node:child_process';
import {mkdir,writeFile,readFile,open} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {cpus,totalmem,platform,release,freemem} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {PIN} from './sintese-dev-download.mjs';
import {sha256Arquivo} from './lib/sintese-local-runtime.mjs';
import {ambienteMinimo,argumentosServidor,portaLivre,processo,conferirArtefatos} from './lib/sintese-dev-runtime.mjs';
import {LIMITES,casos,trabalhos,protocolo,validarEstrutura,interpretarSSE} from './lib/sintese-fatos-diagnostico.mjs';

const app=resolve(dirname(import.meta.filename),'..');
const root=join(app,'work/beta06-sintese-fatos'),assets=join(app,'work/beta06-sintese-dev');
const codeFiles=['scripts/sintese-fatos-diagnostico.mjs','scripts/lib/sintese-fatos-diagnostico.mjs','test/sintese-fatos-diagnostico.test.js','scripts/sintese-dev-download.mjs','scripts/lib/sintese-dev-runtime.mjs','scripts/lib/sintese-dev-composicao.mjs','scripts/lib/sintese-dev-casos.mjs','scripts/lib/sintese-local-runtime.mjs','scripts/lib/sintese-prompt.mjs','scripts/lib/sintese-termino.mjs','src/sintese-contexto/contrato.js'];
const report='docs/beta-06/SINTESE-FATOS-DIAGNOSTICO-2026-09-26.md';
const evidenceFiles=['model-download.json','runtime-download.json','model-LICENSE.txt','runtime-LICENSE.txt','model-README.md','runtime-server-README.md','attempt-2/dev-01-acordo-result.json','attempt-2/dev-04-cancelamento-parcial-result.json'];
const json=v=>JSON.stringify(v,null,2)+'\n';
const digest=v=>createHash('sha256').update(v).digest('hex');
const save=(dir,name,value)=>writeFile(join(dir,name),typeof value==='string'||Buffer.isBuffer(value)?value:json(value),{flag:'wx'});
const argv=process.argv.slice(2);
const preparing=argv.length===1&&argv[0]==='prepare';
const running=argv.length===3&&argv[0]==='run'&&argv[1]==='--cpu-exclusiva-confirmada'&&/^msg_[a-z0-9]+$/.test(argv[2]);
if(!preparing&&!running)throw Error('USE: node scripts/sintese-fatos-diagnostico.mjs prepare | run --cpu-exclusiva-confirmada msg_ID_DA_LIBERACAO');
if(preparing){
  await mkdir(root,{recursive:true});
  const dir=join(root,'prepared');await mkdir(dir);
  const manifest={preparedAt:new Date().toISOString(),pin:PIN,code:{},files:{},priorEvidence:{}};
  const snapshots={};
  for(const file of codeFiles){const data=await readFile(join(app,file));manifest.code[file]=digest(data);snapshots[file]=data.toString('utf8');}
  for(const [file,value] of Object.entries({'protocol.json':protocolo(),'cases.json':casos(),'requests.json':trabalhos(),'code-snapshot.json':snapshots})){await save(dir,file,value);manifest.files[file]=await sha256Arquivo(join(dir,file));}
  await save(dir,'protocol-before-inference.md',await readFile(join(app,report)));manifest.files['protocol-before-inference.md']=await sha256Arquivo(join(dir,'protocol-before-inference.md'));
  for(const file of evidenceFiles){const data=await readFile(join(assets,file));const copied='origin-'+file.replaceAll('/','--');await save(dir,copied,data);manifest.priorEvidence[file]={sha256:digest(data),copy:copied};}
  await save(dir,'manifest.json',manifest);
  console.log(json({preparedAt:manifest.preparedAt,protocolSha256:manifest.files['protocol.json'],inferences:0,next:'Aguardar mensagem explícita do coordenador liberando CPU.'}));
}else{
  const prepared=join(root,'prepared'),manifest=JSON.parse(await readFile(join(prepared,'manifest.json'),'utf8'));
  // All checks before launch are read-only. Mutated preparation cannot launch.
  if(json(manifest.pin)!==json(PIN))throw Error('FATOS_PIN_MUDOU');
  for(const file of codeFiles)if(await sha256Arquivo(join(app,file))!==manifest.code[file])throw Error('FATOS_CODIGO_MUDOU: '+file);
  for(const [file,hash] of Object.entries(manifest.files))if(await sha256Arquivo(join(prepared,file))!==hash)throw Error('FATOS_PREPARACAO_MUDOU: '+file);
  for(const [file,info] of Object.entries(manifest.priorEvidence))if(await sha256Arquivo(join(assets,file))!==info.sha256||await sha256Arquivo(join(prepared,info.copy))!==info.sha256)throw Error('FATOS_ORIGEM_MUDOU: '+file);
  if(await readFile(join(prepared,'protocol.json'),'utf8')!==json(protocolo())||await readFile(join(prepared,'requests.json'),'utf8')!==json(trabalhos()))throw Error('FATOS_PROTOCOLO_MUDOU');
  const dir=join(root,'run');await mkdir(dir); // EEXIST: no retry, even after failure.
  const result={schema:'lume-sintese-fatos-diagnostico-v1',startedAt:new Date().toISOString(),authorizationMessage:argv[2],manifestSha256:await sha256Arquivo(join(prepared,'manifest.json')),protocolSha256:manifest.files['protocol.json'],pin:PIN,
    host:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemBytes:totalmem(),freeMemBeforeBytes:freemem(),platform:platform(),release:release(),node:process.version},limites:LIMITES,casos:[],semanticApproval:false};
  let child,observer,watchdog,fatal,loadStart,closedPromise;
  let observerRaw='',observerErr='',logBytes=0;const logs=[];
  async function stop(p){
    if(!p||p.exitCode!==null||p.signalCode!==null)return;
    const closed=new Promise(ok=>p.once('close',ok));p.kill();
    const confirmed=await Promise.race([closed.then(()=>true),delay(5000).then(()=>false)]);
    if(!confirmed)throw Error('FATOS_ENCERRAMENTO_NAO_CONFIRMADO: '+p.pid);
  }
  try{
    await save(dir,'preflight.json',result);
    await mkdir(join(root,'temp'),{recursive:true});
    result.artifacts=await conferirArtefatos(assets,PIN);
    const exe=join(assets,'runtime/llama-server.exe'),env=ambienteMinimo(root);
    result.version=await processo(exe,['--version'],{env,cwd:root});
    if(result.version.code!==0)throw Error('FATOS_VERSAO_FALHOU');
    const port=await portaLivre(),nonce=randomBytes(32).toString('hex'),args=argumentosServidor(join(assets,PIN.model.filename),port,nonce);
    result.argv=args.map(v=>v===nonce?'[ephemeral loopback authentication]':v);
    await save(dir,'launch.json',{argv:result.argv,version:result.version,artifacts:result.artifacts});
    loadStart=performance.now();
    child=spawn(exe,args,{windowsHide:true,shell:false,cwd:root,env,stdio:['ignore','pipe','pipe']});
    closedPromise=new Promise(ok=>{child.once('error',e=>{fatal=e;});child.once('close',(code,signal)=>{result.serverExit={code,signal,at:new Date().toISOString()};ok();});});
    for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logBytes+=b.length;if(logBytes<=8*1024**2)logs.push(b);else{fatal=Error('FATOS_LOG_LIMIT');child.kill();}});
    if(!child.pid)throw Error('FATOS_SPAWN_FAILED');result.serverPid=child.pid;
    const memoryCommand=`$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${child.pid}); $self=[Diagnostics.Process]::GetCurrentProcess(); while(!$p.HasExited) { $p.Refresh(); $self.Refresh(); [Console]::WriteLine(('{"utc":"'+[DateTime]::UtcNow.ToString('o')+'","workingSetBytes":'+$p.WorkingSet64+',"peakWorkingSetSoBytes":'+$p.PeakWorkingSet64+',"privateBytes":'+$p.PrivateMemorySize64+',"cpuMs":'+$p.TotalProcessorTime.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)+',"observerWorkingSetBytes":'+$self.WorkingSet64+'}')); Start-Sleep -Milliseconds 500 }`;
    observer=spawn(join(env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',memoryCommand],{windowsHide:true,shell:false,env,stdio:['ignore','pipe','pipe']});
    observer.stdout.on('data',b=>{observerRaw+=b;});observer.stderr.on('data',b=>{observerErr+=b;});observer.on('error',e=>{observerErr+=String(e);});
    watchdog=setTimeout(()=>{fatal=Error('FATOS_WALL_TIMEOUT');child.kill();},LIMITES.servidorMs);
    const base=`http://127.0.0.1:${port}`,headers={'Authorization':`Bearer ${nonce}`,'Content-Type':'application/json'};
    const localFetch=(path,options={})=>fetch(base+path,{...options,headers,redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??LIMITES.chamadaMs)});
    while(true){
      if(fatal||result.serverExit)throw fatal??Error('FATOS_SERVER_EXITED');
      if(performance.now()-loadStart>LIMITES.chamadaMs)throw Error('FATOS_LOAD_TIMEOUT');
      try{const r=await localFetch('/health',{timeoutMs:1000});if(r.ok)break;}catch{}
      await delay(200);
    }
    result.serverLoadMs=performance.now()-loadStart;
    async function post(path,body){const r=await localFetch(path,{method:'POST',body:JSON.stringify(body)});if(!r.ok)throw Error('FATOS_HTTP_'+r.status);return r.json();}
    const jobs=JSON.parse(await readFile(join(prepared,'requests.json'),'utf8'));
    if(jobs.length!==LIMITES.chamadas)throw Error('FATOS_CONTAGEM_INVALIDA');
    for(const job of jobs){
      if(fatal||result.serverExit)throw fatal??Error('FATOS_SERVER_EXITED');
      const request=job.request;
      const template=await post('/apply-template',{messages:request.messages,add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false}});
      const tokenization=await post('/tokenize',{content:template.prompt,add_special:false});
      await save(dir,job.id+'-template.json',template);await save(dir,job.id+'-tokens.json',tokenization);
      if(tokenization.tokens.length>LIMITES.entradaTokens)throw Error('FATOS_TOKEN_LIMIT');
      const row={id:job.id,caso:job.caso,formato:job.formato,inputTokens:tokenization.tokens.length,startUtc:new Date().toISOString()};
      // A durable consumed slot precedes the sole generative POST. No restart path.
      await save(dir,job.id+'-consumed.json',{...row,requestSha256:digest(json(request))});result.casos.push(row);
      const handle=await open(join(dir,job.id+'-raw.sse'),'wx'),started=performance.now();let raw='',firstContentMs=null;
      try{
        const response=await localFetch('/v1/chat/completions',{method:'POST',body:JSON.stringify(request)});
        if(!response.ok){raw=await response.text();await handle.write(raw);throw Error('FATOS_HTTP_'+response.status);}
        const decoder=new TextDecoder();
        for await(const b of response.body){
          await handle.write(b);raw+=decoder.decode(b,{stream:true});if(Buffer.byteLength(raw)>LIMITES.streamBytes)throw Error('FATOS_STREAM_LIMIT');
          if(firstContentMs===null)for(const line of raw.split('\n')){
            if(!line.startsWith('data:')||line.includes('[DONE]'))continue;
            try{const e=JSON.parse(line.slice(5));if(e.choices?.[0]?.delta?.content){firstContentMs=performance.now()-started;break;}}catch{}
          }
        }
        raw+=decoder.decode();row.elapsedMs=performance.now()-started;row.ttFirstContentMs=firstContentMs;row.fromServerStartMs=performance.now()-loadStart;
        const decoded=interpretarSSE(raw);row.raw=decoded.raw;row.finishReason='stop';
        row.usage=decoded.eventos.findLast(e=>e.usage)?.usage??null;row.timings=decoded.eventos.findLast(e=>e.timings)?.timings??null;
        await save(dir,job.id+'-text.txt',row.raw);
        try{row.structure=validarEstrutura(row.raw,casos().find(c=>c.id===job.caso).fontes,job.formato);row.structureValid=true;}catch(e){row.structureValid=false;row.validationError=String(e.message);}
      }catch(e){row.error=String(e.message);row.elapsedMs=performance.now()-started;row.ttFirstContentMs=firstContentMs;throw e;}
      finally{await handle.close();await save(dir,job.id+'-result.json',row);}
      console.log(JSON.stringify({id:row.id,inputTokens:row.inputTokens,outputTokens:row.usage?.completion_tokens,elapsedMs:row.elapsedMs,structureValid:row.structureValid}));
    }
  }catch(e){result.error=String(e.stack??e);process.exitCode=1;}
  finally{
    clearTimeout(watchdog);
    for(const p of [child,observer])try{await stop(p);}catch(e){result.cleanupError=String(e.message);process.exitCode=1;}
    if(child&&!result.cleanupError)await closedPromise;
    await save(dir,'server.log',Buffer.concat(logs));await save(dir,'memory-raw.ndjson',observerRaw);await save(dir,'memory-observer.stderr.txt',observerErr);
    const memory=[];for(const line of observerRaw.trim().split(/\r?\n/)){if(line)try{memory.push(JSON.parse(line));}catch{}}
    const max=key=>memory.length?Math.max(...memory.map(m=>m[key])):null;
    result.memory={samples:memory.length,samplingMs:500,serverPeakWorkingSetSoBytes:max('peakWorkingSetSoBytes'),serverWorkingSetSampleMaxBytes:max('workingSetBytes'),serverPrivateSampleMaxBytes:max('privateBytes'),serverCpuMsObserved:max('cpuMs'),observerWorkingSetMaxBytes:max('observerWorkingSetBytes'),driverPeakRssBytes:process.resourceUsage().maxRSS*1024,
      limits:'Native server peak observed every 500ms; final peak may be missed. Separate peaks are not simultaneous totals. Excludes Electron, OS and other apps; host is not minimum hardware.'};
    result.finishedAt=new Date().toISOString();result.host.freeMemAfterBytes=freemem();await save(dir,'result.json',result);
    console.log(JSON.stringify({completedCalls:result.casos.length,error:result.error??null,serverExit:result.serverExit,memory:result.memory,result:join(dir,'result.json')}));
  }
}

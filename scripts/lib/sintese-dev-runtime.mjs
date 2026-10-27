import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sha256Arquivo} from './sintese-local-runtime.mjs';
import {LIMITES,esquema,mensagens,aceitarTermino} from './sintese-dev-composicao.mjs';

export function ambienteMinimo(root){
  const sys=process.env.SystemRoot||'C:\\Windows';
  return {SystemRoot:sys,WINDIR:sys,PATH:join(sys,'System32'),TEMP:join(root,'temp'),TMP:join(root,'temp')};
}
export function argumentosServidor(model,port,token){
  if(!Number.isInteger(port)||port<1024||port>65535||!/^[0-9a-f]{64}$/.test(token))throw Error('DEV_SERVIDOR_CONFIG_INVALIDA');
  return ['--model',model,'--host','127.0.0.1','--port',String(port),'--api-key',token,
    '--offline','--no-webui','--device','none','--gpu-layers','0','--ctx-size','2048',
    '--threads','4','--threads-batch','4','--batch-size','256','--ubatch-size','128','--parallel','1',
    '--cache-ram','0','--no-context-shift','--no-warmup','--jinja','--reasoning','off',
    '--chat-template-kwargs','{"enable_thinking":false}','--n-predict',String(LIMITES.saidaTokens)];
}
export function requisicao(fontes,tentativa){
  return {messages:mensagens(fontes,tentativa),response_format:{type:'json_object',schema:esquema(fontes)},
    max_tokens:LIMITES.saidaTokens,temperature:tentativa===1?0.7:0.2,top_p:0.8,top_k:20,min_p:0,presence_penalty:tentativa===1?1.5:0,seed:260926,
    stream:true,stream_options:{include_usage:true},cache_prompt:false,chat_template_kwargs:{enable_thinking:false},reasoning_effort:'none'};
}
export function interpretarSSE(texto){
  const eventos=[];let done=false,stopped=false;
  for(const frame of texto.replaceAll('\r\n','\n').split('\n\n')){
    const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data)continue;
    if(done)throw Error('DEV_SSE_APOS_FIM');
    if(data==='[DONE]'){done=true;continue;}
    const e=JSON.parse(data);if(e?.error)throw Error('DEV_SERVIDOR_ERRO');
    if(!Array.isArray(e?.choices)||e.choices.length>1)throw Error('DEV_SSE_CHOICES');
    const choice=e.choices[0];
    if(choice){
      if(choice.index!==0||stopped)throw Error('DEV_SSE_ORDEM');
      const delta=choice.delta??{};
      if(delta.reasoning||delta.function_call)throw Error('DEV_CONTEUDO_NAO_PERMITIDO');
      if(delta.content!=null&&typeof delta.content!=='string')throw Error('DEV_SSE_TEXTO');
      if(choice.finish_reason){if(choice.finish_reason!=='stop')throw Error('DEV_GERACAO_INCOMPLETA');stopped=true;}
    }
    eventos.push(e);
  }
  if(!done)throw Error('DEV_SSE_INCOMPLETO');
  aceitarTermino(eventos);
  return {eventos,raw:eventos.map(e=>e.choices?.[0]?.delta?.content??'').join('')};
}
export async function encerrarProcesso(p,{esperaMs=5000}={}){
  if(!p||p.exitCode!==null||p.signalCode!==null)return;
  await new Promise((ok,no)=>{
    const limpar=()=>{clearTimeout(timer);p.removeListener('close',fechou);};
    const fechou=()=>{limpar();ok();};
    const timer=setTimeout(()=>{limpar();no(Error('DEV_ENCERRAMENTO_NAO_CONFIRMADO'));},esperaMs);
    p.once('close',fechou);
    try{p.kill();}catch(error){limpar();no(error);}
  });
}
export async function portaLivre(){
  const s=createServer();await new Promise((ok,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',ok);});
  const port=s.address().port;await new Promise(ok=>s.close(ok));return port;
}
export async function processo(command,args,options={}){
  const p=spawn(command,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],...options});
  let stdout='',stderr='';
  p.stdout.on('data',b=>{stdout+=b;if(stdout.length>2000000)p.kill();});
  p.stderr.on('data',b=>{stderr+=b;if(stderr.length>2000000)p.kill();});
  const timer=setTimeout(()=>p.kill(),60000);
  try{return await new Promise((ok,no)=>{p.once('error',no);p.once('close',(code,signal)=>ok({code,signal,stdout,stderr}));});}
  finally{clearTimeout(timer);}
}
export async function conferirArtefatos(root,pin){
  if(process.platform!=='win32')throw Error('DEV_NATIVE_WINDOWS_ONLY');
  root=await realpath(root);
  for(const p of [pin.model,pin.runtime]){
    const file=join(root,p.filename),info=await lstat(file);
    if(info.isSymbolicLink()||!info.isFile()||info.size!==p.bytes||await sha256Arquivo(file)!==p.sha256)throw Error('DEV_HASH_DIVERGENTE');
  }
  // Compare extracted files to entries from the hash-pinned official archive.
  // No execute-policy change, unblock command, alternate binary or install.
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const command=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead(${quote(join(root,pin.runtime.filename))}); try { $rows=@(); foreach($e in $z.Entries) { if($e.Name -eq '') { continue }; $s=$e.Open(); try { $h=[Security.Cryptography.SHA256]::Create(); $digest=([BitConverter]::ToString($h.ComputeHash($s))).Replace('-','').ToLower(); $rows+=@{path=$e.FullName;bytes=$e.Length;sha256=$digest} } finally {$s.Dispose()} }; ConvertTo-Json -InputObject $rows -Compress } finally {$z.Dispose()}`;
  const verification=await processo(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{env:ambienteMinimo(root)});
  if(verification.code!==0)throw Error('DEV_ARCHIVE_VERIFICATION_FAILED: '+verification.stderr);
  const entries=JSON.parse(verification.stdout),seen=new Set(),runtime=join(root,'runtime');
  for(const e of entries){
    if(!/^[A-Za-z0-9_./-]+$/.test(e.path)||e.path.split('/').some(s=>s==='..'||s==='.')||seen.has(e.path))throw Error('DEV_ARCHIVE_PATH_INVALID');
    seen.add(e.path);const file=join(runtime,e.path),info=await lstat(file);
    if(info.isSymbolicLink()||!info.isFile()||info.size!==e.bytes||await realpath(file)!==resolve(file)||await sha256Arquivo(file)!==e.sha256)throw Error('DEV_RUNTIME_DIVERGENTE');
  }
  async function walk(dir,prefix=''){
    for(const e of await readdir(dir,{withFileTypes:true})){
      if(e.isSymbolicLink())throw Error('DEV_RUNTIME_SYMLINK');
      const name=prefix+e.name;
      if(e.isDirectory())await walk(join(dir,e.name),name+'/');
      else if(!e.isFile()||!seen.has(name))throw Error('DEV_RUNTIME_EXTRA');
    }
  }
  await walk(runtime);
  return {entries,manifestSha256:createHash('sha256').update(JSON.stringify(entries)).digest('hex')};
}

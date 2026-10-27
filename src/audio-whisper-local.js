import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,dirname,resolve} from 'node:path';
import {createReadStream} from 'node:fs';
import {validarAudioWav} from './audio-desktop-contrato.js';
import {analisarSinalAudioLocal} from './audio-local-sinal.js';

const MAX_JSON_BYTES=1024*1024;
const MAX_TEXT=100000;

export function conferirSaidaWhisper(dados,{duracaoMs}={}){
  if(!dados||!Array.isArray(dados.transcription)||dados.transcription.length>1000||!Number.isFinite(duracaoMs)||duracaoMs<=0)throw new Error('Saída de transcrição local inválida.');
  const idioma=dados.result?.language;
  if(idioma!=='pt')throw new Error('O motor local não confirmou português. Confira o áudio antes de usar o texto.');
  let ultimo=0,comprimento=0;
  const trechos=dados.transcription.map(parte=>{
    const inicioMs=parte?.offsets?.from,fimMs=parte?.offsets?.to,texto=parte?.text;
    if(!Number.isSafeInteger(inicioMs)||!Number.isSafeInteger(fimMs)||inicioMs<ultimo||fimMs<inicioMs||fimMs>duracaoMs+1000||typeof texto!=='string'||!texto.trim())throw new Error('Trechos da transcrição local inválidos.');
    comprimento+=texto.length;
    if(comprimento>MAX_TEXT)throw new Error('Transcrição local longa demais.');
    ultimo=fimMs;
    return {inicioMs,fimMs,texto:texto.trim()};
  });
  return {transcricao:trechos.map(t=>t.texto).join(' '),trechos,idioma,semFala:trechos.length===0};
}

async function arquivoLocal(path){
  if(typeof path!=='string'||!isAbsolute(path))throw new Error('Selecione um arquivo local absoluto para o motor de áudio.');
  const real=await realpath(path),meta=await stat(real);
  if(!meta.isFile())throw new Error('Arquivo do motor de áudio inválido.');
  return real;
}

function executar(command,args,{signal,timeoutMs,cwd}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(new Error('Transcrição local cancelada.'));
    const child=spawn(command,args,{shell:false,windowsHide:true,cwd,stdio:'ignore',env:{SystemRoot:process.env.SystemRoot,TMP:cwd,TEMP:cwd,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'2'}});
    let done=false,interrupcao=null,forceTimer=null;
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',cancel);error?reject(error):resolve();};
    const stop=()=>{child.kill();forceTimer??=setTimeout(()=>{if(!done)child.kill('SIGKILL');},1000);};
    const cancel=()=>{interrupcao=new Error('Transcrição local cancelada.');stop();};
    const timer=setTimeout(()=>{interrupcao=new Error('Motor local excedeu o tempo limite.');stop();},timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});
    child.once('error',()=>finish(new Error('Não foi possível iniciar o motor local.')));
    child.once('close',code=>finish(interrupcao||(code===0?null:new Error('Motor local falhou; nenhum texto foi aplicado.'))));
    if(signal?.aborted)cancel();
  });
}

function conferirCancelamento(signal){
  if(signal?.aborted)throw new Error('Transcrição local cancelada.');
}

async function hashArquivo(path,signal){
  const hash=createHash('sha256');
  for await(const trecho of createReadStream(path)){
    conferirCancelamento(signal);hash.update(trecho);
  }
  conferirCancelamento(signal);
  return hash.digest('hex');
}

// Adaptador sem banco/rede. O runtime confere o pacote confiável e DesktopAudio
// exige escolha explícita; executar não significa qualidade ou instalação aprovada.
export async function transcreverWhisperLocal(bytes,{executavel,modelo,signal,timeoutMs=360000,threads=2,runner=executar,cliPrefixArgs=[]}={}){
  const meta=validarAudioWav(bytes);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000||!Number.isSafeInteger(threads)||threads<1||threads>4||!Array.isArray(cliPrefixArgs)||cliPrefixArgs.some(arg=>typeof arg!=='string'))throw new Error('Configuração do motor local inválida.');
  conferirCancelamento(signal);
  // O chamador pode reutilizar seu Buffer enquanto aguardamos disco/processo.
  // Análise, arquivo entregue ao motor e hash devem refletir os mesmos bytes.
  bytes=Buffer.from(bytes);
  const analiseSinal=analisarSinalAudioLocal(bytes);
  const [binary,weights]=await Promise.all([arquivoLocal(executavel),arquivoLocal(modelo)]);
  conferirCancelamento(signal);
  const inicio=performance.now();
  let pasta;
  try{
    let resultado;
    if(analiseSinal.silencioDigital){
      // idioma/motor identificam configuração, não detecção de idioma nem ASR
      // executado. O motivo explícito acompanha a prova, sem saída inventada.
      resultado={transcricao:'',trechos:[],idioma:'pt',semFala:true};
    }else{
      pasta=await mkdtemp(join(tmpdir(),'lume-whisper-'));
      const entrada=join(pasta,'audio.wav'),base=join(pasta,'resultado');
      await writeFile(entrada,bytes,{flag:'wx',mode:0o600});
      conferirCancelamento(signal);
      await runner(binary,[...cliPrefixArgs,'-m',weights,'-f',entrada,'-of',base,'-oj','-l','pt','-np','-ng','-t',String(threads),'-p','1'],{signal,timeoutMs,cwd:pasta});
      conferirCancelamento(signal);
      const arquivo=base+'.json',tamanho=await stat(arquivo);
      if(!tamanho.isFile()||tamanho.size<2||tamanho.size>MAX_JSON_BYTES)throw new Error('Saída de transcrição local inválida.');
      resultado=conferirSaidaWhisper(JSON.parse(await readFile(arquivo,'utf8')),{duracaoMs:meta.segundos*1000});
    }
    const modeloSha256=await hashArquivo(weights,signal);
    conferirCancelamento(signal);
    return {...resultado,motor:'whisper.cpp',modeloSha256,audioSha256:createHash('sha256').update(bytes).digest('hex'),
      duracaoMs:Math.round(performance.now()-inicio),origem:'local',qualidade:'nao_validada',
      inferenciaExecutada:!analiseSinal.silencioDigital,analiseSinal,
      ...(resultado.semFala?{motivoSemFala:analiseSinal.silencioDigital?'silencio_digital_pcm_zero':'motor_sem_trechos'}:{})};
  }catch(error){
    if(error instanceof SyntaxError||error?.code==='ENOENT')throw new Error('Motor local não produziu uma transcrição válida.');
    throw error;
  }finally{if(pasta){if(dirname(resolve(pasta))!==resolve(tmpdir()))throw new Error('Diretório temporário de áudio inválido.');await rm(pasta,{recursive:true,force:true,maxRetries:3,retryDelay:100});}}
}

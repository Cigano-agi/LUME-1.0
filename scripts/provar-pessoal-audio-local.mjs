// Development proof only: synthetic SAPI speech -> existing native ASR runtime.
// No downloads, network, personal recording, mocked runner or installed-app edits.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';
import {canonicalWav,wordErrorRate} from './audio-local-smoke-real.mjs';
import {validarAudioWav} from '../src/audio-desktop-contrato.js';

const root=resolve(import.meta.dirname,'..'),work=join(root,'work','pessoal-20261026');
const esperado='Marina confirmou a reunião para terça-feira às dez horas. O relatório precisa de revisão.';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const report={inicio:new Date().toISOString(),status:'iniciada',dados:'Fala fictícia sintetizada localmente; nenhum áudio pessoal.',esperado,
  rede:false,mock:false,qualidadeRealAprovada:false,qualidade100CasosAprovada:false};
await mkdir(work,{recursive:true});
const raw=join(work,'audio-real.sapi.wav'),wav=join(work,'audio-real.wav');

function gerarFala(){
  const ps=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; `+
    `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; `+
    `try { $s.SelectVoice('Microsoft Maria Desktop'); `+
    `$fmt=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); `+
    `$s.SetOutputToWaveFile($env:LUME_PROVA_AUDIO_PATH,$fmt); `+
    `$s.Speak([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LUME_PROVA_AUDIO_TEXT))); } finally { $s.Dispose() }`;
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,
      env:{...process.env,LUME_PROVA_AUDIO_PATH:raw,LUME_PROVA_AUDIO_TEXT:Buffer.from(esperado).toString('base64')},stdio:['ignore','pipe','pipe']});
    let err='';child.stderr.on('data',b=>{err+=b.toString();});child.once('error',reject);
    child.once('close',code=>code===0?resolve():reject(new Error(`Síntese SAPI falhou (${code}): ${err.slice(0,1500)}`)));
  });
}

try{
  if(process.platform!=='win32')throw Error('Esta prova requer Windows e System.Speech local.');
  const policy=JSON.parse(await readFile(join(root,'desktop','audio-local-policy.json'),'utf8'));
  const esperadoManifesto=policy.pacotes[process.platform+'-'+process.arch]?.manifestoSha256;
  if(!esperadoManifesto)throw Error('Plataforma sem pacote fixado pela política.');
  const candidatos=[join(root,'native','audio-local','bin')];
  if(process.env.LOCALAPPDATA)candidatos.push(join(process.env.LOCALAPPDATA,'Programs','Lume','resources','audio-local'));
  let raiz;
  for(const p of candidatos){try{await access(join(p,'manifest.json'));raiz=p;break;}catch{}}
  if(!raiz)throw Error('Pacote local ausente; esta prova não baixa nem instala componentes.');
  const manifesto=await readFile(join(raiz,'manifest.json'));
  if(hash(manifesto)!==esperadoManifesto)throw Error('Manifesto local diverge da política fixada; execução recusada.');
  report.pacote={raiz,manifestoSha256:esperadoManifesto};
  const runtime=criarAudioLocalRuntime({raiz,manifestoSha256:esperadoManifesto});
  report.antes=await runtime.estado();if(!report.antes.disponivel)throw Error(report.antes.motivo);
  await gerarFala();const sapi=await readFile(raw),pcm=canonicalWav(sapi);await writeFile(wav,pcm);
  report.audio={voz:'Microsoft Maria Desktop',origem:'System.Speech.Synthesis',formato:'WAV PCM16 mono 16000 Hz',
    canonicalizacao:'Somente normalização do contêiner RIFF pelo helper existente; PCM preservado.',arquivo:wav,sha256:hash(pcm),bytes:pcm.length,validacao:validarAudioWav(pcm)};
  const inicio=performance.now();report.resultado=await runtime.transcrever(pcm);report.tempoMs=Math.round(performance.now()-inicio);
  const normalizar=s=>s.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
  const recebido=normalizar(report.resultado.transcricao);
  report.conteudo={termosEsperados:['marina','reuniao','dez','relatorio','revisao'],presentes:[],wer:wordErrorRate(esperado,report.resultado.transcricao)};
  report.conteudo.presentes=report.conteudo.termosEsperados.filter(t=>recebido.includes(t));
  report.conteudo.equivalenciasNumericas=!report.conteudo.presentes.includes('dez')&&/\b10 horas\b/u.test(recebido)?[{esperado:'dez horas',obtido:'10 horas',valor:10}]:[];
  report.conteudo.conferido=report.conteudo.presentes.length+report.conteudo.equivalenciasNumericas.length===report.conteudo.termosEsperados.length;
  report.depois=await runtime.estado();
  if(!report.depois.disponivel)throw Error('Pacote deixou de passar integridade após ASR.');
  report.status=report.conteudo.conferido?'asr_real_conteudo_ficticio_conferido':'asr_real_conteudo_parcial';
}catch(error){
  report.status='falha';report.erro={nome:error.name,codigo:error.code??null,mensagem:error.message};process.exitCode=1;
}finally{
  report.fim=new Date().toISOString();
  await writeFile(join(work,'audio-real.json'),JSON.stringify(report,null,2)+'\n','utf8');
  const linhas=['# Prova ASR local — fala fictícia','',`Estado: ${report.status}.`,
    '',`Esperado: ${esperado}`,`Transcrito: ${report.resultado?.transcricao??'Não obtido.'}`,
    '',`Voz: Microsoft Maria Desktop. Motor: ${report.antes?.versaoMotor??'Não verificado'}.`,
    `Tempo ASR: ${report.tempoMs??'Não executado'} ms. Integridade após execução: ${report.depois?.disponivel===true}.`,
    `Conteúdo conferido: ${report.conteudo?.conferido===true}. WER nesta amostra: ${report.conteudo?.wer?.rate??'Não calculado'}.`,
    `Equivalência numérica observada: ${report.conteudo?.equivalenciasNumericas?.length?'dez horas foi transcrito como 10 horas; WER lexical mantém essa diferença.':'Nenhuma aplicada.'}`,
    '',`Pacote: ${report.pacote?.raiz??'Não localizado'}.`,`Manifesto SHA-256: ${report.pacote?.manifestoSha256??'Não verificado'}.`,
    '',report.erro?`Falha: ${report.erro.codigo??report.erro.nome}: ${report.erro.mensagem}`:'Processo nativo invocado pelo runtime existente, sem runner mockado.',
    '', 'Não houve rede, download, gravação pessoal, transcrição de conversa real ou alteração do aplicativo instalado. A fala foi sintetizada em PCM16 mono 16 kHz; a normalização RIFF preservou o PCM.',
    'Esta amostra prova execução nativa e transcrição de conteúdo fictício. Não aprova qualidade em vozes reais, ruído, cem casos de avaliação ou autonomia do produto.',
    '', 'Reprodução: `node scripts/provar-pessoal-audio-local.mjs`. Detalhes e hashes em `audio-real.json`.'];
  await writeFile(join(work,'audio-real.md'),linhas.join('\n')+'\n','utf8');
  console.log(JSON.stringify({status:report.status,transcricao:report.resultado?.transcricao,tempoMs:report.tempoMs,erro:report.erro,relatorio:join(work,'audio-real.md')}));
}

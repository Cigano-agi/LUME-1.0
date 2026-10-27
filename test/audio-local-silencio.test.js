import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {analisarSinalAudioLocal} from '../src/audio-local-sinal.js';
import {transcreverWhisperLocal} from '../src/audio-whisper-local.js';
import {wav} from './fixtures/audio-wav.js';
import {canonicalWav,runSmoke,WORK,SOURCES,wordErrorRate,REFERENCE} from '../scripts/audio-local-smoke-real.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const ativo=()=>{const bytes=wav();bytes.writeInt16LE(1,44);return bytes;};
const ausente=async path=>{await assert.rejects(stat(path),{code:'ENOENT'});};
const saida=texto=>({result:{language:'pt'},transcription:texto===null?[]:[{offsets:{from:0,to:500},text:texto}]});
async function ambiente(t,script=''){
  const dir=await mkdtemp(join(tmpdir(),'lume-silencio-test-'));
  t.after(async()=>{
    assert.equal(dirname(resolve(dir)),resolve(tmpdir()));
    await rm(dir,{recursive:true,force:true});
  });
  const modelo=join(dir,'modelo.bin'),cli=join(dir,'cli.mjs');
  await writeFile(modelo,'modelo-sintetico');await writeFile(cli,script);
  return {executavel:process.execPath,modelo,cliPrefixArgs:[cli]};
}
function runnerJSON(texto,observe=()=>{}){
  return async(command,args,options)=>{
    await observe(command,args,options);
    await writeFile(args[args.indexOf('-of')+1]+'.json',JSON.stringify(saida(texto)));
  };
}

test('PCM zero exato: cabeçalho não entra na análise e toda duração válida é examinada',()=>{
  for(const segundos of [1/16000,0.001,3,300]){
    const bytes=wav(segundos),result=analisarSinalAudioLocal(bytes);
    assert.equal(result.silencioDigital,true);
    assert.equal(result.metodo,'pcm_s16le_zero_exato_v1');
    assert.equal(result.totalAmostras,(bytes.length-44)/2);
    assert.equal(result.duracaoAudioMs,segundos*1000);
    for(const offset of [44,bytes.length-2]){
      bytes.writeInt16LE(1,offset);
      assert.equal(analisarSinalAudioLocal(bytes).silencioDigital,false);
      bytes.writeInt16LE(0,offset);
    }
  }
});

test('WAVs incompatíveis ou truncados não se tornam silêncio por terem payload zero',()=>{
  const casos=[Buffer.alloc(0),wav().subarray(0,44),wav().subarray(0,45),new Uint8Array(wav()),wav(301)];
  for(const [offset,value,size] of [[4,1,4],[16,18,4],[20,3,2],[22,2,2],[24,48000,4],[28,16000,4],[32,1,2],[34,8,2],[40,2,4]]){
    const bytes=wav();size===2?bytes.writeUInt16LE(value,offset):bytes.writeUInt32LE(value,offset);casos.push(bytes);
  }
  const odd=Buffer.concat([wav(),Buffer.alloc(1)]);
  odd.writeUInt32LE(odd.length-8,4);odd.writeUInt32LE(odd.length-44,40);casos.push(odd);
  for(const offset of [0,8,12,36]){const bytes=wav();bytes[offset]|=128;casos.push(bytes);}
  for(const bytes of casos)assert.throws(()=>analisarSinalAudioLocal(bytes),/Áudio inválido/);
});

test('WAV RIFF com chunk extra requer canonicalização explícita antes da prova PCM',()=>{
  const original=wav(3),extra=Buffer.from('4a554e4b0300000001020300','hex');
  const extended=Buffer.concat([original.subarray(0,36),extra,original.subarray(36)]);
  extended.writeUInt32LE(extended.length-8,4);
  assert.throws(()=>analisarSinalAudioLocal(extended),/Áudio inválido/);
  const canonical=canonicalWav(extended);
  assert.deepEqual(canonical,original);
  assert.equal(analisarSinalAudioLocal(canonical).silencioDigital,true);
});

test('silêncio: não executa runner e mantém hashes/metadados honestos',async t=>{
  const cfg=await ambiente(t),bytes=wav(3);
  const result=await transcreverWhisperLocal(bytes,{...cfg,runner:()=>assert.fail('PCM zero executou ASR')});
  assert.equal(result.transcricao,'');assert.deepEqual(result.trechos,[]);assert.equal(result.semFala,true);
  assert.equal(result.inferenciaExecutada,false);assert.equal(result.motivoSemFala,'silencio_digital_pcm_zero');
  assert.equal(result.analiseSinal.silencioDigital,true);assert.equal(result.analiseSinal.totalAmostras,48000);
  assert.equal(result.audioSha256,hash(bytes));assert.equal(result.modeloSha256,hash('modelo-sintetico'));
  assert.equal(result.origem,'local');assert.equal(result.qualidade,'nao_validada');
  assert.equal(result.idioma,'pt');assert.equal(result.motor,'whisper.cpp');
  assert.ok(Number.isSafeInteger(result.duracaoMs)&&result.duracaoMs>=0);
});

test('silêncio mantém validação de configuração/modelo e não ignora cancelamento',async t=>{
  const cfg=await ambiente(t);
  for(const extra of [{threads:0},{timeoutMs:999},{cliPrefixArgs:[null]}]){
    await assert.rejects(transcreverWhisperLocal(wav(),{...cfg,...extra}),/Configuração/);
  }
  await assert.rejects(transcreverWhisperLocal(wav(),{...cfg,modelo:'relativo.bin'}),/absoluto/);
  await assert.rejects(transcreverWhisperLocal(wav(),{...cfg,modelo:join(dirname(cfg.modelo),'ausente.bin')}),{code:'ENOENT'});
  const abort=new AbortController();abort.abort();
  await assert.rejects(transcreverWhisperLocal(wav(),{...cfg,signal:abort.signal}),/cancelada/);
  const during=new AbortController(),pending=transcreverWhisperLocal(wav(),{...cfg,signal:during.signal});
  during.abort();await assert.rejects(pending,/cancelada/);
});

test('um único bit em qualquer byte/amostra não é descartado, sem blacklist de texto',async t=>{
  const cfg=await ambiente(t);
  for(const [offset,sample] of [[44,1],[44,-1],[16044,256],[32042,-32768]]){
    const bytes=wav();bytes.writeInt16LE(sample,offset);let calls=0,path;
    const result=await transcreverWhisperLocal(bytes,{...cfg,runner:runnerJSON('[MÚSICA DE FUNDO]',async(command,args,options)=>{
      calls++;path=options.cwd;
      assert.deepEqual(await readFile(args[args.indexOf('-f')+1]),bytes);
      assert.equal(args[args.indexOf('-t')+1],'2');assert.equal(args[args.indexOf('-p')+1],'1');assert.ok(args.includes('-ng'));
      assert.equal(options.timeoutMs,360000);
    })});
    assert.equal(calls,1);assert.equal(result.inferenciaExecutada,true);
    assert.equal(result.analiseSinal.silencioDigital,false);assert.equal(result.semFala,false);
    assert.equal(result.transcricao,'[MÚSICA DE FUNDO]');assert.equal(result.motivoSemFala,undefined);
    await ausente(path);
  }
});

test('fala/sinal muito baixo e ruído não recebem rótulo de silêncio digital',async t=>{
  const cfg=await ambiente(t);
  for(const forma of ['sinal_baixo','ruido','dc']){
    const bytes=wav();
    for(let i=44;i<bytes.length;i+=2){
      const n=(i-44)/2;
      const sample=forma==='sinal_baixo'?Math.round(2*Math.sin(2*Math.PI*220*n/16000)):
        forma==='ruido'?(n%3)-1:1;
      bytes.writeInt16LE(sample,i);
    }
    let calls=0;
    const result=await transcreverWhisperLocal(bytes,{...cfg,runner:runnerJSON('Fala preservada.',()=>{calls++;})});
    assert.equal(calls,1);assert.equal(result.semFala,false);assert.equal(result.inferenciaExecutada,true);
    assert.equal(result.analiseSinal.silencioDigital,false);
  }
});

test('ASR vazio tem motivo próprio e não é prova de silêncio PCM',async t=>{
  const cfg=await ambiente(t);
  const result=await transcreverWhisperLocal(ativo(),{...cfg,runner:runnerJSON(null)});
  assert.equal(result.transcricao,'');assert.deepEqual(result.trechos,[]);assert.equal(result.semFala,true);
  assert.equal(result.inferenciaExecutada,true);assert.equal(result.motivoSemFala,'motor_sem_trechos');
  assert.equal(result.analiseSinal.silencioDigital,false);
});

test('Buffer do chamador não muda decisão de silêncio, bytes do processo ou hash após a chamada',async t=>{
  const cfg=await ambiente(t);
  const zero=wav(),expectedZero=hash(zero),pendingZero=transcreverWhisperLocal(zero,{...cfg,runner:()=>assert.fail('buffer não foi copiado')});
  zero.writeInt16LE(1,44);
  const silence=await pendingZero;
  assert.equal(silence.audioSha256,expectedZero);assert.equal(silence.semFala,true);
  const input=ativo(),expected=Buffer.from(input);
  const pending=transcreverWhisperLocal(input,{...cfg,runner:runnerJSON('Fala.',async(_,args)=>{
    assert.deepEqual(await readFile(args[args.indexOf('-f')+1]),expected);
  })});
  input.fill(0,44);
  const result=await pending;
  assert.equal(result.audioSha256,hash(expected));assert.equal(result.semFala,false);
});

test('erro de processo, JSON ausente/inválido e cancelamento tardio não retornam sem fala e limpam arquivo',async t=>{
  const cfg=await ambiente(t);
  for(const mode of ['erro','ausente','json','cancelado']){
    let path;
    const abort=new AbortController();
    const runner=async(_,args,options)=>{
      path=options.cwd;
      if(mode==='erro')throw new Error('Falha do processo de teste.');
      if(mode==='json')await writeFile(args[args.indexOf('-of')+1]+'.json','invalid');
      if(mode==='cancelado'){
        await writeFile(args[args.indexOf('-of')+1]+'.json',JSON.stringify(saida(null)));
        abort.abort();
      }
    };
    await assert.rejects(transcreverWhisperLocal(ativo(),{...cfg,runner,signal:abort.signal}),
      mode==='erro'?/Falha do processo/:mode==='cancelado'?/cancelada/:/não produziu/);
    await ausente(path);
  }
});

test('runner real: timeout e cancelamento com PCM não zero rejeitam e removem temporário',async t=>{
  const cfg=await ambiente(t,"import {writeFileSync} from 'node:fs';const a=process.argv;writeFileSync(a[2],process.cwd());setInterval(()=>{},1000);");
  const origTmpDir=resolve(tmpdir());
  const envKeys=['TEMP','TMP','TMPDIR'];
  const prevEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
  const isoDir=await mkdtemp(join(tmpdir(),'lume-silencio-iso-'));
  assert.equal(dirname(resolve(isoDir)),origTmpDir);

  const restaurarEnv=()=>{
    for(const k of envKeys){
      if(prevEnv[k]!==undefined)process.env[k]=prevEnv[k];
      else delete process.env[k];
    }
  };

  try{
    for(const k of envKeys)process.env[k]=isoDir;

    const esperarMarker=async(path,pendente,maxMs=10000)=>{
      const inicio=Date.now();
      while(Date.now()-inicio<maxMs){
        try{
          const c=await readFile(path,'utf8');
          if(c.trim())return c.trim();
        }catch(err){
          if(err.code!=='ENOENT')throw err;
        }
        await Promise.race([
          new Promise(r=>setTimeout(r,25)),
          pendente.then(()=>{throw new Error('Não deveria resolver.');})
        ]);
      }
      return null;
    };

    // 1. Cancelamento antes do startup: signal cancelado com runner real e áudio ativo
    {
      const abortAntes=new AbortController();
      abortAntes.abort();
      await assert.rejects(transcreverWhisperLocal(ativo(),{...cfg,signal:abortAntes.signal}),/cancelada/);
      assert.deepEqual((await readdir(isoDir)).filter(f=>f.startsWith('lume-whisper-')),[]);
    }

    // 2. Cancelamento depois do startup: prontidão determinística pelo marker do filho ativo
    {
      const marker=join(dirname(cfg.modelo),'cancelamento.txt');
      const abort=new AbortController();
      const pendente=transcreverWhisperLocal(ativo(),{
        ...cfg,
        cliPrefixArgs:[cfg.cliPrefixArgs[0],marker],
        timeoutMs:30000,
        signal:abort.signal
      });
      const erroPendente=pendente.catch(err=>err);

      try{
        const cwdFilho=await esperarMarker(marker,pendente);
        assert.ok(cwdFilho,'filho Node deve sinalizar prontidão gravando marker antes do cancelamento');
        assert.equal(dirname(resolve(cwdFilho)),resolve(isoDir));
        abort.abort();
        const err=await erroPendente;
        assert.match(err?.message||'',/cancelada/);
        await ausente(cwdFilho);
      }finally{
        abort.abort();
        await erroPendente;
      }
      assert.deepEqual((await readdir(isoDir)).filter(f=>f.startsWith('lume-whisper-')),[]);
    }

    // 3. Timeout real: runner excede tempo limite e remove temporário mesmo sob race de startup
    {
      const marker=join(dirname(cfg.modelo),'timeout.txt');
      const pendente=transcreverWhisperLocal(ativo(),{
        ...cfg,
        cliPrefixArgs:[cfg.cliPrefixArgs[0],marker],
        timeoutMs:1000
      });
      const erroPendente=pendente.catch(err=>err);
      try{
        const err=await erroPendente;
        assert.match(err?.message||'',/tempo limite/);
        let cwdFilho=null;
        try{
          cwdFilho=await readFile(marker,'utf8');
        }catch(e){
          if(e.code!=='ENOENT')throw e;
        }
        if(cwdFilho){
          assert.equal(dirname(resolve(cwdFilho.trim())),resolve(isoDir));
          await ausente(cwdFilho.trim());
        }
      }finally{
        await erroPendente;
      }
      assert.deepEqual((await readdir(isoDir)).filter(f=>f.startsWith('lume-whisper-')),[]);
    }
  }finally{
    restaurarEnv();
    assert.equal(dirname(resolve(isoDir)),origTmpDir);
    await rm(isoDir,{recursive:true,force:true});
  }
});

// Somente assets pinados já baixados; sem novo download, pessoa gravada ou aprovação.
test('ASR real pinado: fala SAPI, PCM zero e fala sintética atenuada, com evidência própria',{
  skip:process.env.LUME_AUDIO_SILENCIO_REAL!=='1'?'requer LUME_AUDIO_SILENCIO_REAL=1 e bundle oficial local':false,
  timeout:400000,
},async()=>{
  const report=await runSmoke();
  const {run}=JSON.parse(await readFile(join(WORK,'latest-run.json'),'utf8'));
  assert.equal(dirname(resolve(run)),resolve(WORK));
  const speech=await readFile(join(run,'speech.wav'));
  assert.equal(hash(speech),report.audio.sha256);
  assert.equal(report.defaultAdapter.inferenciaExecutada,true);
  assert.equal(report.defaultAdapter.analiseSinal.silencioDigital,false);
  assert.ok(report.defaultAdapter.transcricao.length>10);
  const silence=wav(3);
  assert.equal(report.silence.transcricao,'');assert.deepEqual(report.silence.trechos,[]);
  assert.equal(report.silence.semFala,true);assert.equal(report.silence.inferenciaExecutada,false);
  assert.equal(report.silence.motivoSemFala,'silencio_digital_pcm_zero');
  assert.equal(report.silence.modeloSha256,SOURCES.model.sha256);assert.equal(report.silence.audioSha256,hash(silence));
  assert.equal(report.qualityApproved,false);assert.equal(report.appRuntime.disponivel,false);
  assert.equal(report.defaultAdapter.noNewTempDirectories,true);
  assert.equal(report.defaultCancel.noNewTempDirectories,true);assert.equal(report.defaultTimeout.noNewTempDirectories,true);
  const low=Buffer.from(speech);
  for(let i=44;i<low.length;i+=2)low.writeInt16LE(Math.round(low.readInt16LE(i)/64),i);
  await writeFile(join(run,'speech-low.wav'),low,{flag:'wx'});
  const before=new Set(await readdir(tmpdir()));
  const result=await transcreverWhisperLocal(low,{executavel:join(WORK,'bundle','whisper-cli.exe'),
    modelo:join(WORK,'downloads',SOURCES.model.name),threads:2,timeoutMs:360000});
  const noNewTempDirectories=(await readdir(tmpdir())).every(n=>!n.startsWith('lume-whisper-')||before.has(n));
  const evidence={createdAt:new Date().toISOString(),kind:'digital-silence-regression-development-only',qualityApproved:false,
    speech:{sha256:hash(speech),result:report.defaultAdapter},silence:{sha256:hash(silence),result:report.silence},
    attenuatedSyntheticSpeech:{divisor:64,amplitudeDb:20*Math.log10(1/64),sha256:hash(low),result,
      wer:wordErrorRate(REFERENCE,result.transcricao),noNewTempDirectories},
    limits:'PCM zero exato apenas; atenuação de SAPI não valida fala baixa humana, ruído, VAD ou qualidade PT-BR.'};
  await writeFile(join(run,'silencio-regressao.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
  assert.equal(result.inferenciaExecutada,true);assert.equal(result.analiseSinal.silencioDigital,false);
  assert.equal(result.audioSha256,hash(low));assert.equal(result.modeloSha256,SOURCES.model.sha256);
  assert.equal(noNewTempDirectories,true);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {transcreverWhisperLocal,conferirSaidaWhisper} from '../src/audio-whisper-local.js';
import {wav} from './fixtures/audio-wav.js';

// These cases exercise the subprocess, not the exact-digital-silence shortcut.
function sinal(){const bytes=wav();bytes.writeInt16LE(1,44);return bytes;}

function ambiente(t,script){
  const dir=mkdtempSync(join(tmpdir(),'lume-stt-test-'));
  const modelo=join(dir,'modelo.bin'),cli=join(dir,'cli.mjs');
  writeFileSync(modelo,'modelo-sintetico');writeFileSync(cli,script);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return {executavel:process.execPath,modelo,cliPrefixArgs:[cli]};
}

test('whisper local: interpreta segmentos PT-BR e rejeita saída perigosa ou inconsistente',()=>{
  const dados={result:{language:'pt'},transcription:[{offsets:{from:0,to:300},text:'  Rever proposta'},{offsets:{from:400,to:900},text:' amanhã.'}]};
  assert.deepEqual(conferirSaidaWhisper(dados,{duracaoMs:1000}),{transcricao:'Rever proposta amanhã.',trechos:[{inicioMs:0,fimMs:300,texto:'Rever proposta'},{inicioMs:400,fimMs:900,texto:'amanhã.'}],idioma:'pt',semFala:false});
  for(const caso of [
    {...dados,result:{language:'en'}},
    {...dados,transcription:[{offsets:{from:900,to:2300},text:'fora'}]},
    {...dados,transcription:[{offsets:{from:700,to:800},text:'um'},{offsets:{from:600,to:900},text:'dois'}]},
    {...dados,transcription:[{offsets:{from:0,to:100},text:''}]},
  ])assert.throws(()=>conferirSaidaWhisper(caso,{duracaoMs:1000}));
});

test('whisper local: subprocesso isolado retorna proveniência e apaga áudio temporário',async t=>{
  const cfg=ambiente(t,`import {writeFileSync} from 'node:fs';\nwriteFileSync(new URL('./cwd.txt',import.meta.url),process.cwd());\nconst args=process.argv;const base=args[args.indexOf('-of')+1];writeFileSync(base+'.json',JSON.stringify({result:{language:'pt'},transcription:[{offsets:{from:0,to:500},text:' Confirmar data amanhã.'}]}));`);
  const bytes=sinal(),resultado=await transcreverWhisperLocal(bytes,cfg);
  assert.equal(resultado.transcricao,'Confirmar data amanhã.');
  assert.equal(resultado.origem,'local');assert.equal(resultado.qualidade,'nao_validada');
  assert.equal(resultado.modeloSha256,createHash('sha256').update('modelo-sintetico').digest('hex'));
  assert.equal(resultado.audioSha256,createHash('sha256').update(bytes).digest('hex'));
  // Observe only this subprocess: other tests may create their own temp folders.
  const temporario=readFileSync(join(dirname(cfg.modelo),'cwd.txt'),'utf8');
  assert.equal(resolve(dirname(temporario)),resolve(tmpdir()));
  assert.match(basename(temporario),/^lume-whisper-/);
  assert.equal(existsSync(temporario),false,'o diretório deste subprocesso deve ser removido');
});

test('whisper local: saída ausente mesmo com exit 0 falha; cancelamento limpa entrada',async t=>{
  const cfg=ambiente(t,`setTimeout(()=>{},30000);`);
  await assert.rejects(()=>transcreverWhisperLocal(sinal(),{...cfg,timeoutMs:1000}),/tempo limite/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(()=>transcreverWhisperLocal(wav(),{...cfg,signal:abort.signal}),/cancelada/);
  const semSaida=ambiente(t,`process.exit(0);`);
  await assert.rejects(()=>transcreverWhisperLocal(sinal(),semSaida),/não produziu/);
});

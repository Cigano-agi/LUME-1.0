import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,cpSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {buildAudioLocal,MANIFEST_SHA256} from '../scripts/build-audio-local.mjs';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';

const root=join(import.meta.dirname,'..');
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const policy=JSON.parse(readFileSync(join(root,'desktop/audio-local-policy.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

test('instalador Windows monta áudio local fora do ASAR e política fixa o pacote',()=>{
  assert.deepEqual(pkg.build.win.extraResources,[{from:'native/audio-local/bin',to:'audio-local',filter:['**/*']}]);
  assert.equal(pkg.build.beforePack,'scripts/broker-acl-before-pack.cjs');
  assert.equal(policy.pacotes['win32-x64'].manifestoSha256,MANIFEST_SHA256);
});

test('pacote nativo completo aceita transcrição e falha fechado se uma DLL mudar',{
  skip:process.platform!=='win32'||process.arch!=='x64'?'Windows x64 requerido':false,
  timeout:120000
},async t=>{
  const built=await buildAudioLocal();
  const raiz=mkdtempSync(join(tmpdir(),'lume-audio-package-'));
  t.after(()=>rmSync(raiz,{recursive:true,force:true}));
  cpSync(built.raiz,raiz,{recursive:true});
  const {manifestoSha256,arquivos}=built;
  assert.equal(arquivos,14);
  const runtime=criarAudioLocalRuntime({raiz,manifestoSha256});
  const state=await runtime.estado();
  assert.equal(state.disponivel,true);
  assert.equal(state.modeloSha256,'60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe');
  const wav=readFileSync(join(root,'work/audio-local-real/run-2026-09-25T21-45-52-940Z-16100/speech.wav'));
  const result=await runtime.transcrever(wav);
  assert.match(result.transcricao,/Marina/);
  assert.equal(result.modeloSha256,state.modeloSha256);
  const dll=join(raiz,'ggml-base.dll'),original=readFileSync(dll);
  try{
    const changed=Buffer.from(original);changed[0]^=1;writeFileSync(dll,changed);
    assert.equal((await runtime.estado()).disponivel,false);
    await assert.rejects(runtime.transcrever(wav),/Integridade/);
  }finally{writeFileSync(dll,original);}
  assert.equal(hash(readFileSync(dll)),hash(original));
});

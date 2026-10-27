import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {NotetakerServico} from '../src/notetaker/servico.js';
import {cabecalhoWav} from '../src/notetaker/contrato.js';
import {importarArquivo} from '../src/notetaker/importacao.js';

async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'lume-notetaker-direitos-'));
  const marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
  writeFileSync(join(root,'.lume-notetaker-test'),marker);
  const db=abrirBanco(join(root,'db.sqlite'));new ContextoApp(db);new Desktop(db);
  t.after(()=>{db.close();if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;rmSync(root,{recursive:true,force:true});});
  const asr={estado:async()=>({disponivel:true}),transcrever:async bytes=>({motor:'whisper.cpp',
    modeloSha256:'a'.repeat(64),audioSha256:createHash('sha256').update(bytes).digest('hex'),
    trechos:[{inicioMs:0,fimMs:400,texto:'Texto sintético original.'}]})};
  const s=new NotetakerServico(db,{notetakerExperimento:true,testProfileRoot:root,testMarker:marker,audioLocal:asr});
  const sessao=s.criarSessao({origem:'importacao',entradas:['importacao']}).id;
  s.consentir(sessao,{entradas:['importacao'],confirmar:true});
  const bytes=Buffer.concat([cabecalhoWav(32000),Buffer.alloc(32000)]);
  await importarArquivo({headers:{},complete:true,async *[Symbol.asyncIterator](){yield bytes;}},{servico:s,sessaoId:sessao});
  assert.equal((await s.transcreverImportacao(sessao)).estado,'concluida');
  const id=db.prepare('SELECT id FROM notetaker_trechos').get().id;
  return {db,s,id,sessao};
}

test('correção exige confirmação e limites Unicode sem escrever qualquer revisão inválida',async t=>{
  const {db,s,id}=await fixture(t);
  const entrada=texto=>({texto,revisaoEsperada:0,confirmar:true});
  for(const invalida of [entrada(' '),entrada('x'.repeat(4001)),entrada('\ud800'),
    {...entrada('Novo.'),ator:'cliente'},{...entrada('Novo.'),confirmar:false},
    {...entrada('Novo.'),revisaoEsperada:-1},{...entrada('Novo.'),revisaoEsperada:2**53}])
    assert.throws(()=>s.corrigirTrecho(id,invalida),{code:'ENTRADA'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_correcoes').get().n,0);
  assert.equal(s.trecho(id).revisao,0);
  assert.equal(s.historicoCorrecoes(id).correcoes.length,0);
  assert.throws(()=>s.historicoCorrecoes(id,{limite:21}),{code:'ENTRADA'});
  assert.throws(()=>s.trecho('id-invalido'),{code:'ENTRADA'});
});

test('savepoint de correção volta com transação externa; retry obsoleto conflita',async t=>{
  const {db,s,id}=await fixture(t);
  db.exec('BEGIN IMMEDIATE');
  try{
    assert.equal(s.corrigirTrecho(id,{texto:'Versão temporária.',revisaoEsperada:0,confirmar:true}).revisao,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_correcoes').get().n,1);
  }finally{db.exec('ROLLBACK');}
  assert.equal(s.trecho(id).revisao,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_correcoes').get().n,0);
  assert.equal(s.corrigirTrecho(id,{texto:'Versão persistida.',revisaoEsperada:0,confirmar:true}).revisao,1);
  assert.throws(()=>s.corrigirTrecho(id,{texto:'Outra versão.',revisaoEsperada:0,confirmar:true}),{code:'CONFLITO'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_correcoes').get().n,1);
});

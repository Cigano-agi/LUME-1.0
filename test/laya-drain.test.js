import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {criarLayaLocal} from '../src/laya/index.js';

function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(t,WorkerClass){
  const dir=mkdtempSync(join(tmpdir(),'lume-laya-drain-'));
  writeFileSync(join(dir,'lume-laya-manifest.json'),'{}');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return criarLayaLocal({modelDir:dir,WorkerClass,domainPolicy:{approvedForActions:true,modelSha256:'a'.repeat(64)}});
}

test('close espera terminate real e propaga falha de liberação',async t=>{
  const termination=deferred(),started=deferred();
  let instances=0;
  class FakeWorker extends EventEmitter{
    constructor(){super();instances++;queueMicrotask(()=>this.emit('message',{type:'ready',loadMs:0}));}
    terminate(){started.resolve();return termination.promise;}
  }
  const laya=fixture(t,FakeWorker);
  await laya.preparar();
  let settled=false;
  const closing=laya.close().finally(()=>{settled=true;});
  await started.promise;
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);
  termination.reject(new Error('terminate falhou'));
  await assert.rejects(closing,/terminate falhou/);
  await assert.rejects(laya.close(),/terminate falhou/);
  assert.equal(instances,1);
});

test('erro de tarefa preserva seu código; falha anterior de terminate impede novo worker e chega ao close',async t=>{
  const released=deferred();
  let instances=0;
  class FakeWorker extends EventEmitter{
    constructor(){super();instances++;queueMicrotask(()=>this.emit('message',{type:'ready',loadMs:0}));}
    postMessage({id}){queueMicrotask(()=>this.emit('message',{id,error:'LAYA_INFERENCIA_FALHOU'}));}
    terminate(){released.resolve();return Promise.reject(new Error('liberação incerta'));}
  }
  const laya=fixture(t,FakeWorker);
  await assert.rejects(laya.classificar({texto:'Pode revisar?'}),/LAYA_INFERENCIA_FALHOU/);
  await released.promise;
  await assert.rejects(laya.classificar({texto:'Outro pedido'}),/liberação incerta/);
  assert.equal(instances,1);
  await assert.rejects(laya.close(),/liberação incerta/);
});

test('modelo inválido continua sendo erro da chamada e terminate rejeitado é erro do close',async t=>{
  class FakeWorker extends EventEmitter{
    constructor(){super();queueMicrotask(()=>this.emit('message',{type:'error',error:'LAYA_MODELO_NAO_VERIFICADO'}));}
    terminate(){return Promise.reject(new Error('terminate modelo falhou'));}
  }
  const laya=fixture(t,FakeWorker);
  await assert.rejects(laya.classificar({texto:'Pode revisar?'}),/LAYA_MODELO_NAO_VERIFICADO/);
  await assert.rejects(laya.close(),/terminate modelo falhou/);
  assert.equal(laya.status().integridade,'falhou');
});

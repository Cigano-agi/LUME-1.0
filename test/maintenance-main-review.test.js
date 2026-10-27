import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {criarControladorManutencao}=require('../desktop/maintenance-controller.cjs');
const opId='b7c8f708-4f3c-44e8-a916-f139d157b02d';
const selection={tipo:'legado',id:'legado',geracao:null,dataDir:'synthetic/data'};

function deferred(){let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};}
function fixture(finish){
  const events=[];
  const marker=Object.freeze({opId});
  const token=Object.freeze({});
  const api={
    createMaintenanceMarker:async()=>{events.push('marker');return marker;},
    markMaintenanceStarted:()=>{events.push('started');},
    acquireExclusiveNoMutation:async()=>{events.push('lease');return token;},
    finishMaintenanceWithoutMutation:async args=>{
      assert.strictEqual(args.maintenanceHandle,marker);
      assert.strictEqual(args.noMutationToken,token);
      events.push('finish');return finish();
    }
  };
  const controller=criarControladorManutencao({
    userData:'synthetic',selection,api,
    getBroker:()=>({stopAdmission:()=>events.push('broker-cut'),shutdown:async()=>({confirmed:true})}),
    getUtility:()=>({lifecycle:{cortarIntake:()=>Promise.resolve({opId}),iniciar:()=>true},
      terminal:Promise.resolve({confirmado:true,code:0})}),
    reserve:()=>true,mostrarLocal:async()=>{},
    restart:async()=>{events.push('restart');},
    onQuitReady:()=>{events.push('quit-ready');}
  });
  return{controller,events};
}

test('B2 review: quit durante recibo pendente espera finalização e não inicia restart',async()=>{
  const held=deferred();
  const x=fixture(()=>held.promise);
  const handle=await x.controller.beginMaintenance({opId,kind:'notetaker-delete'});
  const ending=x.controller.endMaintenance(handle);
  assert.equal(x.controller.requestQuit(),true);
  assert.deepEqual(x.events.filter(v=>v==='restart'||v==='quit-ready'),[]);
  held.resolve({opId,kind:'notetaker-delete',outcome:'sem_mutacao',leaseClosed:true,markerRemoved:true});
  await ending;
  assert.deepEqual(x.events.filter(v=>v==='restart'||v==='quit-ready'),['quit-ready']);
});

test('B2 review: recibo resolvido sem markerRemoved entra incerto e não reinicia',async()=>{
  const x=fixture(()=>({opId,kind:'notetaker-delete',outcome:'sem_mutacao',leaseClosed:true,markerRemoved:false}));
  const handle=await x.controller.beginMaintenance({opId,kind:'notetaker-delete'});
  await assert.rejects(x.controller.endMaintenance(handle),/MANUTENCAO_RECIBO_INVALIDO/);
  assert.equal(x.controller.state(),'incerto');
  assert.equal(x.events.includes('restart'),false);
  await assert.rejects(x.controller.endMaintenance(handle),/MANUTENCAO_HANDLE_INVALIDO/);
});

test('B2 review: quit durante restart da recuperação pré-marker é atendido',async()=>{
  const restartStarted=deferred(),restartReleased=deferred(),events=[];
  const controller=criarControladorManutencao({
    userData:'synthetic',selection,
    api:{assertNormalBootAllowed:()=>{}},
    getBroker:()=>({stopAdmission:()=>{},shutdown:async()=>({confirmed:true})}),
    getUtility:()=>({lifecycle:{
      cortarIntake:()=>Promise.reject(Error('ACK_PERDIDO')),
      iniciar:()=>true
    },terminal:Promise.resolve({confirmado:true,code:0})}),
    reserve:()=>true,mostrarLocal:async()=>{},
    restart:async()=>{events.push('restart');restartStarted.resolve();await restartReleased.promise;},
    onQuitReady:()=>events.push('quit-ready')
  });
  const begin=controller.beginMaintenance({opId,kind:'notetaker-delete'});
  await restartStarted.promise;
  assert.equal(controller.requestQuit(),true);
  restartReleased.resolve();
  await assert.rejects(begin,/ACK_PERDIDO/);
  assert.deepEqual(events,['restart','quit-ready']);
});

test('B2 review: recusa de shutdown da utility observa rejeição simultânea do broker',()=>{
  const script=`
    import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url);
    const {criarControladorManutencao}=require('./desktop/maintenance-controller.cjs');
    const unhandled=[];process.on('unhandledRejection',e=>unhandled.push(e.message));
    const c=criarControladorManutencao({userData:'synthetic',selection:{tipo:'legado',id:'legado'},
      api:{assertNormalBootAllowed:()=>{}},reserve:()=>true,mostrarLocal:async()=>{},restart:async()=>{},onQuitReady:()=>{},
      getBroker:()=>({stopAdmission:()=>{},shutdown:()=>Promise.reject(Error('BROKER_DRAIN_FAILED'))}),
      getUtility:()=>({lifecycle:{cortarIntake:()=>Promise.reject(Error('ACK_PERDIDO')),iniciar:()=>false},
        terminal:Promise.resolve({confirmado:true,code:0})})
    });
    let beginReject;try{await c.beginMaintenance({opId:'a9b6cc09-f2c8-4a89-910f-875822e31bfa',kind:'notetaker-delete'});}catch(e){beginReject=e.message;}
    await new Promise(resolve=>setImmediate(resolve));
    console.log(JSON.stringify({beginReject,phase:c.state(),unhandled}));
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:10000
  });
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()),{
    beginReject:'ACK_PERDIDO',phase:'incerto',unhandled:[]
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Executa o trecho real do produto (função, handlers e timer), sem reescrever
// suas condições. DOM/API são fronteiras simuladas; não há perfil nem rede.
const source=readFileSync(new URL('../src/painel/ia.js',import.meta.url),'utf8');
const start=source.indexOf('let consultaSemantica=null;');
const end=source.indexOf('let previaIA =',start);
assert.ok(start>=0&&end>start,'fronteiras do polling real devem estar presentes');
const polling=source.slice(start,end);

function fixture(){
  const nodes=new Map(['settings','semantic-enable','semantic-pause','semantic-progress'].map(id=>[id,{hidden:false}]));
  const requests=[],timers=[],runs=[],errors=[];
  let panelVisible=true;
  const document={hidden:false};
  const context=createContext({document,$:id=>{assert.ok(nodes.has(id));return nodes.get(id);},
    semanticaPainel:{getClientRects:()=>panelVisible?[{}]:[]},
    api:(url,body)=>new Promise((resolve,reject)=>requests.push({url,body,resolve,reject})),
    run:fn=>{const p=Promise.resolve().then(fn).catch(error=>errors.push(error));runs.push(p);return p;},
    setInterval:(callback,ms)=>{timers.push({callback,ms});return 1;}});
  runInContext(polling,context,{filename:'src/painel/ia.js:polling',timeout:1000});
  assert.equal(timers.length,1);assert.equal(timers[0].ms,2500);
  return {requests,nodes,document,errors,runs,call:()=>context.estadoSemantica(),
    panel:visible=>{panelVisible=visible;},tick:async()=>{timers[0].callback();await Promise.resolve();}};
}
const state={ativa:false,etapa:'desativada',indexados:0,total:10};

test('semântica: chamadas concorrentes compartilham a mesma requisição e resultado',async()=>{
  const f=fixture(),first=f.call(),second=f.call(),third=f.call();
  assert.equal(first,second);assert.equal(second,third);assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'/api/v3/semantica');assert.equal(f.requests[0].body,undefined);
  f.requests[0].resolve(state);
  assert.deepEqual(await Promise.all([first,second,third]),[state,state,state]);
  assert.equal(f.nodes.get('semantic-progress').textContent,'desativada · 0 de 10 fontes indexadas');
  const next=f.call();assert.notEqual(next,first);assert.equal(f.requests.length,2);
  f.requests[1].resolve({...state,total:11});await next;
});

test('semântica: falha compartilhada libera a próxima consulta',async()=>{
  const f=fixture(),first=f.call(),second=f.call();
  const settled=Promise.allSettled([first,second]);
  f.requests[0].reject(new Error('Falha sintética'));
  const failures=await settled;assert.ok(failures.every(r=>r.status==='rejected'));
  const next=f.call();assert.equal(f.requests.length,2);f.requests[1].resolve(state);
  assert.equal(await next,state);
});

test('semântica: painel oculto, ajustes fechados ou documento oculto não fazem polling',async()=>{
  const f=fixture();
  f.panel(false);await f.tick();await f.tick();assert.equal(f.requests.length,0);
  f.panel(true);f.nodes.get('settings').hidden=true;await f.tick();assert.equal(f.requests.length,0);
  f.nodes.get('settings').hidden=false;f.document.hidden=true;await f.tick();assert.equal(f.requests.length,0);
  assert.equal(f.runs.length,0);
});

test('semântica: painel visível consulta sem acumular requisições entre ticks lentos',async()=>{
  const f=fixture();await f.tick();assert.equal(f.requests.length,1);
  for(let i=0;i<20;i++)await f.tick();
  assert.equal(f.requests.length,1,'vinte ticks com resposta pendente não abrem vinte requisições');
  f.requests[0].resolve(state);await Promise.all(f.runs);
  await f.tick();assert.equal(f.requests.length,2);
  f.requests[1].reject(new Error('Falha sintética do polling'));await Promise.all(f.runs);
  assert.equal(f.errors.length,1);
  await f.tick();assert.equal(f.requests.length,3);
  f.requests[2].resolve(state);await Promise.all(f.runs);
});

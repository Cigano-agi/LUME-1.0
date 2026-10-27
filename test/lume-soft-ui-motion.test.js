import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/painel/lume-motion.js',import.meta.url),'utf8');
function fixture(){
  const window=new EventTarget(),document=new EventTarget(),preference={matches:false,addEventListener(){}},calls=[];let canceled=0;
  document.hidden=false;document.documentElement={dataset:{}};document.getElementById=()=>null;document.querySelectorAll=()=>[];document.getAnimations=()=>[{cancel(){canceled++;}}];
  window.LumeMascote={atualizar(node,state,options){calls.push({node,state,options});return true;}};
  vm.runInNewContext(source,{window,document,matchMedia:()=>preference,setTimeout,clearTimeout,innerWidth:1024,innerHeight:768});
  const node={classList:{contains:value=>value==='ls-mascote'},dataset:{}};
  return{window,document,preference,node,calls,canceled:()=>canceled};
}
test('operational polling with the same state and signature does not replay a shared mascot gesture',()=>{
  const f=fixture();assert.equal(f.window.lumeMascotState(f.node,'processing','event:1'),true);
  assert.equal(f.window.lumeMascotState(f.node,'processing','event:1'),false);
  assert.equal(f.calls.length,1);
});
test('changed state or different event is allowed, while explicit previews remain repeatable',()=>{
  const f=fixture();f.window.lumeMascotState(f.node,'processing','event:1');
  assert.equal(f.window.lumeMascotState(f.node,'success','event:1'),true);
  assert.equal(f.window.lumeMascotState(f.node,'success','event:2'),true);assert.equal(f.calls.length,3);
  f.window.LumeMascote.atualizar(f.node,'curiosidade',{previa:true});f.window.LumeMascote.atualizar(f.node,'curiosidade',{previa:true});assert.equal(f.calls.length,5);
});
test('hidden and reduced-motion cancellation remains active; returning to the page does not replay polling',()=>{
  const f=fixture();f.window.lumeMascotState(f.node,'processing','event:1');
  f.document.hidden=true;f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(f.canceled(),1);assert.equal(f.document.documentElement.dataset.visible,'false');
  f.document.hidden=false;f.document.dispatchEvent(new Event('visibilitychange'));assert.equal(f.window.lumeMascotState(f.node,'processing','event:1'),false);
  f.preference.matches=true;f.window.dispatchEvent(new Event('lume:preferences'));assert.equal(f.canceled(),2);assert.equal(f.window.lumeReducedMotion(),true);
});

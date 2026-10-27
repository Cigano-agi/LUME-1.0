import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {PoliticaPessoal} from '../src/pessoal/politica.js';
import {FerramentasPessoais} from '../src/pessoal/ferramentas.js';
const DM='551100000001@s.whatsapp.net';
function setup(t,opts){const db=abrirBanco();t.after(()=>db.close());new PoliticaPessoal(db);const f=new FerramentasPessoais(db,{permitida:()=>true,credencial:async()=>null,...opts});f.vincular({conversaId:DM,tipo:'github',recurso:'teste/repo'});return f;}
test('limite de ferramentas: cancela corpo excessivo antes de text ou JSON',async t=>{
 let cancelado=false,textoLido=false;
 const f=setup(t,{fetchImpl:async()=>({ok:true,body:new ReadableStream({pull(c){c.enqueue(new Uint8Array(524289));},cancel(){cancelado=true;}}),text:async()=>{textoLido=true;return '[]';}})});
 const r=await f.consultar(DM);assert.equal(r[0].disponivel,false);assert.equal(cancelado,true);assert.equal(textoLido,false);
});
test('limite de ferramentas: deadline cobre cofre pendurado sem iniciar rede',async t=>{
 let chamadas=0;const f=setup(t,{prazoMs:30,credencial:()=>new Promise(()=>{}),fetchImpl:async()=>{chamadas++;return new Response('[]');}});
 const r=await Promise.race([f.consultar(DM),new Promise(resolve=>setTimeout(()=>resolve(null),250))]);
 assert.ok(r,'Prazo total precisa terminar sem depender do cofre');assert.equal(chamadas,0);assert.equal(r[0].disponivel,false);
});
test('limite de ferramentas: corpo que trava obedece cancelamento',async t=>{
 let cancelado=false;const f=setup(t,{prazoMs:30,fetchImpl:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelado=true;}}))});
 const r=await Promise.race([f.consultar(DM),new Promise(resolve=>setTimeout(()=>resolve(null),250))]);
 assert.ok(r);assert.equal(r[0].disponivel,false);assert.equal(cancelado,true);
});

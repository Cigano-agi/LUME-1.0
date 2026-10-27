import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';

test('pedido público explícito não interpreta "com a fonte pública" como contato',async t=>{
 const db=abrirBanco();new ContextoApp(db);const desktop=new Desktop(db);
 desktop.aceitar({nome:'Dono teste',aceito:true,versao:VERSAO_TERMOS});
 const requests=[];
 const s=new LumePessoal(db,{desktop,chatgpt:{estado:async()=>({connected:true}),encerrar(){},responder:async request=>{
   requests.push(request);return {completed:true,text:JSON.stringify({resposta:'Nenhuma fonte consultada ainda.',leituras:[]})};
 }},telegram:{estado:async()=>({}),agendar:()=>true}});
 t.after(async()=>{await s.encerrar();db.close();});await s.configurar({enabled:true});
 const donoId='123456789',text='Pesquise na Wikipedia o que é SQLite e resuma em duas frases, com a fonte pública.';
 const result=await s.conversar({update_id:1,message:{text,chat:{id:Number(donoId),type:'private'},from:{id:Number(donoId)}}},{diario:{donoId,botId:'987654321',historico:()=>[]}});
 assert.equal(requests.length,1);assert.equal(result.text,'Nenhuma fonte consultada ainda.');
 const payload=JSON.parse(requests[0].input.at(-1).content);
 assert.equal(payload.capacidades.find(c=>c.id==='wikipedia.pesquisar').disponivel,true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM saidas').get().n,0);
});

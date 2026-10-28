// Independent timeout boundary: synthetic vault/body and loopback HTTP only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {ChatGPTPessoal} from '../src/pessoal/chatgpt.js';
const input={instructions:'Synthetic bounded request.',input:[{role:'user',content:'Synthetic only.'}]};
function fixture(t,fetchImpl){
 const db=new DatabaseSync(':memory:'),saved={version:1,active:'synthetic',accounts:[{client_id:'synthetic',access_token:'synthetic-access-only',scopes:['chatgpt.tokens.use.direct'],expires_at:Date.now()+3600000}]};
 const client=new ChatGPTPessoal(db,{fetchImpl,cofre:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>JSON.stringify(saved),gravar:async()=>{throw Error('unexpected synthetic write');}}});
 db.prepare('INSERT INTO desktop_config VALUES(?,?)').run('pessoal-chatgpt-model','synthetic-model');
 t.after(()=>{client.encerrar();db.close();});return client;
}
function shortenTimeout(t){const original=AbortSignal.timeout.bind(AbortSignal);t.mock.method(AbortSignal,'timeout',ms=>original(Math.min(ms,40)));}
async function bounded(operation){return Promise.race([operation.then(()=>({kind:'fulfilled'}),error=>({kind:'rejected',code:error.code})),delay(250).then(()=>({kind:'still-pending'}))]);}

test('request timeout terminates a pending body even when the transport ignores abort',{timeout:3000},async t=>{
 shortenTimeout(t);let bodyController,requestSignal;
 const client=fixture(t,async(_url,options)=>{requestSignal=options.signal;return new Response(new ReadableStream({start(c){bodyController=c;}}));});
 const operation=client.responder(input);
 try{const result=await bounded(operation);assert.equal(requestSignal.aborted,true);assert.equal(result.kind,'rejected','timeout must settle the operation independently of the upstream body');assert.equal(client.controllers.size,0);}
 finally{try{bodyController.error(Error('synthetic cleanup'));}catch{}await operation.catch(()=>{});}
});

test('encerrar terminates a pending body without relying on transport cancellation',{timeout:3000},async t=>{
 let bodyController,started;const ready=new Promise(r=>started=r);
 const client=fixture(t,async()=>new Response(new ReadableStream({start(c){bodyController=c;started();}})));
 const operation=client.responder(input);await ready;await delay(10);client.encerrar();
 try{assert.equal((await bounded(operation)).kind,'rejected','closing the client must settle an active read');assert.equal(client.controllers.size,0);}
 finally{try{bodyController.error(Error('synthetic cleanup'));}catch{}await operation.catch(()=>{});}
});

test('stream parsing failure cannot hang awaiting an unresponsive upstream cancel',{timeout:3000},async t=>{
 shortenTimeout(t);let releaseCancel;const cancellation=new Promise(r=>releaseCancel=r);
 const client=fixture(t,async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: not-json\n\n'));},cancel(){return cancellation;}})));
 const operation=client.responder(input);
 try{assert.equal((await bounded(operation)).kind,'rejected','parser error must not wait forever for upstream cancel');assert.equal(client.controllers.size,0);}
 finally{releaseCancel();await operation.catch(()=>{});}
});

test('control: native fetch aborts a stalled loopback HTTP body',{timeout:3000},async t=>{
 shortenTimeout(t);const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const client=fixture(t,(_url,options)=>fetch('http://127.0.0.1:'+server.address().port,{...options,headers:{'content-type':'application/json'}}));
 assert.equal((await bounded(client.responder(input))).kind,'rejected');
 assert.equal(client.controllers.size,0);
});

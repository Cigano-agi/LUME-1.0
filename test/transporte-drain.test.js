import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Conexao} from '../src/transporte/socket.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const fake=()=>({ev:new EventEmitter(),end(){this.ended=true;},user:{id:'5511999999999@s.whatsapp.net'}});

test('encerrar corta admissao e aguarda inicio retido antes de concluir',async()=>{
  const abertura=defer(),socket=fake();let chamadas=0;
  const conexao=new Conexao({authDir:'fake',aoLote(){},criarSocket:()=>{chamadas++;return abertura.promise;}});
  const inicio=conexao.iniciar();await tick();let terminou=false;
  const encerramento=conexao.encerrar();const fim=encerramento.then(()=>{terminou=true;});
  assert.equal(conexao.encerrar(),encerramento);
  await assert.rejects(conexao.iniciar(),{code:'SOCKET_ENCERRADO'});await tick();assert.equal(chamadas,1);assert.equal(terminou,false);
  abertura.resolve(socket);await Promise.all([inicio,fim]);assert.equal(terminou,true);assert.equal(socket.ended,true);
  await assert.rejects(conexao.iniciar(),{code:'SOCKET_ENCERRADO'});assert.equal(chamadas,1);
});

test('encerrar aguarda retomada automatica ate o finally, inclusive rejeicao',async()=>{
  const retomada=defer(),socket=fake();let iniciou=false,terminou=false;
  const historico={observarEstado(){},observarLote(){},retomarAoReceber(){iniciou=true;return retomada.promise.finally(()=>{terminou=true;});}};
  const conexao=new Conexao({authDir:'fake',aoLote(){},historico,criarSocket:async()=>socket});
  await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});
  socket.ev.emit('messages.upsert',{type:'notify',messages:[]});await tick();assert.equal(iniciou,true);
  let fechado=false;const fim=conexao.encerrar().then(()=>{fechado=true;});await tick();assert.equal(fechado,false);
  retomada.reject(Error('falha sintetica'));await fim;assert.equal(terminou,true);assert.equal(fechado,true);
});

test('encerrar aguarda fetch real mesmo quando a chamada publica falha',async()=>{
  const fetch=defer(),socket=fake();socket.fetchMessageHistory=()=>fetch.promise;
  const conexao=new Conexao({authDir:'fake',aoLote(){},criarSocket:async()=>socket});
  await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});
  const pedido=conexao.solicitarHistorico({chave:{remoteJid:'a@s.whatsapp.net',id:'1',fromMe:false},timestamp:1});
  let fechado=false;const fim=conexao.encerrar().then(()=>{fechado=true;});await tick();assert.equal(fechado,false);
  await assert.rejects(conexao.solicitarHistorico({chave:{remoteJid:'a@s.whatsapp.net',id:'2',fromMe:false},timestamp:1}));
  fetch.reject(Error('falha sintetica'));await assert.rejects(pedido);await fim;assert.equal(fechado,true);
});

test('parar continua reversivel e encerrar impede novo download',async()=>{
  let criados=0;const conexao=new Conexao({authDir:'fake',aoLote(){},criarSocket:async()=>{criados++;return fake();}});
  await conexao.iniciar();await conexao.parar();await conexao.iniciar();assert.equal(criados,2);
  await conexao.encerrar();await assert.rejects(conexao.baixarMidia({}));await assert.rejects(conexao.iniciar(),{code:'SOCKET_ENCERRADO'});assert.equal(criados,2);
});

test('encerrar aguarda midia e grupos admitidos e nao observa estado apos o corte',async()=>{
  const midia=defer(),grupos=defer(),socket=fake();let observacoes=0;
  socket.downloadMediaMessage=()=>midia.promise;
  socket.groupFetchAllParticipating=()=>grupos.promise;
  const historico={observarEstado(){observacoes++;}};
  const conexao=new Conexao({authDir:'fake',aoLote(){},aoGrupos:async()=>{},historico,criarSocket:async()=>socket});
  await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});
  const download=conexao.baixarMidia({});const sync=conexao.sincronizarGrupos();await tick();
  let fechado=false;const fim=conexao.encerrar().then(()=>{fechado=true;});await tick();assert.equal(fechado,false);
  const antes=observacoes;
  await assert.rejects(conexao.sincronizarGrupos(),{code:'GRUPOS_INDISPONIVEIS'});assert.equal(observacoes,antes);
  midia.resolve(Buffer.from('sintetico'));await download;await tick();assert.equal(fechado,false);
  grupos.resolve({});await assert.rejects(sync,{code:'GRUPOS_CANCELADOS'});await fim;assert.equal(fechado,true);
});

test('encerrar aguarda end assíncrono e propaga sua rejeicao',async()=>{
  const fimSocket=defer(),socket=fake();socket.end=()=>fimSocket.promise;
  const conexao=new Conexao({authDir:'fake',aoLote(){},criarSocket:async()=>socket});
  await conexao.iniciar();let fechado=false;const fim=conexao.encerrar().then(()=>{fechado=true;});
  await tick();assert.equal(fechado,false);
  fimSocket.reject(Error('falha sintética de end'));
  await assert.rejects(fim,/falha sintética de end/);assert.equal(fechado,false);
});

test('socket criado durante o corte tambem aguarda end assíncrono',async()=>{
  const abertura=defer(),fimSocket=defer(),socket=fake();socket.end=()=>fimSocket.promise;
  const conexao=new Conexao({authDir:'fake',aoLote(){},criarSocket:()=>abertura.promise});
  const inicio=conexao.iniciar();await tick();
  let fechado=false;const fim=conexao.encerrar().then(()=>{fechado=true;});
  abertura.resolve(socket);await tick();assert.equal(fechado,false);
  fimSocket.resolve();await Promise.all([inicio,fim]);assert.equal(fechado,true);
});

test('timeout do pedido nao representa settle do fetch real',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const fetch=defer(),socket=fake();socket.fetchMessageHistory=()=>fetch.promise;
  const conexao=new Conexao({authDir:'fake',aoLote(){},criarSocket:async()=>socket});
  await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});
  const pedido=conexao.solicitarHistorico({chave:{remoteJid:'a@s.whatsapp.net',id:'1',fromMe:false},timestamp:1});
  t.mock.timers.tick(20_000);await assert.rejects(pedido,{code:'HISTORICO_INDISPONIVEL'});
  let fechado=false;const fim=conexao.encerrar().then(()=>{fechado=true;});await Promise.resolve();assert.equal(fechado,false);
  fetch.resolve('recibo');await fim;assert.equal(fechado,true);
});

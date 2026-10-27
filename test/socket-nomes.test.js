import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Conexao} from '../src/transporte/socket.js';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {salvarNomesWhatsapp} from '../src/nomes-conversa.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('socket nomes: histórico e atualizações entregam metadados antes das mensagens',async t=>{
  const socket={ev:new EventEmitter(),end(){}},recebidos=[],ordem=[];
  const conexao=new Conexao({authDir:'fixture-sem-sessao',criarSocket:async()=>socket,
    aoNomes:lote=>{recebidos.push(lote);ordem.push('nomes');},aoLote:()=>ordem.push('mensagens')});
  t.after(()=>conexao.encerrar());await conexao.iniciar();
  const contacts=[{id:'123456789@lid',name:'Contato Fixture',phoneNumber:'5511000000000@s.whatsapp.net'}];
  const chats=[{id:'123456789@g.us',name:'Grupo Fixture'}];
  const lidPnMappings=[{lid:'123456789@lid',pn:'5511000000000@s.whatsapp.net'}];
  socket.ev.emit('messaging-history.set',{contacts,chats,lidPnMappings,messages:[]});await tick();
  assert.deepEqual(ordem,['nomes','mensagens']);
  assert.deepEqual(recebidos[0].contacts,contacts);assert.deepEqual(recebidos[0].chats,chats);
  assert.deepEqual(recebidos[0].lidPnMappings,lidPnMappings);
  socket.ev.emit('contacts.update',[{id:contacts[0].id,notify:'Nome atualizado'}]);await tick();
  assert.equal(recebidos[1].contacts[0].notify,'Nome atualizado');
});

test('socket nomes: contatos, chats e pares explícitos drenam em ordem e removem listeners',async t=>{
  const socket={ev:new EventEmitter(),end(){}},recebidos=[];let liberar;
  const conexao=new Conexao({authDir:'fixture-sem-sessao',criarSocket:async()=>socket,aoLote(){},
    aoNomes:async lote=>{recebidos.push(lote);if(recebidos.length===1)await new Promise(r=>{liberar=r;});}});
  t.after(()=>conexao.encerrar());await conexao.iniciar();
  socket.ev.emit('contacts.upsert',[{id:'123456789@lid',name:'Contato Fixture'}]);
  socket.ev.emit('lid-mapping.update',{lid:'123456789@lid',pn:'5511000000000@s.whatsapp.net'});
  socket.ev.emit('chats.update',[{id:'12000000000@g.us',name:'Grupo Fixture'}]);
  await tick();assert.equal(recebidos.length,1);
  let terminou=false;const parada=conexao.parar().then(()=>{terminou=true;});await tick();assert.equal(terminou,false);
  liberar();await parada;assert.equal(recebidos.length,3);
  assert.equal(recebidos[1].lidPnMappings[0].lid,'123456789@lid');
  for(const evento of ['contacts.upsert','contacts.update','chats.upsert','chats.update','lid-mapping.update'])assert.equal(socket.ev.listenerCount(evento),0);
  socket.ev.emit('contacts.update',[{id:'123456789@lid',name:'Nome tardio'}]);await tick();assert.equal(recebidos.length,3);
});

test('socket nomes: falha de persistência de nomes não perde mensagem nem expõe payload',async t=>{
  const socket={ev:new EventEmitter(),end(){}},recebidos=[],diagnosticos=[];
  const conexao=new Conexao({authDir:'fixture-sem-sessao',criarSocket:async()=>socket,
    aoNomes(){throw Error('CONTEUDO_PRIVADO_55110000000');},aoLote:l=>recebidos.push(l),aoDiagnostico:d=>diagnosticos.push(d)});
  t.after(()=>conexao.encerrar());await conexao.iniciar();
  socket.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'fixture'}}]});await tick();
  assert.equal(recebidos.length,1);assert.equal(conexao.estado().erro,'Falha ao registrar nomes do WhatsApp');
  assert.deepEqual(diagnosticos,[{evento:'nomes_whatsapp_falhou',codigo:'NOMES_FALHA'}]);
  assert.doesNotMatch(JSON.stringify(conexao.estado()),/CONTEUDO_PRIVADO/);
});

test('socket nomes: eventos de fixture alimentam persistência e preservam grupo em update com ID',async t=>{
  const db=abrirBanco(),e=perfilGrafo(db),socket={ev:new EventEmitter(),end(){}};
  const conexao=new Conexao({authDir:'fixture-sem-sessao',criarSocket:async()=>socket,
    aoNomes:lote=>salvarNomesWhatsapp(db,lote),aoLote:lote=>e.contexto.receber(lote),aoGrupos:g=>e.contexto.salvarGrupos(g)});
  t.after(async()=>{await conexao.encerrar();db.close();});await conexao.iniciar();
  const id='123456789@lid',grupo='12000000000@g.us';
  socket.ev.emit('messaging-history.set',{contacts:[{id,name:'Agenda Fixture'}],chats:[{id:grupo,name:'Grupo Fixture'}],messages:[
    {key:{id:'fixture-recebida',remoteJid:id,fromMe:false},pushName:'Apelido Fixture',messageTimestamp:1793000000,message:{conversation:'Mensagem da fixture'}}
  ]});await tick();
  assert.equal(e.desktop.carteira({q:'Agenda Fixture'}).pagina.total,1);
  socket.ev.emit('groups.upsert',[{id:grupo,subject:'Grupo Fixture'}]);await tick();
  socket.ev.emit('groups.update',[{id:grupo,subject:grupo}]);await tick();
  assert.equal(db.prepare('SELECT nome FROM grupos_app WHERE id=?').get(grupo).nome,'Grupo Fixture');
  assert.equal(db.prepare('SELECT nome FROM conversas_app WHERE id=?').get(grupo).nome,'Grupo Fixture');
});

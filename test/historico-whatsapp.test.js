import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { HistoricoWhatsApp } from '../src/transporte/historico.js';
import { Conexao } from '../src/transporte/socket.js';

function ambiente(t) {
  const db=abrirBanco();t.after(()=>db.close());
  const contexto=new ContextoApp(db);
  let tempo=new Date('2026-09-25T12:00:00Z');
  const historico=new HistoricoWhatsApp(db,{agora:()=>tempo});
  const inserir=(id='um',jid='5511@s.whatsapp.net',data=1790337000,fromMe=false)=>contexto.receber({type:'notify',messages:[{
    key:{id,remoteJid:jid,fromMe},messageTimestamp:data,message:{conversation:'Vamos preparar a proposta.'}
  }]});
  return {db,contexto,historico,inserir,tempo:valor=>tempo=new Date(valor)};
}

test('cobertura permanece desconhecida com silêncio, isLatest e lote recebido',t=>{
  const {historico,inserir}=ambiente(t);historico.observarEstado({estado:'conectada'});inserir();
  historico.observarLote({type:'history',isLatest:true},{novas:1});
  const estado=historico.estado();assert.equal(estado.cobertura,'desconhecida');assert.equal(estado.armazenado.mensagens,1);
  assert.ok(estado.conexao.ultimo_historico_em);assert.match(estado.aviso,/parte/);
});

test('interrupção e reinício persistem sem inventar quais mensagens faltam',t=>{
  const {db,historico,tempo}=ambiente(t);historico.observarEstado({estado:'conectada'});
  tempo('2026-09-25T12:01:00Z');historico.observarEstado({estado:'reconectando'});
  tempo('2026-09-25T12:02:00Z');historico.observarEstado({estado:'conectada'});
  assert.equal(historico.estado().interrupcoes.length,1);
  const retomado=new HistoricoWhatsApp(db,{agora:()=>new Date('2026-09-25T13:00:00Z')});
  retomado.observarEstado({estado:'conectada'});
  assert.equal(retomado.estado().interrupcoes.length,2);assert.equal(retomado.estado().cobertura,'desconhecida');
});

test('pedido usa timestamp em milissegundos e recibo não declara recuperação concluída',async t=>{
  const {historico,inserir}=ambiente(t);inserir();let pedido;
  const resultado=await historico.recuperar({solicitarHistorico:async p=>{pedido=p;return{solicitado:true};}},{conversaId:'5511@s.whatsapp.net'});
  assert.equal(pedido.timestamp,1790337000000);assert.equal(pedido.limite,50);
  assert.equal(resultado.estado,'aguardando_historico');assert.equal(resultado.cobertura,'desconhecida');
  assert.equal(historico.estado({conversaId:'5511@s.whatsapp.net'}).tentativas[0].recibo,1);
});

test('pedidos concorrentes da mesma conversa não duplicam; repetição aguarda',async t=>{
  const {historico,inserir}=ambiente(t);inserir();let chamadas=0,liberar;
  const conexao={solicitarHistorico:()=>{chamadas++;return new Promise(r=>liberar=r);}};
  const a=historico.recuperar(conexao,{conversaId:'5511@s.whatsapp.net'});
  const b=historico.recuperar(conexao,{conversaId:'5511@s.whatsapp.net'});
  await new Promise(r=>setImmediate(r));liberar();
  assert.equal((await a).id,(await b).id);assert.equal(chamadas,1);
  await assert.rejects(historico.recuperar(conexao,{conversaId:'5511@s.whatsapp.net'}),{code:'HISTORICO_AGUARDE'});
});

test('fonte excluída durante o pedido não permanece autorizada',async t=>{
  const {historico,inserir,db}=ambiente(t);inserir();
  await assert.rejects(historico.recuperar({solicitarHistorico:async()=>{db.prepare('DELETE FROM eventos').run();}},{conversaId:'5511@s.whatsapp.net'}),{code:'HISTORICO_SEM_ANCORA'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wa_recuperacoes').get().n,0);
});

test('mensagem nova durante o pedido não invalida a fonte original',async t=>{
  const {historico,inserir}=ambiente(t);inserir();
  const r=await historico.recuperar({solicitarHistorico:async()=>inserir('dois','5511@s.whatsapp.net',1790337100)},{conversaId:'5511@s.whatsapp.net'});
  assert.equal(r.estado,'aguardando_historico');
});

test('grupo pessoal pode recuperar histórico; fonte importada não autoriza outra conta',async t=>{
  const {historico,inserir,db}=ambiente(t);inserir('grupo','120@g.us');
  let chamadas=0;await historico.recuperar({solicitarHistorico:async()=>{chamadas++;}}, {conversaId:'120@g.us'});assert.equal(chamadas,1);
  inserir();db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE conversa_id=?").run('5511@s.whatsapp.net');
  await assert.rejects(historico.recuperar({}, {conversaId:'5511@s.whatsapp.net'}),{code:'HISTORICO_SEM_ANCORA'});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wa_recuperacoes').get().n,1);
});

test('erro de rede não persiste payload ou credenciais no histórico operacional',async t=>{
  const {historico,inserir,db}=ambiente(t);inserir();
  await assert.rejects(historico.recuperar({solicitarHistorico:async()=>{throw Error('token privado');}},{conversaId:'5511@s.whatsapp.net'}),{code:'HISTORICO_FALHA'});
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM wa_recuperacoes').all()),/token privado/);
});

test('nova mensagem após interrupção pede recuperação automática uma vez sem bloquear ingestão',async t=>{
  const {historico,inserir,tempo}=ambiente(t);historico.observarEstado({estado:'conectada'});
  tempo('2026-09-25T12:01:00Z');historico.observarEstado({estado:'reconectando'});
  tempo('2026-09-25T12:02:00Z');historico.observarEstado({estado:'conectada'});
  inserir('retomada','5511@s.whatsapp.net',Date.parse('2026-09-25T12:03:00Z')/1000);
  let pedidos=0;const conexao={estado:()=>({estado:'conectada'}),solicitarHistorico:async()=>{pedidos++;}};
  const lote={type:'notify',messages:[{key:{remoteJid:'5511@s.whatsapp.net'}}]};
  await historico.retomarAoReceber(conexao,lote);await historico.retomarAoReceber(conexao,lote);
  assert.equal(pedidos,1);assert.equal(historico.estado().cobertura,'desconhecida');
});

test('timeout encerra espera do transporte sem declarar recuperação',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const socket={ev:new EventEmitter(),end(){},fetchMessageHistory:()=>new Promise(()=>{})};
  const c=new Conexao({authDir:'fake',aoLote:()=>({}),criarSocket:async()=>socket});
  await c.iniciar();socket.ev.emit('connection.update',{connection:'open'});
  const pedido=c.solicitarHistorico({chave:{id:'a',remoteJid:'5511@s.whatsapp.net',fromMe:false},timestamp:1790337000000});
  const falhou=assert.rejects(pedido,{code:'HISTORICO_INDISPONIVEL'});t.mock.timers.tick(20_000);await falhou;await c.parar();
});

test('transporte cancela recibo de geração antiga e preserva callback de lotes',async t=>{
  const {historico}=ambiente(t);let liberar;
  const socket={ev:new EventEmitter(),end(){},fetchMessageHistory:()=>new Promise(r=>liberar=r)};
  const c=new Conexao({authDir:'fake',historico,aoLote:()=>({novas:0}),criarSocket:async()=>socket});
  await c.iniciar();socket.ev.emit('connection.update',{connection:'open'});
  const pedido=c.solicitarHistorico({chave:{id:'a',remoteJid:'5511@s.whatsapp.net',fromMe:false},timestamp:1790337000000});
  await c.parar();liberar('ok');await assert.rejects(pedido,{code:'HISTORICO_CANCELADO'});
  assert.equal(historico.estado().conexao.estado,'desconectada');
});

function interromper({historico,tempo}) {
  historico.observarEstado({estado:'conectada'});
  tempo('2026-09-25T12:01:00Z');historico.observarEstado({estado:'reconectando'});
  tempo('2026-09-25T12:02:00Z');historico.observarEstado({estado:'conectada'});
}
function notificar(ids) { return {type:'notify',messages:ids.map((remoteJid,i)=>({key:{id:`notify-${i}-${remoteJid}`,remoteJid,fromMe:true}}))}; }

test('notify com quatro conversas elegíveis recupera as quatro e conserva cobertura desconhecida',async t=>{
  const {historico,inserir,tempo}=ambiente(t);interromper({historico,tempo});
  const jids=[1,2,3,4].map(i=>`551100000000${i}@s.whatsapp.net`);jids.forEach((jid,i)=>inserir(`m${i}`,jid,1790337780,true));
  const pedidos=[];const conexao={estado:()=>({estado:'conectada'}),solicitarHistorico:async p=>pedidos.push(p.chave.remoteJid)};
  await historico.retomarAoReceber(conexao,notificar(jids));assert.deepEqual(pedidos,jids);assert.equal(historico.estado().cobertura,'desconhecida');
});

test('lote recebido enquanto a fila aguarda a rede também é enfileirado e drenado',async t=>{
  const {historico,inserir,tempo}=ambiente(t);interromper({historico,tempo});
  const a='5511000000001@s.whatsapp.net',b='5511000000002@s.whatsapp.net';inserir('a',a,1790337780,true);inserir('b',b,1790337780,true);
  let liberar;const pedidos=[];const conexao={estado:()=>({estado:'conectada'}),solicitarHistorico:async p=>{pedidos.push(p.chave.remoteJid);if(pedidos.length===1)await new Promise(r=>liberar=r);}};
  const primeiro=historico.retomarAoReceber(conexao,notificar([a]));await new Promise(r=>setImmediate(r));
  const segundo=historico.retomarAoReceber(conexao,notificar([b]));liberar();await Promise.all([primeiro,segundo]);assert.deepEqual(pedidos,[a,b]);
});

test('fila durável deduplica conversa por interrupção e reinício reabre pedido em curso',async t=>{
  const {db,historico,inserir,tempo}=ambiente(t);interromper({historico,tempo});const jid='5511000000001@s.whatsapp.net';inserir('a',jid,1790337780,true);
  let liberar;const conexao={estado:()=>({estado:'conectada'}),solicitarHistorico:()=>new Promise(r=>liberar=r)};const lote=notificar([jid]);
  const pendente=historico.retomarAoReceber(conexao,lote);await new Promise(r=>setImmediate(r));const duplicata=historico.retomarAoReceber(conexao,lote);
  const antes=db.prepare('SELECT interrupcao_id,conversa_id,estado,tentativas FROM wa_fila_retomada').all();assert.equal(antes.length,1);assert.equal(antes[0].conversa_id,jid);
  const retomado=new HistoricoWhatsApp(db,{agora:()=>new Date('2026-09-25T12:04:00Z')});
  const depois=db.prepare('SELECT estado FROM wa_fila_retomada WHERE conversa_id=?').get(jid);assert.equal(depois.estado,'solicitando');liberar();await Promise.all([pendente,duplicata]);
  assert.equal(retomado.estado().cobertura,'desconhecida');
});

test('falha transitória agenda retry e drenagem posterior tenta de novo',async t=>{
  const {db,historico,inserir,tempo}=ambiente(t);interromper({historico,tempo});const jid='5511000000001@s.whatsapp.net';inserir('a',jid,1790337780,true);
  let chamadas=0;const conexao={estado:()=>({estado:'conectada'}),solicitarHistorico:async()=>{if(++chamadas===1)throw Object.assign(Error('transitório'),{code:'HISTORICO_INDISPONIVEL'});}};
  await historico.retomarAoReceber(conexao,notificar([jid]));const falha=db.prepare('SELECT estado,tentativas,proxima_tentativa_em,ultimo_erro FROM wa_fila_retomada WHERE conversa_id=?').get(jid);
  assert.equal(falha.estado,'pendente');assert.equal(falha.tentativas,1);assert.ok(falha.proxima_tentativa_em);assert.equal(falha.ultimo_erro,'HISTORICO_INDISPONIVEL');
  tempo('2026-09-25T12:03:31Z');await historico.drenarPendentes(conexao);assert.equal(chamadas,2);
});

test('fila revalida âncora e remove conversa apagada ou importada',async t=>{
  const {db,historico,inserir,tempo}=ambiente(t);interromper({historico,tempo});const removida='5511000000001@s.whatsapp.net',importada='5511000000002@s.whatsapp.net';
  inserir('a',removida,1790337780,true);inserir('b',importada,1790337780,true);db.prepare('DELETE FROM eventos WHERE conversa_id=?').run(removida);
  db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE conversa_id=?").run(importada);
  const pedidos=[];await historico.retomarAoReceber({estado:()=>({estado:'conectada'}),solicitarHistorico:async p=>pedidos.push(p.chave.remoteJid)},notificar([removida,importada]));
  assert.deepEqual(pedidos,[]);assert.equal(db.prepare('SELECT count(*) n FROM wa_fila_retomada WHERE conversa_id IN (?,?)').get(removida,importada).n,0);
});

test('duas instâncias não tomam o mesmo pedido enquanto o lease está ativo',async t=>{
  const pasta=mkdtempSync(join(tmpdir(),'lume-historico-lease-'));
  const caminho=join(pasta,'acervo.db'),db1=abrirBanco(caminho),db2=abrirBanco(caminho);
  t.after(()=>{db1.close();db2.close();rmSync(pasta,{recursive:true,force:true});});
  const contexto=new ContextoApp(db1),agora=()=>new Date('2026-09-25T12:03:00Z');
  const um=new HistoricoWhatsApp(db1,{agora});
  um.observarEstado({estado:'conectada'});um.observarEstado({estado:'reconectando'});um.observarEstado({estado:'conectada'});
  const jid='5511000000001@s.whatsapp.net';
  contexto.receber({type:'notify',messages:[{key:{id:'a',remoteJid:jid,fromMe:true},messageTimestamp:1790337780,message:{conversation:'Pauta'}}]});
  let liberar,primeira=0,segunda=0;
  const conexao1={estado:()=>({estado:'conectada'}),solicitarHistorico:()=>{primeira++;return new Promise(r=>liberar=r);}};
  const conexao2={estado:()=>({estado:'conectada'}),solicitarHistorico:async()=>{segunda++;}};
  const pendente=um.retomarAoReceber(conexao1,notificar([jid]));
  await new Promise(r=>setImmediate(r));
  const dois=new HistoricoWhatsApp(db2,{agora});
  await dois.drenarPendentes(conexao2);
  const job=db2.prepare('SELECT estado,tentativas,proxima_tentativa_em FROM wa_fila_retomada').get();
  assert.equal(job.estado,'solicitando');assert.equal(job.tentativas,1);
  assert.ok(job.proxima_tentativa_em);assert.equal(primeira,1);assert.equal(segunda,0);
  liberar();await pendente;
});

test('lease vencido após queda devolve a conversa à drenagem',async t=>{
  const f=ambiente(t);interromper(f);f.tempo('2026-09-25T12:03:00Z');const jid='5511000000001@s.whatsapp.net';
  f.inserir('a',jid,1790337780,true);
  f.db.prepare(`INSERT INTO wa_fila_retomada
    (interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em)
    SELECT id,?,'solicitando',1,?,'CLAIM:morto',?,? FROM wa_interrupcoes ORDER BY fim DESC LIMIT 1`)
    .run(jid,'2026-09-25T12:02:30Z','2026-09-25T12:02:00Z','2026-09-25T12:02:00Z');
  let pedidos=0;
  await f.historico.drenarPendentes({estado:()=>({estado:'conectada'}),solicitarHistorico:async()=>{pedidos++;}});
  const job=f.db.prepare('SELECT estado,tentativas,ultimo_erro FROM wa_fila_retomada').get();
  assert.equal(pedidos,1);assert.equal(job.estado,'aguardando_historico');
  assert.equal(job.tentativas,2);assert.equal(job.ultimo_erro,null);
});

test('lease vencido na quarta tentativa encerra sem ultrapassar teto do backup',async t=>{
  const f=ambiente(t);interromper(f);f.tempo('2026-09-25T12:03:00Z');const jid='5511000000001@s.whatsapp.net';
  f.inserir('a',jid,1790337780,true);
  f.db.prepare(`INSERT INTO wa_fila_retomada
    (interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em)
    SELECT id,?,'solicitando',4,?,'CLAIM:morto',?,? FROM wa_interrupcoes ORDER BY fim DESC LIMIT 1`)
    .run(jid,'2026-09-25T12:02:30Z','2026-09-25T12:02:00Z','2026-09-25T12:02:00Z');
  let pedidos=0;
  await f.historico.drenarPendentes({estado:()=>({estado:'conectada'}),solicitarHistorico:async()=>{pedidos++;}});
  const job=f.db.prepare('SELECT estado,tentativas,ultimo_erro,proxima_tentativa_em FROM wa_fila_retomada').get();
  assert.equal(pedidos,0);assert.equal(job.estado,'falha');assert.equal(job.tentativas,4);
  assert.equal(job.ultimo_erro,'HISTORICO_FALHA');assert.equal(job.proxima_tentativa_em,null);
});

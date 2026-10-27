import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {HistoricoWhatsApp} from '../src/transporte/historico.js';
import {chaveConversa} from '../src/exclusoes.js';

function ambiente(t) {
  const db=abrirBanco(),contexto=new ContextoApp(db);
  let tempo=new Date('2026-10-26T10:00:00Z');
  const criar=()=>new HistoricoWhatsApp(db,{agora:()=>tempo});
  const historico=criar();
  const inserir=(jid,id='origem')=>contexto.receber({type:'history',messages:[{
    key:{id,remoteJid:jid,fromMe:false},messageTimestamp:1793008200,
    message:{conversation:'Contexto sintético anterior à interrupção'}
  }]});
  const conexoes=[];
  const conectar=()=>{
    const pedidos=[],conexao={estado:()=>({estado:conexao.conectada?'conectada':'desconectada'}),conectada:true,
      solicitarHistorico:async p=>{pedidos.push(p);}};
    conexoes.push(conexao);return {conexao,pedidos};
  };
  t.after(()=>{for(const c of conexoes)c.conectada=false;historico.observarEstado({estado:'desconectada'});db.close();});
  return {db,contexto,historico,criar,inserir,conectar,tempo:valor=>tempo=new Date(valor)};
}

test('reinício descobre quatro conversas sem notify e pede histórico com limite seguro',async t=>{
  const f=ambiente(t),jids=[1,2,3,4].map(i=>`55110000000${i}@s.whatsapp.net`);
  jids.forEach(jid=>f.inserir(jid));f.historico.observarEstado({estado:'conectada'});
  f.tempo('2026-10-26T11:00:00Z');const retomado=f.criar();retomado.observarEstado({estado:'conectada'});
  const {conexao,pedidos}=f.conectar();
  await retomado.drenarPendentes(conexao);
  assert.deepEqual(pedidos.map(p=>p.chave.remoteJid),jids);
  assert.ok(pedidos.every(p=>p.limite===50&&p.timestamp===1793008200000));
  await retomado.drenarPendentes(conexao);
  await retomado.retomarAoReceber(conexao,{type:'notify',messages:[{key:{remoteJid:jids[3]}}]});
  assert.equal(pedidos.length,4,'mesma interrupção não duplica pedidos');
  assert.equal(retomado.estado().cobertura,'desconhecida');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saidas').get().n,0);
});

test('descoberta paginada alcança conversas silenciosas sem incluir fontes importadas ou excluídas',async t=>{
  const f=ambiente(t),jids=Array.from({length:105},(_,i)=>`5511${String(i).padStart(8,'0')}@s.whatsapp.net`);
  jids.forEach(jid=>f.inserir(jid));
  f.db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE conversa_id=?").run(jids[0]);
  f.db.prepare('INSERT INTO priv_conversas_excluidas(hash,excluido_em) VALUES(?,?)')
    .run(chaveConversa(jids[1]),'2026-10-26T10:00:00Z');
  f.historico.observarEstado({estado:'conectada'});
  f.historico.observarEstado({estado:'reconectando'});
  f.tempo('2026-10-26T11:00:00Z');f.historico.observarEstado({estado:'conectada'});
  const {conexao,pedidos}=f.conectar();
  await f.historico.drenarPendentes(conexao);
  assert.deepEqual(pedidos.map(p=>p.chave.remoteJid),jids.slice(2));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wa_fila_retomada').get().n,103);
  assert.ok(pedidos.every(p=>p.limite===50));
});

test('falha de conversa silenciosa tem quatro tentativas e não é reinserida pela descoberta',async t=>{
  const f=ambiente(t);f.inserir('551100000001@s.whatsapp.net');
  f.historico.observarEstado({estado:'conectada'});f.historico.observarEstado({estado:'reconectando'});
  f.tempo('2026-10-26T11:00:00Z');f.historico.observarEstado({estado:'conectada'});
  const {conexao}=f.conectar();let chamadas=0;
  conexao.solicitarHistorico=async()=>{chamadas++;throw Error('falha sintética');};
  for(const hora of ['11:00:00','11:00:31','11:02:32','11:12:33']){
    f.tempo(`2026-10-26T${hora}Z`);await f.historico.drenarPendentes(conexao);
  }
  const job=f.db.prepare('SELECT estado,tentativas,proxima_tentativa_em FROM wa_fila_retomada').get();
  assert.deepEqual({...job},{estado:'falha',tentativas:4,proxima_tentativa_em:null});
  const retomado=f.criar();await retomado.drenarPendentes(conexao);
  assert.equal(chamadas,4);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wa_fila_retomada').get().n,1);
});

test('fila de conversas silenciosas sobrevive a interrupção da drenagem e retoma sem repetir concluída',async t=>{
  const f=ambiente(t),jids=[1,2,3,4].map(i=>`55110000000${i}@s.whatsapp.net`);
  jids.forEach(jid=>f.inserir(jid));
  f.historico.observarEstado({estado:'conectada'});f.historico.observarEstado({estado:'reconectando'});
  f.tempo('2026-10-26T11:00:00Z');f.historico.observarEstado({estado:'conectada'});
  const {conexao,pedidos}=f.conectar();
  conexao.solicitarHistorico=async p=>{pedidos.push(p);conexao.conectada=false;};
  await f.historico.drenarPendentes(conexao);
  assert.equal(pedidos.length,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM wa_fila_retomada WHERE estado='pendente'").get().n,3);
  const retomado=f.criar(),segunda=f.conectar();
  await retomado.drenarPendentes(segunda.conexao);
  assert.deepEqual(segunda.pedidos.map(p=>p.chave.remoteJid),jids.slice(1));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM wa_fila_retomada').get().n,4);
  assert.equal(retomado.estado().cobertura,'desconhecida');
});

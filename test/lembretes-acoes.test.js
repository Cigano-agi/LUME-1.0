import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {LembretesAcoes} from '../src/lembretes-acoes.js';
import {Backup} from '../src/backup.js';

function setup(t){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);const desktop=new Desktop(db);
  desktop.aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('dm','Cliente de teste');
  let now=new Date('2026-09-24T18:00:00Z');const agora=()=>now,calls=[];
  const adapter={disponivel:()=>true,cancelar:()=>{},mostrar:async input=>{calls.push(input);return {resultado:'mostrado'};}};
  const actions=new AcoesLume(db,{agora});actions.autorizar({conversa:'dm',permitida:true});
  const id=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('dm','aviso-1','entrada','texto','{}','Enviar a minuta ao cliente.','2026-09-24T17:00:00Z','2026-09-24','minha')`).run().lastInsertRowid);
  actions.registrar({eventoId:id,candidatas:[{fonte:'E'+id,tipo:'pendencia',resumo:'Enviar minuta',trecho:'Enviar a minuta ao cliente.',prazo_citado:''}]});
  const action=actions.listar()[0];
  const options={perfil:()=>desktop.perfil(),notificacoes:adapter,agora};
  const reminders=new LembretesAcoes(db,options);t.after(()=>reminders.encerrar());
  return {db,desktop,actions,action,reminders,adapter,calls,options,id,setNow:value=>{now=new Date(value);}};
}

test('ação estacionada avisa uma vez por horário; reagendamento igual não duplica',async t=>{
  const f=setup(t),hora='2026-09-24T19:00:00.000Z';
  f.actions.revisar({id:f.action.id,acao:'estacionar',lembrarEm:hora,fuso:'America/Sao_Paulo'});
  const antes=f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_historico').get().n;
  f.actions.revisar({id:f.action.id,acao:'estacionar',lembrarEm:hora,fuso:'America/Sao_Paulo'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_historico').get().n,antes);
  assert.equal((await f.reminders.executar()).resultado,'sem-aviso');
  f.setNow('2026-09-24T19:01:00Z');
  assert.equal((await f.reminders.executar()).resultado,'mostrado');
  assert.deepEqual(f.calls,[{categoria:'acao',acaoId:f.action.id,som:true}]);
  assert.equal((await f.reminders.executar()).resultado,'sem-aviso');
  assert.equal((await f.reminders.executar()).resultado,'sem-aviso');
  f.actions.revisar({id:f.action.id,acao:'estacionar',lembrarEm:'2026-09-24T20:00:00.000Z',fuso:'America/Sao_Paulo'});
  f.setNow('2026-09-24T20:01:00Z');assert.equal((await f.reminders.executar()).resultado,'mostrado');
  assert.equal(f.calls.length,2);
});

test('preferência local de som persiste e vale para o próximo aviso',async t=>{
  const f=setup(t);
  assert.equal(f.reminders.estado().som,true);
  assert.throws(()=>f.reminders.configurarSom({som:'não'}),/Escolha/);
  assert.deepEqual(f.reminders.configurarSom({som:false}),{som:false});
  const restarted=new LembretesAcoes(f.db,f.options);t.after(()=>restarted.encerrar());
  assert.equal(restarted.estado().som,false);
  f.actions.revisar({id:f.action.id,acao:'estacionar',lembrarEm:'2026-09-24T19:00:00.000Z',fuso:'America/Sao_Paulo'});
  f.setNow('2026-09-24T19:01:00Z');
  assert.equal((await restarted.executar()).resultado,'mostrado');
  assert.deepEqual(f.calls,[{categoria:'acao',acaoId:f.action.id,som:false}]);
});

test('fonte alterada e revogação impedem aviso; sem suporte conserva horário',async t=>{
  const f=setup(t);f.actions.revisar({id:f.action.id,acao:'estacionar',lembrarEm:'2026-09-24T19:00:00.000Z',fuso:'America/Sao_Paulo'});
  f.setNow('2026-09-24T19:01:00Z');f.adapter.disponivel=()=>false;
  assert.equal((await f.reminders.executar()).resultado,'indisponivel');
  assert.equal(f.db.prepare('SELECT aviso_para FROM lume_acoes WHERE id=?').get(f.action.id).aviso_para,null);
  f.adapter.disponivel=()=>true;f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('A minuta foi cancelada.',f.id);
  assert.equal((await f.reminders.executar()).resultado,'sem-aviso');assert.equal(f.calls.length,0);
  f.actions.autorizar({conversa:'dm',permitida:false});
  assert.equal((await f.reminders.executar()).resultado,'sem-aviso');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
});

test('reinício após tentativa pendente registra incerteza e não repete o aviso',async t=>{
  const f=setup(t);f.actions.revisar({id:f.action.id,acao:'estacionar',lembrarEm:'2026-09-24T19:00:00.000Z',fuso:'America/Sao_Paulo'});
  f.setNow('2026-09-24T19:01:00Z');let resolve;
  f.adapter.mostrar=()=>new Promise(r=>{resolve=r;});
  const pending=f.reminders.executar();
  assert.equal(f.db.prepare('SELECT aviso_resultado FROM lume_acoes').get().aviso_resultado,'pendente');
  f.reminders.encerrar();
  const restarted=new LembretesAcoes(f.db,f.options);t.after(()=>restarted.encerrar());
  assert.equal(f.db.prepare('SELECT aviso_resultado FROM lume_acoes').get().aviso_resultado,'sem-confirmacao');
  assert.equal((await restarted.executar()).resultado,'sem-aviso');
  resolve({resultado:'mostrado'});await pending;
  assert.equal(f.db.prepare('SELECT aviso_resultado FROM lume_acoes').get().aviso_resultado,'sem-confirmacao');
});

test('backup v7 anterior aos recibos de aviso migra campos ausentes; parcial é recusado',t=>{
  const f=setup(t),backup=new Backup(f.db),old=backup.capturar();
  const row=old.tabelas.lume_acoes[0];delete row.aviso_para;delete row.aviso_em;delete row.aviso_resultado;
  backup.validar(old);assert.equal(row.aviso_resultado,null);
  const partial=backup.capturar();delete partial.tabelas.lume_acoes[0].aviso_para;
  assert.throws(()=>backup.validar(partial),/Campos incompatíveis/);
});

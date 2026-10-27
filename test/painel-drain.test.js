import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connect,createServer as criarListener} from 'node:net';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'lume-painel-drain-'));
  const db=abrirBanco(join(dir,'dados.db'));
  new Desktop(db).aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
  const server=criarServidor(db,options);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));db.close();rmSync(dir,{recursive:true,force:true});});
  return {db,server,base,port:server.address().port};
}

test('encerrar aguarda handler mesmo depois de abortar o cliente e é idempotente',async t=>{
  const entered=deferred(),held=deferred();
  const {server,base,db}=await fixture(t,{central:{consultar:async()=>{entered.resolve();await held.promise;db.prepare('SELECT 1').get();return {ok:true};}}});
  const controller=new AbortController();
  const request=fetch(base+'/api/v3/central',{signal:controller.signal}).catch(()=>null);
  await entered.promise;
  controller.abort();await request;
  assert.equal(typeof server.encerrar,'function');
  const first=server.encerrar(),second=server.encerrar();
  assert.equal(first,second);
  let refused;
  server.emit('request',{}, {writeHead(status){refused=status;},end(){}});
  assert.equal(refused,503,'entrada após corte é recusada antes de ler o banco');
  let settled=false;first.finally(()=>{settled=true;});
  await tick();assert.equal(settled,false,'socket fechado não encerra o trabalho');
  held.resolve();await first;assert.equal(settled,true);
  assert.equal(server.listening,false);
});

test('encerrar interrompe corpo HTTP parcial e termina sem depender do timeout de request',async t=>{
  const {server,port}=await fixture(t);
  const socket=connect(port,'127.0.0.1');
  socket.on('error',()=>{}); // reset é a interrupção esperada do corpo incompleto
  t.after(()=>socket.destroy());
  await new Promise(resolve=>socket.once('connect',resolve));
  socket.write('POST /api/v3/aceite HTTP/1.1\r\nHost: 127.0.0.1:'+port+'\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"');
  assert.equal(typeof server.encerrar,'function');
  await server.encerrar();
  if(!socket.destroyed)await new Promise(resolve=>socket.once('close',resolve));
  assert.equal(socket.destroyed,true);
});

test('encerrar aguarda ativação semântica iniciada pelo painel',async t=>{
  const started=deferred(),held=deferred();
  const semantica={ativar:async()=>{started.resolve();await held.promise;},estado:()=>({ativa:false})};
  const {server,base}=await fixture(t,{semantica});
  const {token}=await (await fetch(base+'/api/sessao')).json();
  const response=await fetch(base+'/api/v3/semantica/ativar',{method:'POST',headers:{'Content-Type':'application/json','X-Assessor-Token':token},body:JSON.stringify({baixar:true})});
  assert.equal(response.status,202);await started.promise;
  assert.equal(typeof server.encerrar,'function');
  let done=false;const closing=server.encerrar().then(()=>{done=true;});
  await tick();assert.equal(done,false);
  held.resolve();await closing;assert.equal(done,true);
});

test('encerrar aguarda catch e finally da automação, inclusive após falha',async t=>{
  const started=deferred(),release=deferred(),pausing=deferred(),releasePause=deferred();
  let runs=0;
  const tarefas={executarAutomatico:async()=>{runs++;started.resolve();await release.promise;throw Error('falha sintética');},pausar:async()=>{pausing.resolve();await releasePause.promise;}};
  const {server}=await fixture(t,{desktop:true,produtores:{tarefas,intervaloTarefasMs:5}});
  await started.promise;
  let done=false;const closing=server.encerrar().then(()=>{done=true;});
  release.resolve();await pausing.promise;await tick();assert.equal(done,false);
  releasePause.resolve();await closing;assert.equal(done,true);
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(runs,1);
});

test('encerrar aguarda segundo estágio do lembrete e impede iniciá-lo após corte',async t=>{
  const second=deferred(),release=deferred();let calls=0;
  const produtores={
    lembretesAcoes:{executar:async()=>({resultado:'sem-aviso'}),encerrar(){}},
    lembretes:{executar:async()=>{calls++;second.resolve();await release.promise;},encerrar(){}},
  };
  const {server}=await fixture(t,{desktop:true,notificacoes:{},produtores});
  await second.promise;
  let done=false;const closing=server.encerrar().then(()=>{done=true;});
  await tick();assert.equal(done,false);release.resolve();await closing;assert.equal(calls,1);

  const first=deferred(),finish=deferred();calls=0;
  const other=await fixture(t,{desktop:true,notificacoes:{},produtores:{
    lembretesAcoes:{executar:async()=>{first.resolve();await finish.promise;return {resultado:'sem-aviso'};},encerrar(){}},
    lembretes:{executar:async()=>{calls++;},encerrar(){}},
  }});
  await first.promise;const stopped=other.server.encerrar();finish.resolve();await stopped;
  assert.equal(calls,0);
});

test('close(callback) espera o mesmo encerramento; falha de invalidação é observável',async t=>{
  const {server}=await fixture(t,{desktop:true,produtores:{lembretes:{encerrar(){throw Error('falha sintética de parada');}}}});
  const result=await new Promise(resolve=>server.close(resolve));
  assert.match(result.message,/encerrar o painel/);
  await assert.rejects(server.encerrar(),/encerrar o painel/);
});

test('encerrar antes de listen é terminal e não fica pendente',async()=>{
  const db=abrirBanco();
  try{
    const server=criarServidor(db);
    await server.encerrar();
    await server.encerrar();
    assert.throws(()=>server.listen(0,'127.0.0.1'),/SERVIDOR_ENCERRADO/);
  }finally{db.close();}
});

test('listen e encerrar concorrentes aguardam bind, fecham listener e mantêm callback',async t=>{
  const db=abrirBanco();
  const server=criarServidor(db);
  t.after(()=>db.close());
  let callbacks=0;
  assert.equal(server.listen(0,'127.0.0.1',()=>{callbacks++;}),server);
  await server.encerrar();
  await tick();
  assert.equal(callbacks,1);
  assert.equal(server.listening,false);
  assert.equal(server.address(),null);
});

test('erro de bind concorrente rejeita encerrar e close(callback) sem hang',async t=>{
  const ocupado=criarListener();
  await new Promise(resolve=>ocupado.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>ocupado.close(resolve)));
  const db=abrirBanco();
  t.after(()=>db.close());
  const server=criarServidor(db);
  server.listen(ocupado.address().port,'127.0.0.1');
  const fim=server.encerrar();
  const retorno=new Promise(resolve=>server.close(resolve));
  await assert.rejects(fim,error=>error.code==='EADDRINUSE' || error.errors?.some(e=>e.code==='EADDRINUSE'));
  assert.ok(await retorno instanceof Error);
  assert.equal(server.listening,false);
});

test('erro de bind já emitido continua observável no shutdown posterior', {timeout:1000}, async t=>{
  const ocupado=criarListener();
  await new Promise(resolve=>ocupado.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>ocupado.close(resolve)));
  const db=abrirBanco();
  t.after(()=>db.close());
  const server=criarServidor(db);
  const erro=new Promise(resolve=>server.once('error',resolve));
  server.listen(ocupado.address().port,'127.0.0.1');
  assert.equal((await erro).code,'EADDRINUSE');
  await assert.rejects(server.encerrar(),error=>error.errors?.some(e=>e.code==='EADDRINUSE'));
  assert.equal(server.listening,false);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';
import {LembretesNegocios} from '../src/lembretes-negocios.js';
import {criarPonteLembretes} from '../desktop/lembretes-ponte.js';
import native from '../desktop/notificacoes.cjs';
const {criarNotificacoes}=native;

function env(t){
 const db=abrirBanco(),p=perfilGrafo(db);let now=new Date('2026-09-18T11:59:00Z'),calls=[],cancels=0;
 p.desktop.aceitar({nome:'Teste',aceito:true,versao:p.desktop.perfil().versaoTermos});p.conversa('c');const f=p.evento('c','a');
 const n=new NegociosDesktop(db),save=(changes={},fonte=f)=>n.salvar({previa:n.preparar({fonte}).id,confirmar:true,titulo:'SEGREDO R$ 450',etapa:'proposta',proximo_contato:'2026-09-18',...changes});
 const adapter={disponivel:()=>true,cancelar:()=>cancels++,mostrar:async input=>{calls.push(input);return {resultado:'mostrado'};}};
 const options={perfil:()=>p.desktop.perfil(),notificacoes:adapter,agora:()=>now},l=new LembretesNegocios(db,options);
 t.after(()=>{l.encerrar();db.close();});return {db,p,f,n,l,adapter,options,save,calls,cancels:()=>cancels,setNow:v=>now=new Date(v),on:()=>l.configurar({ativo:true,hora:'09:00',confirmar:true})};
}
test('lembretes: desligado por padrão, valida consentimento/horário e indisponibilidade',async t=>{
 const e=env(t);e.save();assert.equal(e.l.estado().ativo,false);assert.equal((await e.l.executar()).resultado,'sem-aviso');
 for(const data of [{ativo:true,hora:'09:00'},{ativo:1,hora:'09:00',confirmar:true},{ativo:true,hora:'24:00',confirmar:true}])assert.throws(()=>e.l.configurar(data));
 e.adapter.disponivel=()=>false;assert.throws(e.on,/disponíveis/);assert.equal(e.l.configurar({ativo:false,hora:'09:00',confirmar:true}).ativo,false);
 e.db.prepare("DELETE FROM desktop_config WHERE chave='perfil'").run();assert.throws(e.on,/primeiro acesso/);assert.equal(e.calls.length,0);
});
test('lembretes: hora local, uma tentativa por dia, reinício e relógio voltando',async t=>{
 const e=env(t);e.save();e.on();await e.l.executar();assert.equal(e.calls.length,0);
 e.setNow('2026-09-18T12:00:00Z');assert.equal((await e.l.executar()).resultado,'mostrado');await e.l.executar();assert.equal(e.calls.length,1);
 const restarted=new LembretesNegocios(e.db,e.options);await restarted.executar();assert.equal(e.calls.length,1);
 e.setNow('2026-09-17T18:00:00Z');await restarted.executar();assert.equal(e.calls.length,1);
 e.setNow('2026-09-19T12:00:00Z');await restarted.executar();assert.equal(e.calls.length,2);restarted.encerrar();
 assert.deepEqual(e.calls,[{teste:false},{teste:false}]);assert.ok(!JSON.stringify(e.l.estado()).includes('SEGREDO'));
});
test('lembretes: não avisa futuro, encerrado, fonte alterada, removida ou sem leitura',async t=>{
 const e=env(t);e.on();e.setNow('2026-09-18T14:00:00Z');e.save({proximo_contato:'2026-09-19'});await e.l.executar();
 e.save({etapa:'encerrado',proximo_contato:null});await e.l.executar();
 e.save();e.db.prepare("UPDATE eventos SET texto='mudou' WHERE id=?").run(e.f);await e.l.executar();
 const p=e.n.preparar({fonte:e.f});e.n.salvar({previa:p.id,confirmar:true,revisar:true,titulo:'Atual',etapa:'proposta',proximo_contato:'2026-09-18'});
 e.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(e.f);await e.l.executar();
 e.db.prepare('DELETE FROM eventos WHERE id=?').run(e.f);await e.l.executar();assert.equal(e.calls.length,0);assert.equal(e.l.estado().ultimo,null);
});
test('lembretes: falha não vira entrega e não repete a cada minuto; teste não ativa preferência',async t=>{
 const e=env(t);e.save();e.on();e.setNow('2026-09-18T14:00:00Z');e.adapter.mostrar=async()=>{throw Error('OS failed');};
 assert.equal((await e.l.executar()).resultado,'falhou');assert.equal(e.l.estado().ultimo.resultado,'falhou');assert.equal((await e.l.executar()).resultado,'sem-aviso');
 e.l.configurar({ativo:false,hora:'09:00',confirmar:true});e.adapter.mostrar=async()=>({resultado:'mostrado'});
 assert.equal((await e.l.testar({confirmar:true})).resultado,'mostrado');assert.equal(e.l.estado().ativo,false);
 await assert.rejects(e.l.testar({confirmar:true}),/um minuto/);await assert.rejects(e.l.testar({}),/Confirme/);
});
test('lembretes: aviso em voo é invalidado ao desligar, sem duplicação concorrente',async t=>{
 const e=env(t);e.save();e.on();e.setNow('2026-09-18T14:00:00Z');let resolve;
 e.adapter.mostrar=()=>new Promise(r=>resolve=r);const pending=e.l.executar();assert.equal(e.l.estado().ultimo.resultado,'pendente');
 assert.equal((await e.l.executar()).resultado,'indisponivel');e.l.configurar({ativo:false,hora:'09:00',confirmar:true});resolve({resultado:'mostrado'});
 assert.equal((await pending).resultado,'cancelado');assert.equal(e.l.estado().ultimo.resultado,'cancelado');assert.ok(e.cancels()>=2);
});
test('lembretes: resultado desconhecido não é sucesso; encerramento impede nova entrega',async t=>{
 const e=env(t);e.save();e.on();e.setNow('2026-09-18T14:00:00Z');e.adapter.mostrar=async()=>({resultado:'talvez'});
 assert.equal((await e.l.executar()).resultado,'sem-confirmacao');e.l.encerrar();assert.equal((await e.l.executar()).resultado,'indisponivel');
});
test('lembretes: processo encerrado deixa reserva, reinício reconcilia sem inventar entrega',async t=>{
 const e=env(t);e.save();e.on();e.setNow('2026-09-18T14:00:00Z');let resolve;e.adapter.mostrar=()=>new Promise(r=>resolve=r);
 const pending=e.l.executar();e.l.encerrar();resolve({resultado:'mostrado'});await pending;assert.equal(e.l.estado().ultimo.resultado,'pendente');
 const restarted=new LembretesNegocios(e.db,e.options);assert.equal(restarted.estado().ultimo.resultado,'sem-confirmacao');assert.equal((await restarted.executar()).resultado,'sem-aviso');restarted.encerrar();
});

class FakeNotification extends EventEmitter {
 static instances=[];static isSupported=()=>true;
 constructor(options){super();this.options=options;FakeNotification.instances.push(this);}
 show(){this.showCalled=true;}close(){this.closed=true;}
}
test('notificação nativa: texto fixo, confirmação só no evento show, clique preserva janela',async()=>{
 let focus=0;const n=criarNotificacoes(FakeNotification,{focar:()=>focus++}),pending=n.mostrar({titulo:'SEGREDO',body:'R$ 5',url:'https://exemplo'}),item=FakeNotification.instances.at(-1);
 assert.equal(item.options.body,'Você tem contatos para retomar. Confira Hoje no Lume.');assert.equal(item.options.silent,true);
 item.emit('show');assert.equal((await pending).resultado,'mostrado');item.emit('click');assert.equal(focus,1);n.cancelar();item.emit('click');assert.equal(focus,1);assert.equal(item.closed,true);n.encerrar();
});
test('notificação de ação usa ID opaco e texto genérico, sem aceitar conteúdo recebido',async()=>{
 const destinos=[],id='12345678-1234-4123-8123-123456789abc',n=criarNotificacoes(FakeNotification,{focar:destino=>destinos.push(destino)});
 assert.equal((await n.mostrar({categoria:'acao',acaoId:'<script>'})).resultado,'falhou');
 const pending=n.mostrar({categoria:'acao',acaoId:id,titulo:'SEGREDO',body:'R$ 5'}),item=FakeNotification.instances.at(-1);
 assert.equal(item.options.body,'Você tem uma ação para rever. Abra o Lume.');assert.equal(item.options.silent,false);
 assert.equal(JSON.stringify(item.options).includes(id),false);
 item.emit('show');assert.equal((await pending).resultado,'mostrado');item.emit('click');assert.deepEqual(destinos,[{acaoId:id}]);n.encerrar();
});
test('aviso de captura usa a identidade do Lume sem texto privado e não substitui ação aberta',async()=>{
 const destinos=[],n=criarNotificacoes(FakeNotification,{focar:destino=>destinos.push(destino)});
 const captura=n.mostrar({categoria:'captura',body:'SEGREDO R$ 450',som:true}),item=FakeNotification.instances.at(-1);
 assert.equal(item.options.title,'Lume');
 assert.equal(item.options.body,'A chegada de mensagens ficou estável. Confira o andamento no Lume.');
 assert.equal(item.options.silent,true);
 item.emit('show');assert.equal((await captura).resultado,'mostrado');
 item.emit('click');assert.deepEqual(destinos,[{categoria:'captura'}]);
 const id='12345678-1234-4123-8123-123456789abc',acao=n.mostrar({categoria:'acao',acaoId:id});
 const acaoItem=FakeNotification.instances.at(-1);
 assert.equal((await n.mostrar({categoria:'desconhecida'})).resultado,'falhou');
 assert.equal((await n.mostrar({categoria:'captura'})).resultado,'cancelado');
 assert.equal(FakeNotification.instances.at(-1),acaoItem);
 assert.equal(acaoItem.closed,undefined);
 acaoItem.emit('show');assert.equal((await acao).resultado,'mostrado');n.encerrar();
});

test('aviso de ação respeita preferência de som sem expor conteúdo',async()=>{
 const n=criarNotificacoes(FakeNotification),id='12345678-1234-4123-8123-123456789abc';
 const pending=n.mostrar({categoria:'acao',acaoId:id,som:false}),item=FakeNotification.instances.at(-1);
 assert.equal(item.options.silent,true);assert.equal(JSON.stringify(item.options).includes(id),false);
 item.emit('show');assert.equal((await pending).resultado,'mostrado');n.encerrar();
});
test('notificação nativa: falha/cancelamento/tempo sem confirmação têm resultado explícito',async()=>{
 const n=criarNotificacoes(FakeNotification,{timeout:20});let pending=n.mostrar({teste:true}),item=FakeNotification.instances.at(-1);assert.match(item.options.body,/teste/);item.emit('failed');assert.equal((await pending).resultado,'falhou');
 pending=n.mostrar();item=FakeNotification.instances.at(-1);n.cancelar();item.emit('show');assert.equal((await pending).resultado,'cancelado');
 pending=n.mostrar();await new Promise(r=>setTimeout(r,30));assert.equal((await pending).resultado,'sem-confirmacao');assert.equal(FakeNotification.instances.at(-1).closed,true);n.encerrar();assert.equal((await n.mostrar()).resultado,'falhou');
});
test('ponte: correlação, resposta desconhecida, cancelamento e fechamento não vazam conteúdo',async()=>{
 const port=new EventEmitter(),sent=[];port.postMessage=m=>sent.push(m);const b=criarPonteLembretes(port,{suportado:true});
 let p=b.mostrar({teste:true});let msg=sent.at(-1);assert.deepEqual(Object.keys(msg).sort(),['categoria','id','teste','tipo']);assert.equal(msg.categoria,'contato');port.emit('message',{data:{tipo:'lembrete-resposta',id:'outro',resultado:'mostrado'}});port.emit('message',{data:{tipo:'lembrete-resposta',id:msg.id,resultado:'invalido'}});assert.equal((await p).resultado,'sem-confirmacao');
 p=b.mostrar();b.cancelar();assert.equal((await p).resultado,'cancelado');b.encerrar();assert.equal(port.listenerCount('message'),0);assert.equal(b.disponivel(),false);
});
test('ponte de ação transmite somente ID opaco validado',async()=>{
 const port=new EventEmitter(),sent=[];port.postMessage=m=>sent.push(m);const ponte=criarPonteLembretes(port,{suportado:true});
 assert.equal((await ponte.mostrar({categoria:'acao',acaoId:'texto privado'})).resultado,'falhou');assert.equal(sent.length,0);
 const acaoId='12345678-1234-4123-8123-123456789abc',pending=ponte.mostrar({categoria:'acao',acaoId,body:'segredo'}),message=sent.at(-1);
 assert.deepEqual(Object.keys(message).sort(),['acaoId','categoria','id','som','teste','tipo']);assert.equal(message.acaoId,acaoId);assert.equal(message.som,true);assert.equal(JSON.stringify(message).includes('segredo'),false);
 port.emit('message',{data:{tipo:'lembrete-resposta',id:message.id,resultado:'mostrado'}});assert.equal((await pending).resultado,'mostrado');ponte.encerrar();
});
test('ponte de captura transmite só a categoria e não aceita texto recebido',async()=>{
 const port=new EventEmitter(),sent=[];port.postMessage=m=>sent.push(m);const ponte=criarPonteLembretes(port,{suportado:true});
 const pending=ponte.mostrar({categoria:'captura',body:'SEGREDO R$ 450'}),message=sent.at(-1);
 assert.deepEqual(Object.keys(message).sort(),['categoria','id','teste','tipo']);
 assert.equal(message.categoria,'captura');assert.equal(JSON.stringify(message).includes('SEGREDO'),false);
 port.emit('message',{data:{tipo:'lembrete-resposta',id:message.id,resultado:'mostrado'}});
 assert.equal((await pending).resultado,'mostrado');ponte.encerrar();
});
test('ponte: porta encerrada não deixa promessa pendurada ou exceção no timer',async()=>{
 const port=new EventEmitter();port.postMessage=()=>{throw Error('closed');};const b=criarPonteLembretes(port,{suportado:true});assert.equal((await b.mostrar()).resultado,'falhou');b.encerrar();b.encerrar();
});

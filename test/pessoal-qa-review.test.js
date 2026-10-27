// Independent review fixtures: memory-only SQLite, injected transport/fetch,
// and the production status function in a minimal VM; no accounts or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {Privacidade} from '../src/privacidade.js';
import {prepararIndiceFontes} from '../src/fontes-desktop.js';
import {Conexao} from '../src/transporte/socket.js';
import {ChatGPTPessoal} from '../src/pessoal/chatgpt.js';
import {AvaliacaoPessoal} from '../src/pessoal/avaliacao-runtime.js';
import {prepararPessoal} from '../src/pessoal/esquema.js';
import {salvarNomesWhatsapp,criarNomeVisivel} from '../src/nomes-conversa.js';
import {registrarPessoa} from '../src/pessoas.js';
import {chaveExclusao} from '../src/exclusoes.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const PN='5511000000000@s.whatsapp.net',LID='123456789@lid';
const message=(id,pushName)=>({key:{id,remoteJid:PN,fromMe:false},pushName,
  messageTimestamp:1793000000,message:{conversation:'Conteudo sintetico da revisao'}});
async function transportFixture(t){
  const db=abrirBanco(),contexto=new ContextoApp(db),socket={ev:new EventEmitter(),end(){}};
  const conexao=new Conexao({authDir:'fixture-sem-sessao',criarSocket:async()=>socket,
    aoNomes:lote=>salvarNomesWhatsapp(db,lote),aoLote:lote=>contexto.receber(lote)});
  t.after(async()=>{await conexao.encerrar();db.close();});await conexao.iniciar();
  return {db,socket,conexao};
}

test('review: ingestao por alias fraco preserva nome manual canonico',async t=>{
  const {db,socket,conexao}=await transportFixture(t);
  salvarNomesWhatsapp(db,{contacts:[{id:LID,notify:'Inicial Fixture',phoneNumber:PN}]});
  registrarPessoa(db,{identificador:LID,nomeCru:'Manual Fixture',origem:'manual'});
  assert.equal(criarNomeVisivel(db)(null,PN),'Manual Fixture');
  socket.ev.emit('messages.upsert',{type:'notify',messages:[message('alias-review','Mensagem Fixture')]});
  await conexao.parar();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n,1);
  assert.equal(criarNomeVisivel(db)(null,PN),'Manual Fixture');
});

test('review: replay de evento excluido nao recupera seu pushName',async t=>{
  const {db,socket,conexao}=await transportFixture(t);
  db.prepare('INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)')
    .run(chaveExclusao(PN,'deleted-review'),'2026-10-26T12:00:00Z');
  socket.ev.emit('messages.upsert',{type:'notify',messages:[message('deleted-review','Nome Excluido')]});
  await conexao.parar();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n,0,'a mensagem segue excluida');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pessoas').get().n,0,'seu nome tambem deve seguir excluido');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM conversas_app').get().n,0);
});

for(const {explicitAlias,independent} of [{explicitAlias:false,independent:false},{explicitAlias:true,independent:false},{explicitAlias:true,independent:true}])test(`review: exclusao da fonte limpa nome e alias${explicitAlias?' explicito':''}${independent?' preservando fonte independente':''}`,async t=>{
  const {db,socket,conexao}=await transportFixture(t);
  new Desktop(db);new DesktopIA(db);
  const grupo='12000000000@g.us',deleted=message('deleted-review','Nome Excluido');
  deleted.key={...deleted.key,remoteJid:grupo,participant:explicitAlias?LID:PN,...(explicitAlias?{participantAlt:PN}:{})};
  const retained=message('retained-review','Nome Preservado');
  retained.key={...retained.key,remoteJid:grupo,participant:'5511000000001@s.whatsapp.net'};
  socket.ev.emit('messages.upsert',{type:'append',messages:[deleted,retained,...(independent?[message('independent-review','Fonte Independente')]:[])]});await tick();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n,independent?3:2);
  const privacidade=new Privacidade(db),id=db.prepare('SELECT id FROM eventos WHERE origem_id=?').get('deleted-review').id;
  const preview=privacidade.preparar({fonte:id});privacidade.excluir({id:preview.id,confirmar:'APAGAR'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pessoa_identificadores WHERE identificador=?').get(PN).n,independent?1:0,'exclusao deve distinguir identidade sem fonte de identidade ainda referenciada');
  assert.equal(criarNomeVisivel(db)(null,PN),independent?'Fonte Independente':'Contato sem nome','nenhum cache de conversa pode reter o nome excluido');
  socket.ev.emit('messages.upsert',{type:'append',messages:[deleted]});
  await conexao.parar();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n,independent?2:1,'a mensagem excluida nao voltou');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pessoa_identificadores WHERE identificador=?').get(PN).n,independent?1:0,'replay nao muda suporte da identidade');
  assert.equal(criarNomeVisivel(db)(null,PN),independent?'Fonte Independente':'Contato sem nome');
});

test('review: encerrar aborta catalogo cujo corpo ainda esta chegando',{timeout:5000},async t=>{
  const db=abrirBanco(),now=Date.parse('2026-10-26T12:00:00Z');
  let body,requestSignal,received;
  const headersReceived=new Promise(resolve=>{received=resolve;});
  const saved=JSON.stringify({version:1,active:'oaiapp_review',accounts:[{
    client_id:'oaiapp_review',subject:'subject-synthetic',email:'test@example.invalid',
    access_token:'access-secret-synthetic',refresh_token:'refresh-secret-synthetic',id_token:'id-secret-synthetic',
    scopes:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'.split(' '),expires_at:now+3600000
  }]});
  const client=new ChatGPTPessoal(db,{agora:()=>now,cofre:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>saved},
    fetchImpl:async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/models');requestSignal=options.signal;
      const response=new Response(new ReadableStream({start(controller){body=controller;
        options.signal.addEventListener('abort',()=>controller.error(new Error('synthetic abort')),{once:true});
      }}));received();return response;
    }});
  t.after(()=>{client.encerrar();db.close();});
  const pending=client.modelos().then(value=>({value}),error=>({error}));
  await headersReceived;await tick();client.encerrar();
  const aborted=requestSignal.aborted;
  if(!aborted){body.enqueue(new TextEncoder().encode('{"models":[]}'));body.close();}
  const outcome=await pending;
  assert.ok(outcome.error,'resultado tardio nao pode ser aplicado');
  assert.equal(aborted,true,'encerrar deve interromper a leitura imediatamente');
});

for(const state of ['conectando','reconectando','aguardando_qr'])test(`review: captura pode ser pausada durante ${state}`,async()=>{
  const source=readFileSync(new URL('../src/painel/app.js',import.meta.url),'utf8');
  const start=source.indexOf('async function status() {'),end=source.indexOf('function limparQr()',start);
  assert.ok(start>=0&&end>start);
  const nodes=new Map();
  const get=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{},textContent:'',hidden:false,disabled:false,querySelector(){return null;}});return nodes.get(id);};
  const sandbox={$:get,api:async()=>({conexao:{estado:state}}),atualizarConexaoCabecalho(){},window:{},connecting:false,estadoConexaoAnterior:undefined};
  vm.createContext(sandbox);
  await vm.runInContext(source.slice(start,end)+'\nstatus()',sandbox);
  assert.equal(get('disconnect').disabled,false,'o controle de pausa deve estar acessivel durante uma tentativa ativa');
});

test('review: busca multiterma com FTS revalida permissao e preserva cursor por data',t=>{
  const db=abrirBanco();new ContextoApp(db);const desktop=new Desktop(db);t.after(()=>db.close());
  prepararIndiceFontes(db);
  const insert=(id,date,text,permissao='dirigida')=>Number(db.prepare(`INSERT INTO eventos
    (conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(? ,?,'entrada','texto','{}',?,?,?,?)`).run(PN,id,text,date,date.slice(0,10),permissao).lastInsertRowid);
  const fresh=insert('fresh','2026-10-26T10:00:00Z','Revisar orçamento da entrega');
  insert('unrelated','2026-10-26T11:00:00Z','Saudacao sem assunto');
  insert('hidden','2026-10-26T12:00:00Z','Orçamento entrega',null);
  const old=insert('history-late','2026-01-01T10:00:00Z','Entrega com orçamento anterior');
  const first=desktop.buscar({q:'entrega orcamento',limite:1});
  assert.deepEqual(first.mensagens.map(m=>m.id),[fresh]);
  assert.deepEqual(desktop.buscar({q:'entrega orcamento',antes:first.proximoAntes,limite:1}).mensagens.map(m=>m.id),[old]);
  db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(fresh);
  assert.deepEqual(desktop.buscar({q:'entrega orcamento'}).mensagens.map(m=>m.id),[old]);
  assert.deepEqual(desktop.buscar({q:'entrega orcamento',antes:fresh}).mensagens,[]);
});

test('review: recibo response_id sem requestId permanece valido ao reler avaliacao',async t=>{
  const db=abrirBanco();prepararPessoal(db);t.after(()=>db.close());
  const model='modelo-sintetico-review';
  db.prepare("INSERT INTO desktop_config VALUES('pessoal-chatgpt-model',?)").run(model);
  let calls=0;
  const chatgpt={estado:async()=>({connected:true,planEnabled:true,model,paused:false}),
    responder:async()=>({completed:true,model,requestId:null,responseId:'resp_synthetic_'+(++calls),text:'Resposta sintetica'})};
  const avaliacao=new AvaliacaoPessoal(db,{chatgpt,instrucoes:'Contrato sintetico'});
  const initial=await avaliacao.iniciar({confirmar:true});
  const first=await avaliacao.proximo();
  assert.equal(first.executados,1,'hash deve conferir tambem quando reciboTipo esta presente');
  const reopened=new AvaliacaoPessoal(db,{chatgpt,instrucoes:'Contrato sintetico'});
  assert.equal(reopened.estado().id,initial.id);
  assert.equal(reopened.estado().liberada,false);
  assert.equal((await reopened.proximo()).executados,2);
});

async function verificarPrazoResponses(t,{atraso,conclui}){
  // Scale only AbortSignal deadlines and the synthetic provider by 100. Native
  // fetch is never used; 650 ms represents a completed response at 65 seconds.
  const timeout=AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal,'timeout',milliseconds=>timeout(Math.ceil(milliseconds/100)));
  const db=abrirBanco(),now=Date.parse('2026-10-26T12:00:00Z');
  const saved=JSON.stringify({version:1,active:'oaiapp_review',accounts:[{
    client_id:'oaiapp_review',subject:'subject-synthetic',email:'test@example.invalid',
    access_token:'access-secret-synthetic',refresh_token:'refresh-secret-synthetic',id_token:'id-secret-synthetic',
    scopes:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'.split(' '),expires_at:now+3600000
  }]});
  let providerTimer;
  const client=new ChatGPTPessoal(db,{agora:()=>now,cofre:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>saved},
    fetchImpl:async(url,options)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      return new Response(new ReadableStream({start(controller){
        const abort=()=>{clearTimeout(providerTimer);controller.error(new Error('synthetic deadline'));};
        options.signal.addEventListener('abort',abort,{once:true});
        providerTimer=setTimeout(()=>{
          options.signal.removeEventListener('abort',abort);
          controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',id:'resp_synthetic_slow',output:[{content:[{type:'output_text',text:'Resposta sintetica completa'}]}]}})+'\n\n'));
          controller.close();
        },atraso);
      },cancel(){clearTimeout(providerTimer);}}),{headers:{'content-type':'text/event-stream'}});
    }});
  t.after(()=>{clearTimeout(providerTimer);client.encerrar();db.close();});
  db.prepare("INSERT INTO desktop_config VALUES('pessoal-chatgpt-model','modelo-sintetico-review')").run();
  const pending=client.responder({instructions:'Somente texto sintetico',input:[{role:'user',content:'Teste sintetico'}]});
  if(conclui){const result=await pending;assert.equal(result.completed,true);assert.equal(result.text,'Resposta sintetica completa');}
  else await assert.rejects(pending,{code:'stream_interrompido'});
}
test('review: Responses conclui entre 30s e 120s sem ser cortado pelo prazo de JSON',{timeout:5000},t=>verificarPrazoResponses(t,{atraso:650,conclui:true}));
test('review: Responses mantem prazo finito antes de uma resposta de 150s',{timeout:5000},t=>verificarPrazoResponses(t,{atraso:1500,conclui:false}));

test('review: catalogo continuo cancela produtor ao atingir limite e libera controller',{timeout:5000},async t=>{
  const db=abrirBanco(),now=Date.parse('2026-10-26T12:00:00Z');
  const saved=JSON.stringify({version:1,active:'oaiapp_review',accounts:[{
    client_id:'oaiapp_review',subject:'subject-synthetic',email:'test@example.invalid',
    access_token:'access-secret-synthetic',refresh_token:'refresh-secret-synthetic',id_token:'id-secret-synthetic',
    scopes:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'.split(' '),expires_at:now+3600000
  }]});
  let pulls=0,cancelled=false;
  const client=new ChatGPTPessoal(db,{agora:()=>now,cofre:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>saved},
    fetchImpl:async()=>new Response(new ReadableStream({
      pull(controller){pulls++;controller.enqueue(new Uint8Array(64*1024));},cancel(){cancelled=true;}
    }))});
  t.after(()=>{client.encerrar();db.close();});
  await assert.rejects(client.modelos(),{code:'resposta_grande_demais'});
  assert.equal(cancelled,true,'produtor infinito deve receber cancelamento');
  assert.ok(pulls<=36,'leitura limitada a 2 MiB mais pequena fila de streaming');
  assert.equal(client.controllers.size,0);
});

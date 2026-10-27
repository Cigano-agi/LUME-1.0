import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {TelegramDiario} from '../src/pessoal/telegram-diario.js';
import {Conexao} from '../src/transporte/socket.js';
import {ChatGPTPessoal} from '../src/pessoal/chatgpt.js';

const DM='551100000001@s.whatsapp.net',OWNER='123456789',BOT='987654321';
const TEXT='Pode conferir o relatório sintético antes da resposta?';
const update=text=>({update_id:1,message:{message_id:1,chat:{type:'private',id:Number(OWNER)},from:{id:Number(OWNER)},text}});
async function fixture(t,{fetchImpl,model}={}){
  const db=abrirBanco(),contexto=new ContextoApp(db),desktop=new Desktop(db);
  desktop.aceitar({nome:'Revisão sintética',aceito:true,versao:VERSAO_TERMOS});
  let now=new Date();const calls=[],sent=[];
  const diario=new TelegramDiario(db,{botId:BOT,donoId:OWNER});
  const pessoal=new LumePessoal(db,{desktop,agora:()=>now,credencial:async()=> 'synthetic-credential',
    fetchImpl:fetchImpl||(async()=>{throw Error('Unexpected network');}),
    telegram:{estado:async()=>({enabled:true}),agendar:(...args)=>diario.agendar(...args)},
    chatgpt:{estado:async()=>({connected:true}),encerrar(){},responder:async request=>{
      calls.push(request);if(model)return model(request);
      const input=JSON.parse(request.input.at(-1).content);
      return {completed:true,text:JSON.stringify({decisao:'consultar_dono',resumo:'Conferir relatório sintético',
        trecho:input.mensagemAtual.texto,baloes:['Vou conferir o relatório sintético.'],fontes:[input.mensagemAtual.id],motivo:'Decisão sintética'})};
    }},conexao:{enviarTexto:async(jid,text,id)=>{sent.push({jid,text,id});return id;}}});
  t.after(async()=>{await pessoal.encerrar();db.close();});
  await pessoal.configurar({enabled:true});
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(DM,'Cliente conhecido');
  const allow=(remoto=true)=>pessoal.configurarConversa({conversaId:DM,categoria:'lead',modo:'rascunhar',remoto});allow();
  const receive=(text=TEXT)=>{
    contexto.receber({type:'notify',messages:[{key:{remoteJid:DM,id:'source-'+Math.random(),fromMe:false},messageTimestamp:Math.floor(now.getTime()/1000),message:{conversation:text}}]});
    const e=db.prepare('SELECT id FROM eventos ORDER BY id DESC LIMIT 1').get();
    now=new Date(db.prepare("SELECT proxima_tentativa_em FROM etapas WHERE evento_id=? AND etapa='assistencia'").get(e.id).proxima_tentativa_em);return e.id;
  };
  const proposal=async()=>{receive();await pessoal.tick();const p=db.prepare('SELECT * FROM pessoal_propostas ORDER BY criada_em DESC LIMIT 1').get();assert.ok(p);return p;};
  return {db,contexto,pessoal,diario,calls,sent,allow,receive,proposal};
}

test('revisão: recusa do dono após aprovação e antes do transporte impede envio',async t=>{
  const f=await fixture(t),p=await f.proposal();f.pessoal.aprovar(p.id,p.conteudo_hash.slice(0,12),OWNER);
  const reply=await f.pessoal.conversar(update('recusar '+p.id),{diario:f.diario,signal:new AbortController().signal});
  assert.ok(reply);await f.pessoal.tick();
  assert.equal(f.sent.length,0,'recusa posterior à aprovação revoga despacho ainda não iniciado');
  assert.notEqual(f.pessoal.proposta(p.id).estado,'aprovada');
});

test('revisão: revogação enquanto ferramenta consulta impede envio posterior de contexto ao modelo',async t=>{
  let release;const f=await fixture(t,{fetchImpl:async()=>{
    await new Promise(resolve=>release=resolve);
    return new Response(JSON.stringify({id:'task1',name:'Tarefa sintética',status:{status:'open'}}),{status:200});
  }});
  f.pessoal.ferramentas.vincular({conversaId:DM,tipo:'clickup',recurso:'task1'});
  f.receive('INFORMACAO_PRIVADA_REVOGADA: '+TEXT);
  const running=f.pessoal.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');
  f.allow(false);release();await running;
  assert.equal(f.calls.length,0,'contexto foi revogado antes de qualquer requisição ao modelo');
});

test('revisão: autorização no limite Baileys vincula o texto ao conteúdo aprovado',async t=>{
  const f=await fixture(t),p=await f.proposal();f.pessoal.aprovar(p.id,p.conteudo_hash.slice(0,12),OWNER);
  const waId='A'.repeat(40),approved=JSON.parse(p.baloes)[0];
  const row=f.pessoal.saidas.preparar({conversaId:DM,corpo:approved,idempotencia:'transport-review'});
  f.db.prepare('INSERT INTO pessoal_proposta_saidas(proposta_id,ordem,saida_id,wa_id,atualizado_em) VALUES(?,0,?,?,?)').run(p.id,row.id,waId,new Date().toISOString());
  f.db.prepare("UPDATE saidas SET estado='incerta',motivo=? WHERE id=?").run(waId,row.id);
  const sends=[],socket={ev:new EventEmitter(),end(){},sendMessage:async(jid,body,options)=>{sends.push({jid,body,options});return {key:{id:options.messageId}};}};
  const conexao=new Conexao({authDir:'synthetic-review-only',aoLote:()=>({}),criarSocket:async()=>socket,
    autorizarEnvio:(...args)=>f.pessoal.autorizarTransporte(...args)});
  t.after(()=>conexao.encerrar());await conexao.iniciar();socket.ev.emit('connection.update',{connection:'open'});
  await assert.rejects(conexao.enviarTexto(DM,'CONTEUDO_NAO_APROVADO',waId));
  assert.equal(sends.length,0);
});

test('revisão: pergunta sobre conversa inexistente não inclui fontes de outra conversa',async t=>{
  const f=await fixture(t,{model:async()=>({completed:true,text:JSON.stringify({resposta:'Sem fonte suficiente.',acompanhar:null})})});
  f.receive('SEGREDO_DE_OUTRA_CONVERSA: '+TEXT);
  await f.pessoal.conversar(update('O que ficou combinado com Cliente Inexistente?'),{diario:f.diario,signal:new AbortController().signal});
  assert.doesNotMatch(JSON.stringify(f.calls),/SEGREDO_DE_OUTRA_CONVERSA/,'recorte nominal não resolvido deve esclarecer a conversa');
});

test('revisão: revogação durante obtenção do token impede despacho Responses com fonte privada',async t=>{
  const f=await fixture(t);let release;const requests=[];
  const account={client_id:'oaiapp_review',subject:'subject-synthetic',access_token:'synthetic-access-token',
    scopes:['resource.invoke','chatgpt.tokens.use.direct'],expires_at:Date.now()+3600000};
  const cofre={estado:()=>new Promise(resolve=>{release=()=>resolve({disponivel:true,configurada:true});}),
    ler:async()=>JSON.stringify({version:1,active:account.client_id,accounts:[account]}),gravar:async()=>{}};
  f.pessoal.chatgpt=new ChatGPTPessoal(f.db,{cofre,fetchImpl:async(url,options)=>{
    requests.push({url,body:options.body});
    const e={type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text:'{}'}]}]}};
    return new Response('data: '+JSON.stringify(e)+'\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  f.db.prepare("INSERT INTO desktop_config VALUES('pessoal-chatgpt-model','gpt-6-astra')").run();
  f.receive('DADO_REVOGADO_DURANTE_COFRE: '+TEXT);
  const running=f.pessoal.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');
  f.allow(false);release();await running;
  assert.equal(requests.length,0,'direitos devem ser conferidos no último limite anterior à requisição externa');
});

// O gate e o modelo abaixo são mocks explícitos: provam somente a integração
// do serviço, nunca avaliação real de qualidade nem autorização de produção.
const autonomousReply=decisao=>async request=>{
  const input=JSON.parse(request.input.at(-1).content);
  return {completed:true,text:JSON.stringify({decisao,resumo:'Conferir relatório sintético',
    trecho:input.mensagemAtual.texto,baloes:['Vou conferir o relatório sintético.'],
    fontes:[input.mensagemAtual.id],motivo:'Decisão de teste sem execução real'})};
};
for(const scenario of [
  {name:'atender + responder + gate vigente',modo:'atender',decisao:'responder',liberada:true,approved:true},
  {name:'gate fechado',modo:'atender',decisao:'responder',liberada:false},
  {name:'rascunhar',modo:'rascunhar',decisao:'responder',liberada:true},
  {name:'consultar dono',modo:'atender',decisao:'consultar_dono',liberada:true},
  {name:'passivo',modo:'atender',decisao:'passivo',liberada:true},
  {name:'lacuna de áudio anterior',modo:'atender',decisao:'responder',liberada:true,lacuna:true},
  {name:'ferramenta indisponível',modo:'atender',decisao:'responder',liberada:true,ferramenta:true},
])test('autonomia integrada (mock explícito): '+scenario.name,async t=>{
  const f=await fixture(t,{model:autonomousReply(scenario.decisao)});
  f.pessoal.avaliacao.estado=()=>({liberada:scenario.liberada,id:'avaliacao-sintetica'});
  f.pessoal.configurarConversa({conversaId:DM,categoria:'lead',modo:scenario.modo,remoto:true});
  if(scenario.lacuna){
    f.contexto.receber({type:'append',messages:[{key:{remoteJid:DM,id:'audio-historico',fromMe:false},
      messageTimestamp:Math.floor(Date.now()/1000)-60,message:{audioMessage:{mimetype:'audio/ogg',seconds:2}}}]});
    assert.ok(f.pessoal.contexto.recuperar({conversaId:DM,remoto:true}).lacunas.some(l=>l.tipo==='audio_pendente'));
  }
  if(scenario.ferramenta)f.pessoal.ferramentas.vincular({conversaId:DM,tipo:'clickup',recurso:'task1'});
  if(scenario.decisao==='passivo'){
    const eventoId=f.receive();await f.pessoal.tick();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n,0);
    assert.ok(f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(eventoId));
    await f.pessoal.tick();assert.equal(f.sent.length,0);return;
  }
  const p=await f.proposal();assert.equal(p.estado,scenario.approved?'aprovada':'pendente');
  if(scenario.approved)assert.equal(p.aprovada_por,'avaliacao:avaliacao-sintetica');
  await f.pessoal.tick();assert.equal(f.sent.length,scenario.approved?1:0);
});

for(const change of ['fechar gate','trocar avaliação','trocar modelo'])test('autonomia integrada (mock explícito): '+change+' antes do envio cancela proposta automática',async t=>{
  const f=await fixture(t,{model:autonomousReply('responder')});
  let quality={liberada:true,id:'avaliacao-sintetica'};
  f.db.prepare("INSERT INTO desktop_config VALUES('pessoal-chatgpt-model','modelo-sintetico')").run();
  f.pessoal.avaliacao.estado=()=>({...quality,liberada:quality.liberada&&f.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-chatgpt-model'").get().valor==='modelo-sintetico'});
  f.pessoal.configurarConversa({conversaId:DM,categoria:'lead',modo:'atender',remoto:true});
  const p=await f.proposal();assert.equal(p.estado,'aprovada');
  if(change==='fechar gate')quality.liberada=false;
  else if(change==='trocar avaliação')quality.id='outra-avaliacao-sintetica';
  else f.db.prepare("UPDATE desktop_config SET valor='outro-modelo-sintetico' WHERE chave='pessoal-chatgpt-model'").run();
  await f.pessoal.tick();assert.equal(f.sent.length,0);assert.equal(f.pessoal.proposta(p.id).estado,'cancelada');
});

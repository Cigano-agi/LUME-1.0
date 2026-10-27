import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { criarServidor } from '../src/painel/servidor.js';
import { NegociosDesktop } from '../src/negocios-desktop.js';
import { VendasJev } from '../src/vendas/servico.js';
import { avaliarComJev,interpretarJev,JEV_ENDPOINT,CRITERIOS_TEMPERATURA,CRITERIOS_ETAPA } from '../src/vendas/jev.js';
const { criarCofre }=createRequire(import.meta.url)('../desktop/segredos.cjs');
const chave='sk-or-v1-'+'a'.repeat(64);
const answer=(criteria,value)=>({type:'choice',choice:value,confidence:.9,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===value?1:0]))});
const resposta=()=>({model:'typesafe/jev-1.14-20261014',answers:{temperatura:answer(CRITERIOS_TEMPERATURA,'quente'),etapa:answer(CRITERIOS_ETAPA,'proposta')},usage:{cost:.00002}});
const fontes=[{id:1,texto:'Sim, pode mandar a proposta amanhã.',recebido_em:'2026-09-25T10:00:00Z',autor_e_dono:0}];

test('Jev usa API de decisões, versão fixa e apenas contexto confirmado',async()=>{
  let capturado;
  const r=await avaliarComJev({fontes,chave,confirmar:true,fetch:async(url,opcoes)=>{capturado={url,...opcoes};return Response.json(resposta());}});
  assert.equal(capturado.url,JEV_ENDPOINT);assert.equal(capturado.redirect,'error');
  const body=JSON.parse(capturado.body);assert.equal(body.model,'typesafe/jev-1.14');assert.equal(body.state[0].papel,'contato');
  assert.equal(Object.hasOwn(body,'messages'),false);assert.equal(r.temperatura,'quente');assert.equal(r.calibracao,'nao_validada_no_lume');
  assert.doesNotMatch(JSON.stringify(r),/sk-or-v1/);
});

test('sem consentimento, recorte excessivo ou resposta inválida não há classificação inventada',async()=>{
  let calls=0;const fetch=async()=>{calls++;return Response.json({});};
  await assert.rejects(avaliarComJev({fontes,chave,fetch}),{code:'JEV_SEM_CONSENTIMENTO'});
  await assert.rejects(avaliarComJev({fontes:[{...fontes[0],texto:'a'.repeat(25000)}],chave,confirmar:true,fetch}),{code:'JEV_CONTEXTO_LONGO'});
  assert.equal(calls,0);
  const wrong=resposta();wrong.answers.temperatura.probabilities.quente=4;
  assert.throws(()=>interpretarJev(wrong),{code:'JEV_RESPOSTA_INVALIDA'});
  assert.throws(()=>interpretarJev({...resposta(),model:'outro/modelo'}),{code:'JEV_MODELO_DIVERGENTE'});
  await assert.rejects(avaliarComJev({fontes,chave,confirmar:true,fetch:async()=>new Response('token secreto',{status:401})}),{code:'JEV_CHAVE_RECUSADA'});
});

function setup(t,avaliar) {
  const db=abrirBanco();t.after(()=>db.close());const contexto=new ContextoApp(db);new Desktop(db);
  const inserir=(id,texto='Vamos conversar sobre a proposta.',jid='5511@s.whatsapp.net',fromMe=false)=>contexto.receber({type:'notify',messages:[{key:{id,remoteJid:jid,fromMe},messageTimestamp:1790326800,message:{conversation:texto}}]});
  inserir('primeira');const service=new VendasJev(db,{segredos:{ler:async()=>chave,estado:async()=>({disponivel:true,configurada:true})},avaliar:avaliar??(async()=>interpretarJev(resposta()))});
  return {db,service,inserir};
}
test('avaliação preserva origem, persiste no reinício e não muda pipeline confirmado',async t=>{
  const {db,service}=setup(t);const negocios=new NegociosDesktop(db),revisao=negocios.preparar({fonte:1});
  negocios.salvar({previa:revisao.id,confirmar:true,titulo:'Proposta sintética',etapa:'interesse'});
  const antes=JSON.stringify(db.prepare('SELECT * FROM desktop_negocios').all());
  const previa=service.preparar({conversa_id:'5511@s.whatsapp.net'});
  const r=await service.avaliar({previa_id:previa.id,confirmar:true});assert.equal(r.temperatura,'quente');assert.deepEqual(r.fontes,[1]);
  const retomado=new VendasJev(db);assert.equal(retomado.obter({conversa_id:'5511@s.whatsapp.net'}).id,r.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lume_vendas_avaliacoes").get().n,1);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM desktop_negocios').all()),antes);
});
test('fontes alteradas entre prévia e confirmação bloqueiam antes de enviar',async t=>{
  let enviados=0;const {service,inserir}=setup(t,async()=>{enviados++;return interpretarJev(resposta());});
  const p=service.preparar({conversa_id:'5511@s.whatsapp.net'});inserir('nova','Cancelar a proposta.');
  await assert.rejects(service.avaliar({previa_id:p.id,confirmar:true}),{code:'JEV_FONTE_ALTERADA'});assert.equal(enviados,0);
});
test('revogação durante resposta impede gravar e apagar fonte remove avaliações',async t=>{
  let liberar;const {db,service}=setup(t,()=>new Promise(r=>liberar=r));
  const p=service.preparar({conversa_id:'5511@s.whatsapp.net'});const pending=service.avaliar({previa_id:p.id,confirmar:true});
  await new Promise(r=>setImmediate(r));db.prepare('DELETE FROM eventos').run();liberar(interpretarJev(resposta()));
  await assert.rejects(pending,{code:'JEV_FONTE_ALTERADA'});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lume_vendas_avaliacoes').get().n,0);
});
test('terceiro de grupo não aparece na prévia e mudança posterior oculta classificação antiga',async t=>{
  const {service,inserir}=setup(t);inserir('terceiro','texto restrito','grupo@g.us');
  assert.throws(()=>service.preparar({conversa_id:'grupo@g.us'}),{code:'JEV_SEM_FONTES'});
  const p=service.preparar({conversa_id:'5511@s.whatsapp.net'});await service.avaliar({previa_id:p.id,confirmar:true});
  inserir('mudanca','Não tenho mais interesse.');const r=service.obter({conversa_id:'5511@s.whatsapp.net'});
  assert.equal(r.desatualizada,true);assert.equal(r.temperatura,'insuficiente');assert.deepEqual(r.fontes,[]);
});
test('correção manual registra histórico e não treina nem chama modelo',async t=>{
  let calls=0;const {service,db}=setup(t,async()=>{calls++;return interpretarJev(resposta());});
  const r=service.corrigir({conversa_id:'5511@s.whatsapp.net',temperatura:'morno',etapa:'interesse',confirmar:true});
  assert.equal(r.origem,'manual');assert.equal(r.confianca,null);assert.equal(calls,0);
  service.corrigir({conversa_id:'5511@s.whatsapp.net',temperatura:'frio',etapa:'encerrado',confirmar:true});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lume_vendas_avaliacoes').get().n,2);
});
test('cofre OpenRouter isolado de Gemini, cifrado e sem plaintext fallback',t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-openrouter-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const valores=new Map();let i=0;const safe={isEncryptionAvailable:()=>true,encryptString:value=>{const id='cifra'+ ++i;valores.set(id,value);return Buffer.from(id);},decryptString:bytes=>valores.get(bytes.toString())};
  const cofre=criarCofre(dir,safe);cofre.executar('gravar','gemini-sintetico-123456789');cofre.executar('openrouter-gravar',chave);
  assert.equal(cofre.executar('openrouter-ler'),chave);assert.doesNotMatch(readFileSync(join(dir,'openrouter.seguro'),'utf8'),/sk-or-v1/);
  cofre.executar('openrouter-remover');assert.equal(cofre.executar('ler'),'gemini-sintetico-123456789');
  assert.throws(()=>criarCofre(dir,{isEncryptionAvailable:()=>false}).executar('openrouter-gravar',chave),/indisponível/);
});

async function httpFixture(t, avaliarJev) {
  const db = abrirBanco(), contexto = new ContextoApp(db), desktop = new Desktop(db);
  contexto.receber({type:'notify',messages:[{
    key:{id:'http-sintetico',remoteJid:'5511@s.whatsapp.net',fromMe:false},
    messageTimestamp:1790326800,message:{conversation:'Pode mandar a proposta. Quero avançar.'}
  }]});
  let configurada = false, chamadas = 0;
  const segredosJev = {
    estado:async()=>({disponivel:true,configurada}),
    gravar:async valor=>{assert.equal(valor,chave);configurada=true;},
    ler:async()=>{if(!configurada)throw Error('SEGREDO_NAO_DEVE_APARECER');return chave;},
    remover:async()=>{configurada=false;}
  };
  const server = criarServidor(db, {desktop:true,contexto,segredosJev,
    avaliarJev:async args=>{chamadas++;return avaliarJev?avaliarJev(args):interpretarJev(resposta());},
    conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();});
  const base = `http://127.0.0.1:${server.address().port}`;
  const {token} = await (await fetch(base+'/api/sessao')).json();
  const headers = {'x-assessor-token':token,'content-type':'application/json'};
  return {db,desktop,base,headers,chamadas:()=>chamadas,
    aceitar:()=>desktop.aceitar({nome:'Pessoa sintética',aceito:true,versao:VERSAO_TERMOS}),
    get:(route,extra={})=>fetch(base+'/api/v3/vendas/'+route,{headers:{...headers,...extra}}),
    post:(route,body,extra={})=>fetch(base+'/api/v3/vendas/'+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)})
  };
}

test('Vendas HTTP: sessão, prévia, envio explícito e correção manual sem alterar negócio',async t=>{
  const f = await httpFixture(t);
  assert.equal((await f.get('jev')).status,403);f.aceitar();
  assert.equal((await f.get('jev',{'x-assessor-token':''})).status,403);
  assert.equal((await f.post('jev/configurar',{chave},{origin:'https://externo.invalid'})).status,403);
  assert.equal((await f.get('jev?chave=nao')).status,400);
  assert.equal((await f.post('jev/configurar',{chave:'invalida'})).status,400);
  for(const body of [null,[],{}, {chave,automatico:true}])assert.equal((await f.post('jev/configurar',body)).status,400);
  const estado = await (await f.post('jev/configurar',{chave})).json();
  assert.equal(estado.configurada,true);assert.doesNotMatch(JSON.stringify(estado),/sk-or-v1/);
  const {previa} = await (await f.post('preparar',{conversa_id:'5511@s.whatsapp.net'})).json();
  assert.equal(previa.fontes.length,1);assert.equal(f.chamadas(),0);
  assert.equal((await f.post('avaliar',{previa_id:previa.id,confirmar:false})).status,400);
  assert.equal(f.chamadas(),0);
  const {avaliacao} = await (await f.post('avaliar',{previa_id:previa.id,confirmar:true})).json();
  assert.equal(avaliacao.temperatura,'quente');assert.equal(f.chamadas(),1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM desktop_negocios').get().n,0);
  assert.equal((await f.get('avaliacao?conversa_id=5511%40s.whatsapp.net&conversa_id=outro')).status,400);
  const manual = await (await f.post('corrigir',{conversa_id:'5511@s.whatsapp.net',temperatura:'morno',etapa:'interesse',confirmar:true})).json();
  assert.equal(manual.avaliacao.origem,'manual');assert.equal(f.chamadas(),1);
  const lida = await (await f.get('avaliacao?conversa_id=5511%40s.whatsapp.net')).json();
  assert.equal(lida.avaliacao.id,manual.avaliacao.id);
  const removida = await (await f.post('jev/remover',{})).json();assert.equal(removida.configurada,false);
});

test('Vendas HTTP: falha de cofre fica sanitizada e remoção cancela envio em andamento',async t=>{
  let resolver;
  const f = await httpFixture(t,()=>new Promise(resolve=>{resolver=resolve;}));f.aceitar();
  let {previa} = await (await f.post('preparar',{conversa_id:'5511@s.whatsapp.net'})).json();
  let response = await f.post('avaliar',{previa_id:previa.id,confirmar:true});
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/SEGREDO_NAO_DEVE_APARECER/);
  await f.post('jev/configurar',{chave});
  ({previa} = await (await f.post('preparar',{conversa_id:'5511@s.whatsapp.net'})).json());
  const pending = f.post('avaliar',{previa_id:previa.id,confirmar:true});
  for(let i=0;i<30&&!resolver;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(typeof resolver,'function');
  await f.post('jev/remover',{});resolver(interpretarJev(resposta()));
  response = await pending;assert.equal(response.status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM lume_vendas_avaliacoes').get().n,0);
});

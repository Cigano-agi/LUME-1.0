// Percurso HTTP/UI isolado: nenhum perfil, conversa ou provedor real.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilHoje} from './fixtures/hoje-profile.js';

const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db);
let conexao='desconectada',providerCalls=0;
const analise={pendentes:1,analisando:0,aguardandoModelo:0,aguardandoValidacao:0,sugeridas:0,abstidas:0,erros:0,canceladas:0};
const filaLaya={estado:()=>({total:Object.values(analise).reduce((a,b)=>a+b,0),...analise}),sinalizar:()=>{}};
const server=criarServidor(db,{contexto,desktop:true,filaLaya,conexao:{estado:()=>({estado:conexao,qr:null}),parar:async()=>{},iniciar:async()=>{}},gerarIA:async()=>{providerCalls++;throw Error('Provedor proibido');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,output='work/nota7-today-state';
mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:820,height:900}}),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin+'/'))external.push(request.url());});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin+'/app');
  await page.locator('#owner').fill('Perfil de teste');
  await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();
  await page.locator('#skip').click();
  await page.locator('#first-hide').click();

  const pipeline=page.locator('#today-pipeline'),analysisCell=pipeline.locator('[data-pipeline="analysis"]');
  await analysisCell.getByText(/1 mensagem na fila/).waitFor();
  assert.match(await pipeline.innerText(),/conexão/i);
  assert.match(await pipeline.innerText(),/captura|mensagens salvas/i);
  assert.match(await pipeline.innerText(),/análise/i);
  assert.match(await pipeline.innerText(),/histórico.*(desconhecid|incomplet)/i);
  assert.equal(await pipeline.getByRole('button',{name:/conectar|reconectar/i}).count(),1);

  // O zero da lista não pode apagar uma fila pendente ou declarar cobertura completa.
  await page.locator('#tasks').getByText(/nenhum próximo passo/i).waitFor({state:'attached'});
  assert.match(await pipeline.innerText(),/1 mensagem na fila/);
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const width of [390,820,1440]){
      await page.setViewportSize({width,height:900});
      await pipeline.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${theme} ${width}px overflow`);
      await page.screenshot({path:`${output}/${theme}-${width}.png`});
    }
  }
  await pipeline.getByRole('button',{name:/conectar|reconectar/i}).focus();
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('#today-pipeline')!==null),true);

  analise.pendentes=0;
  await page.locator('#refresh').click();
  await analysisCell.getByText(/nenhuma análise pendente|nenhuma mensagem na fila/i).waitFor();
  assert.doesNotMatch(await pipeline.innerText(),/histórico completo|tudo analisado/i);

  analise.aguardandoModelo=1;
  await page.locator('#refresh').click();
  await analysisCell.getByText(/aguardando o modelo/i).waitFor();
  assert.doesNotMatch(await pipeline.locator('[data-pipeline="analysis"]').innerText(),/nenhuma análise pendente/i);
  analise.aguardandoModelo=0;
  analise.aguardandoValidacao=1;
  await page.locator('#refresh').click();
  await analysisCell.getByText(/aguardando validação/i).waitFor();
  assert.doesNotMatch(await pipeline.locator('[data-pipeline="analysis"]').innerText(),/nenhuma análise pendente/i);
  analise.aguardandoValidacao=0;
  analise.erros=1;
  await page.locator('#refresh').click();
  await analysisCell.getByText(/com erro/i).waitFor();
  assert.doesNotMatch(await pipeline.locator('[data-pipeline="analysis"]').innerText(),/nenhuma análise pendente/i);
  analise.erros=0;

  const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética'})});
  await page.route('**/api/v3/acoes/analise',fail);
  await page.locator('#refresh').click();
  await analysisCell.getByText(/não foi possível consultar a análise/i).waitFor();
  assert.doesNotMatch(await pipeline.innerText(),/nenhuma análise pendente/i);
  const retryButton=pipeline.locator('[data-pipeline="analysis"] [data-pipeline-retry-dimension]');
  await retryButton.focus();
  await page.waitForTimeout(6500);
  assert.equal(await retryButton.evaluate(element=>document.activeElement===element),true,'retry mantém foco após atualização automática');
  await page.unroute('**/api/v3/acoes/analise',fail);
  analise.pendentes=1;
  await pipeline.getByRole('button',{name:/tentar novamente/i}).click();
  await analysisCell.getByText(/1 mensagem na fila/).waitFor();

  conexao='conectada';
  await page.locator('#refresh').click();
  await pipeline.locator('[data-pipeline="connection"]').getByText(/WhatsApp conectado/i).waitFor();
  assert.match(await pipeline.innerText(),/histórico.*(desconhecid|incomplet)/i);

  // Uma nota pessoal não é mensagem do WhatsApp, nem sua data é a da última mensagem.
  await page.evaluate(()=>api('/api/v3/nota',{titulo:'Nota pessoal de teste',texto:'Lembrar de revisar o relatório.'}));
  const resumoComNota=await page.evaluate(()=>api('/api/v3/resumo'));
  assert.ok(resumoComNota.mensagens>0);
  assert.equal(resumoComNota.mensagensWhatsapp,0);
  await page.locator('#refresh').click();
  await pipeline.locator('[data-pipeline="messages"]').getByText(/0 mensagens/i).waitFor();
  assert.doesNotMatch(await pipeline.locator('[data-pipeline="messages"]').innerText(),/última mensagem salva/i);

  // A invalidação precisa apagar contagens já vistas mesmo se a nova consulta falhar.
  adicionar({texto:'Mensagem sintética de revogação'});
  const resumoComMensagem=await page.evaluate(()=>api('/api/v3/resumo'));
  assert.equal(resumoComMensagem.mensagensWhatsapp,1);
  await pipeline.locator('[data-pipeline-retry]').click();
  let messageState='';
  for(let attempt=0;attempt<30;attempt++){
    messageState=await pipeline.locator('[data-pipeline="messages"]').innerText();
    if(/1 (?:mensagem|mensagens) do WhatsApp/i.test(messageState))break;
    await page.waitForTimeout(100);
  }
  assert.match(messageState,/1 (?:mensagem|mensagens) do WhatsApp/i);
  let releaseResumo;
  const heldResumo=new Promise(resolve=>{releaseResumo=resolve;});
  const failResumo=async route=>{await heldResumo;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética após revogação'})});};
  await page.route('**/api/v3/resumo',failResumo);
  await page.evaluate(()=>window.limparDadosVisiveis());
  assert.doesNotMatch(await pipeline.locator('[data-pipeline="messages"]').innerText(),/1 (?:mensagem|mensagens) do WhatsApp/i,'revogação limpa valor antes da rede');
  releaseResumo();
  await pipeline.locator('[data-pipeline="messages"]').getByText(/não foi possível consultar/i).waitFor();
  assert.doesNotMatch(await pipeline.locator('[data-pipeline="messages"]').innerText(),/1 (?:mensagem|mensagens) do WhatsApp/i);
  await page.unroute('**/api/v3/resumo',failResumo);

  // O servidor deve diferenciar fila inexistente de fila vazia.
  const noQueue=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:conexao,qr:null}),parar:async()=>{},iniciar:async()=>{}}});
  await new Promise(resolve=>noQueue.listen(0,'127.0.0.1',resolve));
  try{
    const noQueueOrigin=`http://127.0.0.1:${noQueue.address().port}`;
    const session=await (await fetch(noQueueOrigin+'/api/sessao')).json();
    const response=await fetch(noQueueOrigin+'/api/v3/acoes/analise',{headers:{'x-assessor-token':session.token}});
    assert.equal(response.status,200);
    assert.equal((await response.json()).disponivel,false);
  }finally{await new Promise(resolve=>noQueue.close(resolve));}
  const unavailable=route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({disponivel:false,...Object.fromEntries(Object.keys(analise).map(key=>[key,0]))})});
  await page.route('**/api/v3/acoes/analise',unavailable);
  await page.locator('#today-pipeline [data-pipeline-retry]').click();
  await pipeline.locator('[data-pipeline="analysis"]').getByText(/indisponível/i).waitFor();
  await page.unroute('**/api/v3/acoes/analise',unavailable);

  assert.equal(providerCalls,0);
  assert.deepEqual(errors,[]);
  assert.deepEqual(external,[]);
  writeFileSync(`${output}/evidence.json`,JSON.stringify({synthetic:true,nativeExecution:false,providerCalls,errors,external,checks:['disconnected plus pending analysis','no false empty','three dimensions','zero queue','blocked model, validation, error','analysis error and retry','focus across automatic refresh','note is not WhatsApp message','invalidation clears stale state','missing queue differs from empty','connected without proven coverage','390/820/1440 light and dark','keyboard and reduced motion']},null,2));
  console.log('NOTA7_TODAY_STATE_OK');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}

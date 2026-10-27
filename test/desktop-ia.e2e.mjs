// Fluxo UI/HTTP real; provedor e chave sintéticos. Nenhuma chamada remota.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { criarServidor } from '../src/painel/servidor.js';
import { Semantica } from '../src/semantica.js';
import { resolve } from 'node:path';
const db=abrirBanco(), contexto=new ContextoApp(db);
const longContext=process.env.ASSESSOR_E2E_LONG_CONTEXT==='1';
contexto.nota({titulo:'Beta sintético',texto:(longContext?'Registro introdutório da reunião, ainda sem decisão. '.repeat(80):'')+'Proposta: revisar o instalador com os sócios na sexta. <script>window.invasao=true</script>'});
let key=null, calls=0, invalid=false;
const segredos={estado:async()=>({disponivel:true,configurada:Boolean(key)}),gravar:async k=>key=k,ler:async()=>key,remover:async()=>key=null};
const gerarIA=async req=>{calls++;const f=JSON.parse(req.pedido.contents[0].parts[0].text).fontes[0];assert.equal(req.pedido.tools,undefined);return {dados:{insuficiente:false,afirmacoes:[{texto:'A fonte propõe revisar o instalador. <img src=x onerror=alert(1)>',fonte:invalid?'E99999':f.fonte,trecho:'revisar o instalador com os sócios na sexta.'}]}};};
const conexao={estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{}};
const semantica=process.env.ASSESSOR_E2E_EMBEDDINGS==='1'?new Semantica(db,{cacheDir:resolve('work/modelos-e5')}):null;
if(semantica){await semantica.ativar();await semantica.indexar();}
const server=criarServidor(db,{contexto,conexao,desktop:true,segredos,gerarIA,semantica});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
const output=(semantica?'work/desktop-ia-qa-sem':'work/desktop-ia-qa')+(longContext?'-long':'');mkdirSync(output,{recursive:true});
try {
  const page=await browser.newPage({viewport:{width:1320,height:950}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/app`);
  await page.locator('#owner').fill('Beta de teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  const abrirPerguntas=async()=>{await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-ask').click();};
  await abrirPerguntas();await page.waitForFunction(()=>document.getElementById('ia-summary').textContent.includes('Perguntas desativadas'));
  assert.equal(calls,0);assert.equal(await page.locator('#ia-prepare').isDisabled(),true);
  if(semantica){await page.locator('#memory-mode-search').click();await page.locator('#search').fill('programa de computador para a equipe');await page.locator('#local-search-mode').selectOption('denso');await page.locator('#results .source').waitFor();assert.match(await page.locator('#results').innerText(),/revisar o instalador/);assert.equal(calls,0);await page.locator('#local-search-mode').selectOption('lexical');await page.locator('#memory-mode-ask').click();}
  await page.locator('#ia-open-settings').click();await page.locator('#ia-key').fill('chave_sintetica_para_ui_123456789');await page.locator('#ia-enabled').check();await page.locator('#ia-ack').check();
  await page.locator('#ia-config-form button.primary').click();await page.locator('#ia-key-status').filter({hasText:'Chave guardada'}).waitFor();
  assert.equal(await page.locator('#ia-key').inputValue(),'');await page.locator('#ia-policies input').check();await page.waitForFunction(()=>document.querySelector('#ia-policies input')?.checked);
  await abrirPerguntas();await page.locator('#ia-question').fill('Qual proposta do instalador?');if(semantica)await page.locator('#ia-mode').selectOption('hibrido');await page.locator('#ia-prepare').click();await page.locator('#ia-preview').waitFor();
  assert.equal(calls,0);await page.locator('#ia-preview summary').click();await page.screenshot({path:output+'/01-previa-fontes.png',fullPage:true});
  assert.match(await page.locator('#ia-preview').innerText(),/revisar o instalador com os sócios na sexta/);
  await page.getByRole('button',{name:'Confirmar envio e perguntar'}).click();await page.locator('#ia-answer .ia-claim').waitFor();
  assert.equal(calls,1);assert.equal(await page.locator('#ia-answer img').count(),0);assert.equal(await page.evaluate(()=>window.invasao),undefined);
  await page.getByRole('button',{name:/E\d+ · Conferir fonte/}).click();await page.locator('#results .source').waitFor();assert.match(await page.locator('#results').innerText(),/Proposta: revisar o instalador com os sócios na sexta/);
  assert.equal(await page.locator('#results script').count(),0);await page.screenshot({path:output+'/02-resposta-fontes.png',fullPage:true});
  await page.setViewportSize({width:820,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+'/03-820px.png',fullPage:true});
  invalid=true;await page.locator('#memory-mode-ask').click();await page.locator('#ia-prepare').click();await page.locator('#ia-preview').waitFor();await page.getByRole('button',{name:'Confirmar envio e perguntar'}).click();
  await page.locator('#ia-progress').filter({hasText:'não pude conferir'}).waitFor();assert.equal(await page.locator('#ia-answer .ia-claim').count(),0);
  await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#ia-policies input').uncheck();await abrirPerguntas();await page.locator('#ia-prepare').click();await page.locator('#ia-progress').filter({hasText:'Não encontrei fontes'}).waitFor();assert.equal(calls,2);
  await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#ia-remove-key').click();await page.locator('#ia-key-status').filter({hasText:'A chave será guardada'}).waitFor();assert.equal(key,null);assert.equal(await page.locator('#ia-enabled').isChecked(),false);
  assert.deepEqual(errors,[]);writeFileSync(output+'/evidence.json',JSON.stringify({date:new Date().toISOString(),longContext,provider:'simulado localmente; zero chamadas remotas',embeddings:semantica?semantica.estado():'não usados',calls,errors,checks:['opt-in','preview before send','relevant passage in preview','source navigation','XSS literal','invalid citation rejected','revocation','budget display','820px','key removal']},null,2));
  console.log('DESKTOP_IA_UI_OK: prévia, resposta, fontes, recusa, revogação e chave.');
} finally {await browser.close();await new Promise(r=>server.close(r));db.close();}

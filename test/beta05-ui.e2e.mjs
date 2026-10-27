// Synthetic legal-practice persona. No real profile, WhatsApp or model call.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
const db=abrirBanco(), {contexto,desktop,fontes}=perfilBeta05(db,{agora:new Date()});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,output='work/beta05-ui-qa';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.emulateMedia({reducedMotion:'reduce'}); await page.goto(origin+'/app');
  await page.locator('#first-hide').click();
  await page.locator('#clarity-content:not([hidden])').waitFor();
  assert.match(await page.locator('#clarity-title').innerText(),/Preparar a reunião/);
  await page.locator('.clarity-history-details > summary').click();
  assert.match(await page.locator('#clarity-metrics').innerText(),/3.500,00/);
  assert.match(await page.locator('#clarity-money-disclosure').innerText(),/Não representam honorários recebidos/);
  assert.doesNotMatch(await page.locator('#greeting').innerText(),/acompanhando/);
  assert.match(await page.locator('#connection').innerText(),/desconectado/);
  await page.locator('#feedback').waitFor({state:'hidden'});
  for(const width of [1440,820,390]){
    await page.setViewportSize({width,height:1000});await page.screenshot({path:`${output}/today-${width}.png`,fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow at ${width}`);
  }
  await page.setViewportSize({width:1440,height:1000});
  // Context stays bound to the source even if a refreshed daily focus changes.
  await page.locator('.clarity-practice summary').click();
  await page.locator('#clarity-practice-text').fill('Separar documentos recebidos e perguntas ainda abertas.');
  await page.locator('#clarity-practice-form button').click();
  await page.locator('#clarity-practice-feedback').filter({hasText:'Reflexão guardada'}).waitFor();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos WHERE texto LIKE ?').get('%Separar documentos recebidos e perguntas ainda abertas.%').n,1);
  await page.locator('#clarity-main-action').click();await page.locator('#memory:not([hidden])').waitFor();
  assert.match(await page.locator('#results').innerText(),/Nossa reunião de revisão/);
  await page.locator('nav [data-view=today]').click();
  // Controlled model adapter only verifies UI behavior; this is not model accuracy evidence.
  let modelState={instalado:true,integridade:'verificando',experimental:true,local:true};
  await page.route('**/api/v3/laya',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(modelState)}));
  await page.route('**/api/v3/laya/classificar',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({categoria:null,abstencao:true,motivo:'mensagem_ambigua',sugestao:true,experimental:true,local:true})}));
  await page.locator('#clarity-local-helper summary').click();
  await page.locator('#clarity-local-helper').locator('p').filter({hasText:'Conferindo os arquivos'}).waitFor();
  assert.equal(await page.locator('#clarity-local-helper button').isDisabled(),true);
  modelState={instalado:true,integridade:'falhou',experimental:true,local:true};
  await page.locator('#clarity-local-helper').locator('p').filter({hasText:'incompletos ou alterados'}).waitFor();
  assert.equal(await page.locator('#clarity-local-helper button').isDisabled(),true);
  await page.setViewportSize({width:390,height:850});
  await page.locator('#clarity-local-helper').screenshot({path:output+'/laya-integridade-falhou-390.png'});
  await page.setViewportSize({width:1440,height:1000});
  modelState={instalado:true,integridade:'verificada',experimental:true,local:true};
  await page.locator('#clarity-local-helper summary').click();
  await page.waitForTimeout(50);
  await page.locator('#clarity-local-helper summary').click();
  await page.waitForFunction(()=>!document.querySelector('#clarity-local-helper button').disabled);
  assert.equal(await page.locator('#clarity-local-helper button').isDisabled(),false);
  await page.locator('#clarity-local-text').fill('O cliente confirmou o pagamento?');
  await page.locator('#clarity-local-helper button').click();await page.locator('#clarity-local-result').filter({hasText:'Sugestões permanecem bloqueadas'}).waitFor();
  assert.equal(await page.locator('#clarity-local-helper button').isDisabled(),false);
  await page.screenshot({path:output+'/laya-abstention-synthetic.png',fullPage:true});
  await page.locator('#clarity-businesses').click();await page.locator('#memory[data-mode=businesses]').waitFor();
  assert.match(await page.locator('#negocios-memory-shell').innerText(),/Consultoria contratual/);
  await page.locator('nav [data-view=today]').click();
  await page.route('**/api/v3/clareza',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética'})}));
  await page.evaluate(()=>window.carregarClareza());await page.locator('#clarity-error:not([hidden])').waitFor();
  assert.equal(await page.locator('#clarity-content').isVisible(),false);
  await page.unroute('**/api/v3/clareza');await page.locator('#clarity-retry').click();await page.locator('#clarity-content:not([hidden])').waitFor();
  await page.evaluate(()=>window.limparDadosVisiveis());assert.equal(await page.locator('#clarity-content').isVisible(),false);
  // First use in an independent browser context, with an explicitly synthetic profile response.
  desktop.configurarGuia({dispensado:false});
  const first=await browser.newPage({viewport:{width:1320,height:950}});
  await first.route('**/api/v3/perfil',async route=>{const response=await route.fetch(),profile=await response.json();await route.fulfill({response,json:{...profile,aceito:false,guiaDispensado:false}});});
  await first.goto(origin+'/app');await first.locator('#onboarding:not([hidden])').waitFor();
  await first.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
  assert.equal(await first.locator('#consent').isChecked(),false);
  for(const width of [1320,390]){await first.setViewportSize({width,height:950});await first.screenshot({path:`${output}/onboarding-${width}.png`,fullPage:true});assert.equal(await first.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await first.setViewportSize({width:1320,height:950});await first.locator('#owner').fill('Eduardo · demonstração');await first.locator('#consent').check();await first.locator('#accept-form button').click();
  await first.locator('#skip').click();await first.locator('#clarity-content:not([hidden])').waitFor();
  await first.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await first.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
  assert.equal(await first.evaluate(()=>scrollY),0);
  await first.screenshot({path:output+'/first-use-1320.png',fullPage:true});await first.close();
  assert.deepEqual(errors,[]);writeFileSync(output+'/evidence.json',JSON.stringify({synthetic:true,widths:[1440,820,390],errors,source:fontes.ana.id,checks:['money-is-potential','disconnected-greeting','reflection-persisted','source-navigation','business-navigation','failure-recovery','ACL-clears-summary','no-horizontal-overflow','model-integrity-controls','model-abstention-interface-only','explicit-consent','onboarding-responsiveness','skip-resets-scroll']},null,2));
  console.log(JSON.stringify({ok:true,output,checks:13}));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}

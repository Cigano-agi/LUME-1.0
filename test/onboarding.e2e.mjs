// Real UI + HTTP with an in-memory profile. WhatsApp is a controlled fixture.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { criarServidor } from '../src/painel/servidor.js';
const out='work/onboarding-crm-qa';mkdirSync(out,{recursive:true});
const db=abrirBanco(),contexto=new ContextoApp(db);
let connectionState='desconectada',qr=null,qrVersao=0,fail='throw',attempts=0,providers=0;
let layaState={instalado:false,integridade:'ausente',estado:'nao_instalado',aprovado:false,avaliacao:'reprovada'};
const conexao={estado:()=>({estado:connectionState,qr,qrVersao,qrGeradoEm:qr?'2026-09-18T16:43:00.000Z':null}),iniciar:async()=>{attempts++;if(fail==='throw')throw Error('Conexão sintética indisponível');connectionState=fail||'conectada';},parar:async()=>{connectionState='desconectada';qr=null;}};
const server=criarServidor(db,{contexto,conexao,desktop:true,laya:{status:()=>layaState},gerarIA:async()=>{providers++;throw Error('Provider forbidden');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});const errors=[],external=[];
const page=await browser.newPage({viewport:{width:1320,height:950}});
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{if(!route.request().url().startsWith(base)){external.push(route.request().url());return route.abort();}return route.continue();});
const fit=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
try{
  await page.goto(base+'/apresentacao');await page.waitForFunction(()=>typeof Motion?.animate==='function');
  for(const width of [1320,820,390]){
    await page.setViewportSize({width,height:950});await fit();
    await page.screenshot({path:`${out}/landing-${width}.png`,fullPage:true});
  }
  await page.locator('#demo-next').click();assert.match(await page.locator('#demo-counter').innerText(),/2 de 3/);
  await page.locator('#demo-next').click();assert.match(await page.locator('#demo-source').innerText(),/não foi salva/);
  assert.equal(db.prepare('SELECT count(*) n FROM eventos').get().n,0);
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#demo-next').click();
  assert.equal(await page.evaluate(()=>document.querySelector('#demo-card').getAnimations().filter(a=>a.playState==='running').length),0);
  await page.goto(base+'/app');await page.locator('#owner').waitFor();assert.equal(await page.locator('#consent').isChecked(),false);
  for(const width of [1320,820,390]){
    await page.setViewportSize({width,height:950});await fit();
    await page.screenshot({path:`${out}/onboarding-${width}.png`,fullPage:true});
  }
  await page.locator('.terms-details summary').click();assert.match(await page.locator('.privacy-copy').innerText(),/histórico bruto/);
  await page.locator('.terms-details summary').click();
  await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#connect-step').waitFor();
  await page.locator('[data-phone=iphone]').click();assert.match(await page.locator('#phone-instructions').innerText(),/iPhone/);
  assert.match(await page.locator('.pair-steps').innerText(),/Continuar[\s\S]*Escaneie de novo/);
  assert.equal(attempts,0);
  await page.locator('#pair').click();await page.locator('#pair-error').waitFor();assert.equal(attempts,1);
  fail='erro';await page.locator('#pair').click();await page.locator('#pair-error').filter({hasText:'Não consegui conectar agora'}).waitFor();
  connectionState='auth_invalida';await page.evaluate(()=>status());assert.match(await page.locator('#pair-error').innerText(),/encerrou esta sessão/);
  connectionState='substituida';await page.evaluate(()=>status());assert.match(await page.locator('#pair-error').innerText(),/aberta em outro lugar/);
  connectionState='aguardando_qr';qr='codigo-1';qrVersao=1;await page.evaluate(()=>status());
  assert.match(await page.locator('#qr-renewal').innerText(),/primeiro escaneamento/);
  qr='codigo-2';qrVersao=2;await page.evaluate(()=>status());assert.match(await page.locator('#qr-renewal').innerText(),/QR renovado/);
  await page.screenshot({path:`${out}/connection-error-390.png`,fullPage:true});
  await page.locator('#skip').click();await page.locator('#first-use').waitFor();
  await page.locator('#first-laya-state').filter({hasText:'não encontrado'}).waitFor();
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'1');
  await page.locator('.first-assistant-prompt summary').click();
  const assistantContext=await page.locator('#first-assistant-prompt-text').inputValue();
  assert.match(assistantContext,/Claude Code, Codex ou AGY|Ajustes no Lume/);
  assert.match(assistantContext,/não conecta você ao Lume/);
  assert.equal(/token\s*[:=]|senha\s*[:=]|api[_-]?key\s*[:=]/i.test(assistantContext),false);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
  await page.locator('#first-assistant-prompt-copy').click();
  assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),assistantContext);
  await fit();await page.screenshot({path:`${out}/assistant-prompt-390.png`,fullPage:true});
  await page.locator('.first-assistant-prompt summary').click();
  layaState={instalado:true,integridade:'verificando',estado:'carregando',aprovado:false,avaliacao:'reprovada'};
  await page.evaluate(()=>window.atualizarMotorPrimeiroUso());
  await page.locator('#first-laya-state').filter({hasText:'Conferindo os arquivos'}).waitFor();
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'1');
  await page.locator('#first-readiness').evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.locator('#first-readiness').screenshot({path:`${out}/laya-verificando-390.png`});
  layaState={instalado:true,integridade:'falhou',estado:'erro',aprovado:false,avaliacao:'reprovada'};
  await page.locator('#first-laya-state').filter({hasText:'incompletos ou alterados'}).waitFor();
  await page.locator('#first-readiness').evaluate(el=>el.scrollIntoView({block:'center'}));
  await page.locator('#first-readiness').screenshot({path:`${out}/laya-integridade-falhou-390.png`});
  layaState={instalado:true,integridade:'verificada',estado:'pronto',aprovado:false,avaliacao:'reprovada'};
  await page.evaluate(()=>window.atualizarMotorPrimeiroUso());
  await page.locator('#first-laya-state').filter({hasText:'qualidade das ações ainda não foi aprovada'}).waitFor();
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'1');
  await page.locator('#first-assistant').click();await page.locator('#mcp-panel').waitFor();
  await page.waitForFunction(()=>!document.getElementById('first-assistant').disabled);
  await page.locator('nav [data-view=today]').click();await page.locator('#first-use').waitFor();
  await page.reload();await page.locator('#workspace').waitFor();await page.locator('nav [data-view=today]').click();await page.locator('#first-connect').waitFor();await page.locator('.first-help').click();
  await page.locator('#try-example').click();await page.locator('#example-next').click();await page.locator('#example-next').click();
  assert.match(await page.locator('#example-progress').innerText(),/3 de 3/);await page.keyboard.press('Escape');
  assert.equal(await page.locator('#learn-example').isVisible(),false);
  assert.equal(db.prepare('SELECT count(*) n FROM eventos').get().n,0);
  await page.locator('#first-connect').click();fail=false;await page.locator('#pair').click();
  await page.locator('#first-connection').filter({hasText:'WhatsApp conectado · aguardando mensagens'}).waitFor();
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'1');
  assert.match(await page.locator('#first-history').innerText(),/primeiras mensagens/);
  contexto.nota({titulo:'Proposta de teste',texto:'Combinado sintético: enviar a proposta revisada na sexta.'});
  await page.locator('#refresh').click();
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'1');
  assert.match(await page.locator('#first-history').innerText(),/primeiras mensagens/);
  assert.equal(contexto.receber({type:'notify',donoJids:['5511888888888@s.whatsapp.net'],messages:[{
    key:{id:'ONBOARDING-WA-1',remoteJid:'5511999999999@s.whatsapp.net',fromMe:true},
    messageTimestamp:1789819200,message:{conversation:'Conversa sintética: revisar proposta amanhã.'}
  }]}).novas,1);
  await page.locator('#refresh').click();
  await page.locator('#first-history').filter({hasText:'1 mensagem'}).waitFor();
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'2');
  for(const width of [1320,820,390]){
    await page.setViewportSize({width,height:950});await fit();await page.screenshot({path:`${out}/first-use-${width}.png`,fullPage:true});
  }
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await fit();await page.screenshot({path:`${out}/first-use-dark-390.png`,fullPage:true});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  layaState={instalado:true,integridade:'verificada',estado:'pronto',aprovado:true,avaliacao:'aprovada'};
  await page.evaluate(()=>window.atualizarMotorPrimeiroUso());
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'3');
  layaState={instalado:true,integridade:'verificada',estado:'pronto',aprovado:false,avaliacao:'reprovada'};
  await page.evaluate(()=>window.atualizarMotorPrimeiroUso());
  assert.equal(await page.locator('#first-ready-progress').getAttribute('value'),'2');
  await page.locator('#first-search').fill('proposta');await page.locator('#first-search-form button').click();
  await page.locator('#results .source').first().waitFor();assert.match(await page.locator('#results').innerText(),/Combinado sintético/);
  await page.locator('#results').getByRole('button',{name:'Criar nota vinculada'}).first().click();
  await page.locator('#note-title').fill('Próximo passo');await page.locator('#note-text').fill('Preparar a proposta revisada.');
  await page.getByRole('button',{name:'Guardar nota',exact:true}).click();await page.locator('#feedback').filter({hasText:'Ideia guardada'}).waitFor();
  await page.locator('nav [data-view=today]').click();await page.locator('#first-hide').click();await page.locator('#first-use').waitFor({state:'hidden'});
  await page.reload();await page.locator('#workspace').waitFor();await page.locator('#first-use').waitFor({state:'hidden'});assert.equal(await page.locator('#first-use').isVisible(),false);
  await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-data').click();await page.locator('#guide-reopen').click();await page.locator('#first-use').waitFor();
  await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-data').click();await page.locator('#read-terms').click();assert.match(await page.locator('#terms-full').innerText(),/histórico bruto/);await page.keyboard.press('Escape');
  assert.equal(providers,0);assert.equal(external.length,0);assert.deepEqual(errors,[]);
  const report={date:new Date().toISOString(),widths:[1320,820,390],passed:true,externalRequests:0,providerCalls:0,errors,proofs:['terms retained and unchecked','pairing failure and retry including HTTP 200 error state','two-scan WhatsApp security guidance and renewed QR shown','asynchronous invalid/replaced session shown','resume accepted profile before connection','connected but history empty','internal note does not count as WhatsApp capture','synthetic WhatsApp message advances progress','Laya absent and rejected stay unavailable; approved fixture advances progress','external assistant remains optional','assistant context copies without secrets or external calls','example has no DB writes','local search and linked note','guide dismissal persists and reopens','reduced motion and Escape']};
  writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

// Product UI, real local HTTP/data, synthetic permitted and excluded sources.
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { perfilHoje } from './fixtures/hoje-profile.js';
const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db),out='work/premium-qa';mkdirSync(out,{recursive:true});
adicionar({tipo:'compromisso',texto:'Preparar a proposta revisada · exemplo sintético'});
adicionar({tipo:'lead',texto:'Retomar o orçamento com a equipe · exemplo sintético'});
adicionar({tipo:'pendencia',texto:'Conferir as informações do contrato · exemplo sintético'});
adicionar({tipo:'lead',permissao:'terceiro',texto:'NEGÓCIO PRIVADO QUE NÃO PODE APARECER'});
let calls=0;const conexao={estado:()=>({estado:'desconectada',qr:null}),iniciar:async()=>{},parar:async()=>{}};
const server=criarServidor(db,{contexto,conexao,desktop:true,gerarIA:async()=>{calls++;throw Error('Provider forbidden');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1320,height:950}}),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
try{
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.goto(origin+'/apresentacao');
 await page.locator('#tour-today').focus();await page.keyboard.press('ArrowDown');
 assert.equal(await page.locator('#tour-conversations').getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('#tour-panel-today').isVisible(),false);
 await page.keyboard.press('End');assert.equal(await page.locator('#tour-panel-map').isVisible(),true);
 await page.keyboard.press('Home');assert.equal(await page.locator('#tour-panel-today').isVisible(),true);
 await page.waitForFunction(()=>document.querySelector('#tour-panel-today').getAnimations().some(a=>a.playState==='running'));
 await page.emulateMedia({reducedMotion:'reduce'});
 for(const width of [1320,820,390]){
  await page.setViewportSize({width,height:950});await page.evaluate(()=>scrollTo(0,0));await fit();
  await page.screenshot({path:`${out}/landing-${width}.png`,fullPage:true});
  await page.locator('#acompanhar-negocio').scrollIntoViewIfNeeded();await fit();
  assert.equal(await page.locator('.business-steps li').count(),3);
  assert.match(await page.locator('.business-note').innerText(),/confirma antes de salvar/);
  assert.equal(await page.locator('.business-drawing button,.business-drawing input').count(),0);
  await page.screenshot({path:`${out}/business-${width}.png`});
  for(const name of ['today','conversations','map']){await page.locator('#tour-'+name).click();await fit();assert.equal(await page.locator('#tour-panel-'+name).evaluate(el=>el.scrollWidth>el.clientWidth),false);}
  await page.locator('#por-dentro').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/tour-${width}.png`});
  await page.locator('[data-download-open]').first().click();await page.locator('#download-dialog').waitFor();
  await page.locator('[data-platform=mac]').click();assert.match(await page.locator('#install-copy').innerText(),/Dock/);
  assert.match(await page.locator('.download-state').innerText(),/não há download/);
  assert.equal(await page.locator('a[download],a[href$=".exe"],a[href$=".dmg"]').count(),0);
  assert.equal(await page.locator('#download-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);
  await page.screenshot({path:`${out}/download-${width}.png`});await page.keyboard.press('Escape');
  assert.equal(await page.locator('#download-dialog').isVisible(),false);
 }
 await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();
 await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
 await page.locator('#first-hide').click();await page.locator('#first-use').waitFor({state:'hidden'});
 await page.locator('#task-options summary').click();
 await page.evaluate(()=>{clearTimeout(toastTimer);document.getElementById('feedback').hidden=true;});
 assert.equal(await page.locator('#stat-actions').innerText(),'3');
 assert.ok(!(await page.locator('#today').innerText()).includes('NEGÓCIO PRIVADO'));
 for(const width of [1320,820,390]){
  await page.setViewportSize({width,height:950});await page.evaluate(()=>scrollTo(0,0));await fit();
  await page.screenshot({path:`${out}/dashboard-${width}.png`,fullPage:true});
 }
 await page.locator('#quick-find').fill('proposta');await page.locator('#quick-find-form button').click();await page.locator('#results .source').waitFor();
 assert.match(await page.locator('#results').innerText(),/Preparar a proposta/);
 await page.waitForFunction(()=>document.activeElement.id==='results');
 await page.locator('#results').getByRole('button',{name:'Criar nota vinculada'}).first().click();
 await page.locator('#nota-vinculo').waitFor();
 await page.locator('#note-text').fill('Rascunho ligado à proposta, ainda não salvo.');
 const draftTitle=await page.locator('#note-title').inputValue(),draftSources=await page.evaluate(()=>[...window.fontesDaNota]);
 await page.locator('nav [data-view=today]').click();await page.locator('#quick-note').click();
 await page.locator('#draft-dialog').waitFor();assert.match(await page.locator('#draft-detail').innerText(),/ligado a uma mensagem/);
 await page.locator('#draft-close').click();assert.equal(await page.locator('#today').isVisible(),true);
 await page.locator('#quick-note').click();await page.locator('#draft-resume').click();await page.waitForFunction(()=>document.activeElement.id==='note-title');
 assert.equal(await page.locator('#note-title').inputValue(),draftTitle);
 assert.equal(await page.locator('#note-text').inputValue(),'Rascunho ligado à proposta, ainda não salvo.');
 assert.deepEqual(await page.evaluate(()=>window.fontesDaNota),draftSources);
 await page.getByRole('button',{name:'Guardar nota',exact:true}).click();await page.locator('#feedback').filter({hasText:'Ideia guardada'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>window.fontesDaNota),[]);
 await page.locator('nav [data-view=today]').click();await page.locator('#quick-note').click();await page.waitForFunction(()=>document.activeElement.id==='note-title');
 await page.locator('#note-title').fill('Próximo passo de teste');await page.locator('#note-text').fill('Conferir o contexto antes de preparar o orçamento.');
 await page.getByRole('button',{name:'Guardar nota',exact:true}).click();await page.locator('#feedback').filter({hasText:'Ideia guardada'}).waitFor();
 await page.locator('nav [data-view=today]').click();await page.locator('#tasks .task-action').first().getByRole('button',{name:'Marcar resolvido'}).click();
 await page.locator('#stat-actions').filter({hasText:'2'}).waitFor();assert.equal(db.prepare("SELECT count(*) n FROM itens_crm WHERE estado='aberto' AND tipo='compromisso'").get().n,0);
 await page.locator('#open-graph').click();await page.locator('#network .graph-node').first().waitFor();await fit();
 assert.equal(calls,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 assert.equal(await page.evaluate(()=>document.getAnimations().filter(a=>a.playState==='running').length),0);
 const report={date:new Date().toISOString(),widths:[1320,820,390],passed:true,providerCalls:calls,externalRequests:external,errors,checks:['tour tabs click and keyboard','all sections without horizontal overflow','download status truthful and no unsafe artifact links','Mac installation explanation','Escape and focus','reduced motion','action total excludes third-party source','quick search uses actual source and focus','linked draft explicitly resumed without losing text or source','quick note actual persistence','resolve updates real total','actual graph renders']};
 writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

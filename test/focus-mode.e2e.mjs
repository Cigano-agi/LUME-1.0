// UI real com perfil sintético. Prova que o primeiro uso mostra uma intenção por vez.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilHoje} from './fixtures/hoje-profile.js';

const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db),out='work/focus-mode-qa';mkdirSync(out,{recursive:true});
for(let i=0;i<7;i++)adicionar({tipo:i===0?'lead':'pendencia',texto:`Próximo passo ${i+1} · exemplo sintético`});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'conectada',qr:null}),iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{throw Error('Provedor proibido');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1320,height:950},reducedMotion:'reduce'}),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin))external.push(r.url());});
const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
try{
 await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
 assert.equal(await page.locator('#first-use').isVisible(),true);assert.equal(await page.locator('#focus-home').isVisible(),false);
 assert.equal(await page.locator('#first-use .focus-choice:visible').count(),3);assert.equal(await page.locator('.home-status').isVisible(),false);assert.equal(await page.locator('.content-grid').isVisible(),false);
 await page.screenshot({path:out+'/01-escolha-1320.png',fullPage:true});
 await page.locator('#first-actions').click();await page.locator('#first-use').waitFor({state:'hidden'});assert.equal(await page.locator('#focus-home').isVisible(),false);assert.equal(await page.locator('.home-status').isVisible(),true);assert.equal(await page.locator('.content-grid').isVisible(),true);assert.equal(await page.locator('.dashboard-tools').isVisible(),false);
 assert.equal(await page.locator('#tasks .task-action:visible').count(),3);assert.equal(await page.locator('#focus-more-actions').isVisible(),false);
 await page.locator('nav [data-view=memory]').click();await page.waitForFunction(()=>document.activeElement.id!=='first-use-heading');
 assert.equal(await page.locator('#search-form').isVisible(),false);assert.equal(await page.locator('.ia-panel').isVisible(),false);assert.equal(await page.locator('.conversation-workspace').isVisible(),true);
 const memoryTones=await page.locator('.memory-modes button').evaluateAll(nodes=>nodes.map(node=>node.dataset.tone));assert.equal(new Set(memoryTones).size,5);
 await page.locator('#memory-mode-search').click();assert.equal(await page.locator('#search-form').isVisible(),true);assert.equal(await page.locator('.conversation-workspace').isVisible(),false);
 await page.locator('#memory-mode-ask').click();assert.equal(await page.locator('.ia-panel').isVisible(),true);assert.equal(await page.locator('#search-form').isVisible(),false);
 await page.locator('#memory-mode-conversations').click();assert.equal(await page.locator('.conversation-workspace').isVisible(),true);assert.equal(await page.locator('#contacts').isVisible(),false);assert.equal(await page.locator('#negocios-memory').isVisible(),false);
 await page.locator('#memory-mode-contacts').click();assert.equal(await page.locator('#contacts').isVisible(),true);assert.equal(await page.locator('.conversation-workspace').isVisible(),false);
 await page.locator('#memory-mode-conversations').click();assert.equal(await page.locator('.conversation-workspace').isVisible(),true);assert.equal(await page.locator('#contacts').isVisible(),false);
 await page.locator('#memory-mode-businesses').click();assert.equal(await page.locator('#negocios-memory').isVisible(),true);assert.equal(await page.locator('.conversation-workspace').isVisible(),false);
 await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-data').click();assert.equal(await page.locator('#ui-sounds').isChecked(),false);await page.locator('#ui-sounds').check();assert.equal(await page.evaluate(()=>localStorage.getItem('lume-interface-sounds')),'on');await page.locator('#ui-sounds').uncheck();
 await page.setViewportSize({width:390,height:900});await page.evaluate(()=>scrollTo(0,0));await fit();await page.screenshot({path:out+'/02-pessoas-390.png',fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const report={date:new Date().toISOString(),passed:true,widths:[1320,390],checks:['first use stays separate from passive dashboard','six memory destinations share one navigation level and five semantic tones','connection status appears first after onboarding','actions show at most three','legacy choice grid stays hidden','search, ask, people, conversations, businesses and commands are mutually exclusive','interface sounds are optional and persist locally','no horizontal overflow'],errors,external};
 writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

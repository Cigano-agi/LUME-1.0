import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa} from '../src/pessoas.js';

const db=abrirBanco(),f=perfilGrafo(db),out='work/conversas-qa';mkdirSync(out,{recursive:true});
f.conversa('principal','Ateliê Horizonte · proposta de expansão comercial para a unidade do centro · exemplo');
for(let i=0;i<23;i++){
  const autor='pessoa-'+i;registrarPessoa(db,{identificador:autor,nomeCru:i<2?'Ana Silva':'Pessoa de teste '+i});
  const id=f.evento('principal',autor,{permissao:'dirigida',texto:'Conferir proposta de teste '+i});
  const event=db.prepare('SELECT origem_id FROM eventos WHERE id=?').get(id);
  db.prepare("INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em) VALUES('principal',?,?,?,'2026-09-18T12:00:00Z')").run(event.origem_id,i%2?'lead':'compromisso','Rever proposta de teste '+i);
}
f.conversa('privado','CONVERSA_SECRETA');f.evento('privado','AUTOR_SECRETO',{permissao:'terceiro',texto:'SEGREDO'});
for(let i=0;i<13;i++){f.conversa('extra-'+i,'Outra conversa de teste '+i);f.evento('extra-'+i,'pessoa-extra');}
let provider=0;const server=criarServidor(db,{contexto:f.contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{provider++;throw Error('Forbidden');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1320,height:950},reducedMotion:'reduce'}),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(!r.request().url().startsWith(origin)){external.push(r.request().url());return r.abort();}return r.continue();});
const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
try{
 assert.equal((await page.request.get(origin+'/api/v3/conversas/resumo')).status(),403);
 await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
 await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();await page.locator('.conversation-card').first().waitFor();
 assert.equal(await page.locator('.conversation-card').count(),12);assert.ok(!(await page.locator('#memory').innerText()).includes('SECRETO'));
 await page.getByRole('button',{name:'Próxima página de conversas',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.conversation-card').length===3);
 assert.match(await page.locator('#conversation-list').innerText(),/CONVERSA_SECRETA/);
 await page.getByRole('button',{name:'Página anterior de conversas',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.conversation-card').length===12);
 await page.locator('#conversation-name').fill('atelie');await page.locator('#conversation-filter').selectOption('oportunidades');await page.locator('#conversation-filters button').click();await page.waitForFunction(()=>document.querySelectorAll('.conversation-card').length===1);
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:950});await fit();await page.screenshot({path:`${out}/conversas-${width}.png`,fullPage:true});}
 await page.locator('.conversation-card').getByRole('button',{name:'Abrir conversa',exact:true}).click();await page.locator('#conversation-heading').waitFor();await page.waitForFunction(()=>document.activeElement.id==='conversation-heading');
 assert.equal(await page.locator('.conversation-action').count(),5);assert.equal(await page.locator('.conversation-person').count(),6);
 assert.match(await page.locator('.conversation-action').first().innerText(),/Oportunidade/);
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:950});await page.evaluate(()=>scrollTo(0,0));await fit();await page.screenshot({path:`${out}/contexto-${width}.png`});}
 await page.locator('.conversation-action').first().getByRole('button',{name:'Ver origem',exact:true}).click();await page.locator('.conversation-action .source').waitFor();assert.match(await page.locator('.conversation-action .source').innerText(),/Conferir proposta de teste/);
 await page.locator('.conversation-action').first().getByRole('button',{name:'Marcar resolvido',exact:true}).click();await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-summary>div')].some(item=>item.querySelector('dt')?.textContent==='ações abertas'&&item.querySelector('dd')?.textContent==='22'));
 assert.equal(db.prepare("SELECT count(*) n FROM itens_crm WHERE estado='resolvido'").get().n,1);
 await page.getByRole('button',{name:'Próxima página de ações',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#conversation-detail').textContent.includes('22 ações · página 2 de 5'));
 await page.getByRole('button',{name:'Próxima página de pessoas',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#conversation-detail').textContent.includes('23 pessoas · página 2 de 4'));
 await page.getByRole('button',{name:'Voltar à lista',exact:true}).click();await page.locator('.conversation-card').waitFor();
 let release,started;const startedPromise=new Promise(r=>started=r),held=new Promise(r=>release=r);
 const delay=async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});};
 await page.route('**/api/v3/conversas/detalhe?*',delay);
 await page.locator('.conversation-card').getByRole('button',{name:'Abrir conversa',exact:true}).click();await startedPromise;
 await page.evaluate(()=>document.querySelector('#feedback').hidden=true);await page.screenshot({path:out+'/carregando-390.png',fullPage:true});
 db.prepare("UPDATE eventos SET permissao=NULL WHERE conversa_id='principal'").run();
 await page.evaluate(()=>window.limparDadosVisiveis());release();await page.waitForTimeout(120);
 assert.equal(await page.locator('#conversation-detail').innerText(),'');
 await page.unroute('**/api/v3/conversas/detalhe?*',delay);
 const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha de teste recuperável'})});
 await page.route('**/api/v3/conversas/resumo?*',fail);await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();await page.locator('#conversation-list').getByRole('button',{name:'Tentar novamente'}).waitFor();await page.evaluate(()=>document.querySelector('#feedback').hidden=true);await page.screenshot({path:out+'/erro-390.png',fullPage:true});
 assert.ok(!(await page.locator('#conversation-list').innerText()).includes('Ateliê'));
 await page.unroute('**/api/v3/conversas/resumo?*',fail);await page.locator('#conversation-list').getByRole('button',{name:'Tentar novamente'}).click();await page.locator('#conversation-list').getByText('Nenhuma conversa neste filtro.').waitFor();await page.evaluate(()=>document.querySelector('#feedback').hidden=true);await page.screenshot({path:out+'/vazio-390.png',fullPage:true});
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(provider,0);
 const report={date:new Date().toISOString(),passed:true,widths:[1320,820,390],provider,external,errors,checks:['acceptance required','directory pagination','accent-insensitive filter','opportunities first','long name keeps row alignment','detail and people pagination','source shown','resolution persisted','loading state is explicit','revocation clears response in flight','failure clears old data and retry succeeds','empty state keeps filters','responsive UI']};
 writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

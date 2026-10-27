import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';

const db=abrirBanco(),f=perfilGrafo(db),n=new NegociosDesktop(db),out='work/negocios-qa';mkdirSync(out,{recursive:true});
f.conversa('ana','Ana · exemplo');const source=f.evento('ana','ana',{texto:'Pode me mandar uma proposta para o site? Quero entender o valor antes de decidir.'});
f.conversa('oculta','SEGREDO');const hidden=f.evento('oculta','hidden',{permissao:'terceiro',texto:'PRIVADO'});
let provider=0;const server=criarServidor(db,{desktop:true,contexto:f.contexto,conexao:{estado:()=>({estado:'desconectada',qr:null}),iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{provider++;throw Error('Forbidden');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1320,height:950},reducedMotion:'reduce'}),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(!r.request().url().startsWith(origin)){external.push(r.request().url());return r.abort();}return r.continue();});
const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
const saved=()=>db.prepare('SELECT * FROM desktop_negocios WHERE evento_id=?').get(source);
try{
	 assert.equal((await page.request.get(origin+'/api/v3/negocios')).status(),403);
	 await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
	 await page.locator('#first-hide').click();
 await page.locator('.clarity-history-details > summary').click();
 await page.locator('#negocios-today').getByText('Nenhum contato marcado.').waitFor();
 await page.locator('#recent .source').first().getByRole('button',{name:'Acompanhar negócio',exact:true}).click();await page.locator('#negocio-title').waitFor();
 assert.equal(await page.locator('#negocio-value').inputValue(),'');assert.equal(await page.locator('#negocio-date').inputValue(),'');assert.equal(await page.locator('#negocio-confirm').isChecked(),false);assert.equal(saved(),undefined);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'negocio-title');await page.keyboard.press('Escape');await page.locator('#negocio-dialog').waitFor({state:'hidden'});assert.equal(saved(),undefined);
 await page.locator('#recent .source').first().getByRole('button',{name:'Acompanhar negócio',exact:true}).click();await page.locator('#negocio-title').waitFor();
 await page.locator('#negocio-title').fill('Site da Ana · exemplo');await page.locator('#negocio-stage').selectOption('proposta');await page.locator('#negocio-value').fill('2.500,00');await page.locator('#negocio-date').fill('2026-09-21');
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:950});await fit();await page.screenshot({path:`${out}/conferir-${width}.png`});}
 await page.locator('#negocio-dialog').getByRole('button',{name:'Salvar negócio',exact:true}).click();assert.equal(saved(),undefined);
 await page.locator('#negocio-confirm').check();await page.locator('#negocio-dialog').getByRole('button',{name:'Salvar negócio',exact:true}).click();await page.locator('#negocio-dialog').waitFor({state:'hidden'});
 await page.locator('#negocios-today .negocio-card').waitFor();assert.equal(saved().valor_centavos,250000);assert.equal(saved().proximo_contato,'2026-09-21');
 await page.locator('#negocios-today').getByRole('button',{name:'Rever negócio',exact:true}).click();await page.locator('#negocio-title').waitFor();assert.equal(await page.locator('#negocio-value').inputValue(),'2500,00');
 await page.locator('#negocio-stage').selectOption('fechado');await page.locator('#negocio-confirm').check();await page.locator('#negocio-dialog').getByRole('button',{name:'Salvar negócio',exact:true}).click();await page.locator('#negocio-error').getByText('Retire o próximo contato ao fechar ou encerrar o negócio.').waitFor();
 await page.locator('#negocio-date').fill('');await page.locator('#negocio-dialog').getByRole('button',{name:'Salvar negócio',exact:true}).click();await page.locator('#negocio-dialog').waitFor({state:'hidden'});await page.locator('#negocios-today').getByText('Nenhum contato marcado.').waitFor();assert.equal(saved().etapa,'fechado');
 // More businesses exercise complete pagination, source/context scoping and visual density.
 f.conversa('b','Outro cliente · exemplo');for(let i=0;i<8;i++){const id=f.evento('b','b',{texto:'Mensagem sintética de interesse '+i});const p=n.preparar({fonte:id});n.salvar({previa:p.id,confirmar:true,titulo:['Identidade visual','Loja virtual','Fotos do catálogo','Revisão do site','Material de vendas','Campanha de lançamento','Site da clínica','Catálogo digital'][i]+' · exemplo',etapa:i%2?'proposta':'interesse',valor_centavos:i%2?180000:null,proximo_contato:i%2?'2026-09-22':null});}
	 await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();await page.locator('#memory-mode-businesses').click();await page.waitForFunction(()=>document.querySelectorAll('#negocios-memory .negocio-card').length===6);
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:950});await page.locator('#negocios-memory').scrollIntoViewIfNeeded();await fit();await page.screenshot({path:`${out}/negocios-${width}.png`});}
 await page.locator('#negocios-memory').getByRole('button',{name:'Próxima página de negócios',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#negocios-memory .negocio-card').length===3);
 await page.locator('#negocios-memory select').selectOption('fechado');await page.waitForFunction(()=>document.querySelectorAll('#negocios-memory .negocio-card').length===1);assert.match(await page.locator('#negocios-memory').innerText(),/Site da Ana/);
	 await page.locator('#negocios-memory select').selectOption('todas');await page.locator('nav [data-view=memory]').click();await page.locator('.conversation-card').filter({hasText:'Ana · exemplo'}).getByRole('button',{name:'Abrir conversa',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#negocios-memory .negocio-card').length===1);
	 await page.locator('#conversation-detail').getByRole('button',{name:'Voltar à lista',exact:true}).click();await page.locator('#memory-mode-businesses').click();await page.waitForFunction(()=>document.querySelectorAll('#negocios-memory .negocio-card').length===6);
 await page.locator('nav [data-view=today]').click();await page.locator('#negocios-today .negocio-card').first().waitFor();
 // Refresh catches changes made after the page was loaded.
 for(const row of n.listar({contatos:true}).negocios){const p=n.preparar({fonte:row.evento_id});n.salvar({previa:p.id,confirmar:true,titulo:row.titulo,etapa:'encerrado'});}
 await page.locator('#refresh').click();
 await page.locator('#negocios-today').getByText('Nenhum contato marcado.').waitFor();
 db.prepare("UPDATE eventos SET texto='O projeto foi cancelado.' WHERE id=?").run(source);await page.locator('#refresh').click();await page.locator('#negocios-today').getByRole('button',{name:'Conferir novamente'}).click();await page.locator('#negocio-title').waitFor();assert.equal(await page.locator('#negocio-title').inputValue(),'');assert.ok(!(await page.locator('#negocio-dialog').innerText()).includes('2.500'));
 await page.locator('#negocio-title').fill('Site encerrado · exemplo');await page.locator('#negocio-stage').selectOption('encerrado');await page.locator('#negocio-confirm').check();await page.locator('#negocio-dialog').getByRole('button',{name:'Salvar negócio',exact:true}).click();await page.locator('#negocio-dialog').waitFor({state:'hidden'});assert.equal(db.prepare('SELECT count(*) n FROM desktop_negocios_historico WHERE negocio_id=?').get(saved().id).n,1);
 // Server authentication and revocation invalidate previews even after reauthorization.
 const token=(await (await page.request.get(origin+'/api/sessao')).json()).token,headers={'X-Assessor-Token':token};
 const post=(path,data)=>page.request.post(origin+path,{headers,data});
 assert.equal((await page.request.post(origin+'/api/v3/negocios/preparar',{data:{fonte:source}})).status(),403);
 assert.equal((await post('/api/v3/negocios/preparar',{fonte:hidden})).status(),400);
 await post('/api/v3/politica',{conversa:'oculta',politica:'tudo'});const pending=await (await post('/api/v3/negocios/preparar',{fonte:hidden})).json();assert.ok(pending.id);
 await post('/api/v3/politica',{conversa:'oculta',politica:'so-minhas'});await post('/api/v3/politica',{conversa:'oculta',politica:'tudo'});
 const stale=await post('/api/v3/negocios/salvar',{previa:pending.id,confirmar:true,titulo:'Não salvar',etapa:'interesse'});assert.equal(stale.status(),400);assert.match((await stale.json()).erro,/expirada/);
 await post('/api/v3/politica',{conversa:'oculta',politica:'so-minhas'});
 // A delayed source response cannot resurrect the dialog after privacy clearing.
 let release,started;const startedPromise=new Promise(r=>started=r),held=new Promise(r=>release=r);
 const delay=async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});};await page.route('**/api/v3/negocios/preparar',delay);
 await page.evaluate(id=>{window.abrirNegocio(id);},source);await startedPromise;await page.evaluate(()=>window.limparDadosVisiveis());release();await page.waitForTimeout(100);assert.equal(await page.locator('#negocio-dialog').isVisible(),false);assert.equal(await page.locator('#negocio-dialog').innerText(),'');await page.unroute('**/api/v3/negocios/preparar',delay);
 let releaseList,startedList;const listStarted=new Promise(r=>startedList=r),listHeld=new Promise(r=>releaseList=r);
 const delayList=async route=>{const response=await route.fetch();startedList();await listHeld;await route.fulfill({response});};await page.route('**/api/v3/negocios?*',delayList);
 await page.locator('nav [data-view=memory]').click();await listStarted;db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(source);await page.evaluate(()=>window.limparDadosVisiveis());releaseList();await page.waitForTimeout(100);assert.equal(await page.locator('#negocios-memory .negocio-card').count(),0);assert.ok(!(await page.locator('#negocios-memory').innerText()).includes('Site encerrado'));await page.unroute('**/api/v3/negocios?*',delayList);
  const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha de teste recuperável'})});await page.route('**/api/v3/negocios?*',fail);await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-businesses').click();await page.locator('#negocios-memory').getByRole('button',{name:'Tentar novamente'}).waitFor();assert.equal(await page.locator('#negocios-memory .negocio-card').count(),0);await page.unroute('**/api/v3/negocios?*',fail);await page.locator('#negocios-memory').getByRole('button',{name:'Tentar novamente'}).click();await page.locator('#negocios-memory .negocio-card').first().waitFor();
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(provider,0);
 const report={date:new Date().toISOString(),passed:true,widths:[1320,820,390],provider,external,errors,checks:['empty fields and unchecked confirmation','form does not save without confirmation','focus starts in title and Escape cancels without saving','BRL input persists in cents','closing requires removal of next contact','pagination and stage filter','context reset reloads businesses','today refresh reloads contacts','changed source hides old fields and resets history only after confirmation','acceptance and CSRF required','revocation/regrant invalidates preview','privacy clearing discards in-flight dialog and list responses','list failure clears old data and retry succeeds']};writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

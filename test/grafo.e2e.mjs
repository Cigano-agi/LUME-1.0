// Real HTTP and browser, synthetic sources; no WhatsApp, model or native app.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
const db=abrirBanco(),e=perfilGrafo(db);
db.exec('BEGIN');
for(let c=0;c<29;c++){
  const id='c'+String(c).padStart(2,'0');e.conversa(id,c===0?'Criação <img src=x onerror="window.invadiu=true">':'Projeto sintético '+String(c).padStart(2,'0'));
  for(let a=0;a<(c===0?45:4);a++)e.evento(id,'Participante '+String(a).padStart(2,'0'));
}
for(let i=0;i<22;i++)e.evento('c00','Participante 00',{texto:'Fonte do par '+i});
e.evento('c00','AUTOR_PRIVADO',{permissao:'terceiro',texto:'SEGREDO_SINTETICO'});
db.exec("INSERT INTO f10_projetos VALUES('alfa','Projeto Alfa','2026-09-17'); INSERT INTO f10_conversas VALUES('alfa','c00'); COMMIT");
const server=criarServidor(db,{contexto:e.contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,output='work/grafo-qa';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1320,height:1000}}),errors=[],external=[];
  page.on('pageerror',err=>errors.push(err.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))external.push(r.url());});
  await page.clock.install({time:new Date('2026-09-18T12:00:00Z')});await page.clock.pauseAt(new Date('2026-09-18T12:00:01Z'));
  await page.goto(origin+'/app');await page.locator('#owner').fill('Teste do mapa');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  await page.locator('nav [data-view=graph]').click();
  const ready=()=>page.locator('#network[aria-busy=false]').waitFor();await ready();
  assert.match(await page.locator('#graph-count').innerText(),/29 conversas/);assert.equal(await page.locator('#network .graph-node').count(),15);
  assert.equal(await page.locator('#network img').count(),0);assert.equal(await page.evaluate(()=>window.invadiu),undefined);assert.ok(!(await page.locator('#graph').innerText()).includes('AUTOR_PRIVADO'));
  await page.locator('#graph-next').click();await ready();assert.match(await page.locator('#graph-page').innerText(),/página 2 de 3/);
  await page.locator('#graph-prev').click();await ready();
  await page.locator('#network [data-id="c:c00"]').focus();await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Focar conversa',exact:true}).click();await ready();
  assert.match(await page.locator('#graph-page').innerText(),/participantes.*45 no recorte/);
  await page.locator('#graph-next').click();await ready();await page.locator('#graph-next').click();await ready();assert.equal(await page.locator('#network .person').count(),9);
  await page.locator('#graph-back').click();await ready();
  await page.locator('#graph-list [data-id="p:Participante 00"]').click();await page.getByRole('button',{name:'Focar pessoa',exact:true}).click();await ready();
  assert.match(await page.locator('#graph-count').innerText(),/29 conversas/);assert.equal(await page.locator('#network .person').count(),1);
  await page.locator('#graph-back').click();await ready();
  await page.locator('#graph-query').fill('criacao');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();assert.match(await page.locator('#graph-count').innerText(),/1 conversas/);
  await page.locator('#graph-list [data-id="c:c00"]').click();await page.locator('#graph-selection .graph-relation').first().getByRole('button',{name:'Conferir mensagens'}).click();
  await page.locator('#graph-sources .source').first().waitFor();assert.equal(await page.locator('#graph-sources .source').count(),10);
  await page.getByRole('button',{name:'Mais mensagens desta ligação'}).click();await page.waitForFunction(()=>document.querySelectorAll('#graph-sources .source').length===20);
  await page.getByRole('button',{name:'Mais mensagens desta ligação'}).click();await page.waitForFunction(()=>document.querySelectorAll('#graph-sources .source').length===23);
  assert.ok(!(await page.locator('#graph-sources').innerText()).includes('SEGREDO'));
  await page.locator('#graph-sources').screenshot({path:output+'/02-fontes.png'});
  await page.locator('#graph-selection').getByRole('button',{name:'Abrir conversa',exact:true}).click();await page.locator('#memory:not([hidden])').waitFor();await page.locator('#conversation-heading').waitFor();assert.match(await page.locator('#conversation-heading').innerText(),/^Criação/);
  await page.locator('nav [data-view=graph]').click();await ready();
  await page.locator('#graph-query').fill('');await page.locator('#graph-project').selectOption('alfa');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();assert.match(await page.locator('#graph-count').innerText(),/Projeto Alfa/);
  await page.locator('#graph-project').selectOption('');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();
  const initial=await page.locator('#network').getAttribute('viewBox');await page.locator('#graph-in').click();assert.notEqual(await page.locator('#network').getAttribute('viewBox'),initial);
  await page.locator('#network').focus();await page.keyboard.press('ArrowRight');await page.locator('#graph-reset').click();assert.equal(await page.locator('#network').getAttribute('viewBox'),initial);
  const rect=await page.locator('#network').boundingBox();await page.mouse.move(rect.x+10,rect.y+10);await page.mouse.down();await page.mouse.move(rect.x+70,rect.y+45);await page.mouse.up();assert.notEqual(await page.locator('#network').getAttribute('viewBox'),initial);await page.locator('#graph-reset').click();
  // Old response arrives after a different filter.
  let release,seen;const captured=new Promise(r=>seen=r),held=new Promise(r=>release=r);
  const delay=async route=>{const response=await route.fetch();seen();await held;await route.fulfill({response});};
  await page.route('**/api/v3/grafo?q=criacao&*',delay);await page.locator('#graph-query').fill('criacao');await page.getByRole('button',{name:'Aplicar filtros'}).click();await captured;
  await page.locator('#graph-query').fill('Projeto');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();
  const delayed=page.waitForResponse(r=>r.url().includes('grafo?q=criacao'));release();await(await delayed).finished();await page.clock.runFor(100);assert.match(await page.locator('#graph-count').innerText(),/28 conversas/);await page.unroute('**/api/v3/grafo?q=criacao&*',delay);
  const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética'})});
  await page.route('**/api/v3/grafo?*',fail);await page.getByRole('button',{name:'Aplicar filtros'}).click();await page.getByRole('button',{name:'Tentar mapa novamente'}).waitFor();assert.equal(await page.locator('#network .graph-node').count(),0);
  await page.unroute('**/api/v3/grafo?*',fail);await page.getByRole('button',{name:'Tentar mapa novamente'}).click();await ready();
  await page.locator('#graph-query').fill('inexistente');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();assert.equal(await page.locator('#graph-empty').isVisible(),true);assert.equal(await page.locator('#graph-list button').count(),0);
  await page.locator('#graph-query').fill('');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();
  // An in-flight exact-source response must disappear on privacy invalidation.
  let releaseSource,seenSource;const sourceCaptured=new Promise(r=>seenSource=r),sourceHeld=new Promise(r=>releaseSource=r);
  const delaySource=async route=>{const response=await route.fetch();seenSource();await sourceHeld;await route.fulfill({response});};
  await page.route('**/api/v3/grafo/fontes?*',delaySource);await page.locator('#graph-list [data-id="c:c00"]').click();await page.locator('#graph-selection .graph-relation').first().getByRole('button',{name:'Conferir mensagens'}).click();await sourceCaptured;
  await page.evaluate(()=>window.limparDadosVisiveis());const sourceResponse=page.waitForResponse(r=>r.url().includes('grafo/fontes?'));releaseSource();await(await sourceResponse).finished();await page.clock.runFor(100);
  assert.equal(await page.locator('#graph-sources .source').count(),0);assert.equal(await page.locator('#graph-selection').isHidden(),true);await page.unroute('**/api/v3/grafo/fontes?*',delaySource);
  await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();
  for(const width of [390,820,1320]){
    await page.setViewportSize({width,height:1100});await page.locator('#graph h1').evaluate(n=>n.scrollIntoView({block:'start'}));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+`/01-mapa-${width}px.png`});
  }
  // Maximal displayed density: 12 conversations with 36 distinct people, not 3 shared people.
  for(let c=0;c<12;c++){const id='d'+c;e.conversa(id,'Denso sintético '+c);for(let a=0;a<3;a++)e.evento(id,'Autor '+c+'-'+a);}
  await page.locator('#graph-query').fill('Denso');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();
  assert.equal(await page.locator('#network .graph-node').count(),48);await page.locator('#network').screenshot({path:output+'/03-denso.png'});
  // Permission changes through the real settings UI invoke the shared invalidation hook.
  await page.locator('nav [data-view=settings]').click();
   await page.locator('#settings-choice-work').click();
  await page.locator('#policies .policy-row').filter({hasText:'Criação'}).locator('select').selectOption('tudo');
  await page.locator('#feedback').filter({hasText:'Política atualizada'}).waitFor();
  await page.locator('nav [data-view=graph]').click();await ready();await page.locator('#graph-query').fill('criacao');await page.getByRole('button',{name:'Aplicar filtros'}).click();await ready();
  assert.match(await page.locator('#graph-count').innerText(),/68 mensagens/);
  await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#policies .policy-row').filter({hasText:'Criação'}).locator('select').selectOption('so-minhas');
  await page.waitForFunction(()=>document.getElementById('graph-count').textContent==='Atualize para consultar o recorte atual.');
  await page.locator('nav [data-view=graph]').click();await ready();assert.match(await page.locator('#graph-count').innerText(),/67 mensagens/);
  for(const query of ['pagina=0','pagina=1.2','periodo=ano','foco=x:abc'])assert.equal((await page.request.get(origin+'/api/v3/grafo?'+query)).status(),400);
  assert.equal((await page.request.get(origin+'/api/v3/grafo/fontes?conversa=c00')).status(),400);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  writeFileSync(output+'/evidence.json',JSON.stringify({date:new Date().toISOString(),synthetic:true,nativeExecution:false,errors,external,checks:['29 conversations paged','45 participants paged','person focus','accent search','project scope','23 exact-pair sources','XSS literal','keyboard selection','zoom/pan/reset','stale filter discarded','privacy cancels source display','error/retry','empty','390/820/1320 no overflow','48 distinct nodes rendered','permission widening and revocation through settings']},null,2));
  console.log('GRAFO_UI_OK');
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

// HTTP/UI real em perfil sintético. Sem app nativo, banco do dono ou provedor remoto.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilHoje} from './fixtures/hoje-profile.js';
const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db);
const antiga=adicionar({tipo:'compromisso',data:'2025-01-01T12:00:00Z',texto:'Enviar a revisão combinada · exemplo sintético'});
for(let i=0;i<34;i++)adicionar({texto:`Revisar item de teste ${i+1}`});
const lead=adicionar({tipo:'lead',texto:'Preparar proposta <img src=x onerror="window.invadiu=true">'});
adicionar({tipo:'compromisso',permissao:'compartilhado',texto:'SEGREDO EXCLUÍDO DO RECORTE',data:'2020-01-01T12:00:00Z'});
let providerCalls=0;
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{}},gerarIA:async()=>{providerCalls++;throw Error('Provedor proibido neste teste');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,output='work/hoje-qa';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1320,height:950}}),errors=[],external=[];
  await page.emulateMedia({reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))external.push(r.url());});
  await page.clock.install({time:new Date('2026-09-18T15:00:00Z')});await page.clock.pauseAt(new Date('2026-09-18T15:00:01Z'));
  await page.goto(origin+'/app');await page.locator('#owner').fill('Perfil de teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  await page.locator('#first-hide').click();
  await page.locator('#task-options summary').click();
  const esperarTotal=async total=>page.locator('#tasks-count').filter({hasText:`de ${total} itens`}).waitFor();
  await esperarTotal(36);assert.equal(await page.locator('#tasks .task-action').count(),10);
  assert.equal(await page.locator('#tasks .task-action').first().getAttribute('data-acao'),String(antiga.id));
  assert.ok(!(await page.locator('#tasks').innerText()).includes('SEGREDO'));assert.match(await page.locator('#task-options').innerText(),/não mede urgência/);
  await page.locator('#today .content-grid').evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:output+'/01-prioridade.png'});
  // Fonte real, não um modal contendo a cópia do resumo.
  await page.locator('#tasks .task-action').first().getByRole('button',{name:'Ver origem'}).click();
  await page.locator('#memory:not([hidden])').waitFor();assert.match(await page.locator('#results').innerText(),/Enviar a revisão combinada/);
  await page.locator('nav [data-view=today]').click();await esperarTotal(36);
  // Atualização sem mudança preserva o botão que está com foco.
  const button=page.locator('#tasks .task-action').first().getByRole('button',{name:'Ver origem'});
  await button.focus();await page.evaluate(()=>overview());assert.equal(await button.evaluate(e=>document.activeElement===e),true);
  const ids=[];
  for(let pagina=1;pagina<=4;pagina++){
    if(pagina>1){await page.locator('#tasks-next').click();await page.locator('#tasks-count').filter({hasText:`página ${pagina} de 4`}).waitFor();}
    ids.push(...await page.locator('#tasks .task-action').evaluateAll(es=>es.map(e=>e.dataset.acao)));
  }
  assert.equal(ids.length,36);assert.equal(new Set(ids).size,36);assert.equal(await page.locator('#tasks-next').isDisabled(),true);
  await page.screenshot({path:output+'/02-ultima-pagina.png'});
  await page.locator('#tasks-order').selectOption('oportunidades');await page.locator(`#tasks .task-action[data-acao="${lead.id}"]`).first().waitFor();
  assert.equal(await page.locator('#tasks .task-action').first().getAttribute('data-acao'),String(lead.id));
  assert.equal(await page.locator('#tasks img').count(),0);assert.equal(await page.evaluate(()=>window.invadiu),undefined);
  // Uma resposta antiga chega depois de uma ordem mais nova: não pode sobrescrevê-la.
  let release,seen;const intercepted=new Promise(r=>seen=r),held=new Promise(r=>release=r);
  const delay=async route=>{const response=await route.fetch();seen();await held;await route.fulfill({response});};
  await page.route('**/api/v3/resumo?ordem=antigas&*',delay);
  await page.locator('#tasks-order').selectOption('antigas');await intercepted;
  const delayedResponse=page.waitForResponse(r=>r.url().includes('ordem=antigas'));
  await page.locator('#tasks-order').selectOption('recentes');await page.locator('#tasks-rule').filter({hasText:'Adicionadas à lista mais recentemente'}).waitFor();
  release();await (await delayedResponse).finished();await page.clock.runFor(100);
  assert.match(await page.locator('#tasks-rule').innerText(),/^Adicionadas/);assert.equal(await page.locator('#tasks-order').inputValue(),'recentes');await page.unroute('**/api/v3/resumo?ordem=antigas&*',delay);
  // Falha tem recuperação explícita, não conserva ações da ordem anterior.
  const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética'})});
  await page.route('**/api/v3/resumo?*',fail);await page.locator('#tasks-order').selectOption('compromissos');await page.getByRole('button',{name:'Tentar novamente',exact:true}).waitFor();assert.equal(await page.locator('#tasks .task-action').count(),0);
  await page.unroute('**/api/v3/resumo?*',fail);await page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await esperarTotal(36);
  await page.locator('#tasks .task-action').first().getByRole('button',{name:'Marcar resolvido'}).click();await esperarTotal(35);assert.equal(await page.locator(`[data-acao="${antiga.id}"]`).count(),0);
  // Revogação pela interface limpa a contagem anterior e refaz o recorte.
  await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#policies select').selectOption('tudo');await page.locator('#feedback').filter({hasText:'Política atualizada'}).waitFor();
  await page.clock.fastForward(8000);await page.locator('#feedback').waitFor({state:'hidden'});
  await page.locator('nav [data-view=today]').click();await esperarTotal(35);assert.ok(!(await page.locator('#tasks').innerText()).includes('SEGREDO'));
  await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#policies select').selectOption('so-minhas');await page.locator('#policies select').waitFor();
  await page.locator('#feedback').filter({hasText:'Política atualizada'}).waitFor();
  await page.waitForFunction(()=>document.getElementById('tasks-count').textContent==='Atualize para consultar o filtro atual.');
  await page.locator('nav [data-view=today]').click();await esperarTotal(35);assert.ok(!(await page.locator('#tasks').innerText()).includes('SEGREDO'));
  await page.clock.fastForward(8000);await page.locator('#feedback').waitFor({state:'hidden'});
  for(const width of [390,820,1320]){
    await page.setViewportSize({width,height:950});await page.locator('#today .content-grid').evaluate(e=>e.scrollIntoView({block:'start'}));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:output+`/03-fila-${width}px.png`});
  }
  const session=await page.request.get(origin+'/api/sessao'),sessionToken=(await session.json()).token;
  for(const query of ['ordem=__proto__','ordem=','pagina=0','pagina=1.5','pagina=NaN'])assert.equal((await page.request.get(origin+'/api/v3/resumo?'+query,{headers:{'X-Assessor-Token':sessionToken}})).status(),400);
  assert.equal(providerCalls,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  writeFileSync(output+'/evidence.json',JSON.stringify({date:new Date().toISOString(),synthetic:true,nativeExecution:false,providerCalls,external,errors,checks:['old commitment outside latest 30','complete 36-item pagination','explanation and order choice','literal XSS payload','exact source','resolve','focus preserved on unchanged refresh','stale response discarded','error retry','read revocation and count','invalid HTTP parameters','390/820/1320 without overflow']},null,2));
  console.log('HOJE_UI_OK');
} finally {await browser.close();await new Promise(r=>server.close(r));db.close();}

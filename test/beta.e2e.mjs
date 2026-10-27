// UI/HTTP in a synthetic profile. No native launch, WhatsApp or paid provider.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
import {validarRelato,resumoRelato} from '../src/painel/beta-model.js';
const db=abrirBanco(),contexto=new ContextoApp(db);
contexto.nota({titulo:'Fonte sintética',texto:'Revisar a proposta de teste antes de sexta-feira.'});
let providerCalls=0;
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{}},gerarIA:async()=>{providerCalls++;throw Error('No provider allowed');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,output='work/beta-qa',version=JSON.parse(readFileSync('package.json','utf8')).version;mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1320,height:950}}),errors=[],external=[],mutations=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))external.push(r.url());if(r.method()!=='GET')mutations.push({url:r.url(),method:r.method()});});
  await page.clock.install({time:new Date('2026-09-18T15:00:00Z')});
  await page.goto(origin+'/apresentacao');assert.match(await page.locator('body').innerText(),/beta dos sócios é gratuito/i);assert.ok(!(await page.locator('body').innerText()).includes('controles de exclusão ainda estão em desenvolvimento'));
  await page.screenshot({path:output+'/01-apresentacao.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+'/02-apresentacao-390px.png',fullPage:true});
  await page.goto(origin+'/app');await page.locator('#owner').fill('QA sintético');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  await page.setViewportSize({width:1320,height:950});await page.locator('[data-beta-open]').click();await page.locator('#beta-dialog').waitFor();await page.waitForFunction(expected=>document.getElementById('beta-versao')?.value===expected,version);
  await page.locator('#beta-participante').fill('QA sintético, não é sócio');await page.locator('#beta-plataforma').selectOption('windows');await page.locator('#beta-sistema').fill('Navegador em perfil temporário');await page.locator('#beta-case-instalacao').selectOption('nao-testado');
  await page.screenshot({path:output+'/03-guia-preparar.png',fullPage:true});
  await page.locator('[data-beta-step="1"]').click();assert.equal(await page.locator('#beta-start').isDisabled(),true);await page.locator('#beta-history').check();await page.locator('#beta-start').click();assert.equal(await page.locator('#beta-import').isDisabled(),true);
  await page.locator('.beta-close-row button').click();await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-search').click();await page.locator('#search').fill('proposta');await page.locator('#search-form button').click();await page.locator('#results .source').waitFor();assert.match(await page.locator('#results').innerText(),/Revisar a proposta/);
  await page.clock.fastForward(120000);await page.locator('[data-beta-open]').click();assert.match(await page.locator('#beta-timer').innerText(),/^02:/);
  await page.locator('#beta-source').check();await page.locator('#beta-help').selectOption('sozinho');await page.locator('#beta-found').click();assert.match(await page.locator('#beta-measurement').innerText(),/Ação encontrada/);await page.screenshot({path:output+'/04-primeira-acao.png'});
  await page.locator('[data-beta-step="2"]').click();await page.locator('#beta-week').fill('2026-09-14');for(const [n,date] of [[1,'2026-09-14'],[2,'2026-09-16'],[3,'2026-09-18']])await page.locator('#beta-day'+n).fill(date);
  await page.locator('[data-beta-step="3"]').click();await page.locator('#beta-utilidade').selectOption('voltaria');await page.locator('#beta-atrapalhou').fill('<img src=x onerror=window.betaInvadida=true> Exemplo de texto literal.');await page.locator('[name=beta-nome][value=Lastro]').check();await page.locator('#beta-name-reason').fill('Teste sintético de exportação.');await page.locator('#beta-value').fill('Encontrar um combinado com fonte.');
  assert.equal(await page.locator('#beta-readable img').count(),0);assert.match(await page.locator('#beta-summary').innerText(),/em até 5 minutos, sem ajuda/);assert.match(await page.locator('#beta-summary').innerText(),/3 de 3 dias/);
  const downloadPromise=page.waitForEvent('download');await page.locator('#beta-export').click();const download=await downloadPromise;assert.match(download.suggestedFilename(),/^assessor-feedback-.*\.json$/);await download.saveAs(output+'/feedback-sintetico.json');
  const record=JSON.parse(readFileSync(output+'/feedback-sintetico.json','utf8'));validarRelato(record,{hoje:'2026-09-18'});assert.equal(resumoRelato(record).primeiraAcaoNoPrazo,true);assert.equal(resumoRelato(record).tresDiasNaSemana,true);assert.equal(record.casos.instalacao,'nao-testado');assert.ok(!JSON.stringify(record).includes('Revisar a proposta de teste'));
  await page.locator('.beta-names').scrollIntoViewIfNeeded();await page.screenshot({path:output+'/05-feedback.png'});
  await page.locator('#beta-clear').click();assert.equal(await page.locator('#beta-participante').inputValue(),'');await page.locator('#beta-import').setInputFiles(output+'/feedback-sintetico.json');await page.locator('#beta-status').filter({hasText:'Registro reaberto'}).waitFor();assert.equal(await page.locator('#beta-atrapalhou').inputValue(),record.feedback.atrapalhou);assert.equal(await page.evaluate(()=>window.betaInvadida),undefined);
  await page.locator('#beta-import').setInputFiles({name:'ruim.json',mimeType:'application/json',buffer:Buffer.from('{"schema":"outra-versao"}')});await page.locator('#beta-status').filter({hasText:'preservado'}).waitFor();assert.equal(await page.locator('#beta-atrapalhou').inputValue(),record.feedback.atrapalhou);
  await page.locator('#beta-import').setInputFiles({name:'grande.json',mimeType:'application/json',buffer:Buffer.alloc(65537,32)});await page.locator('#beta-status').filter({hasText:'64 KB'}).waitFor();assert.equal(await page.locator('#beta-atrapalhou').inputValue(),record.feedback.atrapalhou);
  await page.locator('[data-beta-step="2"]').click();await page.locator('#beta-day2').fill('2026-09-14');await page.locator('[data-beta-step="3"]').click();assert.equal(await page.locator('#beta-export').isDisabled(),true);assert.match(await page.locator('#beta-summary').innerText(),/dias diferentes/);
  await page.locator('[data-beta-step="2"]').click();await page.locator('#beta-day2').fill('2026-09-16');await page.locator('[data-beta-step="3"]').click();
  for(const width of [820,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('#beta-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);await page.locator('.beta-names').scrollIntoViewIfNeeded();await page.screenshot({path:output+`/06-feedback-${width}px.png`});}
  await page.locator('.beta-close-row button').click();await page.setViewportSize({width:820,height:844});await page.reload();await page.locator('[data-beta-open]').click();await page.locator('#beta-dialog').waitFor();assert.equal(await page.locator('#beta-participante').inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length})),{local:0,session:0});assert.equal(providerCalls,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(mutations.map(r=>r.url.replace(origin,'')),['/api/v3/aceite']);
  writeFileSync(output+'/evidence.json',JSON.stringify({date:new Date().toISOString(),synthetic:true,nativeExecution:false,providerCalls,externalRequests:external,errors,mutations,checks:['manifest version','strict CSP','guide integrated without losing timer','first action at most 5 minutes with source','three distinct days','feedback JSON round trip','invalid and oversized imports preserve data','XSS literal','no messages in export','no persistence after reload','390/820/1320 layout','no external send']},null,2));
  console.log('BETA_UI_OK');
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

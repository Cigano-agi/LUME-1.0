// Focal native global-search proof. Reuses only the completed synthetic QA profile.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {performance} from 'node:perf_hooks';
if(!process.argv.includes('--run')){console.log('PREPARADO: node test/lume-1-native-search.e2e.mjs --run, após liberação da coordenação');process.exit(0);}
const output=resolve('work/lume-1-20261026/native'),previous=JSON.parse(readFileSync(join(output,'resultado.json'),'utf8'));
assert.equal(previous.synthetic,true);assert.equal(previous.failure,undefined);assert.match(basename(previous.profile),/^lume-1-native-qa-/);
const report={synthetic:true,profile:previous.profile,started:new Date().toISOString(),actions:[],errors:[],httpErrors:[],screens:[],scope:'Fonte textual já aparece integralmente no resultado da busca, com conversa, data, permissão e origem; sem inferência por modelo.'};let app;
try{
  app=await electron.launch({args:[resolve('test/lume-1-native-entry.cjs')],env:{...process.env,ASSESSOR_DESKTOP_TEST_PROFILE:previous.profile,LUME_NATIVE_QA:'isolated'},timeout:60000});
  const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.waitForLoadState('domcontentloaded');
  page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),previous.profile);await page.locator('#lv-global-query').waitFor();
  await page.locator('.sidebar [data-view=today]').click();
  const start=performance.now();await page.keyboard.press('Control+k');report.actions.push('Abrir busca global pelo atalho Ctrl+K');assert.equal(await page.evaluate(()=>document.activeElement.id),'lv-global-query');
  await page.locator('#lv-global-query').fill('catálogo');report.actions.push('Digitar catálogo');
  await page.keyboard.press('Enter');report.actions.push('Enviar busca com Enter');
  const source=page.locator('#results .source').filter({hasText:'Mensagem native-qa-23'});await source.waitFor();
  assert.match(await source.innerText(),/Revisar catálogo sintético, página 24,/);assert.match(await source.innerText(),/Catálogo · grupo sintético/);assert.match(await source.innerText(),/Dirigida a você/);assert.equal(await page.locator('#search').inputValue(),'catálogo');
  report.sourceText=await source.innerText();report.flowMs=performance.now()-start;report.actionCount=report.actions.length;assert.ok(report.actionCount<=5);await source.scrollIntoViewIfNeeded();
  const path=join(output,'busca-global-fonte-native.png'),url=page.url();const bytes=await app.evaluate(async({BrowserWindow},url)=>(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url).webContents.capturePage()).toPNG().toString('base64'),url);writeFileSync(path,Buffer.from(bytes,'base64'));report.screens.push(path);
  report.instrumentation=await app.evaluate(()=>global.__lumeNativeQA);assert.deepEqual(report.instrumentation.externalBlocked,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.httpErrors,[]);
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  report.beforeClose=new Date().toISOString();writeFileSync(join(output,'busca-global-resultado.json'),JSON.stringify({...report,encerramentoPendente:true},null,2));
  if(app)await app.close();report.finished=new Date().toISOString();writeFileSync(join(output,'busca-global-resultado.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}

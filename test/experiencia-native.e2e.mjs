// Windows Electron with its real service, isolated profile and fictitious local note.
// Never connects WhatsApp, ChatGPT, Telegram or an executor.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const output=resolve('work/experiencia-lume-20261026/native');mkdirSync(output,{recursive:true});
const profile=mkdtempSync(join(process.platform==='win32'?process.env.APPDATA:tmpdir(),'lume-vivo-qa-'));
const options={args:[resolve('.')],env:{...process.env,ASSESSOR_DESKTOP_TEST_PROFILE:profile},timeout:60000};
const report={synthetic:true,profile,checks:[],errors:[],screens:[],started:new Date().toISOString()};
let app;
async function shot(page,name){
  const p=join(output,name+'.png'),url=page.url();
  const bytes=await app.evaluate(async({BrowserWindow},url)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);return (await w.webContents.capturePage()).toPNG().toString('base64');},url);
  writeFileSync(p,Buffer.from(bytes,'base64'));report.screens.push(p);
}
async function attach(){
  app=await electron.launch(options);const page=await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/*',route=>{const u=new URL(route.request().url());return ['http:','https:'].includes(u.protocol)&&!['127.0.0.1','localhost'].includes(u.hostname)?route.abort():route.continue();});
  return page;
}
try{
  let page=await attach();await page.locator('#owner').waitFor();await shot(page,'01-primeiro-acesso');
  await page.locator('#owner').fill('Ensaio Lume · fictício');await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();
  await page.getByRole('button',{name:'Explorar meu espaço primeiro'}).click();
  await page.locator('#lv-today').waitFor();await page.locator('#first-use').waitFor();
  assert.equal(await page.locator('#lv-today').getAttribute('aria-busy'),'false');
  await page.locator('#first-hide').click();report.checks.push('Primeiro acesso e memória disponíveis sem conectar serviços');
  await page.locator('.sidebar [data-view=settings]').click();await page.locator('#settings-choice-work').click();
  await page.locator('#note-title').fill('Combinado fictício de verificação');
  await page.locator('#note-text').fill('Revisar o catálogo fictício na sexta. <script>throw Error("não executar")</script>');
  await page.locator('#note-form button').click();await page.getByRole('status').filter({hasText:'Ideia guardada'}).waitFor();
  await page.locator('#lv-global-query').fill('catálogo fictício');await page.locator('#lv-global-search button').click();
  await page.locator('#results .source').waitFor();assert.equal(await page.locator('#results script').count(),0);
  await shot(page,'02-memoria-fonte');report.checks.push('Nota persistida, busca e trecho literal sem interpretar HTML');
  await page.getByRole('button',{name:'Relações',exact:true}).click();await page.locator('#graph-list button').first().waitFor();
  await shot(page,'03-relacoes');report.checks.push('Relações 2D com lista equivalente');
  await page.locator('.sidebar [data-view=settings]').click();await page.locator('#settings-choice-appearance').click();
  await page.waitForFunction(()=>!document.getElementById('lv-pref-tema').disabled);
  assert.equal(await page.locator('#lv-pref-som').isChecked(),false);
  await page.locator('#lv-pref-tema').selectOption('dark');await page.locator('#lv-pref-movimento').selectOption('reduce');
  await page.locator('#lv-pref-enabled').check();await page.locator('#lv-pref-pausado').check();
  await page.locator('#lv-pref-save').click();await page.locator('#lv-pref-status').filter({hasText:'Preferências salvas'}).waitFor();
  await shot(page,'04-preferencias-escuro');
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.motion==='reduce');
  const companion=await app.waitForEvent('window',{predicate:p=>p.url().includes('companheiro.html'),timeout:10000}).catch(()=>app.windows().find(p=>p.url().includes('companheiro.html')));
  assert.ok(companion,'Janela nativa do companheiro');await companion.waitForLoadState('domcontentloaded');await shot(companion,'05-companhia-pausada');
  report.checks.push('Companhia nativa ativada, pausa e silêncio separados do atendimento');
  await page.locator('.sidebar [data-view=today]').click();
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.clearDeviceMetricsOverride');
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).pathname==='/app');w.setContentSize(1024,768);});
  await page.waitForFunction(()=>innerWidth<=1024);await shot(page,'06-1024-escuro');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).pathname==='/app');w.webContents.setZoomFactor(2);});
  await page.waitForFunction(()=>innerWidth<=512);
  report.zoom=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).pathname==='/app');return{factor:w.webContents.getZoomFactor(),size:w.getContentSize()};});
  assert.equal(report.zoom.factor,2);
  await shot(page,'07-zoom-200');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>new URL(w.webContents.getURL()).pathname==='/app');w.webContents.setZoomFactor(1);});
  report.checks.push('1024×768 e zoom nativo 200% sem overflow global');
  report.runtime=await app.evaluate(({app})=>({platform:process.platform,node:process.versions.node,electron:process.versions.electron,data:app.getPath('userData'),memory:process.memoryUsage()}));
  assert.equal(report.runtime.data,profile);
  assert.deepEqual(await page.evaluate(()=>({require:typeof window.require,process:typeof window.process})),{require:'undefined',process:'undefined'});
  await app.close();app=null;page=await attach();await page.locator('#workspace').waitFor();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.motion==='reduce');
  await page.locator('#lv-global-query').fill('catálogo fictício');await page.locator('#lv-global-search button').click();await page.locator('#results .source').waitFor();
  await page.locator('.sidebar [data-view=settings]').click();await page.locator('#settings-choice-appearance').click();
  await page.waitForFunction(()=>!document.getElementById('lv-pref-tema').disabled);
  assert.equal(await page.locator('#lv-pref-pausado').isChecked(),true);assert.equal(await page.locator('#lv-pref-som').isChecked(),false);
  await shot(page,'08-reinicio');report.checks.push('Reinício preserva nota, tema, movimento, companhia pausada e som desligado');
  assert.deepEqual(report.errors,[]);
}catch(e){report.failure=e.stack;process.exitCode=1;}
finally{if(app)await app.close();report.finished=new Date().toISOString();writeFileSync(join(output,'resultado.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks,errors:report.errors,failure:report.failure||null}));}

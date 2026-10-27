// Windows native QA, real Electron/service, isolated synthetic profile.
// Run only after coordination has released the consistent profile snapshot.
// All interactions use Electron/Playwright CDP, never personal desktop input.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir,cpus,totalmem} from 'node:os';
import {performance} from 'node:perf_hooks';
import {abrirBanco} from '../src/banco.js';
import {Desktop} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {ContextoPessoal} from '../src/pessoal/contexto.js';

if(!process.argv.includes('--run')){
  console.log('PREPARADO, NÃO EXECUTADO. Após liberação da coordenação: node test/lume-1-native.e2e.mjs --run');
  process.exit(0);
}
const output=resolve('work/lume-1-20261026/native');mkdirSync(output,{recursive:true});
const profile=mkdtempSync(join(process.platform==='win32'?process.env.APPDATA:tmpdir(),'lume-1-native-qa-'));
const dataDir=join(profile,'data');mkdirSync(dataDir);
const db=abrirBanco(join(dataDir,'assessor.db'));new Desktop(db);new ContextoApp(db);const contexto=new ContextoPessoal(db);
const person='550000000099@s.whatsapp.net',group='120000000000099@g.us';
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(person,'Ana Ensaio');db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(group,'Catálogo · grupo sintético');
for(let i=0;i<24;i++){
  const text=`Revisar catálogo sintético, página ${i+1}, na sexta-feira.`;
  const id=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(i===0?person:group,'native-qa-'+i,person,text).lastInsertRowid);
  if(i<4)contexto.registrarDemanda({eventoId:id,resumo:'Revisar página '+(i+1),trecho:text,tipo:'pendencia'});
}
db.close();
const options={args:[resolve('test/lume-1-native-entry.cjs')],env:{...process.env,ASSESSOR_DESKTOP_TEST_PROFILE:profile,LUME_NATIVE_QA:'isolated'},timeout:60000};
const report={synthetic:true,profile,instrumentation:'Test entry replaces BrowserWindow.show with showInactive and suppresses focus calls; production files unchanged.',checks:[],flows:[],errors:[],httpErrors:[],screens:[],resources:[],navigation:[],opening:[],started:new Date().toISOString(),machine:{platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,totalMemoryBytes:totalmem()}};
let app,page,companion;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
function soundProbe(){if(window.__lumeSoundProbe)return;window.__lumeSoundProbe=true;window.__lumeSoundStarts=0;const proto=window.OscillatorNode?.prototype;if(proto){const start=proto.start;proto.start=function(...args){window.__lumeSoundStarts++;return start.apply(this,args);};}}
async function attach(){
  const started=performance.now();app=await electron.launch(options);page=await app.firstWindow();page.setDefaultTimeout(20000);
  page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
  // Instrument only oscillator starts; do not prevent audio or make silence pass artificially.
  await page.addInitScript(soundProbe);
  await page.waitForLoadState('domcontentloaded');await page.evaluate(soundProbe);report.opening.push({stage:report.opening.length?'restart':'first',windowReadyMs:performance.now()-started});
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),profile);return page;
}
async function shot(target,name){
  const path=join(output,name+'.png'),url=target.url();const bytes=await app.evaluate(async({BrowserWindow},url)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);return(await w.webContents.capturePage()).toPNG().toString('base64');},url);
  writeFileSync(path,Buffer.from(bytes,'base64'));report.screens.push(path);
}
async function flow(name,steps,verify){
  assert.ok(steps.length<=5,`${name}: more than five interactions`);const started=performance.now();
  for(const [label,action]of steps)await action();await verify?.();report.flows.push({name,actions:steps.map(([label])=>label),count:steps.length,ms:performance.now()-started});
}
async function metrics(stage){
  await app.evaluate(({app})=>app.getAppMetrics());const samples=[];
  for(let i=0;i<5;i++){await wait(1000);samples.push(await app.evaluate(({app})=>({when:new Date().toISOString(),main:process.memoryUsage(),processes:app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,name:p.name,serviceName:p.serviceName,cpu:p.cpu,memory:p.memory}))})));}
  const value={stage,samples,medianMainRssBytes:median(samples.map(s=>s.main.rss)),medianWorkingSetKiB:median(samples.map(s=>s.processes.reduce((n,p)=>n+(p.memory?.workingSetSize||0),0))),medianCpuPercent:median(samples.map(s=>s.processes.reduce((n,p)=>n+(p.cpu?.percentCPUUsage||0),0)))};report.resources.push(value);return value;
}
async function attendanceSnapshot(){return page.evaluate(()=>window.lumeConnectionRequest('/api/v3/pessoal'));}
function stableAttendance(data){return (data.conversas||[]).map(c=>({id:c.id,modo:c.modo,pausada:c.pausada,atendimento:c.atendimento}));}
async function findCompanion(){
  for(let i=0;i<40;i++){const p=app.windows().find(p=>p.url().includes('companheiro.html'));if(p){await p.waitForLoadState('domcontentloaded');return p;}await wait(250);}throw Error('Companion window unavailable');
}
try{
  await attach();await page.locator('#owner').fill('Ensaio nativo Lume · sintético');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.getByRole('button',{name:'Explorar meu espaço primeiro'}).click();await page.locator('#lv-today').waitFor();await page.locator('#first-hide').click();
  report.checks.push('Primeiro acesso nativo em perfil sintético, nenhuma conta conectada');
  assert.equal(await page.locator('#try-example,#learn-example').count(),0);
  const identity=await page.evaluate(()=>window.lumeConnectionRequest('/api/v3/versao'));report.identity=identity;assert.equal(await page.title(),identity.titulo);assert.equal(await page.locator('.l1-brand-version').innerText(),identity.versaoComercial);
  report.runtime=await app.evaluate(({app})=>({platform:process.platform,node:process.versions.node,electron:process.versions.electron,userData:app.getPath('userData'),version:app.getVersion(),memory:process.memoryUsage()}));
  const before=await attendanceSnapshot();
  await metrics('idle-companion-disabled');
  for(const theme of ['light','dark']){
    await flow('Tema '+theme,[['Tema global',()=>page.locator('#l1-global-theme').selectOption(theme)]],()=>page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme));
    for(const route of ['today','memory','sales','deliveries','contacts','settings']){
      const started=performance.now();await page.locator(`.sidebar [data-view=${route}]`).click();await page.waitForFunction(()=>![...document.querySelectorAll('[aria-busy="true"]')].some(n=>n.getClientRects().length));
      report.navigation.push({route,theme,ms:performance.now()-started});await shot(page,route+'-'+theme);
    }
  }
  await flow('Consultar conexão',[['Ajustes',()=>page.locator('.sidebar [data-view=settings]').click()],['Conexões',()=>page.locator('#settings-choice-connections').click()]],async()=>{await page.locator('#connection-detail').waitFor();assert.match(await page.locator('#connection-detail').innerText(),/desconect|conect|paus|aguard/i);});
  let card=page.locator('.l1-person').filter({has:page.getByRole('heading',{name:'Ana Ensaio',exact:true})});
  await flow('Corrigir tag',[['Pessoas',()=>page.locator('.sidebar [data-view=contacts]').click()],['Corrigir tags',()=>card.getByRole('button',{name:'Corrigir tags'}).click()],['Cliente',()=>page.getByLabel('Cliente',{exact:true}).check()],['Salvar correção',()=>page.getByRole('button',{name:'Salvar correção'}).click()]],async()=>{await page.locator('.l1-dialog').waitFor({state:'detached'});assert.match(await card.innerText(),/Cliente · corrigido por você/);});
  await flow('Compromisso e fonte',[['Pessoas',()=>page.locator('.sidebar [data-view=contacts]').click()],['Ver timeline',()=>card.getByRole('button',{name:'Ver timeline'}).click()],['Conferir fonte',()=>page.locator('.l1-dialog').getByRole('button',{name:'Conferir fonte',exact:true}).first().click()]],async()=>{await page.waitForFunction(()=>document.getElementById('search-context').textContent.includes('Fonte E1'));await page.locator('#results .source').waitFor();assert.match(await page.locator('#results').innerText(),/Revisar catálogo sintético, página 1,/);});
  await flow('Mostrar companhia',[['Mostrar Lume',()=>page.locator('#l1-global-companion').click()]],async()=>{companion=await findCompanion();assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('companheiro.html')).isFocused()),false);});
  await companion.evaluate(soundProbe);await shot(companion,'companhia-ativa');
  await flow('Pausar companhia',[['Pausar',()=>companion.locator('#pausar').click()]],()=>companion.waitForFunction(()=>document.getElementById('companheiro').dataset.state==='pausado'));
  assert.deepEqual(stableAttendance(await attendanceSnapshot()),stableAttendance(before));
  await page.locator('.sidebar [data-view=settings]').click();await page.locator('#settings-choice-appearance').click();await page.waitForFunction(()=>!document.getElementById('lv-pref-movimento').disabled);
  assert.equal(await page.locator('#lv-pref-som').isChecked(),false);await page.locator('#lv-pref-movimento').selectOption('reduce');await page.locator('#lv-pref-save').click();await page.waitForFunction(()=>document.documentElement.dataset.motion==='reduce');
  assert.equal(await companion.locator('#som').getAttribute('aria-pressed'),'false');
  report.soundObservation={main:await page.evaluate(()=>({attached:window.__lumeSoundProbe,starts:window.__lumeSoundStarts})),companion:await companion.evaluate(()=>({attached:window.__lumeSoundProbe,starts:window.__lumeSoundStarts})),scope:'Oscillator starts observed after DOM attachment; no human audibility claim'};assert.equal(report.soundObservation.main.attached,true);assert.equal(report.soundObservation.companion.attached,true);assert.equal(report.soundObservation.main.starts,0);assert.equal(report.soundObservation.companion.starts,0);report.checks.push('Companhia nativa sem foco; pausa preserva atendimento; som opt-in segue desligado; movimento reduzido salvo');await shot(companion,'companhia-pausada');
  await page.locator('.sidebar [data-view=today]').click();await metrics('idle-companion-paused-reduced');
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.clearDeviceMetricsOverride');
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http:'));w.setContentSize(1024,768);});await page.waitForFunction(()=>innerWidth<=1024);await shot(page,'native-1024');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http:')).webContents.setZoomFactor(2));await page.waitForFunction(()=>innerWidth<=512);
  report.zoom=await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http:'));return{factor:w.webContents.getZoomFactor(),size:w.getContentSize()};});assert.equal(report.zoom.factor,2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot(page,'native-200');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http:')).webContents.setZoomFactor(1));
  await page.locator('.sidebar [data-view=contacts]').click();await card.getByRole('button',{name:'Ver timeline'}).focus();await page.keyboard.press('Enter');await page.locator('.l1-timeline-item').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('.l1-dialog').count(),0);report.checks.push('Zoom Electron200%,1024×768, teclado e Escape no percurso real');
  report.nativeInstrumentation=await app.evaluate(()=>global.__lumeNativeQA);assert.deepEqual(report.nativeInstrumentation.externalBlocked,[]);
  await app.close();app=null;await attach();card=page.locator('.l1-person').filter({has:page.getByRole('heading',{name:'Ana Ensaio',exact:true})});await page.locator('#workspace').waitFor();await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.motion==='reduce');await page.locator('.sidebar [data-view=contacts]').click();await card.waitFor();assert.match(await card.innerText(),/Cliente · corrigido por você/);
  companion=await findCompanion();await companion.waitForFunction(()=>document.getElementById('companheiro').dataset.state==='pausado');assert.equal(await companion.locator('#som').getAttribute('aria-pressed'),'false');await shot(page,'reinicio-pessoas');report.checks.push('Reinício preserva tags, tema, movimento, companhia pausada e silêncio');
  assert.deepEqual(await page.evaluate(()=>({require:typeof window.require,process:typeof window.process})),{require:'undefined',process:'undefined'});
  const historicalPath=resolve('work/experiencia-lume-20261026/native/resultado.json');
  if(existsSync(historicalPath)){const old=JSON.parse(readFileSync(historicalPath,'utf8')),historical=old.runtime?.memory?.rss,current=report.resources[0].medianMainRssBytes;report.historicalBaseline={path:historicalPath,started:old.started,metric:'main process RSS only',beforeBytes:historical,currentMedianBytes:current,deltaPercent:Number.isFinite(historical)?(current/historical-1)*100:null,comparable:false,reason:'Historical single RSS snapshot, different synthetic profile and code. No native CPU or latency samples existed; not a regression verdict.'};}
  assert.deepEqual(report.errors,[]);
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  if(app)await app.close();report.finished=new Date().toISOString();writeFileSync(join(output,'resultado.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks,flows:report.flows,errors:report.errors,failure:report.failure||null}));
}

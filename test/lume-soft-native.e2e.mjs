// Native Electron with synthetic profile. Real native collector proof is separate.
// This harness never sends personal desktop input or opens a personal profile.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join,extname} from 'node:path';
import {tmpdir,cpus,totalmem} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {abrirBanco} from '../src/banco.js';
import {Desktop} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {AtividadeApps} from '../src/atividade-apps.js';

if(!process.argv.includes('--run')){console.log('PREPARADO. Após freeze: node test/lume-soft-native.e2e.mjs --run [--baseline]');process.exit(0);}
const baseline=process.argv.includes('--baseline'),ref='2afaca9';
const output=mkdtempSync(resolve('work/lume-soft-20261027')+'/'+(baseline?'baseline-':'current-'));
const profile=mkdtempSync(join(process.platform==='win32'?process.env.APPDATA:tmpdir(),'lume-1-native-qa-soft-'));
mkdirSync(join(profile,'data'));
const db=abrirBanco(join(profile,'data/assessor.db'));new Desktop(db);new ContextoApp(db);
const person='550000000099@s.whatsapp.net';db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(person,'Pessoa de ensaio sintético');
for(let i=0;i<12;i++)db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(person,'soft-fixture-'+i,person,'Fonte sintética do catálogo, página '+(i+1)+'.');
db.close();
const fixtureDb=new DatabaseSync(join(output,'activity-fixture.sqlite'));
let clock=Date.now(),mono=0;
const collector=()=>({estado:'amostra',appId:'editor-ensaio.exe',idleMs:0});
const controllerOptions={coletar:collector,disponivel:true,agora:()=>new Date(clock),monotonico:()=>mono};
let activity=new AtividadeApps(fixtureDb,controllerOptions);
const report={started:new Date().toISOString(),synthetic:true,profile,output,baseline,
  comparison:baseline?'UI assets exactly from Git 2afaca9, current Electron/service and identical synthetic seed. Not a historical binary benchmark.':'Current UI/current service, same synthetic seed as baseline.',
  instrumentation:'Existing test entry changes show to showInactive and suppresses native focus. Activity HTTP responses use real AtividadeApps with synthetic collector and dedicated fixture DB; not the production HTTP authorization/native capture gate.',
  checks:[],flows:[],screens:[],resources:[],errors:[],httpErrors:[],requests:[],machine:{cpu:cpus()[0]?.model,totalMemoryBytes:totalmem(),platform:process.platform}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));let app,page,pid;
const save=()=>writeFileSync(join(output,'resultado.json'),JSON.stringify(report,null,2)+'\n');
const bounded=async(job,ms,label)=>{let timer;try{return await Promise.race([job,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),ms))]);}finally{clearTimeout(timer);}};
const gitFiles=baseline?new Set(execFileSync('git',['ls-tree','-r','--name-only',ref,'--','src/painel'],{encoding:'utf8'}).trim().split(/\r?\n/)):null;
const assets=new Map();
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
function soundProbe(){if(window.__softSoundProbe)return;window.__softSoundProbe=true;window.__softSoundStarts=0;const proto=window.OscillatorNode?.prototype;if(proto){const start=proto.start;proto.start=function(...args){window.__softSoundStarts++;return start.apply(this,args);};}}
async function routing(route){
  const req=route.request(),url=new URL(req.url());
  if(url.pathname.startsWith('/api/v3/atividade-apps')){
    let result;const path=url.pathname;
    try{
      if(req.method()==='GET'&&path==='/api/v3/atividade-apps')result=activity.estado();
      else if(req.method()==='POST'&&path.endsWith('/config'))result=await activity.configurar(req.postDataJSON());
      else if(req.method()==='POST'&&path.endsWith('/apagar'))result=await activity.apagar();
      else return route.fulfill({status:404,json:{erro:'Fixture endpoint absent'}});
      report.requests.push({method:req.method(),path,synthetic:true});return route.fulfill({status:200,json:result});
    }catch(error){return route.fulfill({status:400,json:{erro:error.message}});}
  }
  if(baseline&&req.method()==='GET'&&!url.pathname.startsWith('/api/')){
    const relative=['/','/app'].includes(url.pathname)?'app.html':decodeURIComponent(url.pathname.slice(1));
    const path='src/painel/'+relative;
    if(gitFiles.has(path)){
      if(!assets.has(path))assets.set(path,execFileSync('git',['show',ref+':'+path],{maxBuffer:20*1024*1024}));
      return route.fulfill({status:200,body:assets.get(path),contentType:mime[extname(relative)]||'application/octet-stream'});
    }
  }
  return route.continue();
}
async function attach(){
  report.stage='launch';save();
  const start=performance.now();app=await electron.launch({args:[resolve('test/lume-1-native-entry.cjs')],env:{...process.env,ASSESSOR_DESKTOP_TEST_PROFILE:profile,LUME_NATIVE_QA:'isolated'},timeout:60000});
  app.process().stderr.on('data',bytes=>{const codes=[...new Set(bytes.toString().match(/\b(?:APP_ACTIVITY|PERFIL|BROKER|UTILITY|SQLITE|ERR)_[A-Z0-9_]+\b/g)||[])];if(codes.length){report.runtimeCodes??=[];report.runtimeCodes.push({date:new Date().toISOString(),codes});save();}});
  pid=await app.evaluate(()=>process.pid);page=await app.firstWindow({timeout:60000});page.setDefaultTimeout(15000);
  report.stage='await-local-navigation';report.pid=pid;save();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/app(?:[?#].*)?$/,{waitUntil:'load',timeout:60000});
  report.initialMainRoundtrip=await app.evaluate(async({BrowserWindow})=>{
    global.__softNativeNavigation=[];
    for(const w of BrowserWindow.getAllWindows())w.webContents.on('did-fail-load',(_event,code,_description,_url,main)=>global.__softNativeNavigation.push({code,main}));
    const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http:'));
    if(!w)throw Error('LOCAL_WINDOW_MISSING');const contents=w.webContents;
    if(contents.isLoading())await new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);contents.removeListener('did-finish-load',loaded);contents.removeListener('did-stop-loading',loaded);contents.removeListener('did-fail-load',failed);};
      const loaded=()=>{if(!contents.isLoading()){cleanup();resolve();}};
      const failed=(_event,code,_description,_url,main)=>{if(main){cleanup();reject(Error('INITIAL_NATIVE_LOAD_FAILED_'+code));}};
      const timer=setTimeout(()=>{cleanup();reject(Error('INITIAL_NATIVE_LOAD_TIMEOUT'));},15000);
      contents.on('did-finish-load',loaded);contents.on('did-stop-loading',loaded);contents.on('did-fail-load',failed);loaded();
    });
    await new Promise(resolve=>setImmediate(resolve));
    const readyState=await contents.executeJavaScript('document.readyState');
    return {ready:true,loading:contents.isLoading(),path:new URL(contents.getURL()).pathname,readyState,date:new Date().toISOString()};
  });
  assert.equal(report.initialMainRoundtrip.loading,false);
  assert.equal(report.initialMainRoundtrip.path,'/app');assert.equal(report.initialMainRoundtrip.readyState,'complete');
  report.stage='route-reload';report.initialPagePath=new URL(page.url()).pathname;save();
  await page.context().route(url=>url.protocol==='http:'&&url.hostname==='127.0.0.1',routing);await page.addInitScript(soundProbe);
  page.on('pageerror',error=>report.errors.push(error.message));page.on('response',r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
  await page.reload();
  await page.waitForLoadState('domcontentloaded');await page.evaluate(soundProbe);
  assert.equal(await app.evaluate(({app})=>app.getPath('userData')),profile);
  report.openings??=[];report.openings.push({ms:performance.now()-start,pid});report.stage='attached';save();
}
async function close(){
  if(!app)return;
  try{await bounded(app.evaluate(({app})=>{setTimeout(()=>app.quit(),20);return true;}),5000,'MAIN_QUIT_COMMAND_TIMEOUT');}
  catch(error){
    report.closeCommandFailure=error.message;report.status='failed';
    if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($p -and $c.CommandLine -like '*test*lume-1-native-entry.cjs*' -and $p.ProcessName -eq 'electron'){[void]$p.CloseMainWindow()}`],{windowsHide:true,timeout:10000});
  }
  let exited=false;
  for(let i=0;i<30;i++){
    await pause(500);
    if(process.platform==='win32'){
      const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if(!$p -or $p.HasExited){'EXITED'}else{'RUNNING'}`],{encoding:'utf8',windowsHide:true,timeout:10000});
      exited=result.trim()==='EXITED';
    }else{try{process.kill(pid,0);}catch{exited=true;}}
    if(exited)break;
  }
  assert(exited,'Owned Electron process must exit normally');report.checks.push('Normal quit observed by OS for PID '+pid);app=null;pid=null;
}
async function click(selector){await page.locator(selector).evaluate(node=>node.click());}
async function value(selector,value){await page.locator(selector).evaluate((node,value)=>{node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function flow(name,steps,verify){assert(steps.length<=5);const start=performance.now();for(const [label,action]of steps)await action();await verify?.();report.flows.push({name,actions:steps.map(x=>x[0]),count:steps.length,ms:performance.now()-start});save();}
async function shot(name){const path=join(output,name+'.png');const bytes=await app.evaluate(async({BrowserWindow},url)=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()===url);return(await w.webContents.capturePage()).toPNG().toString('base64');},page.url());writeFileSync(path,Buffer.from(bytes,'base64'));report.screens.push(path);}
async function settled(){await page.waitForFunction(()=>![...document.querySelectorAll('[aria-busy="true"]')].some(n=>n.getClientRects().length));await pause(550);}
async function dimensions(width=1024,height=768,zoom=1){await app.evaluate(({BrowserWindow},{width,height,zoom})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http:'));w.setContentSize(width,height);w.webContents.setZoomFactor(zoom);},{width,height,zoom});await pause(250);}
async function metrics(label){const samples=[];await app.evaluate(({app})=>app.getAppMetrics());for(let i=0;i<5;i++){await pause(1000);samples.push(await app.evaluate(({app})=>({rss:process.memoryUsage().rss,processes:app.getAppMetrics().map(x=>({type:x.type,cpu:x.cpu.percentCPUUsage,workingSetKiB:x.memory.workingSetSize}))})));}report.resources.push({label,samples});}
async function openGroup(group){await click('.sidebar [data-view="settings"]');await click('#settings-choice-'+group);await settled();}
try{
  await attach();
  if(await page.locator('#onboarding').isVisible()){
    await value('#owner','Ensaio soft · dados sintéticos');await click('#consent');await page.getByRole('button',{name:'Preparar meu espaço'}).evaluate(n=>n.click());await page.getByRole('button',{name:'Explorar meu espaço primeiro'}).evaluate(n=>n.click());
  }
  await page.locator('#workspace').waitFor();if(await page.locator('#first-hide').isVisible())await click('#first-hide');
  await dimensions();await metrics('idle-1024-before-interaction');
  for(const theme of ['light','dark']){
    await value('#l1-global-theme',theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    for(const route of ['today','memory','settings']){
      await click('.sidebar [data-view="'+route+'"]');await settled();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot(route+'-'+theme+'-1024');
    }
  }
  await openGroup('appearance');
  if(!baseline){
    const expressions=await page.locator('#ls-gallery [data-expression]').evaluateAll(nodes=>nodes.map(n=>n.dataset.expression));assert(expressions.length>=12);report.expressions=expressions;
    for(const state of expressions){await flow('Prévia '+state,[['Escolher expressão',()=>click('#ls-gallery [data-expression="'+state+'"]')]],async()=>{assert.equal(await page.locator('.ls-gallery-stage .ls-mascote').getAttribute('data-estado'),state);assert.match(await page.locator('#ls-gallery-status').innerText(),/Prévia/);});}
    await page.locator('#ls-gallery').evaluate(n=>n.scrollIntoView());await shot('galeria-13-expressoes');
    await flow('Aceno lúdico',[['Aceno',()=>click('#ls-easter-egg')]],async()=>{await pause(600);assert.equal(await page.locator('.ls-gallery-stage .ls-mascote').evaluate(n=>n.classList.contains('ls-gesture')),false);assert.match(await page.locator('#ls-gallery-status').innerText(),/Prévia lúdica/);});
    await flow('Surpresa da marca',[['Primeiro toque',()=>click('#ls-brand-play')],['Segundo toque',()=>click('#ls-brand-play')],['Terceiro toque',()=>click('#ls-brand-play')]],async()=>{assert.match(await page.locator('#ls-brand-message').innerText(),/prévia/i);await pause(1300);});
    await flow('Constelação da lanterna',[['Acender prévia',()=>click('#ls-lantern-surprise')]],async()=>{await page.locator('.ls-constellation').waitFor();await shot('previa-constelacao');await page.locator('.ls-constellation').waitFor({state:'detached'});});
    await page.locator('#ls-easter-egg').focus();await page.keyboard.press('Enter');await pause(550);report.checks.push('Keyboard Enter dispatched only through isolated Electron CDP');
  }
  assert.equal(await page.locator('#lv-pref-som').isChecked(),false);assert.equal(await page.evaluate(()=>window.__softSoundStarts),0);
  await flow('Som opt-in e prévia',[['Ligar som',()=>click('#lv-pref-som')],['Salvar',()=>click('#lv-pref-save')],['Ouvir decisão',async()=>{await page.waitForFunction(()=>!document.getElementById('lv-preview-decisao').disabled);await click('#lv-preview-decisao');}]],async()=>{await page.waitForFunction(()=>window.__softSoundStarts>0);});
  await flow('Silenciar',[['Desligar som',()=>click('#lv-pref-som')],['Salvar',()=>click('#lv-pref-save')]],()=>page.waitForFunction(()=>document.documentElement.dataset.sound==='false'||document.documentElement.dataset.soundEnabled==='false'||!document.getElementById('lv-pref-som').checked));
  await value('#lv-pref-movimento','reduce');await click('#lv-pref-save');await page.waitForFunction(()=>document.documentElement.dataset.motion==='reduce');
  if(!baseline){await click('#ls-gallery [data-expression="celebracao"]');assert.equal(await page.locator('.ls-gallery-stage .ls-mascote').evaluate(n=>n.classList.contains('ls-gesture')),false);}
  await dimensions(1024,768,2);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot('appearance-200-reduced');await dimensions();
  if(!baseline){
    await flow('Abrir acompanhamento',[['Ajustes',()=>click('.sidebar [data-view="settings"]')],['Dados',()=>click('#settings-choice-data')]],()=>page.locator('#ls-activity-start').waitFor());
    assert(report.requests.some(r=>r.method==='GET'&&r.path==='/api/v3/atividade-apps'),'Fixture interception must be observed before enabling any collection');
    await flow('Iniciar acompanhamento',[['Iniciar',()=>click('#ls-activity-start')]],()=>page.waitForFunction(()=>document.getElementById('ls-activity-start').hidden));
    await activity.passo();clock+=5000;mono+=5000;await activity.passo();
    await click('#ls-activity-refresh');await page.waitForFunction(()=>document.querySelector('.ls-activity-list').textContent.includes('editor-ensaio'));
    assert.equal(activity.estado().resumo.duracaoMs,5000);await shot('atividade-sintetica-5000ms');
    await flow('Excluir aplicativo',[['Executável fictício',()=>value('#ls-activity-excluded','editor-ensaio.exe')],['Salvar limites',()=>page.locator('#ls-activity').getByRole('button',{name:'Salvar limites'}).evaluate(n=>n.click())]],()=>page.waitForFunction(()=>!document.querySelector('.ls-activity-list').textContent.includes('editor-ensaio')));
    assert.equal(activity.estado().resumo.duracaoMs,0);
    await flow('Pausar acompanhamento',[['Pausar',()=>click('#ls-activity-pause')]],()=>page.waitForFunction(()=>document.getElementById('ls-activity-state').textContent.startsWith('Pausado')));
    report.activityBeforeRestart=activity.estado();await activity.encerrar();activity=new AtividadeApps(fixtureDb,controllerOptions);
  }
  await metrics('idle-after-interaction');await close();await attach();await page.locator('#workspace').waitFor();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.motion==='reduce');await openGroup('appearance');assert.equal(await page.locator('#lv-pref-som').isChecked(),false);
  if(!baseline){await openGroup('data');await page.waitForFunction(()=>document.getElementById('ls-activity-state').textContent.startsWith('Pausado'));assert.deepEqual(activity.estado().config.excluidos,['editor-ensaio.exe']);await shot('reinicio-atividade-pausada');}
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.httpErrors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=error.stack;}
finally{
  try{await close();}catch(error){report.closeFailure=error.message;report.status='failed';}
  await activity.encerrar();fixtureDb.close();
  try{
    const check=new DatabaseSync(join(profile,'data/assessor.db'),{readOnly:true});
    try{const row=check.prepare('SELECT valor FROM desktop_config WHERE chave=?').get('atividade_apps_v1');const config=row?JSON.parse(row.valor):null;assert(config?.habilitado!==true,'Native collection must remain disabled in the Electron profile');report.realCollectorEnabledInProfile=false;}finally{check.close();}
  }catch(error){report.isolationFailure=error.message;report.status='failed';}
  report.finished=new Date().toISOString();save();
  console.log(JSON.stringify({status:report.status,output,screens:report.screens.length,flows:report.flows.length,failure:report.failure,closeFailure:report.closeFailure}));
  process.exit(report.status==='passed'?0:1);
}

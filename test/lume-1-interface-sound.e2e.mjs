// Real HTTP/SQLite controls and browser Web Audio scheduling. Synthetic profile.
// --mute-audio prevents physical playback; this is not human audibility proof.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {criarServidor} from '../src/painel/servidor.js';
const out='work/lume-1-20261026/ui-sound-integrated';await mkdir(out,{recursive:true});
const db=abrirBanco(':memory:'),desktop=new Desktop(db);new ContextoApp(db);desktop.aceitar({nome:'Som rápido · ensaio sintético',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
let external=0;const forbidden=()=>{external++;throw Error('External call forbidden');};const conexao={estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},enviarTexto:forbidden};
const pessoal=new LumePessoal(db,{desktop,conexao,chatgpt:{estado:async()=>({available:false,connected:false,accounts:[]}),modelos:async()=>[],encerrar(){},responder:forbidden},telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,publicar:()=>{}});
const server=criarServidor(db,{desktop:true,pessoal,conexao});let browser;
const report={synthetic:true,started:new Date().toISOString(),audio:'Real Web Audio oscillator starts instrumented; browser output muted, not a listening test',checks:[],screens:[],patches:[],errors:[],httpErrors:[]};
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});const context=await browser.newContext({viewport:{width:1024,height:768},reducedMotion:'reduce'});
  await context.addInitScript(()=>{window.audioStarts=[];const original=OscillatorNode.prototype.start;OscillatorNode.prototype.start=function(...args){window.audioStarts.push({at:performance.now()});return original.apply(this,args);};});
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v3/pessoal/companheiro')report.patches.push(r.postDataJSON());});
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();});
  const shot=async name=>{const path=out+'/'+name+'.png';await page.screenshot({path});report.screens.push(path);};
  await page.goto(origin+'/app',{waitUntil:'networkidle'});await page.locator('#l1-global-sound').waitFor();assert.equal(pessoal.companheiro.estado().som,false);assert.equal(await page.evaluate(()=>audioStarts.length),0);
  await page.locator('#l1-sound-summary').focus();await page.keyboard.press('Enter');await page.locator('#l1-global-volume').waitFor();assert.equal(await page.locator('#l1-preview-decisao').isDisabled(),true);await shot('som-desligado-claro');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'l1-sound-summary');
  await page.locator('.sidebar nav [data-view=settings]').click();await page.locator('#settings-choice-appearance').click();await page.locator('#lv-pref-tema').selectOption('dark');
  await page.locator('#l1-sound-summary').click();await page.locator('#l1-global-volume').focus();await page.keyboard.press('End');await page.waitForFunction(()=>LumePreferencias.estado().volume===1);assert.equal(pessoal.companheiro.estado().volume,1);assert.equal(pessoal.companheiro.estado().som,false);assert.deepEqual(report.patches,[{volume:1}]);assert.equal(await page.locator('#lv-pref-tema').inputValue(),'dark');assert.equal(pessoal.companheiro.estado().tema,'system');report.checks.push('Abrir painel + ajustar volume(2ações): PATCH só volume e SQLite real, som continua off e rascunho de tema preservado');
  await page.locator('#l1-global-sound').click();await page.waitForFunction(()=>LumePreferencias.estado().som);assert.equal(pessoal.companheiro.estado().som,true);assert.equal(await page.evaluate(()=>audioStarts.length),0);assert.deepEqual(report.patches.at(-1),{som:true});
  await page.locator('#l1-preview-decisao').click();await page.waitForFunction(()=>audioStarts.length===2);report.checks.push('Som liga em1ação explícita sem tocar; painel + prévia(2ações após opt-in) agenda2osciladores reais');await shot('som-ligado-claro');
  await page.locator('#lv-pref-pausado').check();await page.locator('#lv-pref-save').click();await page.waitForFunction(()=>LumePreferencias.estado().pausado);assert.equal(await page.locator('#l1-preview-decisao').isDisabled(),true);const pausedCount=await page.evaluate(()=>audioStarts.length);assert.equal(await page.evaluate(async()=>(await LumePreferencias.previa('decisao')).tocou),false);assert.equal(await page.evaluate(()=>audioStarts.length),pausedCount);await page.locator('#l1-sound-summary').scrollIntoViewIfNeeded();await shot('som-pausado-escuro');
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>LumePreferencias.estado().pausado);assert.equal(await page.evaluate(()=>audioStarts.length),0);assert.equal(pessoal.companheiro.estado().volume,1);assert.equal(pessoal.companheiro.estado().tema,'dark');report.checks.push('Pausa bloqueia prévia e reload conserva som/volume/tema/pausa sem replay');
  await page.locator('#l1-sound-summary').click();await page.evaluate(()=>document.documentElement.style.zoom='2');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.locator('.l1-sound-panel').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>{const panel=document.querySelector('.l1-sound-panel').getBoundingClientRect(),bar=document.querySelector('.l1-global-controls').getBoundingClientRect();return panel.left>=bar.left-1&&panel.right<=bar.right+1;}),true);await shot('som-zoom-css-200');
  await page.evaluate(()=>document.documentElement.style.zoom='');await page.setViewportSize({width:512,height:384});await page.locator('#l1-sound-options').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await shot('som-reflow-200');assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);await page.keyboard.press('Escape');
  report.checks.push('Claro/escuro,1024×768,CSS200%,reflow512×384,teclado/Escape e reduced-motion sem overflow');
  assert.equal(external,0);assert.deepEqual(report.errors,[]);assert.equal(report.httpErrors.some(e=>e.path!=='/api/v3/novidades'),false);report.external=external;
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await pessoal.encerrar();db.close();report.finished=new Date().toISOString();await writeFile(out+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}

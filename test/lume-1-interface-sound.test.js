import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const scripts=await Promise.all(['lume-soft-audio.js','experiencia-preferencias.js','lume-1-interface.js'].map(file=>readFile(new URL('../src/painel/'+file,import.meta.url),'utf8')));
let browser;before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});after(async()=>{await browser?.close();});
async function setup(t){
  const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});
  await page.setContent('<body><form id="lv-global-search"></form><section id="settings-group-appearance-cards"></section><section id="contacts"></section></body>');
  await page.evaluate(()=>{
    window.saved={som:false,volume:.35,tema:'light',movimento:'reduce',pausado:false,enabled:false,disponivel:true};window.patches=[];window.notes=[];window.gains=[];window.stops=0;window.fail=false;window.suspended=false;window.createdAudio=0;
    window.lumeConnectionRequest=async(path,body)=>{if(body){window.patches.push(body);if(window.fail)throw Error('Falha sintética ao salvar');Object.assign(window.saved,body);}return{...window.saved};};
    window.AudioContext=class{constructor(){window.createdAudio++;this.state=window.suspended?'suspended':'running';}currentTime=0;destination={};resume(){return new Promise(r=>{window.resumeAudio=()=>{this.state='running';r();};});}close(){return Promise.resolve();}createOscillator(){const o={frequency:{setValueAtTime:f=>o.f=f},connect(){},disconnect(){},start(){window.notes.push(o.f);},stop(){window.stops++;}};return o;}createGain(){return{gain:{setValueAtTime(){},linearRampToValueAtTime:v=>window.gains.push(v),exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}};
  });
  for(const script of scripts)await page.addScriptTag({content:script});await page.evaluate(()=>LumePreferencias.carregar());return page;
}
test('Som rápido é opt-in; prévia usa estado salvo, volume e não acumula repetição',async t=>{
  const p=await setup(t);assert.equal(await p.locator('#l1-global-sound').getAttribute('aria-pressed'),'false');await p.locator('#l1-sound-summary').click();assert.equal(await p.locator('#l1-preview-decisao').isDisabled(),true);
  assert.equal(await p.evaluate(async()=>(await LumePreferencias.previa('decisao')).tocou),false);assert.equal(await p.evaluate(()=>createdAudio),0);
  await p.locator('#l1-global-sound').click();assert.deepEqual(await p.evaluate(()=>patches),[{som:true}]);assert.deepEqual(await p.evaluate(()=>notes),[]);
  await p.locator('#l1-preview-decisao').click();assert.deepEqual(await p.evaluate(()=>notes),[620,930]);assert.equal(await p.evaluate(()=>gains[0]),.06*.35);
  await p.locator('#l1-preview-decisao').click();assert.equal(await p.evaluate(()=>notes.length),2);assert.match(await p.locator('#l1-audio-status').innerText(),/já está tocando/);
  await p.keyboard.press('Escape');assert.equal(await p.locator('#l1-sound-options').getAttribute('open'),null);assert.equal(await p.evaluate(()=>document.activeElement.id),'l1-sound-summary');
});
test('Volume rápido salva só volume, preserva tema pendente e reverte controle após falha',async t=>{
  const p=await setup(t);await p.locator('#lv-pref-tema').selectOption('dark');await p.locator('#l1-sound-summary').click();
  await p.locator('#l1-global-volume').evaluate(n=>{n.value='.7';n.dispatchEvent(new Event('input'));n.dispatchEvent(new Event('change'));});await p.waitForFunction(()=>saved.volume===.7);
  assert.deepEqual(await p.evaluate(()=>patches),[{volume:.7}]);assert.equal(await p.locator('#lv-pref-tema').inputValue(),'dark');assert.equal(await p.evaluate(()=>LumePreferencias.estado().tema),'light');assert.equal(await p.evaluate(()=>saved.som),false);
  await p.evaluate(()=>window.fail=true);await p.locator('#l1-global-volume').evaluate(n=>{n.value='.2';n.dispatchEvent(new Event('input'));n.dispatchEvent(new Event('change'));});await p.getByText('Falha sintética ao salvar',{exact:true}).first().waitFor();assert.equal(await p.locator('#l1-global-volume').inputValue(),'0.7');assert.equal(await p.evaluate(()=>saved.volume),.7);assert.deepEqual(await p.evaluate(()=>notes),[]);
});
test('Prévia rápida respeita pausa, volume zero e documento oculto',async t=>{
  const p=await setup(t);await p.evaluate(()=>LumePreferencias.atualizar({som:true,pausado:true}));assert.equal(await p.evaluate(async()=>(await LumePreferencias.previa('conclusao')).tocou),false);
  await p.evaluate(()=>LumePreferencias.atualizar({pausado:false,volume:0}));assert.equal(await p.evaluate(async()=>(await LumePreferencias.previa('conclusao')).tocou),false);
  await p.evaluate(()=>LumePreferencias.atualizar({volume:.4}));await p.locator('#lv-pref-pausado').check();assert.equal(await p.evaluate(async()=>(await LumePreferencias.previa('conclusao')).tocou),false);await p.locator('#lv-pref-pausado').uncheck();await p.locator('#lv-pref-som').uncheck();assert.equal(await p.evaluate(async()=>(await LumePreferencias.previa('conclusao')).tocou),false);await p.locator('#lv-pref-som').check();
  await p.evaluate(()=>LumePreferencias.atualizar({volume:.4}));await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await p.evaluate(async()=>(await LumePreferencias.previa('conclusao')).tocou),false);assert.equal(await p.evaluate(()=>createdAudio),0);assert.deepEqual(await p.evaluate(()=>notes),[]);
});
test('Resume de áudio tardio não toca depois de ocultar nem liga som em nome de rascunho',async t=>{
  const p=await setup(t);await p.locator('#lv-pref-som').check();assert.equal(await p.evaluate(async()=>(await LumePreferencias.previa('decisao')).tocou),false);assert.equal(await p.evaluate(()=>saved.som),false);
  await p.evaluate(()=>LumePreferencias.atualizar({som:true}));await p.evaluate(()=>{window.suspended=true;window.pendingPreview=LumePreferencias.previa('decisao');});await p.waitForFunction(()=>typeof resumeAudio==='function');
  await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));resumeAudio();});assert.equal(await p.evaluate(async()=>(await pendingPreview).tocou),false);assert.deepEqual(await p.evaluate(()=>notes),[]);
});

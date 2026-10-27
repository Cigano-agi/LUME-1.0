import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const script=(await Promise.all(['lume-soft-audio.js','experiencia-preferencias.js'].map(name=>readFile(new URL('../src/painel/'+name,import.meta.url),'utf8')))).join('\n');
let browser;before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});});after(async()=>{await browser?.close();});
async function setup(t){
  const page=await browser.newPage();t.after(()=>page.close());await page.setContent('<section id="settings-group-appearance-cards"></section>');
  await page.evaluate(()=>{
    window.saved={som:true,volume:.8,tema:'light',movimento:'reduce',pausado:false,enabled:false,disponivel:true};window.started=[];window.created=0;window.audioClosed=0;
    window.lumeConnectionRequest=async(path,body)=>{if(body)Object.assign(saved,body);return{...saved};};
    window.AudioContext=class{constructor(){created++;}state='suspended';currentTime=0;destination={};resume(){return new Promise(r=>window.releaseAudio=()=>{this.state='running';r();});}close(){audioClosed++;return Promise.resolve();}createOscillator(){return{frequency:{setValueAtTime(){}},connect(){},disconnect(){},start(){started.push(true);},stop(){}};}createGain(){return{gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}};
  });await page.addScriptTag({content:script});await page.evaluate(()=>LumePreferencias.carregar());assert.equal(await page.evaluate(()=>created),0);
  await page.evaluate(()=>{window.pending=LumePreferencias.previa('decisao');});await page.waitForFunction(()=>typeof releaseAudio==='function');return page;
}
test('sound review: refresh volume zero during suspended AudioContext cannot emit old volume',async t=>{
  const page=await setup(t);await page.evaluate(async()=>{saved.volume=0;await LumePreferencias.carregar();releaseAudio();});
  const result=await page.evaluate(()=>pending);assert.equal(result.tocou,false);assert.deepEqual(await page.evaluate(()=>started),[]);assert.equal(await page.evaluate(()=>LumePreferencias.estado().volume),0);
});
test('sound review: late resume after 400ms budget never emits or replays on refresh',async t=>{
  const page=await setup(t);const result=await page.evaluate(()=>pending);assert.equal(result.tocou,false);await page.evaluate(async()=>{releaseAudio();await LumePreferencias.carregar();});assert.deepEqual(await page.evaluate(()=>started),[]);
});
test('sound review: pagehide during pending resume closes audio and discards scheduled preview',async t=>{
  const page=await setup(t);await page.evaluate(()=>{dispatchEvent(new Event('pagehide'));releaseAudio();});assert.equal((await page.evaluate(()=>pending)).tocou,false);assert.deepEqual(await page.evaluate(()=>started),[]);assert.equal(await page.evaluate(()=>audioClosed),1);
});

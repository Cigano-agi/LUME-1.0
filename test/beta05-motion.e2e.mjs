// Browser motion recording: synthetic profile, no WhatsApp, no model inference.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
const output='work/beta05-motion-qa';mkdirSync(output,{recursive:true});
const db=abrirBanco(),{contexto}=perfilBeta05(db,{agora:new Date()});
db.prepare("DELETE FROM desktop_config WHERE chave IN ('perfil','guia-dispensado')").run();
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{throw Error('WhatsApp proibido no ensaio');}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
let recordingContext,video,videoError=null;
try {
  try { recordingContext=await browser.newContext({viewport:{width:1320,height:950},reducedMotion:'no-preference',recordVideo:{dir:output+'/video',size:{width:1320,height:950}}}); }
  catch(error){videoError=error.message;recordingContext=await browser.newContext({viewport:{width:1320,height:950},reducedMotion:'no-preference'});}
  await recordingContext.addInitScript(()=>{
    window.motionEvidence={waapi:[],css:[],running:[],frames:0};
    const label=node=>node?.id?'#'+node.id:node?.className?.baseVal||node?.className||node?.tagName;
    const native=Element.prototype.animate;
    Element.prototype.animate=function(...args){
      const animation=native.apply(this,args),entry={target:label(this),duration:animation.effect?.getTiming().duration,delay:animation.effect?.getTiming().delay,finished:false};
      window.motionEvidence.waapi.push(entry);
      animation.finished.then(()=>entry.finished=true,()=>entry.cancelled=true);
      return animation;
    };
    document.addEventListener('animationstart',event=>{
      const css=getComputedStyle(event.target);window.motionEvidence.css.push({target:label(event.target),name:event.animationName,duration:css.animationDuration,delay:css.animationDelay});
    },true);
    let previous='';
    function sample(){
      if(window.motionEvidence.stopped)return;
      const running=document.getAnimations().filter(animation=>animation.playState==='running').map(animation=>({target:label(animation.effect?.target),name:animation.animationName||'web-animation',duration:animation.effect?.getTiming().duration,currentTime:Math.round(animation.currentTime||0)}));
      const signature=JSON.stringify(running.map(({currentTime,...value})=>value));
      if(running.length&&signature!==previous)window.motionEvidence.running.push(running);
      previous=signature;window.motionEvidence.frames++;requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  const page=await recordingContext.newPage(),errors=[],requests=[];
  video=page.video();page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/v3/laya'))requests.push(request.url());});
  const settle=()=>page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(a=>a.playState==='running').map(a=>a.finished.catch(()=>{})));});
  await page.goto(origin+'/app');await page.locator('#onboarding:not([hidden])').waitFor();await settle();
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),false);
  assert.equal(await page.evaluate(()=>Boolean(window.Motion?.animate)),true);
  await page.screenshot({path:output+'/01-onboarding.png'});
  await page.locator('#owner').fill('Eduardo · demonstração');await page.locator('#consent').check();await page.locator('#accept-form button').click();
  await page.locator('#connect-step:not([hidden])').waitFor();await settle();
  assert.equal(await page.locator('#skip').isEnabled(),true);await page.screenshot({path:output+'/02-connect.png'});
  await page.locator('#skip').click();await page.locator('#clarity-content:not([hidden])').waitFor();await settle();
  await page.locator('#first-hide').click();await page.locator('#feedback').waitFor({state:'visible'});await page.locator('#feedback').waitFor({state:'hidden'});await settle();
  assert.equal(await page.locator('#clarity-main-action').isEnabled(),true);await page.screenshot({path:output+'/03-today.png'});
  const mascot=await page.locator('.clarity-illustration .lume-mascot').evaluate(node=>({animationName:getComputedStyle(node).animationName,animationDuration:getComputedStyle(node).animationDuration,opacity:getComputedStyle(node).opacity}));
  assert.equal(mascot.animationName,'clarity-arrive');assert.equal(mascot.animationDuration,'0.65s');assert.equal(mascot.opacity,'1');
  await page.locator('#clarity-main-action').click();await page.locator('#memory:not([hidden])').waitFor();await settle();
  assert.match(await page.locator('#results').innerText(),/Nossa reunião de revisão/);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'results');await page.screenshot({path:output+'/04-source.png'});
  await page.locator('nav [data-view=today]').click();await page.locator('#today:not([hidden])').waitFor();await settle();
  await page.locator('#refresh').click();await settle();assert.equal(await page.locator('#refresh').isEnabled(),true);
  await page.screenshot({path:output+'/05-return-today.png'});
  const evidence=await page.evaluate(()=>{window.motionEvidence.stopped=true;return window.motionEvidence;});
  assert.ok(evidence.waapi.some(item=>item.target==='#connect-step'&&item.duration===180&&item.finished));
  assert.ok(evidence.waapi.some(item=>item.target==='#terms-step'&&item.duration===180&&item.finished));
  assert.ok(evidence.css.some(item=>item.name==='clarity-arrive'&&item.duration==='0.65s'));
  assert.ok(evidence.running.flat().some(item=>item.name==='clarity-arrive'));
  assert.ok(evidence.running.flat().some(item=>item.name==='web-animation'));
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
  await recordingContext.close();
  let videoPath=null;if(video){videoPath=output+'/onboarding-today-source-return.webm';copyFileSync(await video.path(),videoPath);}
  writeFileSync(output+'/evidence.json',JSON.stringify({synthetic:true,motionPreference:'no-preference',flow:['onboarding','connection-step','today','source','today','refresh'],modelRequests:requests,errors,mascot,video:videoPath,videoError,...evidence},null,2));
  console.log(JSON.stringify({ok:true,output,video:videoPath,cssStarts:evidence.css.length,waapi:evidence.waapi.length,observedRunningSets:evidence.running.length}));
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}

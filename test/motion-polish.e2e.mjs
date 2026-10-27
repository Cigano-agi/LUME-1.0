import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { perfilHoje } from './fixtures/hoje-profile.js';

const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db);
adicionar({tipo:'compromisso',texto:'Confirmar a revisão da proposta'});
let connection={estado:'conectada',qr:null};
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>connection,iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{throw Error('Provider forbidden');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});

async function enter(page){
  await page.goto(origin+'/app');
  if(await page.locator('#onboarding').isVisible()){
    await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();
    await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  }
  await page.locator('#workspace').waitFor();
  if(await page.locator('#first-use').isVisible())await page.locator('#first-hide').click();
}

try{
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  await enter(page);
  const result=await page.evaluate(async()=>{
    const calls=[];const original=Motion.animate;
    Motion.animate=(target,keyframes,options)=>{calls.push({target:target.id||[...(target.classList||[])].join('.'),keyframes,options});return original(target,keyframes,options);};
    const fixture=document.createElement('div');fixture.id='motion-fixture';fixture.textContent='1';document.body.append(fixture);
    const orb=document.createElement('div');orb.className='orb';orb.append(document.createElement('i'));document.body.append(orb);
    const first=lumeChanged(fixture,'one'),same=lumeChanged(fixture,'one'),second=lumeChanged(fixture,'two');
    let scrollOptions;fixture.scrollIntoView=options=>{scrollOptions=options;};lumeScrollIntoView(fixture,{smooth:true,block:'nearest'});
    const statusCalls=()=>calls.filter(call=>call.target==='home-status'||call.target.includes('lume-mascot')).length;
    const beforeStatus=statusCalls();await status();await status();const unchangedStatus=statusCalls()-beforeStatus;
    return {first,same,second,scrollOptions,calls,unchangedStatus,scrollBehavior:getComputedStyle(document.documentElement).scrollBehavior,orbAnimation:getComputedStyle(orb.firstElementChild).animationName};
  });
  assert.equal(result.first,true);assert.equal(result.same,false);assert.equal(result.second,true);
  assert.equal(result.calls.filter(call=>call.target==='motion-fixture').length,2,'same data must not replay motion');
  assert.equal(result.unchangedStatus,0,'polling an identical connection state must stay still');
  assert.equal(result.scrollOptions.behavior,'smooth');
  assert.equal(result.scrollBehavior,'auto');
  assert.equal(result.orbAnimation,'none');
  for(const call of result.calls){
    assert.ok((call.options?.duration||0)<=.32,'motion exceeds 320ms');
    assert.equal('filter' in (call.keyframes||{}),false,'motion must not animate blur/filter');
    if(Array.isArray(call.keyframes?.y))assert.ok(Math.max(...call.keyframes.y.map(Math.abs))<=8,'motion exceeds 8px');
  }

  connection={estado:'reconectando',qr:null};
  const changed=await page.evaluate(async()=>{
    const original=Motion.animate;let count=0;
    Motion.animate=(target,keyframes,options)=>{if(target.id==='home-status')count++;return original(target,keyframes,options);};
    await status();await status();return {count,state:document.querySelector('#home-status').dataset.state};
  });
  assert.equal(changed.state,'working');assert.equal(changed.count,1,'a real status change should animate once');
  assert.equal(await page.locator('.home-status-mascot').getAttribute('data-mascot-state'),'processing');
  assert.equal(await page.locator('.home-status-mascot').evaluate(node=>getComputedStyle(node).animationName),'none','mascot must not use a looping CSS animation');

  const reduced=await browser.newPage({viewport:{width:1100,height:900},reducedMotion:'reduce'});
  await enter(reduced);
  const reducedResult=await reduced.evaluate(()=>{
    let count=0;const original=Motion.animate;Motion.animate=(...args)=>{count++;return original(...args);};
    const fixture=document.createElement('div');document.body.append(fixture);let scrollOptions;
    fixture.scrollIntoView=options=>{scrollOptions=options;};
    lumeReveal(document.querySelector('#today .page-heading'));lumeChanged(fixture,'one');lumeToast(fixture,true);lumeScrollIntoView(fixture,{smooth:true});
    return {count,scrollOptions,mascotAnimation:getComputedStyle(document.querySelector('.home-status-mascot')).animationName};
  });
  assert.equal(reducedResult.count,0);assert.equal(reducedResult.scrollOptions.behavior,'auto');assert.equal(reducedResult.mascotAnimation,'none');
  await reduced.close();await page.close();

  const motion=readFileSync('src/painel/lume-motion.js','utf8');
  const scripts=['src/painel/app.js','src/painel/lume-motion.js','src/painel/mcp.js'].map(file=>readFileSync(file,'utf8')).join('\n');
  const styles=['src/painel/app.css','src/painel/lume-theme.css'].map(file=>readFileSync(file,'utf8')).join('\n');
  assert.doesNotMatch(motion,/filter\s*:/i);
  assert.doesNotMatch(scripts,/addEventListener\(['"](?:mouse|pointer)move/i);
  assert.doesNotMatch(styles,/cursor\s*:\s*(?:none|url\()/i);
  assert.doesNotMatch(styles,/animation\s*:[^;}]*infinite[^;}]*!important/i);
  console.log('MOTION_POLISH_UI_OK');
}finally{
  await browser.close();await new Promise(resolve=>server.close(resolve));db.close();
}

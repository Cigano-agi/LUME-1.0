// Prova visual e de interação dos Ajustes em mouse, teclado e toque.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {ContextoApp} from '../src/contexto-app.js';

const db=abrirBanco(),contexto=new ContextoApp(db),out='work/settings-groups-qa';mkdirSync(out,{recursive:true});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'conectada',qr:null}),iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{throw Error('Provedor proibido');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1320,height:950},hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage(),errors=[],external=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin))external.push(request.url());});
const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
const home=async()=>{
  await page.locator('nav [data-view=settings]').click();
  await page.locator('#settings-home').waitFor();
  assert.equal(await page.locator('#settings-home .settings-choice:visible').count(),3);
  assert.equal(await page.locator('[data-settings-group-panel]:visible').count(),0);
  assert.equal(await page.locator('.settings-card').count(),16);
};
const oneGroup=async(id,count)=>{
  await page.locator(`#settings-group-${id}`).waitFor();
  assert.equal(await page.locator('[data-settings-group-panel]:visible').count(),1);
  assert.equal(await page.locator(`#settings-group-${id}`).isVisible(),true);
  assert.equal(await page.locator(`#settings-group-${id} .settings-card:visible`).count(),count);
};
try{
  await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  for(const width of [390,820,1320]){
    await page.setViewportSize({width,height:950});await home();await fit();
    await page.screenshot({path:`${out}/escolhas-${width}.png`,fullPage:true});
    if(width===390)await page.locator('#settings-choice-connections').tap();
    else if(width===820){await page.locator('#settings-choice-work').focus();await page.keyboard.press('Enter');}
    else await page.locator('#settings-choice-data').click();
    const selected=width===390?'connections':width===820?'work':'data';await oneGroup(selected,width===390?3:width===820?7:6);await fit();
    assert.equal(await page.evaluate(()=>document.activeElement?.id),`settings-group-${selected}-title`);
    await page.screenshot({path:`${out}/grupo-${selected}-${width}.png`,fullPage:true});
    const back=page.locator('[data-settings-group-panel]:visible [data-settings-back]');await back.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#settings-home').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'settings-choice-connections');
  }
  await page.setViewportSize({width:390,height:950});await page.locator('nav [data-view=today]').click();await page.locator('#connection').tap();
  await oneGroup('connections',3);
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('[data-settings-card]')?.id),'settings-whatsapp');
  await home();await page.locator('#settings-choice-data').tap();await page.locator('#guide-claude').tap();
  await oneGroup('connections',3);
  assert.equal(await page.evaluate(()=>document.activeElement?.closest('[data-settings-card]')?.id),'mcp-panel');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const report={date:new Date().toISOString(),passed:true,widths:[390,820,1320],cards:15,checks:['exactly three initial choices','one group visible at a time','all cards remain reachable','mouse, touch and keyboard','back restores choices and focus','connection opens WhatsApp','Claude opens MCP','no horizontal overflow','no external requests'],errors,external};
  writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await context.close();await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}

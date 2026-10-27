import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {validarAnotacoes} from '../scripts/laya-annotations-lib.mjs';

const selection={schema:'lume-laya-review-selection-v1',dataKind:'local_dm_unreviewed',items:[
  {id:'s101',personKey:'pessoa_a',conversationKey:'conversa_a',channel:'dm',author:'other',text:'Você consegue enviar a proposta amanhã?',receivedAt:'2026-09-25T10:00:00.000Z',reviewed:false,sourceId:101},
  {id:'s102',personKey:'pessoa_b',conversationKey:'conversa_b',channel:'dm',author:'self',text:'Eu envio o resumo da reunião na sexta-feira.',receivedAt:'2026-09-25T11:00:00.000Z',reviewed:false,sourceId:102},
  {id:'s103',personKey:'pessoa_c',conversationKey:'conversa_c',channel:'dm',author:'other',text:'A negociação já foi concluída ontem.',receivedAt:'2026-09-25T12:00:00.000Z',reviewed:false,sourceId:103}
]};
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1320,height:900}});
const errors=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(/^https?:/u.test(request.url()))requests.push(request.url());});
await page.addInitScript(()=>{
  window.__saved=[];
  Object.defineProperty(window,'showSaveFilePicker',{configurable:true,value:async()=>({createWritable:async()=>({write:async value=>window.__saved.push(JSON.parse(value)),close:async()=>{}})})});
});
await page.goto(new URL('../tools/laya-revisao.html',import.meta.url).href);
const load=async()=>page.locator('#selection-file').setInputFiles({name:'synthetic.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(selection))});
await load();
assert.match(await page.locator('#notice').textContent(),/3 mensagens carregadas/u);
assert.equal(await page.locator('#message').textContent(),selection.items[0].text);
await page.locator('#include').click();
assert.match(await page.locator('#notice').textContent(),/Confirme a leitura/u);
await page.locator('#rights').check();
await page.locator('#span').fill('enviar a proposta amanhã');
await page.locator('#add-request').click();
await page.locator('#include').click();
assert.equal(await page.locator('#included').textContent(),'1');
await page.locator('#rights').check();
await page.locator('#include').click();
await page.locator('#rights').check();
await page.locator('#include').click();
await page.locator('#save-draft').click();
await page.waitForFunction(()=>window.__saved.length===1);
const saved=await page.evaluate(()=>window.__saved[0]);
assert.equal(saved.schema,'lume-laya-review-draft-v1');
assert.equal(saved.annotations.length,3);
await page.locator('#save-annotations').click();
assert.match(await page.locator('#notice').textContent(),/Confirme a revisão do titular/u);
await page.locator('#owner').check();
await page.locator('#save-annotations').click();
await page.waitForFunction(()=>window.__saved.length===2);
const exported=await page.evaluate(()=>window.__saved[1]);
assert.equal(validarAnotacoes(exported).items.length,3);
assert.equal(exported.items.length,3);
assert.equal(exported.items[0].actions[0].type,'request');
assert.equal(exported.items.every(item=>item.rightsConfirmed),true);
await page.locator('#next-pending').click();
assert.match(await page.locator('#notice').textContent(),/Todas as mensagens/u);
await load();
await page.locator('#draft-file').setInputFiles({name:'good.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(saved))});
assert.equal(await page.locator('#included').textContent(),'3');
const malicious={...saved,annotations:[['s101',{status:'include',critical:false,risks:['none'],actions:[],rightsConfirmed:false}]]};
await page.locator('#draft-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(malicious))});
assert.match(await page.locator('#notice').textContent(),/Rascunho incompatível/u);
assert.equal(await page.locator('#included').textContent(),'3');
const large={...selection,items:Array.from({length:180},(_,n)=>({
  id:`s${1000+n}`,personKey:`pessoa_${n}`,conversationKey:`conversa_${n}`,channel:'dm',author:'other',
  text:`Mensagem sintética número ${n} para revisão.`,receivedAt:'2026-09-25T12:00:00.000Z',reviewed:false,sourceId:1000+n
}))};
await page.locator('#selection-file').setInputFiles({name:'large.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(large))});
assert.match(await page.locator('#scope-summary').textContent(),/150 DMs distintas de 180 mensagens/u);
assert.match(await page.locator('#position').textContent(),/1 de 150/u);
await page.locator('#all-scope').click();
assert.match(await page.locator('#position').textContent(),/1 de 180/u);
await page.locator('#sample-scope').click();
assert.match(await page.locator('#position').textContent(),/1 de 150/u);
for(const width of [390,820,1320]){
  await page.setViewportSize({width,height:850});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`horizontal overflow at ${width}`);
  await page.screenshot({path:`work/laya-review-ui-${width}.png`,fullPage:true});
}
assert.deepEqual(errors,[]);
assert.deepEqual(requests,[]);
await browser.close();
console.log('Laya review UI: synthetic review, save, resume validation and 3 viewports OK');

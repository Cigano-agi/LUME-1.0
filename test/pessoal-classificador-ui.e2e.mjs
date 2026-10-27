import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const page=await browser.newPage();
 await page.setContent('<main><section><details id="pessoal-companion"></details><section id="pessoal-atendimento"></section></section></main>');
 await page.evaluate(()=>{
  window.calls=[];window.current={enabled:false,configurada:false,modelo:'typesafe/jev-1.14',limiteMensalMicrousd:0,reservadoMicrousd:0,motivo:'Conecte uma chave própria.'};
  window.lumeConnectionRequest=async(path,body)=>{window.calls.push({path,body});if(window.fail&&body)throw Error('Tempo esgotado.');if(path.endsWith('configurar'))window.current.configurada=true;else if(path.endsWith('remover'))window.current.configurada=false;else if(body)window.current={...window.current,...body};return {...window.current};};
 });
 await page.addScriptTag({path:'src/painel/pessoal-classificador.js'});
 assert.equal(await page.evaluate(()=>window.calls.length),0,'Lazy UI makes no call on load');
 await page.locator('#pessoal-classificador > summary').click();
 await page.waitForFunction(()=>document.querySelector('#classificador-save').disabled===false);
 assert.equal(await page.locator('#classificador-enabled').isDisabled(),true);
 await page.locator('#pessoal-classificador details > summary').click();
 await page.locator('#classificador-key').fill('SYNTHETIC_KEY');await page.locator('#classificador-key-form button').click();
 await page.waitForFunction(()=>!document.querySelector('#classificador-enabled').disabled);
 assert.equal(await page.locator('#classificador-key').inputValue(),'');
 assert.equal(await page.locator('#classificador-enabled').isChecked(),false);
 await page.locator('#classificador-enabled').check();await page.locator('#classificador-limit').fill('0.01');
 assert.equal(await page.locator('#classificador-save').isDisabled(),true);
 await page.locator('#classificador-consent').check();await page.locator('#classificador-save').click();
 await page.waitForFunction(()=>window.current.enabled);
 assert.equal((await page.evaluate(()=>window.calls.filter(c=>c.path.endsWith('classificador')&&c.body)))[0].body.limiteMensalMicrousd,10000);
 await page.locator('#classificador-remove').click();
 await page.waitForFunction(()=>!window.current.configurada);
 assert.equal(await page.locator('#classificador-enabled').isDisabled(),false,'Can switch off after key removed');
 await page.locator('#classificador-enabled').uncheck();await page.locator('#classificador-save').click();
 await page.waitForFunction(()=>!window.current.enabled);
 await page.evaluate(()=>window.fail=true);const before=await page.evaluate(()=>window.calls.length);
 await page.locator('#classificador-save').click();await page.waitForFunction(()=>document.querySelector('#classificador-result').textContent.includes('Tempo esgotado'));
 await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.calls.length),before+1,'No retry on mutation timeout');
 console.log('PASS: lazy, no key/no spend by default, separate consent, fixed limit, key cleared, disable after removal, no POST retry. Synthetic DOM only.');
}finally{await browser.close();}

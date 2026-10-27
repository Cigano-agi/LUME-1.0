import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';

const db=abrirBanco();
let envios=0;
const central={
  consultar:async()=>({situacao:'feedback_autorizado',consentido:false,feedbackHabilitado:true,registrado:true,revogada:false,instalacaoId:'b84c33d7-35c6-4a89-bf3f-7f9dc7c8b133',ultimoSucessoEm:null,proximaTentativaEm:null,falhasConsecutivas:0}),
  enviarFeedback:async()=>{envios++;throw new Error('Envio não esperado no handoff.');}
};
const server=criarServidor(db,{desktop:true,central,conexao:{estado:()=>({estado:'desconectada',qr:null}),iniciar:async()=>{},parar:async()=>{}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1100,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin+'/app');
  await page.locator('#owner').fill('Pessoa teste');
  await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();
  await page.locator('#skip').click();
  await page.locator('[data-beta-open]').click();
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-beta-step="3"]').click();
  await page.locator('#beta-atrapalhou').fill('O QR não explicou como continuar.');
  await page.locator('#beta-faltou').fill('Quero um passo claro depois de conectar.');
  await page.locator('#beta-utilidade').selectOption('talvez');
  mkdirSync('work/beta-qa',{recursive:true});
  await page.locator('.beta-review').screenshot({path:'work/beta-qa/07-enviar-feedback-390.png'});
  await page.locator('#beta-send').click();
  await page.locator('#central-feedback-text').waitFor({state:'visible'});
  assert.equal(await page.locator('#beta-dialog').evaluate(node=>node.open),false);
  assert.equal(await page.locator('#central-feedback-text').inputValue(),'O QR não explicou como continuar.\n\nQuero um passo claro depois de conectar.');
  assert.equal(await page.locator('#central-feedback-utility').inputValue(),'parcial');
  assert.equal(await page.locator('#central-feedback-stage').inputValue(),'ajustes');
  assert.equal(await page.locator('#central-feedback-status').innerText()!=='Recebido',true);
  assert.equal(envios,0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('BETA_FEEDBACK_HANDOFF_OK');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}

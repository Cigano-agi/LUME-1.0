import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';

const out='work/atualizacoes-qa';mkdirSync(out,{recursive:true});
const db=abrirBanco();let state={disponivel:true,estado:'em_dia',canal:'beta',versaoAtual:'3.1.0-beta.1',versaoNova:null,progresso:null,codigoErro:null,verificadoEm:null},actions=[];
const atualizacoes={estado:()=>({...state}),executar:async action=>{actions.push(action);if(action==='verificar')state={...state,estado:'disponivel',versaoNova:'3.1.0-beta.2',verificadoEm:'2026-09-18T20:00:00.000Z'};if(action==='baixar')state={...state,estado:'pronta',versaoNova:'3.1.0-beta.2'};if(action==='instalar')state={...state,estado:'pronta'};return{...state};}};
const server=criarServidor(db,{desktop:true,atualizacoes,conexao:{estado:()=>({estado:'desconectada',qr:null}),iniciar:async()=>{},parar:async()=>{}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1320,height:1000},reducedMotion:'reduce'}),errors=[],external=[];
page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
try{
 assert.equal((await page.request.get(origin+'/api/v3/atualizacoes')).status(),403);
 await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();await page.locator('#first-hide').click();
 await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-data').click();const panel=page.locator('#atualizacoes-panel');await panel.getByText('Versão instalada: 3.1.0-beta.1 · canal beta').waitFor();
 await panel.getByRole('button',{name:'Verificar agora'}).click();await panel.getByText('Versão 3.1.0-beta.2 disponível.').waitFor();
 const notice=page.locator('#atualizacao-aviso');await notice.getByText('Nova versão 3.1.0-beta.2').waitFor();
 await notice.getByRole('button',{name:'Depois'}).click();await notice.waitFor({state:'hidden'});await page.evaluate(()=>window.carregarAtualizacoes());await notice.waitFor({state:'hidden'});
 await panel.getByRole('button',{name:'Baixar atualização'}).click();await panel.getByText('Versão 3.1.0-beta.2 pronta para instalar.').waitFor();await notice.getByText('Atualização pronta').waitFor();
 await page.waitForTimeout(7200);
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:1000});await panel.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await panel.screenshot({path:`${out}/atualizacoes-${width}.png`});await notice.screenshot({path:`${out}/aviso-${width}.png`});}
 await notice.getByRole('button',{name:'Reiniciar agora'}).click();await page.waitForFunction(()=>document.querySelector('#atualizacoes-status')?.textContent.includes('pronta para instalar'));
 assert.deepEqual(actions,['verificar','baixar','instalar']);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const report={date:new Date().toISOString(),passed:true,widths:[390,820,1320],syntheticUpdate:true,actions,errors,external};writeFileSync(`${out}/checks.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}

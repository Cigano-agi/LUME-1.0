// UX resilience: navigation context, honest search errors and non-overlapping mobile feedback.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { perfilHoje } from './fixtures/hoje-profile.js';

const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db);
adicionar({tipo:'compromisso',texto:'Revisar a proposta de teste'});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'conectada',qr:null}),iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{throw Error('Provider forbidden');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});

try{
  const page=await browser.newPage({viewport:{width:1320,height:950},reducedMotion:'reduce'});
  await page.goto(origin+'/app');
  await page.locator('#owner').fill('Pessoa de teste');
  await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();
  await page.locator('#skip').click();
  await page.locator('#first-hide').click();

  await page.locator('#refresh').focus();
  await page.keyboard.press('2');
  assert.equal(await page.locator('#today').isVisible(),true,'atalho não deve roubar foco de um botão');

  await page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus();});
  await page.keyboard.press('2');
  await page.locator('#memory').waitFor();
  assert.equal(await page.locator('nav [data-view="memory"]').getAttribute('aria-current'),'page');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#memory .page-heading h1')),true);

  await page.locator('[data-memory-mode="search"]').click();
  await page.locator('#search').fill('proposta');
  await page.locator('#search-form button').click();
  await page.locator('#results .source').waitFor();

  await page.route('**/api/v3/busca?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética'})}));
  await page.locator('#search').fill('consulta que falha');
  await page.locator('#search-form button').click();
  await page.locator('#results [role="alert"]').waitFor();
  assert.equal(await page.locator('#results .source').count(),0,'resultado anterior não pode sobreviver a uma busca que falhou');
  assert.equal(await page.locator('#results').getAttribute('aria-busy'),'false');
  await page.unroute('**/api/v3/busca?*');

  await page.locator('nav [data-view="today"]').click();
  await page.setViewportSize({width:390,height:950});
  await page.evaluate(()=>feedback('Aviso de teste que não cobre o conteúdo.'));
  const toast=await page.locator('#feedback').boundingBox(),main=await page.locator('#today .page-heading').boundingBox();
  assert.ok(toast&&main&&toast.y+toast.height<=main.y+1,'toast móvel deve ficar visível sem cobrir o conteúdo');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  console.log('UX_RESILIENCE_OK');
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
  db.close();
}

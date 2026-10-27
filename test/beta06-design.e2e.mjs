// UI audit against the real HTTP/Electron renderer. Synthetic, in-memory DB only.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {AcoesLume} from '../src/acoes-lume.js';
const baseline=process.argv.includes('--baseline');
const output=`work/beta06-design/${baseline?'baseline':'review'}`;mkdirSync(output,{recursive:true});
const db=abrirBanco(':memory:'),{contexto,desktop,fontes}=perfilBeta05(db,{agora:new Date()});
if(!baseline){
  const actions=new AcoesLume(db);actions.autorizar({conversa:'demo-ana',permitida:true});
  actions.registrar({eventoId:fontes.ana.id,candidatas:[{fonte:'E'+fontes.ana.id,tipo:'compromisso',resumo:'Preparar a reunião de revisão com Ana',trecho:'Nossa reunião de revisão ficou para 24/09 às 10h.',prazo_citado:'24/09 às 10h'}]});
}
desktop.configurarGuia({dispensado:true});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{throw Error('Conexão proibida no ensaio');}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[],external=[],evidence={synthetic:true,baseline,sizes:[]};
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith(origin))external.push(request.url());});
  await page.goto(origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
  for(const width of [1440,820,390]){
    await page.setViewportSize({width,height:1000});await page.screenshot({path:`${output}/today-${width}.png`,fullPage:true});
    await page.screenshot({path:`${output}/today-viewport-${width}.png`});
    evidence.sizes.push({view:'today',width,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),cta:baseline?null:await page.locator('#luminus-body .resolver-open').boundingBox()});
    if(evidence.sizes.at(-1).overflow)console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth&&n.getClientRects().length).map(n=>({tag:n.tagName,id:n.id,class:n.className,right:n.getBoundingClientRect().right})).slice(0,20)));
    assert.equal(evidence.sizes.at(-1).overflow,false,`Today overflow ${width}`);
  }
  await page.setViewportSize({width:1440,height:1000});
  if(!baseline){await page.setViewportSize({width:390,height:844});await page.screenshot({path:output+'/today-mobile-844.png'});const cta=await page.locator('#luminus-body .resolver-open').boundingBox();assert.ok(cta.y+cta.height<774,'primary CTA above the mobile navigation');await page.setViewportSize({width:1440,height:1000});}
  await page.locator('nav [data-view=memory]').click();await page.locator('#memory:not([hidden])').waitFor();
  await page.screenshot({path:output+'/conversations-1440.png',fullPage:true});
  await page.locator('#memory-mode-search').click();await page.locator('#search').fill('documentos');await page.locator('#search-form button').click();
  await page.locator('#results .source').first().waitFor();await page.screenshot({path:output+'/search-1440.png',fullPage:true});
  if(!baseline){
    for(const width of [820,390]){
      await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:`${output}/search-${width}.png`,fullPage:true});
    }
    // Route changes have one deliberate reset before requests, and no late jump.
    await page.locator('nav [data-view=today]').click();await page.locator('#today:not([hidden])').waitFor();
    await page.evaluate(()=>window.scrollTo(0,750));
    await page.locator('nav [data-view=memory]').click();await page.locator('#conversation-list .conversation-row').first().waitFor();
    assert.equal(await page.evaluate(()=>scrollY),0);await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>scrollY),0);
    await page.locator('.conversation-row').filter({hasText:'Ana Ribeiro'}).getByRole('button',{name:'Abrir conversa'}).click();
    await page.locator('.conversation-agreements .resolver-open').waitFor();
    for(const width of [390,1440]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`${output}/conversation-agreement-${width}.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
    await page.locator('.conversation-agreements .resolver-open').click();await page.locator('#resolver-consent').waitFor();
    assert.match(await page.locator('.resolver-sources').innerText(),/Ana Ribeiro/);await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:950});
    for(const route of ['contacts','businesses','projects']){
      await page.locator(`nav [data-route=${route}]`).click();
      await page.waitForFunction(route=>document.querySelector('#memory').dataset.mode===route,route);
      assert.equal(await page.locator(`nav [data-route=${route}]`).getAttribute('aria-current'),'page');
      assert.equal(await page.locator('#memory .page-heading h1').isVisible(),true);
      await page.screenshot({path:`${output}/${route}-390.png`,fullPage:true});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    }
    await page.locator('nav [data-view=today]').click();
    const open=()=>page.locator('#luminus-body').getByRole('button',{name:'Resolver com →'}).click();
    await open();await page.locator('#resolver-consent').waitFor();
    assert.equal(await page.locator('#resolver-consent').isChecked(),false);
    await page.getByRole('button',{name:'Autorizar contexto →'}).click();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n,0);
    await page.locator('#resolver-title').focus(); // Dismiss the native validity bubble before visual review.
    for(const width of [390,820,1440]){
      await page.setViewportSize({width,height:950});await page.screenshot({path:`${output}/resolver-preview-${width}.png`});
      assert.equal(await page.locator('#resolver-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false,`drawer overflow ${width}`);
    }
    await page.keyboard.press('Escape');assert.equal(await page.locator('#resolver-dialog').isVisible(),false);
    assert.equal(await page.locator('#luminus-body .resolver-open').evaluate(n=>document.activeElement===n),true);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>{window.resolverMotion=[];window.resolverTransforms=[];window.sampleResolver=true;const sample=()=>{const n=document.querySelector('#resolver-dialog');if(n?.open)window.resolverTransforms.push(getComputedStyle(n).transform);if(window.sampleResolver)requestAnimationFrame(sample);};requestAnimationFrame(sample);const native=Element.prototype.animate;Element.prototype.animate=function(...args){const a=native.apply(this,args);if(this.id==='resolver-dialog')window.resolverMotion.push({duration:a.effect.getTiming().duration,frames:a.effect.getKeyframes()});return a;};});
    await open();await page.locator('#resolver-consent').waitFor();
    await page.waitForTimeout(500);evidence.motion=await page.evaluate(()=>window.resolverMotion);assert.ok(evidence.motion.length>0,'drawer uses real WAAPI spring');
    evidence.transforms=await page.evaluate(()=>{window.sampleResolver=false;return [...new Set(window.resolverTransforms)];});assert.ok(evidence.transforms.length>1,'drawer moves across measured animation frames');
    await page.locator('input[name=assistente][value=codex]').check();await page.locator('#resolver-consent').check();
    await page.getByRole('button',{name:'Autorizar contexto →'}).click();
    await page.locator('.resolver-state').filter({hasText:'Aguardando o assistente'}).waitFor();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n,1);
    await page.getByRole('button',{name:'Copiar pedido'}).click();
    assert.equal(db.prepare('SELECT estado FROM lume_execucoes').get().estado,'aguardando_assistente');
    await page.screenshot({path:output+'/resolver-waiting-1440.png'});
    const executionId=db.prepare('SELECT id FROM lume_execucoes').get().id;
    await page.evaluate(id=>api('/api/v3/execucoes/progresso',{execucao_id:id,chave_idempotencia:crypto.randomUUID(),texto:'Progresso sintético: documentos separados para a revisão.'}),executionId);
    await page.evaluate(async id=>{for(let i=1;i<=41;i++)await api('/api/v3/execucoes/progresso',{execucao_id:id,chave_idempotencia:crypto.randomUUID(),texto:`Marco sintético ${String(i).padStart(2,'0')} da execução longa.`});},executionId);
    await page.getByRole('button',{name:'Atualizar andamento'}).click();await page.locator('.resolver-state').filter({hasText:'Em andamento'}).waitFor();
    assert.doesNotMatch(await page.locator('.resolver-timeline').innerText(),/Marco sintético 01 /);
    await page.getByRole('button',{name:'Ver registros anteriores',exact:true}).click();
    await page.locator('.resolver-timeline [role=status]').filter({hasText:'20 registros anteriores carregados.'}).waitFor();
    await page.getByRole('button',{name:'Ver registros anteriores',exact:true}).click();
    await page.getByRole('button',{name:'Ver registros anteriores',exact:true}).waitFor({state:'hidden'});
    const historicalText=await page.locator('.resolver-timeline').innerText();
    assert.match(historicalText,/Marco sintético 01 /);assert.match(historicalText,/Contexto autorizado/);
    assert.ok(historicalText.indexOf('Marco sintético 01 ')<historicalText.indexOf('Marco sintético 41 '));
    assert.equal((historicalText.match(/Marco sintético \d{2} /g)||[]).length,41,'history pages do not repeat records');
    await page.setViewportSize({width:390,height:950});await page.screenshot({path:output+'/resolver-long-history-390.png'});
    assert.equal(await page.locator('#resolver-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.resolver-manual summary').click();
    await page.locator('.resolver-manual textarea[name=resumo]').fill('Demonstração sintética: pauta da reunião preparada com documentos e perguntas abertas.');
    await page.locator('.resolver-manual textarea[name=artefatos]').fill('pauta-demonstracao.md');
    await page.getByRole('button',{name:'Guardar resultado informado'}).click();
    await page.locator('.resolver-state').filter({hasText:'Resultado informado'}).waitFor();
    assert.equal(db.prepare('SELECT estado FROM lume_execucoes').get().estado,'resultado_informado');
    await page.keyboard.press('Escape');await page.reload();await page.locator('#luminus-body .resolver-open').waitFor();
    await open();await page.locator('#resolver-verification-note').waitFor();
    assert.match(await page.locator('.resolver-timeline').innerText(),/pauta-demonstracao.md/);
    await page.screenshot({path:output+'/resolver-result-1440.png'});
    await page.locator('#resolver-verification-note').fill('Conferi a pauta sintética e as referências.');
    await page.getByRole('button',{name:'Confirmar resultado verificado'}).click();
    await page.locator('.resolver-state').filter({hasText:'Resultado verificado por você'}).waitFor();
    assert.equal(db.prepare('SELECT estado FROM lume_execucoes').get().estado,'verificado');
    await page.setViewportSize({width:390,height:950});await page.screenshot({path:output+'/resolver-verified-390.png'});
    await page.keyboard.press('Escape');await page.emulateMedia({reducedMotion:'reduce'});
    await open();await page.locator('.resolver-state').waitFor();
    assert.equal(await page.locator('#resolver-dialog').evaluate(n=>n.getAnimations().filter(a=>a.playState==='running').length),0);
    // Keyboard focus cannot leave a modal dialog.
    for(let i=0;i<14;i++){await page.keyboard.press('Tab');const focus=await page.evaluate(()=>({inside:document.querySelector('#resolver-dialog').contains(document.activeElement),active:document.activeElement.outerHTML.slice(0,300),controls:[...document.querySelectorAll('#resolver-dialog button,#resolver-dialog summary')].map(n=>({text:n.textContent,tabIndex:n.tabIndex,rect:n.getClientRects().length}))}));assert.equal(focus.inside,true,JSON.stringify({i,...focus}));}
    await page.keyboard.press('Escape');
    await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-data').click();await page.locator('#theme-mode').selectOption('dark');
    await page.locator('nav [data-view=today]').click();await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:output+'/today-dark-1440.png'});
    await open();await page.locator('.resolver-state').waitFor();await page.screenshot({path:output+'/resolver-dark-1440.png'});
    await page.locator('.resolver-revoke summary').click();await page.getByRole('button',{name:'Confirmar revogação'}).click();
    await page.locator('.resolver-state').filter({hasText:'revogada'}).waitFor();
    assert.equal(db.prepare('SELECT estado FROM lume_execucoes').get().estado,'revogada');
    await page.getByRole('button',{name:'Voltar ao histórico',exact:true}).click();
    await page.getByRole('button',{name:'Ver histórico preservado',exact:true}).click();
    await page.locator('.resolver-timeline').getByText('Conferi a pauta sintética e as referências.',{exact:true}).waitFor();
    assert.equal(await page.locator('.resolver-manual,.resolver-verify,.resolver-revoke').count(),0);
    assert.match(await page.locator('.resolver-state').innerText(),/revogad/i);
    await page.screenshot({path:output+'/resolver-revoked-history-1440.png'});
    await page.keyboard.press('Escape');
    await page.route('**/api/v3/execucoes/contexto',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({erro:'A fonte mudou. Prepare novamente.'})}));
    await open();await page.locator('.resolver-error').waitFor();assert.equal(await page.locator('.resolver-sources').count(),0);
    await page.screenshot({path:output+'/resolver-stale-error.png'});
    evidence.execution={authorized:1,copyDidNotStart:true,resultSurvivedReload:true,verified:true,revoked:true,staleContextCleared:true,focusTrapped:true,paginatedHistory:true};
    await page.keyboard.press('Escape');await page.unroute('**/api/v3/execucoes/contexto');
    await page.evaluate(()=>window.limparDadosVisiveis());assert.equal(await page.locator('#luminus-body .acoes06-card').count(),0);assert.equal(await page.locator('#acoes06-list .acoes06-card').count(),0);
    // A separate empty profile proves the design does not seed the live app.
    const emptyDb=abrirBanco(':memory:'),emptyFixture=perfilBeta05(emptyDb,{vazio:true});
    const emptyServer=criarServidor(emptyDb,{contexto:emptyFixture.contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{throw Error('Conexão proibida');}}});
    await new Promise(resolve=>emptyServer.listen(0,'127.0.0.1',resolve));
    try{
      const emptyPage=await browser.newPage({viewport:{width:390,height:950},reducedMotion:'reduce'});emptyPage.on('pageerror',error=>errors.push(error.message));
      await emptyPage.route('**/api/v3/laya',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({instalado:false,integridade:'ausente',aprovado:false})}));
      await emptyPage.goto(`http://127.0.0.1:${emptyServer.address().port}/app`);await emptyPage.locator('#clarity-content:not([hidden])').waitFor();
      await emptyPage.locator('#first-organization-state').filter({hasText:'Conecte sua conta ChatGPT'}).waitFor();
      assert.equal(await emptyPage.locator('#first-use').isVisible(),true);
      assert.equal(await emptyPage.locator('.first-optional-assistant').getAttribute('open'),null);
      for(const width of [1440,820,390]){
        await emptyPage.setViewportSize({width,height:844});
        await emptyPage.screenshot({path:`${output}/first-use-${width}.png`,fullPage:true});
        assert.equal(await emptyPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`first-use overflow ${width}`);
        const connect=await emptyPage.locator('#first-connect').boundingBox();assert.ok(connect.y+connect.height<774,'first-use CTA immediately reachable');
        assert.equal(await emptyPage.locator('#first-organization-state').isVisible(),true);
      }
      await emptyPage.locator('.first-optional-assistant>summary').click();assert.equal(await emptyPage.locator('#first-assistant').isVisible(),true);
      await emptyPage.locator('#first-hide').click();await emptyPage.locator('#first-use').waitFor({state:'hidden'});
      evidence.firstUse={missingModelVisible:true,optionalAssistantCollapsed:true,connectAboveFold:true};
      await emptyPage.setViewportSize({width:390,height:950});
      assert.equal(await emptyPage.locator('#luminus-banner').isVisible(),false);assert.equal(await emptyPage.locator('#acoes06-list .acoes06-card').count(),0);
      assert.doesNotMatch(await emptyPage.locator('#today').innerText(),/Ana Ribeiro|3.500,00|Marcos Almeida/);
      await emptyPage.screenshot({path:output+'/empty-390.png',fullPage:true});assert.equal(await emptyPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await emptyPage.close();evidence.emptyProfile=true;
    }finally{emptyServer.closeAllConnections();await new Promise(resolve=>emptyServer.close(resolve));emptyDb.close();}
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  writeFileSync(output+'/evidence.json',JSON.stringify({...evidence,errors,external},null,2));
  console.log(JSON.stringify({ok:true,output,...evidence}));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}

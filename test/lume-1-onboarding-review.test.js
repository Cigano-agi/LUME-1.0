// Independent browser proof: synthetic account states, local HTTP, no Electron or credentials.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';

const out='work/lume-1-20261026/onboarding-review';
const account={available:true,connected:true,planEnabled:true,paused:false,model:'synthetic-review',accounts:[]};
const organization={estado:'aguardando',limitacao:null,processados:0,pendentes:0,abstidos:0,cobertura:0,historicoCompleto:false};
let browser,db,server,origin;
before(async()=>{
  await mkdir(out,{recursive:true});db=abrirBanco();new Desktop(db).aceitar({nome:'Revisao sintetica do onboarding',aceito:true,versao:VERSAO_TERMOS});
  server=criarServidor(db,{desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null})}});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});db.close();});

async function fixture(t,{chatgpt=account,organizacao=organization,error=false}={}){
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});t.after(()=>page.close());const errors=[];let external=0,centralCalls=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();});
  await page.route('**/api/v3/pessoal',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({enabled:false,chatgpt,telegram:{enabled:false},conversas:[],pendencias:[],autonomiaLiberada:false})}));
  await page.route('**/api/v3/lume-1/central',route=>{centralCalls++;return route.fulfill({status:error?503:200,contentType:'application/json',body:JSON.stringify(error?{erro:'Falha sintetica recuperavel'}:{organizacao,acontecimentos:[],comunicados:[]})});});
  await page.goto(origin+'/app');await page.locator('#first-use:visible').waitFor();await page.waitForFunction(()=>!document.querySelector('#first-organization-state')?.textContent.startsWith('Conferindo'));
  await page.getByText('Precisa de ajuda para começar?',{exact:true}).click();await page.locator('#first-readiness:visible').waitFor();
  await page.evaluate(()=>window.atualizarPrimeirosPassos({conectada:true,mensagens:1}));
  t.after(()=>{assert.deepEqual(errors,[]);assert.equal(external,0);});
  return{page,shot:async name=>{await page.locator('#first-readiness').scrollIntoViewIfNeeded();await page.screenshot({path:out+'/'+name+'.png'});},recover(){error=false;},calls:()=>centralCalls};
}

test('onboarding review: available integration without connected account never marks organization ready',async t=>{
  const f=await fixture(t,{chatgpt:{...account,connected:false}});await f.shot('sem-conta');
  assert.equal(await f.page.locator('#first-readiness').getAttribute('data-ready'),'false');assert.equal(await f.page.locator('#first-ready-progress').getAttribute('value'),'2');
  assert.match(await f.page.locator('#first-organization-state').innerText(),/conta|conect/i);await f.page.locator('#first-organization').click();await f.page.locator('#pessoal-panel:visible').waitFor();
});

for(const [name,change] of [['plano-indisponivel',{planEnabled:false}],['conta-pausada',{paused:true}],['sem-modelo',{model:null}]])test('onboarding review: '+name+' cannot claim readiness from stale central state',async t=>{
  const f=await fixture(t,{chatgpt:{...account,...change}});assert.equal(await f.page.locator('#first-readiness').getAttribute('data-ready'),'false');
  await f.page.locator('#first-organization').click();await f.page.locator('#pessoal-panel:visible').waitFor();
});

test('onboarding review: connected account with evaluation pending explains gate and opens central in one action',async t=>{
  const f=await fixture(t,{organizacao:{...organization,limitacao:'avaliacao_pendente'}});await f.shot('avaliacao-pendente');
  assert.equal(await f.page.locator('#first-readiness').getAttribute('data-ready'),'false');assert.match(await f.page.locator('#first-organization-state').innerText(),/avaliação de qualidade/i);
  await f.page.locator('#first-organization').click();await f.page.getByRole('heading',{name:'Acontecimentos locais'}).waitFor();assert.equal(await f.page.locator('.l1-dialog').count(),1);
});

test('onboarding review: organization paused is explicit and leads to independent central controls',async t=>{
  const f=await fixture(t,{organizacao:{...organization,estado:'pausado'}});await f.shot('organizacao-pausada');assert.equal(await f.page.locator('#first-readiness').getAttribute('data-ready'),'false');assert.match(await f.page.locator('#first-organization-state').innerText(),/pausada/i);
  await f.page.locator('#first-organization').click();await f.page.getByRole('heading',{name:'Acontecimentos locais'}).waitFor();assert.equal(await f.page.getByRole('button',{name:'Retomar organização',exact:true}).count(),1);
});

test('onboarding review: processing authorized account is factual; external-assistant button opens ChatGPT',async t=>{
  const f=await fixture(t,{organizacao:{...organization,estado:'processando'}});await f.shot('processando');assert.equal(await f.page.locator('#first-readiness').getAttribute('data-ready'),'true');assert.match(await f.page.locator('#first-organization-state').innerText(),/recorte autorizado/i);
  const prompt=await f.page.locator('#first-assistant-prompt-text').inputValue();assert.match(prompt,/ChatGPT/);assert.doesNotMatch(prompt,/Laya é o motor/);
  await f.page.getByText('Usar com meu assistente · opcional',{exact:true}).click();await f.page.getByRole('button',{name:'Ver conexão com ChatGPT',exact:true}).click();await f.page.locator('#pessoal-panel:visible').waitFor();
});

test('onboarding review: endpoint error exposes retry and recovers without claiming readiness early',async t=>{
  const f=await fixture(t,{error:true});await f.shot('erro-recuperavel');assert.equal(await f.page.locator('#first-readiness').getAttribute('data-ready'),'false');assert.match(await f.page.locator('#first-organization-state').innerText(),/memória salva continua disponível/i);
  const before=f.calls();f.recover();await f.page.getByRole('button',{name:'Tentar novamente',exact:true}).click();await f.page.waitForFunction(()=>document.querySelector('#first-readiness').dataset.ready==='true');assert.equal(f.calls(),before+1);await f.shot('recuperado');
});

test('onboarding review: operational privacy summary is current and versioned terms are unchanged',async()=>{
  const html=await readFile(new URL('../src/painel/app.html',import.meta.url),'utf8'),old=execFileSync('git',['show','HEAD:src/painel/app.html'],{encoding:'utf8'});
  const terms=value=>value.match(/<div class="privacy-copy">([\s\S]*?)<\/div><\/details>/)?.[1];assert.ok(terms(html));assert.equal(terms(html),terms(old));
  const summary=html.match(/<div class="privacy-summary">([\s\S]*?)<\/div>/)?.[1];assert.match(summary,/ChatGPT/);assert.doesNotMatch(summary,/Requer Laya/);assert.match(terms(html),new RegExp(VERSAO_TERMOS));
});

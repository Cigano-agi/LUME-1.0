// Real HTTP/renderer; fictional messages and injected evaluator. No external inference.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
const output='work/beta06-context-selection';mkdirSync(output,{recursive:true});
const db=abrirBanco(':memory:'),contexto=new ContextoApp(db),desktop=new Desktop(db),jid='selecao-demo@s.whatsapp.net';
desktop.aceitar({nome:'Demonstração local',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
const texts=['Quero revisar sua proposta de consultoria.','Assunto pessoal que não será enviado.','Correção: ainda não aceitei a proposta.'];
texts.forEach((texto,i)=>contexto.receber({type:'notify',messages:[{key:{remoteJid:jid,id:'selection-'+i,fromMe:false},messageTimestamp:Math.floor(Date.now()/1000)-30+i,message:{conversation:texto}}]}));
db.prepare('INSERT OR REPLACE INTO conversas_app VALUES(?,?)').run(jid,'Cliente fictício');
const ids=db.prepare('SELECT id FROM eventos ORDER BY id').all().map(x=>x.id),negocios=new NegociosDesktop(db);
negocios.salvar({previa:negocios.preparar({fonte:ids[0]}).id,confirmar:true,titulo:'Consultoria fictícia',etapa:'interesse'});
const sent=[],errors=[],external=[];
const server=criarServidor(db,{contexto,desktop:true,segredosJev:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>`sk-or-v1-${'a'.repeat(64)}`},avaliarJev:async({fontes})=>{sent.push(structuredClone(fontes));return {temperatura:'morno',etapa:'proposta',criterio:'Exemplo sintético de interesse.',criterio_etapa:'Sem aceite no recorte.',confianca:.8,confianca_etapa:.8,origem:'jev',modelo:'typesafe/jev-1.13'};}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:390,height:950},reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(origin))external.push(r.url());});
  await page.goto(origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
  await page.locator('nav [data-route=businesses]').click();await page.getByRole('button',{name:'Conferir interesse',exact:true}).click();
  await page.getByRole('button',{name:'Conferir recorte para avaliar com Jev',exact:true}).click();
  await page.locator('.sales-selection-form').waitFor();assert.equal(sent.length,0);
  await page.getByRole('button',{name:'Limpar seleção',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Conferir seleção',exact:true}).isDisabled(),true);
  await page.getByRole('checkbox',{name:`Incluir mensagem E${ids[0]}`,exact:true}).check();
  const last=page.getByRole('checkbox',{name:`Incluir mensagem E${ids[2]}`,exact:true});await last.focus();await page.keyboard.press('Space');assert.equal(await last.isChecked(),true);
  for(const width of [390,820,1440]){await page.setViewportSize({width,height:950});await page.screenshot({path:`${output}/selection-${width}.png`});assert.equal(await page.locator('#sales-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);}
  await page.getByRole('button',{name:'Conferir seleção',exact:true}).click();await page.locator('#sales-consent').waitFor();
  assert.equal(await page.locator('#sales-consent').isChecked(),false);assert.equal(await page.locator('.sales-preview-sources article').count(),2);
  assert.doesNotMatch(await page.locator('.sales-preview-sources').innerText(),/Assunto pessoal/);assert.match(await page.locator('.sales-preview-sources').innerText(),/ainda não aceitei/);
  await page.getByRole('button',{name:'Enviar este recorte ao Jev'}).click();assert.equal(sent.length,0);
  await page.locator('#sales-consent').check();await page.getByRole('button',{name:'Rever seleção',exact:true}).click();
  await page.locator('.sales-selection-form').waitFor();assert.equal(await page.locator('.sales-selection-form input:checked').count(),2);
  await page.getByRole('button',{name:'Conferir seleção',exact:true}).click();assert.equal(await page.locator('#sales-consent').isChecked(),false);
  await page.locator('#sales-consent').check();await page.getByRole('button',{name:'Enviar este recorte ao Jev'}).click();await page.locator('.sales-meter h3').filter({hasText:'Morno'}).waitFor();
  assert.equal(sent.length,1);assert.deepEqual(sent[0].map(f=>f.id),[ids[0],ids[2]]);assert.equal(db.prepare('SELECT etapa FROM desktop_negocios').get().etapa,'interesse');
  await page.setViewportSize({width:390,height:950});await page.screenshot({path:output+'/selected-result-390.png'});
  assert.match(await page.locator('.sales-meter').innerText(),/2 mensagens escolhidas/);await page.keyboard.press('Escape');
  // Strict HTTP parsing remains in front of the new optional selection field.
  const rejected=await page.evaluate(async({jid,ids})=>api('/api/v3/vendas/preparar',{conversa_id:jid,fonte_ids:[ids[0]],surpresa:true}).catch(e=>({erro:e.message})),{jid,ids});assert.match(rejected.erro,/campos/);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const evidence={synthetic:true,selected:2,excludedPersonalMessage:true,correctionIncluded:true,reconsentAfterEdit:true,externalCalls:0,injectedEvaluations:sent.length,pipelineUnchanged:true,keyboard:true,widths:[390,820,1440],errors,external};
  writeFileSync(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}

// Real renderer and local HTTP; synthetic evaluator + transport, never real keys.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';
import {HistoricoWhatsApp} from '../src/transporte/historico.js';
import {criarServidor} from '../src/painel/servidor.js';
const output='work/beta06-sales-history';mkdirSync(output,{recursive:true});
const db=abrirBanco(':memory:'),contexto=new ContextoApp(db),desktop=new Desktop(db);
desktop.aceitar({nome:'Bia · demonstração',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
const jid='5511999000011@s.whatsapp.net',source='Quero avançar com a proposta de consultoria. Podemos revisar o escopo na sexta?';
const raw={key:{remoteJid:jid,id:'sales-synthetic',fromMe:false},messageTimestamp:Math.floor(Date.now()/1000),message:{conversation:source}};
contexto.receber({type:'notify',messages:[raw]});db.prepare('INSERT OR REPLACE INTO conversas_app VALUES(?,?)').run(jid,'Cliente · demonstração');
const sourceId=db.prepare('SELECT id FROM eventos WHERE origem_id=?').get(raw.key.id).id;
const business=new NegociosDesktop(db);business.salvar({previa:business.preparar({fonte:sourceId}).id,confirmar:true,titulo:'Consultoria · demonstração',etapa:'interesse',valor_centavos:250000});
let configured=false,evaluations=0,requests=0;
const historico=new HistoricoWhatsApp(db);historico.observarEstado({estado:'conectada'});
const server=criarServidor(db,{contexto,desktop:true,
  segredosJev:{estado:async()=>({disponivel:true,configurada:configured}),gravar:async()=>{configured=true;},ler:async()=>`sk-or-v1-${'a'.repeat(64)}`,remover:async()=>{configured=false;}},
  avaliarJev:async()=>{evaluations++;return {temperatura:'quente',etapa:'proposta',criterio:'Critério sintético: intenção explícita de avançar.',criterio_etapa:'Classificação sintética da proposta.',confianca:.8,origem:'jev',modelo:'typesafe/jev-1.13',custo_usd:.001};},
  conexao:{historico,estado:()=>({estado:'conectada',qr:null}),solicitarHistorico:async()=>{requests++;},iniciar:async()=>{},parar:async()=>{}}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],external=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(origin))external.push(r.url());});
  await page.goto(origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
  await page.locator('nav [data-route=businesses]').click();await page.locator('.sales-pipeline .negocio-card').waitFor();
  assert.equal(evaluations,0);await page.screenshot({path:output+'/pipeline-1440.png',fullPage:true});
  await page.locator('.sales-pipeline').getByRole('button',{name:'Conferir interesse'}).click();await page.locator('.sales-meter').waitFor();
  assert.equal(await page.getByRole('button',{name:'Conferir recorte para avaliar com Jev'}).isDisabled(),true);
  await page.locator('.sales-manual summary').click();await page.locator('.sales-manual select[name=temperatura]').selectOption('morno');await page.locator('.sales-manual select[name=etapa]').selectOption('interesse');await page.locator('.sales-manual input[type=checkbox]').check();await page.getByRole('button',{name:'Guardar minha avaliação'}).click();
  await page.locator('.sales-meter h3').filter({hasText:'Morno'}).waitFor();assert.equal(evaluations,0);
  await page.locator('.sales-connection summary').click();await page.locator('.sales-connection input').fill(`sk-or-v1-${'a'.repeat(64)}`);await page.getByRole('button',{name:'Guardar chave protegida'}).click();
  await page.getByRole('button',{name:'Conferir recorte para avaliar com Jev'}).click();await page.getByRole('button',{name:'Conferir seleção',exact:true}).click();await page.locator('#sales-consent').waitFor();assert.equal(evaluations,0);assert.match(await page.locator('.sales-preview-sources').innerText(),/Quero avançar com a proposta/);
  await page.getByRole('button',{name:'Enviar este recorte ao Jev'}).click();assert.equal(evaluations,0);await page.locator('#sales-title').focus();
  for(const width of [1440,390]){await page.setViewportSize({width,height:950});await page.screenshot({path:`${output}/jev-preview-${width}.png`});assert.equal(await page.locator('#sales-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);}
  await page.locator('#sales-consent').check();await page.getByRole('button',{name:'Enviar este recorte ao Jev'}).click();await page.locator('.sales-meter h3').filter({hasText:'Quente'}).waitFor();assert.equal(evaluations,1);
  assert.equal(db.prepare('SELECT etapa FROM desktop_negocios').get().etapa,'interesse');
  await page.screenshot({path:output+'/jev-result-390.png'});await page.keyboard.press('Escape');
  await page.screenshot({path:output+'/pipeline-390.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('nav [data-view=memory]').click();await page.locator('.conversation-open').first().click();await page.locator('.conversation-history summary').click();
  await page.locator('.history-coverage').waitFor();assert.match(await page.locator('.history-coverage').innerText(),/cobertura desconhecida/);
  await page.getByRole('button',{name:'Buscar anteriores',exact:true}).click();await page.locator('.history-receipt').waitFor();assert.equal(requests,1);assert.match(await page.locator('.history-receipt').innerText(),/aguardando histórico/);
  await page.screenshot({path:output+'/history-request-390.png',fullPage:true});
  await page.reload();await page.locator('nav [data-view=memory]').click();await page.locator('.conversation-open').first().click();await page.locator('.conversation-history summary').click();await page.locator('.conversation-history').getByText(/Aguardando histórico ·/).waitFor();
  await page.route('**/api/v3/historico/recuperar',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Transporte sintético indisponível.'})}));
  await page.getByRole('button',{name:'Recuperar contexto',exact:true}).click();await page.locator('.history-error').waitFor();assert.equal(requests,1);
  // Projects are explicit source groups, distinct from the sales pipeline.
  await page.locator('#memory-mode-search').click();await page.locator('#search').fill('avançar');await page.locator('#search-form button').click();
  await page.locator('#results').getByRole('button',{name:'Adicionar a projeto'}).click();await page.locator('#project-name').waitFor();
  await page.locator('#project-name').fill('Revisão de consultoria · demonstração');await page.locator('#project-excerpt').fill('Quero avançar com a proposta de consultoria.');
  await page.getByRole('button',{name:'Criar rascunho de projeto'}).click();await page.getByRole('button',{name:'Confirmar organização'}).waitFor();
  assert.equal(db.prepare('SELECT estado FROM lume_projetos_comerciais').get().estado,'rascunho');
  assert.equal(db.prepare('SELECT selecao FROM lume_projetos_fontes').get().selecao,'trecho');
  await page.screenshot({path:output+'/project-draft-390.png'});
  await page.getByRole('button',{name:'Confirmar organização'}).click();await page.locator('#projects-dialog .resolver-state').filter({hasText:'Organizado'}).waitFor();
  assert.equal(db.prepare('SELECT etapa FROM desktop_negocios').get().etapa,'interesse');
  await page.keyboard.press('Escape');await page.locator('#results').getByRole('button',{name:'Adicionar a projeto'}).click();await page.locator('.project-link-existing summary').click();await page.getByRole('button',{name:'Vincular fonte ao projeto'}).click();
  await page.getByRole('button',{name:'Desvincular fonte'}).waitFor();assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE removida=0').get().n,2);
  await page.getByRole('button',{name:'Desvincular fonte'}).click();await page.getByRole('button',{name:'Desvincular fonte'}).waitFor({state:'hidden'});assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE removida=0').get().n,1);
  await page.getByRole('button',{name:'Arquivar projeto'}).click();await page.getByRole('button',{name:'Restaurar rascunho'}).waitFor();
  await page.getByRole('button',{name:'Restaurar rascunho'}).click();await page.getByRole('button',{name:'Confirmar organização'}).waitFor();await page.keyboard.press('Escape');
  await page.reload();await page.locator('nav [data-route=projects]').click();await page.locator('.project-card').waitFor();
  for(const width of [390,820,1440]){await page.setViewportSize({width,height:950});await page.screenshot({path:`${output}/projects-${width}.png`,fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.locator('.project-card').getByRole('button',{name:'Abrir projeto'}).click();await page.locator('#projects-dialog .resolver-timeline').waitFor();assert.match(await page.locator('#projects-dialog .resolver-timeline').innerText(),/Rascunho restaurado/);await page.screenshot({path:output+'/project-timeline-1440.png'});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const evidence={synthetic:true,evaluator:'injected, not real Jev',evaluations,readDidNotEvaluate:true,manualDidNotEvaluate:true,consentRequired:true,pipelineUnchanged:true,historyRequests:requests,receiptNotCompletion:true,receiptSurvivedReload:true,project:{selectedExcerpt:true,organizedNotCommercialAgreement:true,archiveRestore:true,survivedReload:true},errors,external};
  writeFileSync(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}

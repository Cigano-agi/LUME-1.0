// UI and HTTP real. Synthetic conversation, key and model; no paid calls.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
const db=abrirBanco(),contexto=new ContextoApp(db);let calls=0,emptyAnswer=false;
const server=criarServidor(db,{contexto,desktop:true,agoraIA:()=>new Date('2026-09-18T15:00:00Z'),conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{}},segredos:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>'chave_sintetica'},gerarIA:async request=>{
  calls++;const fontes=JSON.parse(request.pedido.contents[0].parts[0].text).fontes;assert.ok(!JSON.stringify(fontes).includes('SEGREDO'));assert.equal(request.pedido.tools,undefined);
  if(emptyAnswer)return {dados:{insuficiente:true,afirmacoes:[]}};
  const f=fontes.find(f=>f.contextoProximo);assert.ok(f);return {dados:{insuficiente:false,afirmacoes:[{texto:'A mensagem posterior retira o valor; ainda não há aceite.',fonte:f.fonte,trecho:'Retiro o valor anterior. Ainda não fechamos nada.'}]}};
}});
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('equipe','Equipe · cenário sintético');
db.exec("UPDATE desktop_ia_config SET habilitada=1,limite_micros=1000000; INSERT INTO desktop_ia_conversas VALUES('equipe',1,'2026-09-18')");
let seq=0;const add=(text,at,permission='minha')=>db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('equipe',?,'entrada','texto','{}',?,?,'2026-09-18',?)").run('s'+(++seq),text,at,permission);
add('Orçamento Neblina: proponho R$ 6.100. Aguardo o aceite.','2026-09-18T12:00:00Z');
add('SEGREDO: parecer privado.','2026-09-18T12:02:00Z','terceiro');
add('Retiro o valor anterior. Ainda não fechamos nada. <img src=x onerror="window.invadiu=true">','2026-09-18T12:04:00Z');
add('Hotel reservado para a equipe. Enviarei os dados depois.','2026-09-18T14:00:00Z');
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,out='work/contexto-ia-qa';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
  const page=await browser.newPage({viewport:{width:1320,height:1000}}),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))external.push(r.url());});
  await page.clock.install({time:new Date('2026-09-18T15:00:00Z')});await page.clock.pauseAt(new Date('2026-09-18T15:00:01Z'));
  await page.goto(origin+'/app');await page.locator('#owner').fill('Teste de continuidade');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-ask').click();await page.waitForFunction(()=>!document.getElementById('ia-prepare').disabled);
  await page.locator('#ia-question').fill('O orçamento Neblina foi aprovado?');await page.locator('#ia-prepare').click();await page.locator('#ia-preview').waitFor();
  assert.equal(calls,0);assert.equal(await page.locator('#ia-preview details').count(),2);assert.match(await page.locator('#ia-preview').innerText(),/1 mensagem próxima acrescentada/);
  for(const s of await page.locator('#ia-preview summary').all())await s.click();
  assert.match(await page.locator('#ia-preview').innerText(),/Retiro o valor anterior/);assert.ok(!(await page.locator('#ia-preview').innerText()).includes('SEGREDO'));assert.equal(await page.locator('#ia-preview img').count(),0);
  for(const width of [390,820,1320]){await page.setViewportSize({width,height:1000});await page.locator('#ia-preview').evaluate(n=>n.scrollIntoView({block:'start'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:out+`/01-previa-${width}px.png`});}
  await page.locator('.query-settings>summary').click();
  await page.locator('#ia-neighbors').uncheck();assert.equal(await page.locator('#ia-preview').isHidden(),true);await page.locator('#ia-prepare').click();await page.locator('#ia-preview').waitFor();assert.equal(await page.locator('#ia-preview details').count(),1);
  await page.locator('#ia-neighbors').check();await page.locator('#ia-prepare').click();await page.locator('#ia-preview').waitFor();
  await page.getByRole('button',{name:'Confirmar envio e perguntar'}).click();await page.locator('#ia-answer .ia-claim').waitFor();assert.equal(calls,1);
  await page.getByRole('button',{name:/E\d+ · Conferir fonte/}).click();await page.waitForFunction(()=>document.querySelectorAll('#results .source').length===1);assert.match(await page.locator('#results').innerText(),/Retiro o valor/);assert.equal(await page.evaluate(()=>window.invadiu),undefined);
  await page.locator('#memory-mode-ask').click();await page.locator('#ia-answer').screenshot({path:out+'/02-resposta.png'});
  // Candidate exists, but simulated provider explicitly abstains. No assertion of real model quality.
  emptyAnswer=true;await page.locator('#memory-mode-ask').click();await page.locator('#ia-question').fill('Qual é o localizador da reserva do hotel?');await page.locator('#ia-prepare').click();await page.locator('#ia-preview').waitFor();
  assert.match(await page.locator('#ia-preview').innerText(),/podem não responder/);await page.getByRole('button',{name:'Confirmar envio e perguntar'}).click();await page.locator('#ia-answer h3').filter({hasText:'Faltou evidência'}).waitFor();assert.equal(calls,2);assert.equal(await page.locator('#ia-answer .ia-claim').count(),0);await page.locator('#ia-answer').screenshot({path:out+'/03-insuficiente-simulado.png'});
  await page.locator('#ia-question').fill('Eclipse Quebec astronomia');await page.locator('#ia-prepare').click();await page.locator('#ia-progress').filter({hasText:'Não encontrei fontes'}).waitFor();assert.equal(calls,2);assert.equal(await page.locator('#ia-preview').isHidden(),true);
  await page.locator('#ia-question').fill('Orçamento Neblina');await page.locator('#ia-prepare').click();await page.locator('#ia-preview').waitFor();add('Surgiu outra revisão, confira antes de prosseguir.','2026-09-18T12:01:00Z');
  await page.getByRole('button',{name:'Confirmar envio e perguntar'}).click();await page.locator('#ia-progress').filter({hasText:'próximas mudaram'}).waitFor();assert.equal(calls,2);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  writeFileSync(out+'/evidence.json',JSON.stringify({date:new Date().toISOString(),synthetic:true,provider:'simulated',realProviderCalls:0,simulatedCalls:calls,errors,external,checks:['literal nearby correction previewed','checkbox opt-out invalidates preview','cost confirmation before send','private message excluded','XSS literal','citation opens correction source','simulated abstention with candidates','no-candidate local abstention','new nearby message prevents send','390/820/1320 no overflow']},null,2));console.log('CONTEXTO_IA_UI_OK');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}

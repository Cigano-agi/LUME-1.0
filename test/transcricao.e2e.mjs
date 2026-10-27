import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';
import {Semantica} from '../src/semantica.js';
import {resolve} from 'node:path';
const db=abrirBanco(),contexto=new ContextoApp(db);prepararEsquemaTranscricao(db);
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('audio-ui','Equipe de teste · áudios sintéticos');
function audio(origemId,permissao='minha'){
 return Number(db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('audio-ui',?,'entrada','audio','{}',NULL,'2026-09-18T12:00:00Z','2026-09-18',?)").run(origemId,permissao).lastInsertRowid);
}
const id=audio('original'),legado=audio('legado'),secreto=audio('secreto','terceiro');
const original='  Aqui está a transcrição do áudio: Revisar a proposta sintética.\nObservações: talvez seja melhor cobrar antes. <img src=x onerror="window.invadiu=true">  ';
gravarTranscricao(db,{conversaId:'audio-ui',origemId:'original',textoOriginal:original,respostas:[{textoOriginal:'(sem fala)',duracaoMs:2},{textoOriginal:original,duracaoMs:3}]});
gravarTranscricao(db,{conversaId:'audio-ui',origemId:'legado',texto:'Transcrição antiga disponível sem original.'});
gravarTranscricao(db,{conversaId:'audio-ui',origemId:'secreto',textoOriginal:'Transcrição: SEGREDO TRANSCRITO'});
contexto.nota({titulo:'Nota sintética',texto:'Revisar a proposta de teste.\nObservações: pode ser comentário acrescentado por modelo.'});
let providerCalls=0;
const semantica=process.env.ASSESSOR_E2E_EMBEDDINGS==='1'?new Semantica(db,{cacheDir:resolve('work/modelos-e5')}):null;
if(semantica){await semantica.ativar();await semantica.indexar();}
const server=criarServidor(db,{contexto,semantica,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{}},agoraIA:()=>new Date('2026-09-18T15:00:00Z'),segredos:{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>'apenas_teste_sem_credencial'},gerarIA:async()=>{providerCalls++;throw Error('Provedor proibido');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,output=semantica?'work/fontes-audio-qa':'work/transcricao-qa';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1320,height:950}}),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))external.push(r.url());});
 await page.goto(origin+'/app');await page.locator('#owner').fill('QA sintético');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
 await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-search').click();await page.locator('#search').fill('proposta sintética');await page.locator('#search-form button').click();
 await page.waitForFunction(()=>document.querySelectorAll('#results .source').length===1&&document.getElementById('results').textContent.includes('proposta sintética'));assert.match(await page.locator('#results').innerText(),/Possível texto acrescentado/);assert.ok(!(await page.locator('#results').innerText()).includes('SEGREDO'));
 await page.getByRole('button',{name:'Conferir transcrição',exact:true}).click();await page.locator('.transcript-proof h3').first().waitFor();
 assert.equal(await page.locator('.transcript-proof>p').nth(1).textContent(),original);assert.equal(await page.locator('#results img').count(),0);assert.equal(await page.evaluate(()=>window.invadiu),undefined);
 await page.getByText('Resposta da tentativa 1',{exact:true}).click();assert.match(await page.locator('.transcript-proof details').first().innerText(),/sem fala/);
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:950});await page.locator('#results').evaluate(e=>e.scrollIntoView({block:'start'}));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+`/01-original-${width}px.png`});}
 await page.setViewportSize({width:1320,height:950});await page.locator('#search').fill('antiga disponível');await page.locator('#search-form button').click();await page.locator('#results').filter({hasText:'não preservado neste registro'}).waitFor();await page.getByRole('button',{name:'Conferir transcrição',exact:true}).click();await page.locator('.transcript-proof').filter({hasText:'Original não preservado'}).waitFor();await page.screenshot({path:output+'/02-legado.png'});
 // Prévia recupera o áudio vinculado; captura original continua sem texto.
 const {token}=await (await page.request.get(origin+'/api/sessao')).json();const headers={'X-Assessor-Token':token};
 const post=(path,data)=>page.request.post(origin+path,{headers,data});
 assert.equal((await post('/api/v3/ia/config',{habilitada:true,limiteUSD:1,cienteEnvio:true})).status(),200);
 assert.equal((await post('/api/v3/ia/permissao',{conversa:'audio-ui',permitida:true})).status(),200);
 await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-ask').click();await page.locator('#ia-question').fill('proposta');await page.locator('.query-settings>summary').click();await page.locator('#ia-period').selectOption('tudo');await page.locator('#ia-prepare').click();
 await page.locator('#ia-preview:not([hidden])').waitFor();await page.locator('#ia-preview details').first().locator('summary').click();assert.match(await page.locator('#ia-preview').innerText(),/Possível texto acrescentado/);await page.locator('#ia-preview').evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:output+'/03-previa-avisos.png'});
 assert.match(await page.locator('#ia-preview').innerText(),/proposta sintética/);
 assert.equal(db.prepare('SELECT texto FROM eventos WHERE id=?').get(id).texto,null);
 if(semantica){
  const res=await page.request.get(origin+'/api/v3/busca-semantica?q=proposta');assert.equal(res.status(),200);const payload=await res.json();
  assert.ok(payload.mensagens.some(f=>f.id===id));assert.ok(!payload.mensagens.some(f=>f.id===secreto));
  for(const f of payload.mensagens){assert.equal(f.transcricao_meta,undefined);assert.equal(f.transcricao?.textoOriginal,undefined);}
  await page.locator('#memory-mode-search').click();await page.locator('#search').fill('proposta');await page.locator('#local-search-mode').selectOption('denso');await page.getByRole('button',{name:'Conferir transcrição',exact:true}).first().waitFor();
  assert.match(await page.locator('#results').innerText(),/Possível texto acrescentado/);await page.getByRole('button',{name:'Conferir transcrição',exact:true}).first().click();await page.locator('#results .transcript-proof h3').first().waitFor();
  await page.screenshot({path:output+'/04-busca-significado.png'});
  for(const modo of ['denso','hibrido']){await page.locator('#ia-mode').selectOption(modo);await page.locator('#ia-prepare').click();await page.locator('#ia-preview:not([hidden])').waitFor();await page.locator('#ia-preview details').first().click();assert.match(await page.locator('#ia-preview').innerText(),/proposta sintética/);}
  await page.locator('#local-search-mode').selectOption('lexical');
 }
 assert.equal((await page.request.get(origin+'/api/v3/fonte?id='+secreto)).status(),404);
 const response=await (await page.request.get(origin+'/api/v3/busca?q=proposta%20sint%C3%A9tica')).json();assert.equal(response.mensagens[0].transcricao.textoOriginal,undefined);
 // Revogação durante a comparação impede que o original atrasado reapareça.
 await post('/api/v3/politica',{conversa:'audio-ui',politica:'tudo'});await page.locator('#memory-mode-search').click();await page.locator('#search').fill('SEGREDO');await page.locator('#search-form button').click();await page.locator('#results').filter({hasText:'SEGREDO'}).waitFor();
 let release,seen;const held=new Promise(r=>release=r),started=new Promise(r=>seen=r);
 await page.route('**/api/v3/fonte?id='+secreto,async route=>{const response=await route.fetch();seen();await held;await route.fulfill({response});});
 await page.getByRole('button',{name:'Conferir transcrição',exact:true}).click();await started;
 await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#policies select[aria-label="Leitura de Equipe de teste · áudios sintéticos"]').selectOption('so-minhas');await page.locator('#feedback').filter({hasText:'Política atualizada'}).waitFor();
 const arrived=page.waitForResponse(r=>r.url().endsWith('/api/v3/fonte?id='+secreto));release();await (await arrived).finished();await page.locator('nav [data-view=memory]').click();assert.equal(await page.locator('#results .transcript-proof').count(),0);assert.ok(!(await page.locator('#results').innerText()).includes('SEGREDO'));
 assert.equal(providerCalls,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 writeFileSync(output+'/evidence.json',JSON.stringify({date:new Date().toISOString(),synthetic:true,native:false,embeddings:semantica?semantica.estado():'não usados',providerCalls,errors,external,checks:['text search on linked transcript','original literal','attempts','legacy without invented original','XSS literal','source ACL','original absent from search payload','linked audio in AI preview','warning in AI preview',...(semantica?['real cached E5 on audio','dense HTTP excludes original/internal metadata','dense source comparison','dense and hybrid audio previews']:[]),'revocation during original request','390/820/1320 without overflow']},null,2));console.log('TRANSCRICAO_UI_OK');
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

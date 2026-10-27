// HTTP/UI reais; WAV silencioso e resposta Gemini sintética. Sem credenciais ou rede paga.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {wav} from './fixtures/audio-wav.js';
import {baixarAudioWhatsapp} from '../src/audio-whatsapp.js';
const dir=mkdtempSync(join(tmpdir(),'assessor-audio-ui-')),output=resolve('work/audio-desktop-qa');mkdirSync(output,{recursive:true});
const db=abrirBanco(),contexto=new ContextoApp(db),arquivos=new ArquivosDados(dir),calls=[],errors=[],external=[];
let hold=false,downloadSuccess=false,release,started;const held=new Promise(r=>release=r),ready=new Promise(r=>started=r);
const original='Transcrição: Revisar a proposta amanhã. <img src=x onerror="window.invadiu=true">';
let localAvailable=false,localCalls=0;
const localState={disponivel:true,motor:'local',modelo:'fixture',modeloSha256:'a'.repeat(64),manifestoSha256:'b'.repeat(64),versaoMotor:'teste-1'};
const server=criarServidor(db,{
 desktop:true,contexto,arquivosDados:arquivos,
 audioLocal:{estado:async()=>localAvailable?localState:{disponivel:false,motivo:'Motor local indisponível nesta instalação.'},transcrever:async bytes=>{localCalls++;return {audioSha256:createHash('sha256').update(bytes).digest('hex'),modeloSha256:localState.modeloSha256,manifestoSha256:localState.manifestoSha256,versaoMotor:localState.versaoMotor,idioma:'pt',duracaoMs:20,transcricao:'Texto local sintético.',trechos:[{inicioMs:0,fimMs:900,texto:'Texto local sintético.'}]};}},
 baixarAudio:async(raw,options)=>downloadSuccess?{base64:wav(2).toString('base64'),nome:'Áudio do WhatsApp.wav',mime:'audio/wav'}:baixarAudioWhatsapp(raw,options),
 conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}},agoraIA:()=>new Date('2026-09-18T15:00:00Z'),
 segredos:{estado:async()=>({configurada:true,disponivel:true}),ler:async()=>'chave_de_teste'},
 gerarAudio:async req=>{calls.push(req);if(hold){started();await held;}return {dados:{transcricao:original}};}
});
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('audio','Equipe · áudio sintético');
const fonte=Number(db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('audio','a1','entrada','audio','{}',NULL,'2026-09-18T12:00:00.000Z','2026-09-18','minha')").run().lastInsertRowid);
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1320,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(origin+'/'))external.push(r.url());});
 assert.equal((await page.request.post(origin+'/api/v3/audio/preparar',{data:{}})).status(),403);
 await page.goto(origin+'/app');await page.locator('#owner').fill('Teste de áudio');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
 const {token}=await (await page.request.get(origin+'/api/sessao')).json();const post=(route,data)=>page.request.post(origin+route,{headers:{'X-Assessor-Token':token},data});
 await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-search').click();await page.locator('#results').getByRole('button',{name:'Transcrever áudio',exact:true}).click();
 const panel=page.locator('#results .audio-panel');await panel.getByRole('button',{name:'Buscar áudio no WhatsApp',exact:true}).click();await panel.getByRole('status').filter({hasText:'Não consegui recuperar'}).waitFor();assert.equal(calls.length,0);
 await panel.locator('input[type=file]').setInputFiles({name:'fala-sintetica.wav',mimeType:'audio/wav',buffer:wav(2)});
 assert.equal(await panel.locator('select').inputValue(),'local');
 await page.evaluate(()=>{window.__audioPcmOriginal=window.OfflineAudioContext;window.OfflineAudioContext=class{constructor(){throw Error('PCM_EXECUTADO_SEM_MOTOR');}};});
 await panel.locator('input[type=checkbox]').check();await panel.getByRole('button',{name:'Preparar transcrição',exact:true}).click();
 await panel.getByRole('status').filter({hasText:/manifesto|Motor local indisponível/}).waitFor();
 assert.equal(calls.length,0);
 await panel.locator('select').selectOption('gemini');await panel.getByRole('button',{name:'Preparar transcrição',exact:true}).click();
 await panel.getByRole('status').filter({hasText:'Transcrição indisponível. Configure o Gemini'}).waitFor();assert.equal(calls.length,0);
 await page.evaluate(()=>{window.OfflineAudioContext=window.__audioPcmOriginal;delete window.__audioPcmOriginal;});
 await page.locator('#feedback').waitFor({state:'hidden'});await page.setViewportSize({width:390,height:1000});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:output+'/00-sem-motor-390px.png'});
 assert.equal((await post('/api/v3/ia/config',{habilitada:true,cienteEnvio:true,limiteUSD:1})).status(),200);assert.equal((await post('/api/v3/ia/permissao',{conversa:'audio',permitida:true})).status(),200);
 await panel.locator('input[type=checkbox]').check();assert.equal(calls.length,0);await panel.getByRole('button',{name:'Preparar transcrição',exact:true}).click();await panel.getByRole('button',{name:'Confirmar e transcrever',exact:true}).waitFor();assert.equal(calls.length,0);
 assert.match(await panel.innerText(),/2.0 segundos/);assert.match(await panel.innerText(),/reserva de até US\$/);
 await page.locator('#feedback').waitFor({state:'hidden'});
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:1000});await panel.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+`/01-previa-${width}px.png`});}
 await page.setViewportSize({width:1320,height:1000});await panel.getByRole('button',{name:'Confirmar e transcrever',exact:true}).click();await panel.getByRole('button',{name:'Conferir resultado',exact:true}).waitFor();assert.equal(calls.length,1);
 await panel.getByRole('button',{name:'Conferir resultado',exact:true}).click();await page.locator('#results').getByRole('button',{name:'Conferir transcrição',exact:true}).click();await page.locator('#results .transcript-proof h3').first().waitFor();assert.equal(await page.locator('#results .transcript-proof>p').nth(1).textContent(),original);assert.equal(await page.locator('#results img').count(),0);assert.equal(arquivos.listarAnexos().length,1);await page.screenshot({path:output+'/02-resultado.png'});
 const before=db.prepare('SELECT texto_original,arquivo FROM transcricoes').get();
 await page.locator('#results').getByRole('button',{name:'Transcrever novamente',exact:true}).click();
 await panel.locator('select').selectOption('gemini');
 await panel.getByRole('button',{name:'Usar áudio já guardado',exact:true}).click();await panel.locator('input[type=checkbox]').check();await panel.getByRole('button',{name:'Preparar transcrição',exact:true}).click();await panel.getByRole('button',{name:'Confirmar e transcrever',exact:true}).waitFor();assert.match(await panel.innerText(),/Já existe uma transcrição/);
 hold=true;await panel.getByRole('button',{name:'Confirmar e transcrever',exact:true}).click();await ready;await panel.getByRole('button',{name:'Cancelar transcrição',exact:true}).click();assert.equal(calls[1].signal.aborted,true);
 const response=page.waitForResponse(r=>r.url().endsWith('/api/v3/audio/transcrever'));release();await (await response).finished();assert.deepEqual(db.prepare('SELECT texto_original,arquivo FROM transcricoes').get(),before);assert.equal(await panel.count(),0);assert.equal(arquivos.listarAnexos().length,1);
 downloadSuccess=true;await page.locator('#results').getByRole('button',{name:'Transcrever novamente',exact:true}).click();
 await panel.locator('select').selectOption('gemini');
 await panel.getByRole('button',{name:'Buscar áudio no WhatsApp',exact:true}).click();await panel.getByRole('status').filter({hasText:'Arquivo selecionado: Áudio do WhatsApp.wav'}).waitFor();await panel.locator('input[type=checkbox]').check();await panel.getByRole('button',{name:'Preparar transcrição',exact:true}).click();await panel.getByRole('button',{name:'Confirmar e transcrever',exact:true}).waitFor();assert.equal(calls.length,2);await page.locator('#feedback').waitFor({state:'hidden'});await panel.evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:output+'/03-audio-whatsapp.png'});await panel.getByRole('button',{name:'Cancelar transcrição',exact:true}).click();
 localAvailable=true;
 assert.equal((await post('/api/v3/ia/config',{habilitada:false,limiteUSD:1})).status(),200);
 assert.equal((await post('/api/v3/ia/permissao',{conversa:'audio',permitida:false})).status(),200);
 await page.locator('#results').getByRole('button',{name:'Transcrever novamente',exact:true}).click();assert.equal(await panel.locator('select').inputValue(),'local');
 await panel.getByRole('button',{name:'Usar áudio já guardado',exact:true}).click();await panel.locator('input[type=checkbox]').check();
 await panel.getByRole('button',{name:'Preparar transcrição',exact:true}).click();await panel.getByRole('button',{name:'Confirmar e transcrever',exact:true}).waitFor();
 assert.equal(localCalls,0);assert.equal(calls.length,2);assert.match(await panel.innerText(),/sem chamada paga/);
 await page.locator('#feedback').waitFor({state:'hidden'});
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:1000});await panel.scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:output+`/04-local-previa-${width}px.png`});}
 await panel.getByRole('button',{name:'Confirmar e transcrever',exact:true}).click();await panel.getByRole('button',{name:'Conferir resultado',exact:true}).waitFor();
 assert.equal(localCalls,1);assert.equal(calls.length,2);assert.equal(db.prepare('SELECT texto_original FROM transcricoes').get().texto_original,'Texto local sintético.');
 assert.equal(JSON.parse(db.prepare('SELECT audio_metadados_json FROM transcricoes').get().audio_metadados_json).consentimento.tipo,'processamento_local');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);writeFileSync(output+'/evidence.json',JSON.stringify({date:new Date().toISOString(),synthetic:true,native:false,provider:'simulado',whatsappDownload:'simulado; criptografia testada separadamente',calls:calls.length,external,errors,checks:['CSRF','unavailable provider reported before local PCM conversion','local decode and preview before provider','server duration and budget','390/820/1320','original and managed audio persisted','XSS literal','reuse managed audio','cancel while provider ignores abort','previous transcript preserved','WhatsApp download unavailable and available','download is not consent to send to Google']},null,2));console.log('AUDIO_DESKTOP_UI_OK');
}finally{release();await browser.close();await new Promise(r=>server.close(r));db.close();rmSync(dir,{recursive:true,force:true});}

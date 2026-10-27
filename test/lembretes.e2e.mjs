import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
const out='work/lembretes-qa';mkdirSync(out,{recursive:true});
const db=abrirBanco(),f=perfilGrafo(db),n=new NegociosDesktop(db);f.conversa('teste','Cliente sintético');const source=f.evento('teste','p');
n.salvar({previa:n.preparar({fonte:source}).id,confirmar:true,titulo:'PRIVADO',etapa:'proposta',proximo_contato:'2026-09-18'});
let now=new Date('2026-09-18T18:00:00Z'),supported=true,result='falhou',calls=[],cancelCount=0,provider=0,release=null;
const adapter={disponivel:()=>supported,cancelar:()=>{cancelCount++;release?.({resultado:'cancelado'});release=null;},mostrar:async input=>{calls.push(input);if(result==='pending')return new Promise(r=>release=r);return {resultado:result};}};
const server=criarServidor(db,{desktop:true,contexto:f.contexto,agoraLembretes:()=>now,notificacoes:adapter,gerarIA:async()=>{provider++;throw Error('Forbidden');},conexao:{estado:()=>({estado:'desconectada',qr:null}),iniciar:async()=>{},parar:async()=>{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1320,height:1000},reducedMotion:'reduce'}),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(!r.request().url().startsWith(origin)){external.push(r.request().url());return r.abort();}return r.continue();});
const waitFor=async(fn,ms=70000)=>{const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('Timed out waiting for specific reminder callback');await new Promise(r=>setTimeout(r,100));}};
try{
 assert.equal((await page.request.get(origin+'/api/v3/lembretes')).status(),403);
 assert.equal((await page.request.post(origin+'/api/v3/lembretes',{data:{ativo:true,hora:'09:00',confirmar:true}})).status(),403);
 await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();await page.locator('#first-hide').click();
 await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#lembretes-status').filter({hasText:'desligado'}).waitFor();
 assert.equal(await page.locator('#lembretes-ativo').isChecked(),false);assert.equal(calls.length,0);
 await page.locator('#lembretes-panel').getByRole('button',{name:'Testar aviso'}).click();await page.locator('#lembretes-result').filter({hasText:'não conseguiu'}).waitFor();
 assert.equal(await page.locator('#lembretes-ativo').isChecked(),false);assert.deepEqual(calls,[{teste:true}]);
 await page.locator('#lembretes-panel').getByRole('button',{name:'Testar aviso'}).click();await page.locator('#lembretes-result').filter({hasText:'um minuto'}).waitFor();assert.equal(calls.length,1);
 now=new Date(now.getTime()+61000);result='mostrado';await page.locator('#lembretes-panel').getByRole('button',{name:'Testar aviso'}).click();await page.locator('#lembretes-result').filter({hasText:'confirmou a exibição'}).waitFor();
 await page.locator('#lembretes-ativo').check();await page.locator('#lembretes-hora').fill('09:30');await page.locator('#lembretes-panel').getByRole('button',{name:'Salvar lembrete'}).click();await page.locator('#lembretes-status').filter({hasText:/^Lembrete ligado\./}).waitFor();await page.locator('#feedback').filter({hasText:'Lembrete salvo.'}).waitFor();
 await page.evaluate(()=>{clearTimeout(toastTimer);document.getElementById('feedback').hidden=true;});
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:1000});await page.locator('#lembretes-panel').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.locator('#lembretes-panel').screenshot({path:`${out}/lembretes-${width}.png`});}
 // Real server interval, actual stored eligibility, controlled OS adapter. No native toast claim.
 await waitFor(()=>calls.some(c=>c.teste===false));assert.equal(calls.filter(c=>!c.teste).length,1);
 await page.reload();await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#lembretes-result').filter({hasText:'Última tentativa diária'}).waitFor();assert.equal(await page.locator('#lembretes-ativo').isChecked(),true);assert.equal(await page.locator('#lembretes-hora').inputValue(),'09:30');
 const token=(await (await page.request.get(origin+'/api/sessao')).json()).token,headers={'X-Assessor-Token':token},post=(path,data)=>page.request.post(origin+path,{headers,data});
 // A pending OS acknowledgement must be cancelled after editing the due business.
 now=new Date(now.getTime()+61000);result='pending';const pending=post('/api/v3/lembretes/testar',{confirmar:true});await waitFor(()=>release!==null,5000);
 const prep=await (await post('/api/v3/negocios/preparar',{fonte:source})).json();assert.equal((await post('/api/v3/negocios/salvar',{previa:prep.id,confirmar:true,titulo:'PRIVADO',etapa:'encerrado'})).status(),200);
 assert.equal((await (await pending).json()).resultado,'cancelado');assert.ok(cancelCount>0);
 supported=false;await page.locator('nav [data-view=today]').click();await page.locator('nav [data-view=settings]').click();await page.locator('#settings-choice-work').click();await page.locator('#lembretes-status').filter({hasText:'O sistema não oferece'}).waitFor();assert.equal(await page.locator('#lembretes-panel').getByRole('button',{name:'Testar aviso'}).isDisabled(),true);
 await page.locator('#lembretes-ativo').uncheck();await page.locator('#lembretes-panel').getByRole('button',{name:'Salvar lembrete'}).click();await page.locator('#feedback').filter({hasText:'desligado'}).waitFor();
 assert.equal((await (await page.request.get(origin+'/api/v3/lembretes',{headers})).json()).ativo,false);
 assert.equal(provider,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
 const report={date:new Date().toISOString(),passed:true,widths:[390,820,1320],syntheticData:true,nativeNotifications:false,adapter:'controlled',realServerInterval:true,providerCalls:provider,externalRequests:external,errors,notificationRequests:calls,cancelCount};writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{release?.({resultado:'cancelado'});await browser.close();await new Promise(r=>server.close(r));db.close();}

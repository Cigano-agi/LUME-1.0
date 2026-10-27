// UI/HTTP e agendador reais; banco temporário, Gemini/cofre simulados. Nenhuma chamada paga.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
const dir=mkdtempSync(join(tmpdir(),'assessor-tarefas-e2e-')),output=resolve('work/tarefas-qa');mkdirSync(output,{recursive:true});
const db=abrirBanco(join(dir,'app.db')),ctx=new ContextoApp(db),calls=[],errors=[];
let chave='chave_sintetica_do_teste_123';
const server=criarServidor(db,{desktop:true,contexto:ctx,agoraIA:()=>new Date('2026-09-18T15:00:00Z'),conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}},segredos:{estado:async()=>({disponivel:true,configurada:Boolean(chave)}),ler:async()=>chave,gravar:async k=>{chave=k;},remover:async()=>{chave=null;}},gerarIA:async request=>{
 calls.push(request);const fontes=JSON.parse(request.pedido.contents[0].parts[0].text).fontes;
 return{dados:{itens:fontes.filter(f=>f.analisar).map(f=>({tipo:'compromisso',resumo:f.texto,fonte:f.fonte,trecho:f.texto,prazo_citado:''}))}};
}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1360,height:960}});page.on('pageerror',e=>errors.push(e.message));
const insert=(origin,text,permission='minha')=>ctx._registrarEvento({conversaId:'grupo-teste',origemId:origin,tipo:'texto',texto:text,recebidoEm:new Date('2026-09-18T12:00:00Z')},permission);
async function nav(view){await page.locator('nav [data-view='+view+']').click();}
try{
 db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo-teste','Equipe · teste sintético');
 insert('a','Revisar contrato alfa. <img src=x onerror=alert(1)>');insert('b','Preparar apresentação de amanhã.');insert('secret','SEGREDO DE TERCEIRO','terceiro');
	 assert.equal((await fetch(url+'/api/v3/tarefas')).status,403);
	 await page.goto(url+'/app');await page.locator('#owner').fill('Pessoa teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
	 await page.locator('#first-hide').click();
 if(!await page.locator('#legacy-actions').evaluate(el=>el.open))await page.locator('#legacy-actions>summary').click();
 await page.locator('#task-options summary').click();
 await page.locator('#tarefas-estado').filter({hasText:'Ative a IA'}).waitFor();assert.equal(calls.length,0);
 await page.locator('#tarefas-configurar').click();await page.locator('#ia-enabled').check();await page.locator('#ia-ack').check();await page.locator('#ia-config-form button.primary').click();
 await page.locator('#ia-key-status').filter({hasText:'Chave guardada'}).waitFor();await page.locator('#ia-policies input').check();
 await page.waitForFunction(()=>document.querySelector('#tarefas-auto-conversas input'));
 await nav('today');await page.locator('#tarefas-conversa').selectOption('grupo-teste');await page.locator('#tarefas-periodo').selectOption('30dias');await page.locator('#tarefas-preparar').click();
 await page.locator('#tarefas-previa').waitFor({state:'visible'});assert.equal(calls.length,0);assert.equal(await page.locator('#tarefas-previa details').count(),2);assert.ok(!(await page.locator('#tarefas-previa').innerText()).includes('SEGREDO'));
 await page.locator('#tarefas-previa details').first().click();await page.locator('#tarefas-previa').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'01-conferir-fontes.png')});
 await page.getByRole('button',{name:'Confirmar envio e gerar sugestões'}).click();await page.locator('#tarefas-sugestoes article').first().waitFor();assert.equal(calls.length,1);assert.equal(await page.locator('#tarefas-sugestoes article').count(),2);assert.equal(await page.locator('#tarefas-sugestoes img').count(),0);assert.equal(db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,0);
 await page.locator('#tarefas-sugestoes').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'02-revisar-sugestoes.png')});
	 const first=page.locator('#tarefas-sugestoes article').filter({hasText:'Revisar contrato alfa'});await first.getByRole('button',{name:/Conferir fonte E/}).click();await page.locator('#search-context').filter({hasText:/^Fonte E/}).waitFor();await page.locator('#results').filter({hasText:'Revisar contrato alfa'}).waitFor();assert.equal(await page.locator('#results > .source').count(),1);
 await nav('today');await page.locator('#tarefas-sugestoes article').filter({hasText:'Revisar contrato alfa'}).getByRole('button',{name:'Aceitar tarefa'}).click();
 await page.locator('#tasks article').waitFor();assert.equal(db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,1);
 await page.locator('#tarefas-sugestoes article').filter({hasText:'Preparar apresentação'}).getByRole('button',{name:'Descartar',exact:true}).click();await page.locator('#tarefas-sugestoes .empty').waitFor();
 await page.locator('#tasks').getByRole('button',{name:'Marcar resolvido'}).click();await page.locator('#tasks .empty').waitFor();assert.equal(db.prepare('SELECT estado FROM itens_crm').get().estado,'resolvido');
 await nav('settings');await page.locator('#settings-choice-work').click();await page.locator('#tarefas-auto-details summary').click();await page.locator('#tarefas-auto-conversas input').check();await page.locator('#tarefas-auto-max').fill('1');await page.locator('#tarefas-auto-ativa').check();
 await page.getByRole('button',{name:'Salvar automação'}).click();await page.locator('#feedback').filter({hasText:'confirme o envio automático'}).waitFor();assert.equal(db.prepare('SELECT ativa FROM desktop_tarefas_config').get().ativa,0);
 await page.locator('#tarefas-auto-aceite').check();await page.getByRole('button',{name:'Salvar automação'}).click();await page.locator('#tarefas-auto-status').filter({hasText:'Ativa · 0/1'}).waitFor();
 await page.locator('#tarefas-auto-status').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'03-automacao-opcional.png')});
 insert('new','Enviar a proposta revisada na segunda.');await nav('today');
 await page.waitForFunction(()=>document.getElementById('tarefas-sugestoes').textContent.includes('Enviar a proposta revisada'),{},{timeout:45000});
 assert.equal(calls.length,2);assert.equal(db.prepare("SELECT COUNT(*) n FROM desktop_tarefas_lotes WHERE modo='automatico'").get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,1);
 assert.ok(!JSON.stringify(calls.map(c=>c.pedido)).includes('SEGREDO'));
 await page.setViewportSize({width:820,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.locator('.tarefas-panel').scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'04-tarefas-820px.png')});
 await nav('memory');await page.locator('#memory-mode-search').click();await page.locator('#search').fill('Revisar contrato alfa');await page.locator('#search-form button').click();await page.locator('#results article').filter({hasText:'Revisar contrato alfa'}).waitFor();
 let release,ready;const hold=new Promise(r=>release=r),intercepted=new Promise(r=>ready=r);
 await page.route('**/api/v3/tarefas?*',async route=>{const response=await route.fetch();ready();await hold;await route.fulfill({response});});
 await page.evaluate(()=>{window.qaTarefas=window.carregarTarefas();});await intercepted;
 await page.locator('#results').getByRole('button',{name:'Apagar do Lume'}).click();await page.locator('#dados-delete-preview').waitFor({state:'visible'});assert.match(await page.locator('#dados-delete-preview').innerText(),/Sugestões de tarefas: 3/);
 await page.locator('#dados-confirmar').fill('APAGAR');await page.getByRole('button',{name:'Apagar e pausar captura'}).click();await page.locator('#dados-status').filter({hasText:'1 fontes removidas'}).waitFor();
 release();await page.evaluate(()=>window.qaTarefas);await page.unroute('**/api/v3/tarefas?*');assert.equal(await page.locator('#tarefas-sugestoes article').count(),0);assert.equal(db.prepare('SELECT COUNT(*) n FROM desktop_tarefas_sugestoes').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM itens_crm').get().n,0);
 assert.equal(db.prepare('SELECT ativa FROM desktop_tarefas_config').get().ativa,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM desktop_tarefas_lotes WHERE modo='automatico'").get().n,1);
 const csrf=await fetch(url+'/api/v3/tarefas/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ativa:true})});assert.equal(csrf.status,403);
 assert.deepEqual(errors,[]);writeFileSync(join(output,'evidence.json'),JSON.stringify({data:new Date().toISOString(),ambiente:'UI/HTTP e agendador reais; Gemini e cofre simulados; perfil temporário sintético',calls:calls.length,checks:['aceite e CSRF','prévia sem envio','terceiros excluídos antes do prompt','XSS literal','gerar não aceita','fonte exata','aceitar, descartar e resolver','opt-in separado da IA','agendamento de 30s real e quota persistida','820px sem overflow','exclusão alcança todas as sugestões e CRM derivados','resposta atrasada não repõe conteúdo','quota preservada após exclusão'],errors},null,2));console.log('TAREFAS UI PASS');
}catch(e){await page.screenshot({path:join(output,'falha.png'),fullPage:true});throw e;}
finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();rmSync(dir,{recursive:true,force:true});}

// Dados sintéticos, dois perfis temporários e UI/HTTP reais. Sem WhatsApp ou IA remota.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {criarServidor} from '../src/painel/servidor.js';
import {prepararEsquemaTranscricao} from '../src/transcricao.js';
const output=resolve('work/dados-qa');mkdirSync(output,{recursive:true});
const senha='Senha sintética de backup 2026';
async function ambiente(){
 const dir=mkdtempSync(join(tmpdir(),'assessor-dados-e2e-')),db=abrirBanco(join(dir,'assessor.db')),ctx=new ContextoApp(db),arquivos=new ArquivosDados(dir);let paradas=0;
 const server=criarServidor(db,{desktop:true,contexto:ctx,arquivosDados:arquivos,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{paradas++;}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return{dir,db,ctx,server,url:`http://127.0.0.1:${server.address().port}`,paradas:()=>paradas};
}
const a=await ambiente(),b=await ambiente(),browser=await chromium.launch({channel:'msedge',headless:true}),errors=[];
const count=e=>e.db.prepare('SELECT COUNT(*) n FROM eventos').get().n;
async function abrir(e,nome){const p=await browser.newPage({viewport:{width:1360,height:960},acceptDownloads:true});p.on('pageerror',e=>errors.push(e.message));await p.goto(e.url+'/app');await p.locator('#owner').fill(nome);await p.locator('#consent').check();await p.getByRole('button',{name:'Preparar meu espaço'}).click();await p.locator('#skip').click();await p.locator('nav [data-view=settings]').click();await p.locator('#settings-choice-data').click();await p.locator('#dados-total').filter({hasText:'armazenadas'}).waitFor();return p;}
async function detalhe(p,text){const s=p.locator('.settings-card summary').filter({hasText:text}).first();await s.evaluate(e=>window.abrirAjuste(e.closest('[data-settings-card]').id));if(!await s.evaluate(e=>e.parentElement.open))await s.click();}
async function baixar(p,button,nome){const waiting=p.waitForEvent('download');await button.click();const d=await waiting,path=join(output,nome);await d.saveAs(path);return path;}
async function buscar(p,text){await p.locator('nav [data-view=memory]').click();await p.locator('#memory-mode-search').click();await p.locator('#search').fill(text);await p.locator('#search-form button').click();await p.locator('#results').filter({hasText:text}).waitFor();}
async function dadosPost(env,rota,body){const {token}=await (await fetch(env.url+'/api/sessao')).json();const response=await fetch(env.url+'/api/v3/dados/'+rota,{method:'POST',headers:{'X-Assessor-Token':token,'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,value:await response.json()};}

try{
 const source=a.ctx.nota({titulo:'Decisão sintética',texto:'Revisar contrato alfa. <img src=x onerror=alert(1)>'}).id;
 const wa={key:{remoteJid:'privado@g.us',id:'mensagem-oculta',fromMe:false},participant:'outra@lid',messageTimestamp:1700000000,message:{conversation:'Conteúdo oculto sintético'}};a.ctx.receber({type:'notify',messages:[wa]});
 prepararEsquemaTranscricao(a.db);mkdirSync(join(a.dir,'anexos'));const file=join(a.dir,'anexos','audio.bin');writeFileSync(file,'Audio de teste');const row=a.db.prepare('SELECT * FROM eventos WHERE id=?').get(source);
 a.db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,arquivo,texto,estado,criado_em) VALUES(?,?,?,'Texto transcrito sintético','transcrito','2026-09-17')").run(row.conversa_id,row.origem_id,file);
 const pa=await abrir(a,'Pessoa sintética A');await buscar(pa,'contrato alfa');assert.equal(await pa.locator('#results img').count(),0);
 await pa.locator('#results').getByRole('button',{name:'Criar nota vinculada'}).click();await pa.locator('#note-text').fill('Resumo ligado à decisão alfa');await pa.getByRole('button',{name:'Guardar nota',exact:true}).click();await pa.waitForFunction(()=>document.getElementById('feedback').textContent.includes('Ideia guardada'));assert.equal(count(a),3);
 await detalhe(pa,'Exportar uma cópia');await pa.locator('#dados-export-confirmar').check();let path=await baixar(pa,pa.getByRole('button',{name:'Preparar exportação pessoal'}),'exportacao-permitida.json');let exp=JSON.parse(readFileSync(path,'utf8'));assert.equal(exp.eventos.length,2);assert.ok(!JSON.stringify(exp).includes('Conteúdo oculto'));
 await pa.locator('#dados-export-ocultas').check();path=await baixar(pa,pa.getByRole('button',{name:'Preparar exportação pessoal'}),'exportacao-completa.json');exp=JSON.parse(readFileSync(path,'utf8'));assert.equal(exp.eventos.length,3);assert.ok(!JSON.stringify(exp).includes(a.dir));
 // O ensaio legado segue cobrindo exclusão de dados e recibos. A UI v10 e seu
 // arquivo binário são exercitados em painel-backup-v10.e2e.mjs.
 const backupResponse=await dadosPost(a,'backup',{senha,confirmar:true});assert.equal(backupResponse.status,200);const backup=JSON.stringify(backupResponse.value.pacote);
 const pb=await abrir(b,'Pessoa sintética B');
 const wrong=await dadosPost(b,'preparar-restauracao',{arquivo:backup,senha:'Uma senha errada longa'});assert.equal(wrong.status,400);assert.equal(count(b),0);
 const preview=await dadosPost(b,'preparar-restauracao',{arquivo:backup,senha});assert.equal(preview.status,200);const applied=await dadosPost(b,'restaurar',{id:preview.value.id,confirmarMeuBackup:true});assert.equal(applied.status,200);
 assert.equal(count(b),3);assert.equal(b.paradas(),1);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM priv_vinculos').get().n,1);const restored=b.db.prepare('SELECT arquivo FROM transcricoes').get().arquivo;assert.equal(readFileSync(restored,'utf8'),'Audio de teste');assert.ok(!restored.startsWith(a.dir));
 await pb.reload();await pb.locator('nav [data-view=settings]').click();await pb.locator('#settings-choice-data').click();
 await buscar(pb,'contrato alfa');
 const apagar=pb.locator('#results article.source').filter({hasText:'Revisar contrato alfa.'}).getByRole('button',{name:'Apagar do Lume'});await apagar.waitFor();
 const restoredSourceId=b.db.prepare("SELECT id FROM eventos WHERE texto LIKE '%Revisar contrato alfa.%'").get().id;
 let releaseSearch,searchIntercepted;const delayedSearch=new Promise(r=>releaseSearch=r),intercepted=new Promise(r=>searchIntercepted=r);
 await pb.route('**/api/v3/busca?*',async route=>{const response=await route.fetch();searchIntercepted();await delayedSearch;await route.fulfill({response});});
 await pb.evaluate(()=>{window.qaBuscaPendente=search();});await intercepted;
 await pb.evaluate(id=>window.excluirFonte(id),restoredSourceId);await pb.locator('#dados-delete-preview').waitFor({state:'visible'});assert.match(await pb.locator('#dados-delete-preview').innerText(),/Notas vinculadas incluídas: 1/);await pb.locator('#dados-delete-preview').scrollIntoViewIfNeeded();await pb.screenshot({path:join(output,'02-previa-exclusao.png')});
 await pb.locator('#dados-confirmar').fill('APAGAR');await pb.getByRole('button',{name:'Apagar e pausar captura'}).click();await pb.waitForFunction(()=>document.getElementById('dados-status').textContent.startsWith('2 fontes removidas'));assert.equal(count(b),1);assert.equal(existsSync(restored),false);assert.equal(b.db.prepare('SELECT COUNT(*) n FROM priv_vinculos').get().n,0);
 releaseSearch();await pb.evaluate(()=>window.qaBuscaPendente);await pb.unroute('**/api/v3/busca?*');assert.equal(await pb.locator('#results article').count(),0);
 await pb.locator('#dados-delete-conversa').selectOption('__tudo__');await pb.getByRole('button',{name:'Conferir antes de apagar'}).click();await pb.locator('#dados-confirmar').fill('APAGAR');await pb.getByRole('button',{name:'Apagar e pausar captura'}).click();await pb.waitForFunction(()=>document.getElementById('dados-status').textContent.startsWith('1 fontes removidas'));assert.equal(count(b),0);b.ctx.receber({type:'append',messages:[wa]});assert.equal(count(b),0);
 await pb.reload();await pb.locator('nav [data-view=settings]').click();await pb.locator('#settings-choice-data').click();await pb.locator('#dados-total').filter({hasText:'captura pausada'}).waitFor();await detalhe(pb,'Recibos de exclusão');await pb.locator('#dados-recibos').scrollIntoViewIfNeeded();await pb.screenshot({path:join(output,'03-recibos.png')});assert.equal(await pb.locator('#dados-recibos > details').count(),3);
 const stale=await dadosPost(b,'preparar-restauracao',{arquivo:backup,senha});assert.equal(stale.status,200);const rejected=await dadosPost(b,'restaurar',{id:stale.value.id,confirmarMeuBackup:true});assert.equal(rejected.status,400);assert.match(rejected.value.erro,/excluídas/);assert.equal(count(b),0);assert.equal(count(a),3);assert.equal(existsSync(file),true);
 await pb.setViewportSize({width:820,height:900});assert.equal(await pb.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const csrf=await fetch(b.url+'/api/v3/dados/excluir',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'inexistente',confirmar:'APAGAR'})});assert.equal(csrf.status,403);
 assert.deepEqual(errors,[]);writeFileSync(join(output,'evidence.json'),JSON.stringify({data:new Date().toISOString(),ambiente:'HTTP/UI reais, dois perfis temporários, dados sintéticos, sem IA/WhatsApp externos',checks:['nota vinculada pela interface','XSS literal','exportação respeita recorte; ocultos explícitos','download de backup cifrado','senha errada não escreve','prévia e restauração com anexo e vínculo','exclusão de fonte e derivados','exclusão de histórico oculto','recaptura bloqueada','resposta atrasada não repõe fonte apagada','pausa e recibos após reload','backup antigo não reverte exclusão','perfil original preservado','CSRF bloqueado','820px'],errors},null,2));console.log('DADOS UI PASS: exportar, excluir, recibos e replay; restauração legada via HTTP.');
}finally{await browser.close();for(const e of[a,b]){e.server.closeAllConnections();await new Promise(r=>e.server.close(r));e.db.close();rmSync(e.dir,{recursive:true,force:true});}}

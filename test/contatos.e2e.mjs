import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa,fundirPessoas} from '../src/pessoas.js';
import {NegociosDesktop} from '../src/negocios-desktop.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';

const db=abrirBanco(),f=perfilGrafo(db),n=new NegociosDesktop(db),out='work/contatos-qa';mkdirSync(out,{recursive:true});
function pessoa(id,nome){registrarPessoa(db,{identificador:id,nomeCru:nome});return db.prepare('SELECT pessoa_id FROM pessoa_identificadores WHERE identificador=?').get(id).pessoa_id;}
const ana=pessoa('ana@lid','Ana Silva'),alias=pessoa('5511999999999@s.whatsapp.net','Ana Silva');fundirPessoas(db,{deId:alias,paraId:ana});
const other=pessoa('outra-ana@lid','Ana Silva');f.conversa('outra-ana@lid','Outra Ana');f.evento('outra-ana@lid','outra-ana@lid');
prepararEsquemaTranscricao(db);const audio=f.evento('outra-ana@lid','outra-ana@lid',{tipo:'audio',texto:null});const audioFonte=db.prepare('SELECT conversa_id,origem_id FROM eventos WHERE id=?').get(audio);
gravarTranscricao(db,{conversaId:audioFonte.conversa_id,origemId:audioFonte.origem_id,textoOriginal:'Transcrição: proposta para sexta'});
for(let i=0;i<15;i++){const c='projeto-'+i+'@g.us';f.conversa(c,i===0?'Ateliê Horizonte · exemplo':'Projeto de exemplo '+i);const id=f.evento(c,i%2?'ana@lid':'5511999999999@s.whatsapp.net',{texto:i===0?'Podemos conversar sobre o site na sexta?':'Mensagem de exemplo '+i});if(i<8)n.salvar({previa:n.preparar({fonte:id}).id,confirmar:true,titulo:i===0?'Site do ateliê':'Projeto de exemplo '+i,etapa:'proposta',valor_centavos:250000});}
f.conversa('ana@lid','Ana Silva');const dm=f.evento('ana@lid','eu',{texto:'Ana, enviei os detalhes do site.'});db.prepare('UPDATE eventos SET autor_e_dono=1 WHERE id=?').run(dm);
for(let i=0;i<12;i++){const id='pessoa-'+i;pessoa(id,'Contato de exemplo '+i);f.evento('projeto-0@g.us',id);}
f.conversa('secreta@g.us','CONVERSA_SECRETA');pessoa('OCULTO','NOME_SECRETO');f.evento('secreta@g.us','OCULTO',{permissao:'terceiro',texto:'SEGREDO'});
let provider=0;const server=criarServidor(db,{contexto:f.contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{provider++;throw Error('Forbidden');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1320,height:950},reducedMotion:'reduce'}),errors=[],external=[];
page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{if(!r.request().url().startsWith(origin)){external.push(r.request().url());return r.abort();}return r.continue();});
const fit=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
try{
 assert.equal((await page.request.get(origin+'/api/v3/contatos')).status(),403);assert.equal((await page.request.get(origin+'/api/v3/contatos/detalhe?contato=p:'+ana)).status(),403);
 await page.goto(origin+'/app');await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
	 await page.locator('nav [data-route=contacts]').click();await page.locator('.contact-card').first().waitFor();
 assert.equal(await page.locator('.contact-card').count(),12);assert.ok(!(await page.locator('#contacts').innerText()).includes('SECRETO'));
 await page.getByRole('button',{name:'Próxima página de contatos',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.contact-card').length===2);
 await page.locator('#contact-name').fill('ána');await page.locator('#contact-filter button').click();await page.waitForFunction(()=>document.querySelector('#contact-pages')?.textContent.includes('página 1 de 1')&&document.querySelectorAll('.contact-card').length===2);
 const audioCard=page.locator('.contact-card').filter({hasText:'2 mensagens'});await audioCard.getByRole('button',{name:'Ver contato',exact:true}).click();
 await page.locator('.contact-transcript-label').getByText('Transcrição automática · confira o áudio.',{exact:true}).waitFor();await page.locator('.contact-transcript-warning').waitFor();
 await page.locator('#contact-detail').screenshot({path:`${out}/transcricao-1320.png`});
 await page.getByRole('button',{name:'Voltar aos contatos',exact:true}).click();
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:950});await fit();await page.locator('#contacts').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/contatos-${width}.png`});}
 const card=page.locator('.contact-card').filter({hasText:'16 conversas'});await card.getByRole('button',{name:'Ver contato',exact:true}).click();await page.locator('#contact-heading').waitFor();await page.waitForFunction(()=>document.activeElement.id==='contact-heading');
 assert.equal(await page.locator('#contact-conversations .contact-row').count(),6);assert.equal(await page.locator('.contact-message').count(),8);assert.equal(await page.locator('#contact-businesses .contact-row').count(),6);
 assert.match(await page.locator('#contact-detail').innerText(),/16 mensagens do contato/);assert.ok(!(await page.locator('#contact-detail').innerText()).includes('Outra Ana'));
 for(const width of [1320,820,390]){await page.setViewportSize({width,height:950});await fit();await page.locator('#contact-detail').scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/ficha-${width}.png`});}
 await page.locator('.contact-message').first().getByRole('button',{name:'Ver mensagem',exact:true}).click();await page.locator('.contact-message .source').waitFor();assert.match(await page.locator('.contact-message .source').innerText(),/enviei os detalhes/);
 await page.getByRole('button',{name:'Próxima página de mensagens do contato',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#contact-messages')?.textContent.includes('página 2 de 2'));
 await page.getByRole('button',{name:'Próxima página de conversas do contato',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#contact-conversations')?.textContent.includes('página 2 de 3'));
 await page.getByRole('button',{name:'Próxima página de negócios ligados às mensagens',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#contact-businesses')?.textContent.includes('página 2 de 2'));
 // Existing business editor must refresh the contact projection after saving.
 await page.locator('#contact-businesses').getByRole('button',{name:'Rever negócio',exact:true}).first().click();await page.locator('#negocio-title').fill('Site revisado');await page.locator('#negocio-confirm').check();await page.getByRole('button',{name:'Salvar negócio',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#negocio-dialog').open);
 await page.getByRole('button',{name:'Página anterior de negócios ligados às mensagens',exact:true}).click();await page.locator('#contact-businesses').getByText('Site revisado',{exact:true}).waitFor();
 // A selected conversation hides the global contact directory; returning restores it.
 await page.locator('#contact-conversations').getByRole('button',{name:'Abrir conversa',exact:true}).first().click();await page.locator('#conversation-heading').waitFor();assert.equal(await page.locator('#contacts').isVisible(),false);
 await page.locator('#conversation-detail').getByRole('button',{name:'Voltar à lista',exact:true}).click();await page.locator('#memory-mode-contacts').click();await page.locator('#contact-heading').waitFor();
 // A delayed source must not return after the underlying permissions change.
 let release,started;const startedPromise=new Promise(r=>started=r),held=new Promise(r=>release=r);
 const delay=async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});};
 await page.route('**/api/v3/fonte?*',delay);await page.locator('.contact-message').first().getByRole('button',{name:'Ver mensagem',exact:true}).click();await startedPromise;
 db.exec("UPDATE eventos SET permissao='terceiro'");await page.evaluate(()=>window.limparDadosVisiveis());release();await page.waitForTimeout(150);assert.equal(await page.locator('#contact-detail').innerText(),'');await page.unroute('**/api/v3/fonte?*',delay);
 assert.equal((await page.request.get(origin+'/api/v3/contatos/detalhe?contato=p:'+ana)).status(),400);
 const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha de teste recuperável'})});
	 await page.route('**/api/v3/contatos?*',fail);await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();await page.locator('#memory-mode-contacts').click();await page.locator('#contact-list').getByRole('button',{name:'Tentar novamente'}).waitFor();assert.ok(!(await page.locator('#contacts').innerText()).includes('Ana Silva'));
 await page.unroute('**/api/v3/contatos?*',fail);await page.locator('#contact-list').getByRole('button',{name:'Tentar novamente'}).click();await page.locator('#contact-list').getByText('Nenhum contato neste filtro.').waitFor();
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(provider,0);
 const report={date:new Date().toISOString(),passed:true,widths:[1320,820,390],provider,external,errors,checks:['acceptance required','full directory pages','accent-insensitive name search','equal names separate','transcription and model warning labeled','aliases and own DM combined once','conversation/source/business pages','source opened','business edit refreshed','conversation navigation','revocation clears source in flight','HTTP denies revoked contact','failure removes stale content and retry works','responsive UI']};
 writeFileSync(out+'/checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));db.close();}

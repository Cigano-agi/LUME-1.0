// Real local HTTP and renderer; fictional reviewed action, no inference or WhatsApp.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {AcoesLume} from '../src/acoes-lume.js';
const output='work/beta06-action-projects';mkdirSync(output,{recursive:true});
const db=abrirBanco(':memory:'),{contexto,desktop,fontes}=perfilBeta05(db,{agora:new Date()});
desktop.configurarGuia({dispensado:true});
const actions=new AcoesLume(db);actions.autorizar({conversa:'demo-ana',permitida:true});
const trecho='Nossa reunião de revisão ficou para 24/09 às 10h.';
actions.registrar({eventoId:fontes.ana.id,candidatas:[{fonte:'E'+fontes.ana.id,tipo:'compromisso',resumo:'Preparar a revisão com Ana',trecho,prazo_citado:''}]});
const actionId=actions.listar()[0].id;
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{throw Error('Pairing forbidden in test');}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'msedge',headless:true});
const errors=[],external=[];
try{
  const page=await browser.newPage({viewport:{width:390,height:950},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(origin))external.push(r.url());});
  await page.goto(origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
  assert.equal(await page.locator('#luminus-body .project-from-action').count(),0,'unreviewed action has no shortcut');
  const headers={'content-type':'application/json','x-assessor-token':(await(await fetch(origin+'/api/sessao')).json()).token};
  const post=(path,body,h=headers)=>fetch(origin+'/api/v3/projetos-comerciais/'+path,{method:'POST',headers:h,body:JSON.stringify(body)});
  assert.equal((await post('acoes/previa',{acaoIds:[actionId]},{})).status,403);
  assert.equal((await post('acoes/previa',{acaoIds:[actionId],enviar:true})).status,400);
  assert.equal((await post('acoes/previa',{acaoIds:[actionId]})).status,400,'review required by server');
  await page.locator('#luminus-body .acoes06-options>summary').click();
  await page.locator('#luminus-body').getByRole('button',{name:'Confirmar',exact:true}).click();
  await page.locator('#luminus-body .project-from-action').waitFor({state:'attached'});
  const open=async()=>{const details=page.locator('#luminus-body .acoes06-options');if(await details.getAttribute('open')===null)await details.locator(':scope>summary').click();await page.locator('#luminus-body .project-from-action').click();await page.locator('#project-name').waitFor();};
  await open();assert.match(await page.locator('#projects-dialog .resolver-sources').innerText(),/Nossa reunião de revisão/);
  assert.equal(await page.locator('#project-name').inputValue(),'','no invented project name');
  for(const width of [390,820,1440]){await page.setViewportSize({width,height:950});await page.screenshot({path:`${output}/reviewed-action-${width}.png`});assert.equal(await page.locator('#projects-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);}
  // A preference update unrelated to the selected source must not invalidate this preview.
  desktop.configurarGuia({dispensado:false});
  await page.locator('#project-name').fill('Revisão com Ana · teste');
  await page.getByRole('button',{name:'Criar rascunho de projeto',exact:true}).click();
  await page.getByRole('button',{name:'Confirmar organização',exact:true}).waitFor();
  const project=db.prepare('SELECT * FROM lume_projetos_comerciais').get();
  assert.equal(project.estado,'rascunho');assert.equal(project.natureza,'incerto');
  const source=db.prepare('SELECT * FROM lume_projetos_fontes').get();assert.equal(source.selecao,'trecho');assert.equal(source.tamanho,trecho.length);
  await page.keyboard.press('Escape');await page.reload();await page.locator('nav [data-route=projects]').click();
  await page.locator('.project-card').filter({hasText:'Revisão com Ana · teste'}).getByRole('button',{name:'Abrir projeto'}).click();
  await page.getByRole('button',{name:'Arquivar projeto',exact:true}).click();await page.getByRole('button',{name:'Restaurar rascunho',exact:true}).waitFor();
  assert.equal(db.prepare('SELECT estado FROM lume_projetos_comerciais').get().estado,'arquivado');
  await page.keyboard.press('Escape');await page.locator('nav [data-view=today]').click();await open();
  actions.autorizar({conversa:'demo-ana',permitida:false});
  await page.locator('#project-name').fill('Não deve ser salvo');await page.getByRole('button',{name:'Criar rascunho de projeto',exact:true}).click();
  await page.locator('#projects-dialog .resolver-error').waitFor();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_projetos_comerciais WHERE nome='Não deve ser salvo'").get().n,0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const evidence={date:new Date().toISOString(),synthetic:true,reviewRequired:true,literalExcerpt:true,unrelatedWritePreservesPreview:true,draftNotAgreement:true,survivedReload:true,archive:true,revocationPreventsCreate:true,automatic:false,errors,external};
  writeFileSync(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();}

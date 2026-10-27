// Synthetic content, real encrypted backup, HTTP and renderer. No external services.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {Backup} from '../src/backup.js';

const output='work/beta06-imported-projects';mkdirSync(output,{recursive:true});
const source=abrirBanco(':memory:'),db=abrirBanco(':memory:');
const seed=perfilBeta05(source,{vazio:true}),{contexto,desktop}=perfilBeta05(db,{vazio:true});
new DesktopIA(source);new DesktopIA(db);desktop.configurarGuia({dispensado:true});
const a=seed.mensagem({texto:'Vamos preparar juntos a proposta do novo produto. Eu reviso o escopo amanhã.'});
const b=seed.mensagem({conversa:'demo-b',nome:'Bruno · demonstração',texto:'A proposta da oficina precisa de revisão antes da reunião.'});
const projects=new ProjetosComerciais(source);
const original=projects.criarRascunho({nome:'Novo produto · demonstração',fontes:[{eventoId:a.id}]});
projects.confirmar({id:original.id,confirmar:true});
const stale=projects.criarRascunho({nome:'Oficina · demonstração',fontes:[{eventoId:b.id}]});
const senha='senha apenas sintetica no teste',backup=new Backup(source),restore=new Backup(db);
const created=await backup.criar({senha,confirmar:true});
const prepared=await restore.preparar({arquivo:JSON.stringify(created.pacote),senha});
restore.restaurar({id:prepared.id,confirmarMeuBackup:true});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{throw Error('Pairing forbidden');}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],external=[];
try{
  const page=await browser.newPage({viewport:{width:390,height:950},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith(origin))external.push(r.url());});
  const token=(await(await fetch(origin+'/api/sessao')).json()).token;
  const headers={'content-type':'application/json','x-assessor-token':token};
  const post=(path,body,h=headers)=>fetch(origin+'/api/v3/projetos-comerciais/'+path,{method:'POST',headers:h,body:JSON.stringify(body)});
  assert.equal((await post('importados/previa',{id:original.id},{})).status,403);
  assert.equal((await post('importados/previa',{id:original.id,enviar:true})).status,400);
  assert.equal((await post('importados/revalidar',{previaId:'x',confirmar:false})).status,400);
  assert.equal((await fetch(origin+'/api/v3/projetos-comerciais/importados?limite=10&limite=2',{headers})).status,400);
  await page.goto(origin+'/app');await page.locator('nav [data-route=projects]').click();
  const card=page.locator('.projects-imported .project-card').filter({hasText:original.nome});await card.waitFor();
  assert.equal(await page.getByText('Nenhum projeto disponível aqui.',{exact:true}).count(),0);
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:950});await page.screenshot({path:`${output}/list-${width}.png`});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  await card.getByRole('button',{name:'Conferir fontes'}).click();
  const check=page.locator('#project-import-confirm'),save=page.getByRole('button',{name:'Retomar rascunho',exact:true});
  await check.waitFor();assert.equal(await check.isChecked(),false);assert.equal(await save.isDisabled(),true);
  assert.match(await page.locator('#projects-dialog .resolver-sources').innerText(),/proposta do novo produto/);
  for(const width of [390,820,1440]){
    await page.setViewportSize({width,height:950});await page.screenshot({path:`${output}/review-${width}.png`});
    assert.equal(await page.locator('#projects-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);
  }
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:`${output}/review-dark-1440.png`});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await check.focus();await page.keyboard.press('Space');await page.keyboard.press('Tab');
  assert.equal(await save.evaluate(n=>n===document.activeElement),true);await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Confirmar organização',exact:true}).waitFor();
  assert.equal(db.prepare('SELECT estado FROM lume_projetos_comerciais WHERE id=?').get(original.id).estado,'rascunho');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_projetos_historico WHERE projeto_id=? AND tipo='importado_revisado'").get(original.id).n,1);
  assert.match(await page.locator('.resolver-timeline').innerText(),/Fontes do backup revisadas/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n,0);
  await page.keyboard.press('Escape');await page.reload();await page.locator('nav [data-route=projects]').click();
  await page.locator('.project-card').filter({hasText:original.nome}).getByRole('button',{name:'Abrir projeto'}).waitFor();
  const staleCard=page.locator('.projects-imported .project-card').filter({hasText:stale.nome});
  await staleCard.getByRole('button',{name:'Conferir fontes'}).click();await check.waitFor();
  db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte corrigida depois da prévia.',b.id);
  await check.check();await save.click();await page.locator('#projects-dialog .resolver-error').waitFor();
  assert.equal(await page.locator('#projects-dialog blockquote').count(),0,'failed review clears source text');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_projetos_historico WHERE projeto_id=? AND tipo='importado_revisado'").get(stale.id).n,0);
  await page.keyboard.press('Escape');
  db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte-base corrigida.',a.id);
  await page.reload();await page.locator('nav [data-route=projects]').click();
  await page.getByText('Nenhum projeto disponível aqui.',{exact:true}).waitFor();
  assert.match(await page.locator('#projects06').innerText(),/Projetos do backup só aparecem quando suas fontes podem ser conferidas/);
  assert.equal(await page.locator('#projects06 .project-card').count(),0);
  assert.doesNotMatch(await page.locator('#projects06').innerText(),/Novo produto|Oficina/);
  await page.setViewportSize({width:390,height:950});await page.screenshot({path:`${output}/unavailable-390.png`});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const evidence={date:new Date().toISOString(),synthetic:true,encryptedBackup:true,widths:[390,820,1440],reducedMotion:true,keyboard:true,consentUnchecked:true,sameProjectId:true,returnsDraft:true,authorityNotRestored:true,history:true,survivedReload:true,changedSourceRejected:true,unavailableWithoutDisclosure:true,errors,external};
  writeFileSync(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();source.close();}

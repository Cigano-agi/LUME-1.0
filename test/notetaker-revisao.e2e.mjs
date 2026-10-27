import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {cabecalhoWav} from '../src/notetaker/contrato.js';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';

const appRoot=resolve(import.meta.dirname,'..');
const output=join(appRoot,'work/beta07-notetaker-revisao/capturas');
await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'lume-notetaker-revisao-'));
const marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
let db,server,browser;
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=async(res)=>({status:res.status,data:await res.json()});

async function runtime(){
  const pasta=join(root,'bundle');await mkdir(pasta);
  const binary=Buffer.from('executavel-sintetico'),weights=Buffer.from('modelo-sintetico');
  const manifest={versao:1,motor:'whisper.cpp',versaoMotor:'teste-04B',plataforma:process.platform,arquitetura:process.arch,
    modeloNome:'modelo-teste',executavelBytes:binary.length,executavelSha256:hash(binary),modeloBytes:weights.length,modeloSha256:hash(weights)};
  await writeFile(join(pasta,process.platform==='win32'?'whisper-cli.exe':'whisper-cli'),binary);
  await writeFile(join(pasta,'modelo.bin'),weights);
  const bytes=Buffer.from(JSON.stringify(manifest));await writeFile(join(pasta,'manifest.json'),bytes);
  return criarAudioLocalRuntime({raiz:pasta,manifestoSha256:hash(bytes),runner:async(_bin,args)=>{
    await writeFile(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'pt'},transcription:[{offsets:{from:0,to:900},text:'Original sintético da reunião.'}]}));
  }});
}

try{
  await writeFile(join(root,'.lume-notetaker-test'),marker);
  db=abrirBanco(join(root,'db.sqlite'));new ContextoApp(db);new Desktop(db).aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
  server=criarServidor(db,{desktop:true,notetakerExperimento:true,testProfileRoot:root,testMarker:marker,audioLocal:await runtime()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const token=(await (await fetch(`${origin}/api/sessao`)).json()).token;
  const headers={'x-assessor-token':token,'content-type':'application/json'};
  const created=await json(await fetch(`${origin}/api/v3/notetaker/sessoes`,{method:'POST',headers,body:JSON.stringify({origem:'importacao',entradas:['importacao']})}));
  assert.equal(created.status,201);
  const session=created.data.id;
  assert.equal((await fetch(`${origin}/api/v3/notetaker/sessoes/${session}/consentir`,{method:'POST',headers,body:JSON.stringify({entradas:['importacao'],confirmar:true})})).status,200);
  const wav=Buffer.concat([cabecalhoWav(32000),Buffer.alloc(32000,1)]);
  const imported=await json(await fetch(`${origin}/api/v3/notetaker/sessoes/${session}/importar`,{method:'POST',headers:{'x-assessor-token':token,'content-type':'audio/wav'},body:wav}));
  assert.equal(imported.status,200);assert.equal(imported.data.asr.estado,'concluida');
  const trecho=db.prepare('SELECT t.id,t.texto_gerado FROM notetaker_trechos t JOIN notetaker_fontes f ON f.trecho_id=t.id WHERE f.sessao_id=?').get(session);
  assert.equal(trecho.texto_gerado,'Original sintético da reunião.');
  const api=`${origin}/api/v3/notetaker/trechos/${trecho.id}`;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(origin))external.push(r.url());});
  const assets=new Map([
    ['/qa-revisao',['test/fixtures/notetaker-revisao/index.html','text/html; charset=utf-8']],
    ...['lume-theme.css','lume-dark.css','notetaker.css','notetaker-view.js','notetaker-revisao.js'].map(name=>[`/${name}`,[`src/painel/${name}`,name.endsWith('.css')?'text/css':'text/javascript']])
  ]);
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const asset=url.origin===origin?assets.get(url.pathname):null;
    if(!asset)return route.continue();
    return route.fulfill({status:200,contentType:asset[1],body:await readFile(join(appRoot,asset[0]))});
  });
  const fit=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow ${label}`);
  const shot=async name=>{await fit(name);await page.screenshot({path:join(output,`${name}.png`),fullPage:true});};
  await page.goto(`${origin}/qa-revisao?trecho=${trecho.id}`);
  await page.getByRole('button',{name:'Corrigir texto'}).click();
  await page.getByLabel('Sua correção').waitFor();
  await page.getByRole('button',{name:'Cancelar'}).click();
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'corrigir','foco retorna ao acionador');
  await page.keyboard.press('Enter');
  await page.getByLabel('Sua correção').waitFor();
  assert.equal(await page.locator('.nt-review-display').textContent(),trecho.texto_gerado);
  await shot('01-editor-claro-1440');
  await page.getByLabel('Sua correção').focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.dataset.reviewAction),'save');
  await shot('01b-teclado-foco-claro');
  await page.getByLabel('Sua correção').fill('Correção humana persistida.');
  await page.getByRole('button',{name:'Guardar correção'}).click();
  await page.getByText('Correção guardada neste dispositivo.').waitFor();
  assert.equal(db.prepare('SELECT texto_gerado,texto_corrigido,revisao FROM notetaker_trechos WHERE id=?').get(trecho.id).texto_gerado,trecho.texto_gerado);
  assert.equal(db.prepare('SELECT texto_corrigido FROM notetaker_trechos WHERE id=?').get(trecho.id).texto_corrigido,'Correção humana persistida.');
  await page.getByText('Histórico de correções').click();
  await page.getByText('Revisão 1', {exact:false}).waitFor();
  await shot('02-sucesso-historico-claro');
  const readBack=await json(await fetch(api,{headers:{'x-assessor-token':token}}));
  assert.equal(readBack.data.textoGerado,trecho.texto_gerado);assert.equal(readBack.data.textoExibido,'Correção humana persistida.');
  assert.equal((await json(await fetch(`${api}/correcoes?limite=20`,{headers:{'x-assessor-token':token}}))).data.correcoes.length,1);
  const concurrent=await json(await fetch(api,{method:'PATCH',headers,body:JSON.stringify({texto:'Versão concorrente sintética.',revisaoEsperada:1,confirmar:true})}));
  assert.equal(concurrent.status,200);
  await page.getByLabel('Sua correção').fill('Meu rascunho após conflito.');
  await page.getByRole('button',{name:'Guardar correção'}).click();
  await page.getByRole('button',{name:'Conferir versão atual'}).waitFor();
  assert.equal(await page.getByLabel('Sua correção').inputValue(),'Meu rascunho após conflito.');
  await page.getByRole('button',{name:'Conferir versão atual'}).click();
  await page.getByText('Versão concorrente sintética.').waitFor();
  await page.setViewportSize({width:390,height:844});await shot('03-conflito-claro-390');
  await page.evaluate(()=>window.setTheme('dark'));await shot('03b-conflito-escuro-390');await page.evaluate(()=>window.setTheme('light'));
  await page.getByRole('button',{name:'Usar meu rascunho nesta versão'}).click();
  assert.equal(await page.getByLabel('Sua correção').inputValue(),'Meu rascunho após conflito.');
  await page.getByRole('button',{name:'Guardar correção'}).click();
  await page.getByText('Correção guardada neste dispositivo.').waitFor();
  assert.equal(db.prepare('SELECT revisao,texto_corrigido FROM notetaker_trechos WHERE id=?').get(trecho.id).revisao,3);
  await page.evaluate(()=>window.setTheme('dark'));
  await page.setViewportSize({width:820,height:900});await shot('04-sucesso-escuro-820');
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>document.body.style.zoom='200%');await shot('05-editor-zoom200');
  assert.equal(await page.locator('.nt-review-layout').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1,'zoom 200% deve empilhar as colunas');
  await page.evaluate(()=>document.body.style.zoom='');
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.nt-review-text').evaluate(el=>getComputedStyle(el).transitionDuration),'0s');
  await page.getByLabel('Sua correção').focus();await shot('05b-reduced-motion-foco');
  await page.waitForFunction(()=>document.querySelectorAll('.nt-review-history-item').length===3);
  const savedBefore=await page.evaluate(()=>window.saved.length);
  await page.evaluate(()=>window.holdNextResponse());
  await page.getByLabel('Sua correção').fill('Correção persistida com resposta tardia.');
  await page.getByRole('button',{name:'Guardar correção'}).click();
  await page.waitForFunction(()=>document.querySelector('.nt-review-status')?.textContent==='Guardando correção…');
  for(let i=0;i<30&&db.prepare('SELECT revisao FROM notetaker_trechos WHERE id=?').get(trecho.id).revisao!==4;i++)await new Promise(r=>setTimeout(r,50));
  assert.equal(db.prepare('SELECT revisao FROM notetaker_trechos WHERE id=?').get(trecho.id).revisao,4,'PATCH tardio alcançou o backend real');
  await page.evaluate(()=>{window.destroyReview();window.releaseHeldResponse();});
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(()=>window.saved.length),savedBefore,'resposta tardia não chamou onSaved');
  assert.equal(await page.locator('#review').textContent(),'','destruir limpou DOM');
  for(let i=0;i<21;i++){
    const patched=await json(await fetch(api,{method:'PATCH',headers,body:JSON.stringify({texto:`Versão paginada sintética ${i}.`,revisaoEsperada:4+i,confirmar:true})}));
    assert.equal(patched.status,200);
  }
  await page.evaluate(id=>window.openReview(id),trecho.id);
  await page.getByLabel('Sua correção').waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.nt-review-history-item').length===20);
  await page.getByText('Histórico de correções').click();
  await page.getByRole('button',{name:'Carregar página seguinte'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.nt-review-history-item').length===25);
  assert.equal(await page.getByRole('button',{name:'Carregar página seguinte'}).isVisible(),false);
  await writeFile(join(root,'notetaker-audio',imported.data.partes[0].id+'.wav'),Buffer.from('original-sintetico-corrompido'));
  await page.getByRole('button',{name:'Cancelar'}).click();
  await page.getByRole('button',{name:'Corrigir texto'}).click();
  await page.getByText('Áudio indisponível.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Guardar correção'}).isEnabled(),true,'correção textual segue disponível sem áudio');
  await shot('05c-original-indisponivel-escuro');
  await page.getByLabel('Sua correção').fill('Texto que será negado.');
  db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run(new Date().toISOString(),session);
  await page.getByRole('button',{name:'Guardar correção'}).click();
  await page.getByText('Este trecho não está disponível para revisão.').waitFor();
  assert.equal((await page.locator('body').textContent()).includes('Texto que será negado.'),false);
  assert.equal((await page.locator('body').textContent()).includes('Meu rascunho após conflito.'),false,'snapshot antigo deve sair do DOM');
  assert.equal((await page.locator('body').textContent()).includes('Versão paginada sintética 20.'),false,'snapshot anterior não pode permanecer no DOM após negação');
  await shot('06-direito-negado-escuro');
  await page.evaluate(()=>window.setTheme('light'));await shot('06b-direito-negado-claro');
  await page.getByRole('button',{name:'Voltar'}).click();
  assert.equal((await page.locator('body').textContent()).includes('Versão paginada sintética 20.'),false,'Voltar não reabre conteúdo negado');
  assert.equal(await page.getByRole('button',{name:'Corrigir texto'}).count(),0);
  assert.equal(await page.evaluate(()=>window.closedCalls.some(c=>c.motivo==='indisponivel')),true);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({resultado:'PASS',capturas:output,originalPreservado:true,revisaoFinal:25,apiReal:true,historicoPaginado:true,respostaTardia:true,externas:external.length,errosConsole:errors.length}));
}finally{
  if(browser)await browser.close();
  if(server)await new Promise(r=>server.close(r));
  db?.close();
  if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;
  await rm(root,{recursive:true,force:true});
}

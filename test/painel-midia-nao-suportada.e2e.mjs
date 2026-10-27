// HTTP e interface reais com perfil sintético. Não usa navegador/perfil pessoal.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {MidiaArquivos,processarUmaMidiaCiclo} from '../src/ciclo-midia-worker.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
const output=resolve(process.argv[2]||'work/midia-nao-suportada');mkdirSync(output,{recursive:true});
const dir=mkdtempSync(join(tmpdir(),'lume-pdf-ui-')),db=abrirBanco();
const contexto=new ContextoApp(db),desktop=new Desktop(db),conversa='pdf-demo@s.whatsapp.net';
desktop.aceitar({nome:'Demonstração sintética',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
contexto.receber({messages:[{key:{remoteJid:conversa,id:'pdf'},messageTimestamp:1788794100,
  message:{documentMessage:{mimetype:'application/pdf',fileName:'demanda.pdf',caption:'Relatório sintético para conferência'}}}]});
db.prepare('INSERT OR REPLACE INTO conversas_app VALUES(?,?)').run(conversa,'Cliente de demonstração');
const arquivos=new MidiaArquivos(db,new ArquivosDados(dir));
assert.equal((await processarUmaMidiaCiclo(db,{arquivos})).motivo,'tipo_nao_suportado');
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null})}});
let browser;const evidence={synthetic:true,screens:[],errors:[],external:[],api:{}};
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const path='/api/v3/conversas/cobertura-midia?conversa='+encodeURIComponent(conversa);
  evidence.api.unauthorized=(await fetch(origin+path)).status;assert.equal(evidence.api.unauthorized,403);
  const {token}=await (await fetch(origin+'/api/sessao')).json(),headers={'x-assessor-token':token};
  const response=await fetch(origin+path,{headers});assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.cobertura.bloqueadas,1);assert.equal(body.cobertura.pendentes,0);assert.equal(body.cobertura.baixadas,0);
  assert.equal(body.historico,'desconhecido');evidence.api.coverage=body.cobertura;
  assert.equal((await fetch(origin+'/api/v3/conversas/cobertura-midia?conversa=sem-acesso',{headers})).status,404);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',e=>evidence.errors.push(e.message));
  await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){evidence.external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
  await page.locator('nav [data-view=memory]').click();
  await page.getByRole('button',{name:'Abrir conversa',exact:true}).click();
  await page.locator('.conversation-history summary').click();
  await page.locator('.history-media-guidance').waitFor();
  assert.match(await page.locator('.history-media-guidance').innerText(),/Consulte o original no WhatsApp/);
  assert.match(await page.locator('.history-media-coverage').innerText(),/0 pendentes/);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    await page.locator('.history-media-guidance').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('.history-media-coverage').evaluate(n=>n.scrollWidth>n.clientWidth),false);
    const file=`pdf-intervencao-${width}.png`;await page.screenshot({path:join(output,file)});evidence.screens.push(file);
    const detail=`pdf-detalhe-${width}.png`;await page.locator('.history-media-coverage').screenshot({path:join(output,detail)});evidence.screens.push(detail);
  }
  assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.external,[]);
  writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{
  await browser?.close();server.closeAllConnections();await server.encerrar();db.close();rmSync(dir,{recursive:true,force:true});
}

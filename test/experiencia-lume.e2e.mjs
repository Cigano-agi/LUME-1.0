// Real renderer + HTTP + SQLite, isolated synthetic profile. No external calls.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {criarServidor} from '../src/painel/servidor.js';

const out='work/experiencia-lume-20261026';await mkdir(out,{recursive:true});
const db=abrirBanco(':memory:'),produto=new Desktop(db);
new ContextoApp(db);
produto.aceitar({nome:'Perfil de teste · dados fictícios',aceito:true,versao:VERSAO_TERMOS});produto.configurarGuia({dispensado:true});
const forbidden=()=>{throw Error('Rede/envio proibidos no ensaio');};
const conexao={estado:()=>({estado:'desconectada',qr:null}),enviarTexto:forbidden,parar:async()=>{}};
const chatgpt={estado:async()=>({available:false,connected:false,accounts:[]}),modelos:async()=>[],encerrar(){},responder:forbidden};
const pessoal=new LumePessoal(db,{desktop:produto,chatgpt,conexao,telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,publicar:()=>{}});
const ids=[];
for(let i=0;i<6;i++){
  const jid='55000000000'+i+'@s.whatsapp.net',nome=['Marina Exemplo','Estúdio Aurora','Rafael Exemplo'][i%3];
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(jid,nome);
  const text=['Pode revisar o catálogo da loja?','Preciso conferir a proposta do site.','A revisão foi concluída, confira os arquivos.'][i%3];
  const evento=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(jid,'ensaio-'+i,jid,text).lastInsertRowid);
  const acao=pessoal.contexto.registrarDemanda({eventoId:evento,resumo:['Revisar catálogo','Conferir proposta do site','Conferir revisão concluída'][i%3],trecho:text,tipo:'pendencia'}).acaoId;ids.push({acao,evento,jid});
  if(i===2){pessoal.contexto.acoes.revisar({id:acao,acao:'confirmar'});pessoal.contexto.acoes.revisar({id:acao,acao:'resolver'});}
  if(i===3)db.prepare('INSERT INTO desktop_config VALUES(?,?)').run('pessoal-acompanhamento:'+acao,JSON.stringify({proxima:'2026-10-28T12:00:00.000Z'}));
}
const server=criarServidor(db,{desktop:true,pessoal,conexao});
const report={synthetic:true,externalCalls:0,screens:[],errors:[],httpErrors:[],checks:[],navigation:[],started:new Date().toISOString()};let browser;
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
  await page.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(url.pathname==='/experiencia.js')await new Promise(r=>setTimeout(r,700));return route.continue();});
  const firstRequests=[];page.on('request',r=>{if(r.url().includes('/api/'))firstRequests.push(new URL(r.url()).pathname);});
  const start=performance.now();await page.goto(origin+'/app',{waitUntil:'networkidle'});await page.waitForSelector('#lv-today .lv-card');report.openingMs=performance.now()-start;
  assert.deepEqual(report.errors,[]);report.checks.push('App renderiza com HTTP/SQLite reais, sem erro de script');
  assert.equal(firstRequests.includes('/api/v3/resumo'),false,'Bootstrap deve aguardar o shell, mesmo com asset atrasado');
  for(const theme of ['light','dark']){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    for(const [route,label]of [['today','Agora'],['memory','Memória'],['sales','Comercial'],['deliveries','Entregas'],['contacts','Pessoas'],['settings','Ajustes']]){
      const t=performance.now();await page.locator('.sidebar nav [data-view='+route+']').click();await page.waitForLoadState('networkidle');
      report.navigation.push({route,theme,ms:performance.now()-t});
      assert.equal(await page.locator('.sidebar nav [aria-current=page]').count(),1);
      const path=out+'/ui-'+route+'-'+theme+'.png';await page.screenshot({path});report.screens.push(path);
    }
  }
  await page.locator('.sidebar nav [data-view=today]').click();await page.locator('#lv-today .lv-card-title button').first().click();
  await page.waitForSelector('.lv-drawer #lv-detail-title');await page.waitForFunction(()=>document.querySelector('.lv-drawer-body')?.getAttribute('aria-busy')==='false');
  assert.match(await page.locator('.lv-drawer').innerText(),/Fontes/);await page.screenshot({path:out+'/ui-assunto.png'});report.screens.push(out+'/ui-assunto.png');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.lv-drawer').count(),0);report.checks.push('Assunto revalidado abre fonte e devolve foco ao fechar');
  await page.locator('#lv-global-query').fill('catálogo');await page.locator('#lv-global-search button').click();await page.waitForLoadState('networkidle');
  assert.ok((await page.locator('#results').innerText()).includes('catálogo'));report.checks.push('Busca global recupera trecho do SQLite');
  await page.locator('#lv-memory-filters summary').click();await page.waitForFunction(()=>document.querySelector('#lv-filter-pessoa').options.length>1);
  await page.locator('#lv-filter-tipo').selectOption('audio');await page.getByRole('button',{name:'Aplicar filtros',exact:true}).click();await page.waitForLoadState('networkidle');assert.match(await page.locator('#results').innerText(),/Não encontrei/);
  await page.getByRole('button',{name:'Limpar filtros',exact:true}).click();report.checks.push('Filtros reais mudam resultados e podem ser limpos');
  await page.setViewportSize({width:1024,height:768});await page.locator('.sidebar nav [data-view=today]').click();await page.screenshot({path:out+'/ui-1024.png'});report.screens.push(out+'/ui-1024.png');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);assert.equal(overflow,false);report.checks.push('Sem overflow global em1024×768');
  assert.deepEqual(report.errors,[]);
}catch(e){report.failure=e.stack;process.exitCode=1;}finally{
  if(browser)await browser.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await pessoal.encerrar();db.close();
  report.finished=new Date().toISOString();await writeFile(out+'/e2e-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify({checks:report.checks,errors:report.errors,httpErrors:report.httpErrors,failure:report.failure||null}));
}

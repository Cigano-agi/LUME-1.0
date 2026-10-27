// Full local HTTP + SQLite renderer proof. Synthetic source content only; no external calls.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {criarServidor} from '../src/painel/servidor.js';

const out='work/lume-1-20261026/ui-integrated';await mkdir(out,{recursive:true});
const db=abrirBanco(':memory:'),desktop=new Desktop(db);new ContextoApp(db);
desktop.aceitar({nome:'Ensaio Lume 1.0 · dados sintéticos',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
let externalCalls=0;const forbidden=()=>{externalCalls++;throw Error('Chamadas externas proibidas no ensaio');};
const conexao={estado:()=>({estado:'desconectada',qr:null}),enviarTexto:forbidden,parar:async()=>{}};
const chatgpt={estado:async()=>({available:false,connected:false,accounts:[]}),modelos:async()=>[],encerrar(){},responder:forbidden};
const pessoal=new LumePessoal(db,{desktop,chatgpt,conexao,telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,publicar:()=>{}});
const group='120000000000000@g.us',person='550000000001@s.whatsapp.net';
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(group,'Ateliê Horizonte · grupo de ensaio');db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(person,'Ana Exemplo');
const ids=[];
for(let i=0;i<24;i++){
  const text=`Orçamento do catálogo: revisar a página ${i+1}. Fonte sintética de ensaio.`;
  const id=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(group,'l1-ensaio-'+i,person,text).lastInsertRowid);ids.push(id);
  if(i<4)pessoal.contexto.registrarDemanda({eventoId:id,resumo:'Revisar página '+(i+1),trecho:text,tipo:'pendencia'});
}
const personalText='Conferir proposta do catálogo. Fonte sintética.';
const personalId=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,'l1-pessoal','entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(person,person,personalText).lastInsertRowid);
const projetos=new ProjetosComerciais(db);const project=projetos.criarRascunho({nome:'Catálogo Horizonte',fontes:[{eventoId:personalId,trecho:personalText}]});
const server=criarServidor(db,{desktop:true,pessoal,conexao});let browser;
const report={synthetic:true,externalCalls:0,checks:[],screens:[],errors:[],httpErrors:[],navigation:[],started:new Date().toISOString()};
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});const page=await context.newPage();
  page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){externalCalls++;return route.abort();}return route.continue();});
  await page.goto(origin+'/app',{waitUntil:'networkidle'});await page.waitForSelector('#lv-today .lv-card');
  assert.deepEqual(await page.locator('#lv-today .lv-section-heading').allTextContents(),['Precisa de você','Em acompanhamento','Aconteceu']);for(const section of await page.locator('#lv-today .lv-board > .lv-section').all())assert.ok(await section.locator('.lv-card:visible').count()<=3);report.checks.push('Agora usa os três blocos atuais, até três itens iniciais por bloco');
  for(const theme of ['light','dark']){
    await page.locator('#l1-global-theme').selectOption(theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    for(const route of ['today','memory','sales','deliveries','contacts','settings']){
      const started=performance.now();await page.locator(`.sidebar nav [data-view=${route}]`).click();await page.waitForLoadState('networkidle');report.navigation.push({route,theme,ms:performance.now()-started});
      assert.equal(await page.locator('.sidebar nav [aria-current=page]').count(),1);const path=`${out}/${route}-${theme}.png`;await page.screenshot({path});report.screens.push(path);
    }
  }
  await page.locator('.sidebar nav [data-view=contacts]').click();const groupCard=page.locator('.l1-person').filter({has:page.getByRole('heading',{name:'Ateliê Horizonte · grupo de ensaio'})});await groupCard.waitFor();
  await groupCard.getByRole('button',{name:'Corrigir tags'}).click();await page.getByLabel('Cliente',{exact:true}).check();await page.getByRole('button',{name:'Salvar correção'}).click();await page.waitForFunction(()=>!document.querySelector('.l1-dialog'));
  assert.match(await groupCard.innerText(),/Cliente · corrigido por você/);assert.deepEqual(pessoal.organizador.tags(group).map(t=>t.valor),['cliente']);
  await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar nav [data-view=contacts]').click();await groupCard.waitFor();assert.match(await groupCard.innerText(),/Cliente · corrigido por você/);report.checks.push('Tag persistida no SQLite reaparece após recarregar o app');
  await groupCard.getByRole('button',{name:'Ver timeline'}).click();await page.waitForSelector('.l1-timeline-item');assert.equal(await page.locator('.l1-timeline-item').count(),20);
  await page.getByRole('button',{name:'Mais mensagens',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.l1-timeline-item').length===24);assert.equal(new Set(await page.locator('.l1-timeline-item').evaluateAll(rows=>rows.map(n=>n.dataset.eventId))).size,24);
  const first=page.locator('.l1-timeline-item').first();await first.locator('summary').click();await first.getByLabel('Projeto da fonte',{exact:true}).selectOption(project.id);await first.getByRole('button',{name:'Salvar vínculo'}).click();await first.getByText('Vínculo salvo.',{exact:false}).waitFor();
  await page.locator('.l1-dialog').getByLabel('Assunto',{exact:true}).fill('Orçamento');await page.locator('.l1-dialog').getByLabel('Pessoa',{exact:true}).fill('Ana Exemplo');await page.locator('.l1-dialog').getByLabel('Projeto',{exact:true}).fill('Catálogo Horizonte');await page.getByRole('button',{name:'Filtrar timeline'}).click();await page.waitForFunction(()=>document.querySelector('.l1-timeline').getAttribute('aria-busy')==='false');assert.equal(await page.locator('.l1-timeline-item').count(),1);
  const timelineShot=out+'/timeline-grupo-projeto.png';await page.screenshot({path:timelineShot});report.screens.push(timelineShot);report.checks.push('Grupo pagina 24 fontes sem duplicação; correção de projeto e três filtros consultam SQLite');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Timeline completa',exact:true}).click();await page.waitForSelector('.l1-timeline-item');assert.ok(await page.locator('.l1-timeline-item').count()>0);await page.keyboard.press('Escape');report.checks.push('Timeline completa usa fontes disponíveis em todas as conversas');
  await page.locator('#l1-global-central').click();await page.getByRole('heading',{name:'Acontecimentos locais'}).waitFor();assert.match(await page.locator('.l1-dialog').innerText(),/Nenhum comunicado disponível/);await page.screenshot({path:out+'/central.png'});report.screens.push(out+'/central.png');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#try-example,#learn-example').count(),0);await page.locator('.sidebar nav [data-view=settings]').click();await page.locator('#settings-choice-appearance').click();await page.locator('#guide-reopen').click();await page.locator('#first-use:visible').waitFor();await page.locator('#first-hide').click();await page.locator('#first-use').waitFor({state:'hidden'});report.checks.push('Demo operacional removida; guia real reabre e oculta sem referências quebradas');
  await page.locator('.sidebar nav [data-view=memory]').click();await page.getByRole('button',{name:'Relações',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#network').getAttribute('aria-busy')==='false');assert.ok(await page.locator('#graph-list button').count()>0);await page.getByRole('button',{name:'Usar lista',exact:true}).click();await page.screenshot({path:out+'/mapa-lista.png'});report.screens.push(out+'/mapa-lista.png');report.checks.push('Mapa e lista usam grafo HTTP real, seleção acessível');
  await page.setViewportSize({width:1024,height:768});await page.locator('.sidebar nav [data-view=contacts]').click();await page.screenshot({path:out+'/pessoas-1024.png'});report.screens.push(out+'/pessoas-1024.png');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.evaluate(()=>document.documentElement.style.zoom='2');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.screenshot({path:out+'/pessoas-200.png'});report.screens.push(out+'/pessoas-200.png');report.checks.push('1024×768 e escala200% sem overflow global, reduced-motion respeitado');
  const zoomContext=await browser.newContext({viewport:{width:512,height:384},deviceScaleFactor:2,reducedMotion:'reduce'}),zoomPage=await zoomContext.newPage();
  zoomPage.on('pageerror',e=>report.errors.push(e.message));await zoomPage.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){externalCalls++;return route.abort();}return route.continue();});
  await zoomPage.goto(origin+'/app',{waitUntil:'networkidle'});await zoomPage.locator('.sidebar nav [data-view=contacts]').click();await zoomPage.locator('.l1-person').first().waitFor();await zoomPage.locator('.l1-person').first().scrollIntoViewIfNeeded();assert.equal(await zoomPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await zoomPage.screenshot({path:out+'/pessoas-reflow-200.png'});report.screens.push(out+'/pessoas-reflow-200.png');await zoomPage.locator('.l1-person').first().getByRole('button',{name:'Ver timeline'}).focus();await zoomPage.keyboard.press('Enter');await zoomPage.waitForSelector('.l1-timeline-item');assert.equal(await zoomPage.evaluate(()=>document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth+1),false);await zoomPage.keyboard.press('Escape');await zoomContext.close();report.checks.push('Reflow em viewport512×384@2x, equivalente ao espaço de1024×768 a200%, com timeline pelo teclado');
  assert.equal(externalCalls,0);assert.deepEqual(report.errors,[]);assert.equal(report.httpErrors.some(e=>e.path.startsWith('/api/v3/lume-1/')||e.path==='/api/v3/pessoal/companheiro'),false);
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await pessoal.encerrar();db.close();report.finished=new Date().toISOString();report.externalCalls=externalCalls;await writeFile(out+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}

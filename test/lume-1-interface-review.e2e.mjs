// Real local HTTP/SQLite + full renderer. All identities/model answers are SYNTHETIC.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {CONTRATO_ORGANIZACAO} from '../src/pessoal/organizador.js';
import {criarServidor} from '../src/painel/servidor.js';

const out='work/lume-1-20261026/ui-review-integrated';await mkdir(out,{recursive:true});
const db=abrirBanco(':memory:'),desktop=new Desktop(db),contexto=new ContextoApp(db);
desktop.aceitar({nome:'Revisão UI · fontes sintéticas',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
const group='120000000009991@g.us',author='550000009991@s.whatsapp.net',text='Empresa Aurora decidiu revisar o catálogo. O prazo mudou e um resultado foi citado. Fonte sintética de ensaio.';
let external=0,modelCalls=0;const forbidden=()=>{external++;throw Error('External calls forbidden');};
const connection={estado:()=>({estado:'desconectada',qr:null}),enviarTexto:forbidden,parar:async()=>{}};
const answer={assuntos:[],tags:[],vinculos:[{tipo:'organizacao',nome:'Empresa Aurora',trecho:text,confianca:.97}],oportunidades:[],compromissos:[],acontecimentos:['decisao','mudanca','resultado'].map(tipo=>({tipo,resumo:'Registro sintético de '+tipo,trecho:text,confianca:.97}))};
const chatgpt={estado:async()=>({available:true,connected:true,planEnabled:true,paused:false,model:'synthetic-ui-review',accounts:[]}),modelos:async()=>[],encerrar(){},responder:async request=>{assert.equal(request.validar(),true);modelCalls++;return{completed:true,model:'synthetic-ui-review',requestId:'synthetic-ui-'+modelCalls,text:JSON.stringify(answer)};}};
const pessoal=new LumePessoal(db,{desktop,conexao:connection,chatgpt,telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao:connection,publicar:()=>{}});
const org=pessoal.organizador;
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(group,'Grupo de ensaio Aurora');db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(author,'Autora sintética');
org.politica.configurar({conversaId:group,categoria:'team',modo:'observar',remoto:true});db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,1,?)').run(group,new Date().toISOString());
org.aprovarAvaliacao({modelo:'synthetic-ui-review',total:100,acertos:100,criticos:20,errosCriticos:0,evidencia:'SYNTHETIC only; not product quality approval',revisor:'synthetic UI harness',contrato:CONTRATO_ORGANIZACAO});org.configurar({acao:'retomar'});
const id=contexto._registrarEvento({conversaId:group,origemId:'synthetic-ui-gap-source',autorId:author,direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date()},'dirigida').id;
assert.equal(await org.passo(),true);assert.equal(modelCalls,1);org.configurar({acao:'pausar'});
const projectText='Fonte sintética para a lista de projetos do ensaio.';
const projectSource=contexto._registrarEvento({conversaId:author,origemId:'synthetic-project-source',autorId:author,direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:projectText,recebidoEm:new Date()},'dirigida').id;
let beyond;
const report={synthetic:true,started:new Date().toISOString(),fixture:{events:2,projects:121,group,modelCalls,attestation:'synthetic test only',ordering:'projects seeded after initial Agora/central assertions; each project has a separate base conversation source'},checks:[],screens:[],errors:[],httpErrors:[],external:0};
const server=criarServidor(db,{desktop:true,pessoal,conexao:connection});let browser;
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1024,height:768},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.status()>=400)report.httpErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();});
  const shot=async name=>{const path=out+'/'+name+'.png';await page.screenshot({path});report.screens.push(path);};
  await page.goto(origin+'/app',{waitUntil:'networkidle'});await page.locator('#lv-today').waitFor();
  assert.match(await page.locator('#lv-today').innerText(),/Registro sintético de/);report.checks.push('Acontecimento sem compromisso aparece em Agora com fonte real');
  await page.locator('#l1-global-central').click();await page.getByRole('heading',{name:'Acontecimentos locais'}).waitFor();assert.match(await page.locator('.l1-dialog').innerText(),/Registro sintético de/);await shot('central-acontecimentos');await page.keyboard.press('Escape');
  for(let n=1;n<=121;n++)org.projetos.criarRascunho({nome:'Projeto sintético '+String(n).padStart(3,'0'),chave:'ui-review-'+n,fontes:[{eventoId:projectSource,trecho:projectText}]});
  beyond=org.projetos.listar({limite:1,offset:100})[0];assert.ok(beyond);
  await page.locator('.sidebar nav [data-view=contacts]').click();const card=page.locator('.l1-person').filter({has:page.getByRole('heading',{name:'Grupo de ensaio Aurora',exact:true})});await card.locator('.l1-organization').waitFor();assert.equal(await card.locator('.l1-entity-kind').textContent(),'Grupo');assert.match(await card.innerText(),/Empresa Aurora[\s\S]*Inferido · confira a fonte/);await card.locator('.l1-organization').scrollIntoViewIfNeeded();await shot('organizacao-claro');
  await card.getByText('Rever organização',{exact:true}).click();await card.getByLabel('Nome da organização',{exact:true}).fill('Aurora corrigida no ensaio');await card.getByRole('button',{name:'Salvar organização',exact:true}).click();await card.getByText('Aurora corrigida no ensaio',{exact:true}).waitFor();assert.equal(org.organizacoes(id)[0].origem,'manual');
  await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar nav [data-view=contacts]').click();await card.getByText('Aurora corrigida no ensaio',{exact:true}).waitFor();assert.match(await card.innerText(),/Corrigido por você/);report.checks.push('Organização corrigida por HTTP persiste no SQLite e reaparece ao recarregar sem mudar tipo Grupo');
  await page.locator('#l1-global-theme').selectOption('dark');await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await card.getByRole('button',{name:'Ver timeline',exact:true}).click();const row=page.locator('.l1-timeline-item').first();await row.locator('.l1-occurrence').first().waitFor();assert.equal(await row.locator('.l1-occurrence').count(),3);assert.match(await row.innerText(),/Decisão[\s\S]*Mudança[\s\S]*Resultado citado/);assert.doesNotMatch(await row.locator('.l1-occurrence').last().innerText(),/Resultado verificado|Envio registrado|Aceite registrado/);await row.locator('.l1-occurrence').first().scrollIntoViewIfNeeded();await shot('timeline-acontecimentos-escuro');await row.locator('.l1-occurrence').last().scrollIntoViewIfNeeded();await shot('timeline-resultado-citado');
  await row.locator('.l1-occurrence').last().getByRole('button',{name:'Conferir fonte',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#results')?.textContent.includes('Empresa Aurora decidiu'));report.checks.push('Pessoas → timeline → acontecimento/fonte em3ações; fonte recarregada pelo endpoint real');
  await page.locator('.sidebar nav [data-view=contacts]').click();await card.getByRole('button',{name:'Ver timeline',exact:true}).click();await row.waitFor();await row.getByText('Corrigir projeto',{exact:true}).click();await row.getByLabel('Projeto da fonte',{exact:true}).waitFor();assert.equal(await row.locator('select option').count(),21);
  for(let pageNumber=2;pageNumber<=6;pageNumber++){await row.getByRole('button',{name:'Mais projetos',exact:true}).click();await page.waitForFunction(count=>document.querySelector('.l1-timeline-item select').options.length===count,pageNumber*20+1);}
  assert.equal(await row.locator('select option').evaluateAll((options,id)=>options.some(o=>o.value===id),beyond.id),true);await row.getByLabel('Projeto da fonte',{exact:true}).selectOption(beyond.id);
  await row.getByLabel('Buscar projeto por nome',{exact:true}).fill(beyond.nome);await row.getByRole('button',{name:'Buscar projetos',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.l1-timeline-item select').options.length===2);await row.getByLabel('Projeto da fonte',{exact:true}).selectOption(beyond.id);await row.getByRole('button',{name:'Salvar vínculo',exact:true}).click();await row.getByText('Vínculo salvo.',{exact:false}).waitFor();assert.equal(org.correcoesVinculo(id)[0].projetoId,beyond.id);await shot('projeto-alem-100');report.checks.push('Seis páginas reais alcançam item101; busca encontra o mesmo projeto e vínculo é persistido por HTTP');
  await row.getByText('Rever organização',{exact:true}).click();await row.getByRole('button',{name:'Remover vínculo de organização',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.l1-timeline-item .l1-organization').length===0);assert.deepEqual(org.organizacoes(id),[]);assert.equal(db.prepare('SELECT count(*) n FROM eventos').get().n,2);report.checks.push('Remover organização retira só vínculo do trecho; fonte preservada e nova leitura não restaura sugestão');
  await page.keyboard.press('Escape');await page.locator('#l1-global-theme').selectOption('light');await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await page.setViewportSize({width:512,height:384});await card.getByRole('button',{name:'Ver timeline',exact:true}).focus();await page.keyboard.press('Enter');await row.locator('.l1-occurrence').first().waitFor();assert.equal(await page.evaluate(()=>document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth+1),false);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await row.locator('.l1-occurrence').first().scrollIntoViewIfNeeded();await shot('timeline-reflow-200');await page.keyboard.press('Escape');report.checks.push('Reflow512×384, espaço equivalente1024×768 a200%, sem overflow e abertura/fechamento por teclado; reduced-motion');
  assert.equal(external,0);assert.deepEqual(report.errors,[]);assert.equal(report.httpErrors.some(e=>e.path!=='/api/v3/novidades'),false);
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await pessoal.encerrar();db.close();report.finished=new Date().toISOString();report.external=external;await writeFile(out+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}

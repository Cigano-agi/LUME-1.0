// Full renderer + real local HTTP/SQLite. Only model answers and conversations are synthetic.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {CONTRATO_ORGANIZACAO} from '../src/pessoal/organizador.js';
import {Novidades} from '../src/novidades.js';
import {criarServidor} from '../src/painel/servidor.js';
if(!process.argv.includes('--run')){console.log('PREPARADO. Use --run para HTTP/SQLite e browser isolado com fontes/modelo sintéticos.');process.exit(0);}
const out='work/lume-auto-20261028/ui-'+Date.now();await mkdir(out,{recursive:true});
const db=abrirBanco(':memory:'),desktop=new Desktop(db),contexto=new ContextoApp(db);
desktop.aceitar({nome:'Auto-organização · ensaio sintético',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
let external=0,modelCalls=0;const forbidden=()=>{external++;throw Error('External call forbidden in synthetic UI QA');};
const conexao={estado:()=>({estado:'desconectada',qr:null}),enviarTexto:forbidden,parar:async()=>{}};
const model='synthetic-auto-ui';
const chatgpt={estado:async()=>({available:true,connected:true,planEnabled:true,paused:false,model,accounts:[]}),modelos:async()=>[],encerrar(){},responder:async request=>{
  assert.equal(request.validar(),true);modelCalls++;const input=JSON.parse(request.input[0].content),trecho=input.texto;
  const answer={assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]};
  if(trecho.startsWith('Sobre')){const nome=trecho.includes('Catálogo')?'Catálogo Aurora':'Feira Horizonte';answer.assuntos=[{nome,trecho,confianca:.98}];answer.vinculos=[{tipo:'projeto',nome,trecho,confianca:.98}];answer.oportunidades=[{resumo:nome,trecho,confianca:.98,temperatura:nome.startsWith('Catálogo')?'quente':'frio',etapa:'conversa',motivo:nome.startsWith('Catálogo')?'Comprador aceita o próximo passo citado.':'Comprador recusa explicitamente este assunto.'}];}
  else{assert.equal(input.projetos.length,2);answer.perguntas=[{pergunta:'Este assunto é de qual projeto?',trecho,confianca:.98,projetoIds:input.projetos.map(p=>p.id)}];}
  return {completed:true,model,requestId:'synthetic-auto-'+modelCalls,text:JSON.stringify(answer)};
}};
const pessoal=new LumePessoal(db,{desktop,conexao,chatgpt,telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,publicar(){}});
const novidades=new Novidades(db,{versao:'3.2.0-beta.9',buscar:forbidden});
const org=pessoal.organizador,group='120000000008881@g.us',author='550000008881@s.whatsapp.net';
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(group,'Grupo de ensaio · dois assuntos');db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(author,'Compradora sintética');
org.aprovarAvaliacao({modelo:model,total:100,acertos:100,criticos:20,errosCriticos:0,evidencia:'SYNTHETIC UI only — not semantic acceptance',revisor:'synthetic harness',contrato:CONTRATO_ORGANIZACAO});org.configurar({acao:'pausar'});
const report={synthetic:true,started:new Date().toISOString(),conditions:'HTTP/SQLite in memory, synthetic model, no real account/profile; browser DOM only',checks:[],screens:[],errors:[],httpErrors:[],posts:[]};
const server=criarServidor(db,{desktop:true,pessoal,conexao,novidades});let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>report.errors.push(error.message));page.on('response',response=>{if(response.status()>=400)report.httpErrors.push({path:new URL(response.url()).pathname,status:response.status()});});
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/v3/lume-1/organizacao'))report.posts.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external++;return route.abort();}return route.continue();});
  const shot=async name=>{const path=out+'/'+name+'.png';await page.screenshot({path});report.screens.push(path);};
  const go=async view=>{await page.locator('.sidebar nav [data-view='+view+']').click();await page.waitForLoadState('networkidle');const id={today:'lv-today',sales:'lv-sales',deliveries:'lv-deliveries',contacts:'l1-people'}[view];if(id)await page.waitForFunction(id=>document.getElementById(id)?.getAttribute('aria-busy')==='false',id);};
  await page.goto(origin+'/app',{waitUntil:'networkidle'});await page.locator('.la-coverage').waitFor();assert.equal(org.escopo().tipo,'autorizadas');assert.equal(report.posts.length,0);
  await page.getByText('Ver cobertura e controles',{exact:true}).click();await page.getByText('Conversas que o Lume organiza',{exact:true}).click();
  await shot('escopo-consentimento-claro');await page.locator('.la-consent input').check();await page.getByRole('button',{name:'Organizar todas as conversas',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.la-coverage-summary')?.textContent.includes('atuais e futuras'));
  assert.equal(org.escopo().tipo,'todas');assert.deepEqual(report.posts[0].body,{escopo:'todas',confirmar:true});report.checks.push('Escopo não ativa no carregamento; opt-in explícito por HTTP persiste em SQLite, sem autorização de envio');
  org.configurar({acao:'retomar'});
  const seed=async(text,key)=>{const id=contexto._registrarEvento({conversaId:group,origemId:key,autorId:author,direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date()},'dirigida').id;assert.equal(await org.passo(),true);return id;};
  const catalogSource=await seed('Sobre o Catálogo Aurora, quero contratar e aceito revisar a proposta amanhã. Fonte sintética de QA.','auto-catalogo');
  await seed('Sobre a Feira Horizonte, não quero contratar esse trabalho. Fonte sintética de QA.','auto-feira');
  for(let i=1;i<=4;i++)await seed('Vamos revisar essa parte do trabalho '+i+' amanhã? Fonte ambígua sintética de QA.','auto-question-'+i);
  org.configurar({acao:'pausar'});assert.equal(org.perguntas().length,4);assert.equal(org.projetos.listar().length,2);
  await page.locator('#lv-today').getByRole('button',{name:'Atualizar',exact:true}).click();await page.locator('.la-question').first().waitFor();assert.equal(await page.locator('.la-question').count(),3);await shot('agora-perguntas-claro');
  const first=org.perguntas()[0];await page.locator('.la-question').first().getByRole('button',{name:first.opcoes[0].nome,exact:true}).click();await page.waitForFunction(id=>!document.querySelector('[data-question-id="'+id+'"]'),first.id);
  assert.equal(org.vinculoManual(first.eventoId).projetoId,first.opcoes[0].projetoId);report.checks.push('Pergunta responde com um botão, vínculo manual persistido por trecho, sem formulário de criação');
  const second=org.perguntas()[0];await page.locator('.la-question').first().getByRole('button',{name:'Adiar',exact:true}).click();await page.waitForFunction(id=>!document.querySelector('[data-question-id="'+id+'"]'),second.id);assert.equal(org.config('pergunta:'+second.id).estado,'adiada');
  await page.reload({waitUntil:'networkidle'});assert.equal(org.perguntas().some(q=>q.id===first.id||q.id===second.id),false);report.checks.push('Resposta e adiamento sobrevivem ao reload da interface');
  await go('sales');await page.locator('#lv-sales .la-interest').first().waitFor();assert.equal(await page.locator('#lv-sales [data-temperature=quente]').count(),1);assert.equal(await page.locator('#lv-sales [data-temperature=frio]').count(),1);await shot('vendas-interesses-claro');
  await go('deliveries');assert.match(await page.locator('#lv-deliveries').innerText(),/Catálogo Aurora/);assert.match(await page.locator('#lv-deliveries').innerText(),/Feira Horizonte/);await shot('projetos-automaticos-claro');
  await go('contacts');const card=page.locator('.l1-person').filter({has:page.getByRole('heading',{name:'Grupo de ensaio · dois assuntos',exact:true})});await card.locator('.la-person-interest').first().waitFor();assert.equal(await card.locator('.la-person-interest').count(),2);assert.equal(await card.locator('.l1-entity-kind').textContent(),'Grupo');await card.locator('.la-person-interests').scrollIntoViewIfNeeded();await shot('pessoas-assuntos-claro');
  const interest=card.locator('.la-person-interest').filter({has:page.getByRole('heading',{name:'Catálogo Aurora',exact:true})});await interest.getByRole('button',{name:'Conferir fonte',exact:true}).click();await page.waitForFunction(()=>document.getElementById('results')?.textContent.includes('quero contratar'));assert.equal(catalogSource>0,true);report.checks.push('Pessoas preserva Grupo e dois interesses distintos; fonte real HTTP acessível em2ações desde navegação');
  await go('contacts');await card.locator('.la-project-links').getByRole('button',{name:'Feira Horizonte',exact:true}).click();await page.locator('.l1-timeline-item').first().waitFor();assert.equal(await page.locator('.l1-dialog input[name=projeto]').inputValue(),org.projetos.listar().find(p=>p.nome==='Feira Horizonte').id);await shot('timeline-projeto-claro');await page.keyboard.press('Escape');
  await page.locator('#l1-global-theme').selectOption('dark');await go('today');await page.locator('.la-question').first().waitFor();await shot('agora-perguntas-escuro');
  await page.setViewportSize({width:1024,height:768});await go('contacts');await card.locator('.la-person-interest').first().waitFor();await card.locator('.la-person-interests').scrollIntoViewIfNeeded();await shot('pessoas-escuro-1024');
  await page.setViewportSize({width:512,height:384});await go('today');await page.locator('.la-question').first().waitFor();const source=page.locator('.la-question').first().getByRole('button',{name:'Conferir fonte'}),questionExcerpt=await page.locator('.la-question').first().locator('blockquote').textContent();await source.focus();await shot('pergunta-escuro-reflow-200');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await page.keyboard.press('Enter');await page.waitForFunction(text=>document.getElementById('results')?.textContent.includes(text),questionExcerpt);report.checks.push('Teclado/reduced-motion e reflow equivalente1024×768 a200%; sem overflow horizontal');
  await page.setViewportSize({width:1024,height:768});await go('sales');const sale=page.locator('#lv-sales .lv-card').filter({has:page.locator('[data-temperature=quente]')});await sale.getByRole('button',{name:/Abrir assunto:/}).click();await page.getByText('Corrigir avaliação deste assunto',{exact:true}).click();await page.getByLabel('Interesse neste assunto',{exact:true}).selectOption('morno');await page.getByRole('button',{name:'Salvar minha avaliação',exact:true}).click();await page.locator('.lv-drawer [data-temperature=morno]').waitFor();assert.equal(org.avaliacao(catalogSource).origem,'manual');assert.equal(org.avaliacao(catalogSource).temperatura,'morno');await shot('interesse-corrigido-escuro');await page.keyboard.press('Escape');await page.reload({waitUntil:'networkidle'});assert.equal(org.avaliacao(catalogSource).temperatura,'morno');report.checks.push('Correção de interesse por trecho usa HTTP real e prevalece após reload; não confirma negócio nem envio');
  assert.equal(external,0);assert.deepEqual(report.errors,[]);assert.deepEqual(report.httpErrors,[]);report.status='passed';
}catch(error){report.failure=error.stack;report.status='failed';process.exitCode=1;}
finally{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await pessoal.encerrar();db.close();report.modelCalls=modelCalls;report.external=external;report.finished=new Date().toISOString();await writeFile(out+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}

import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

// Synthetic contracts in an isolated DOM. No real profile, account or model.
const source=await readFile(new URL('../src/painel/lume-1-interface.js',import.meta.url),'utf8');
const experience=await readFile(new URL('../src/painel/experiencia.js',import.meta.url),'utf8');
const css=await readFile(new URL('../src/painel/experiencia.css',import.meta.url),'utf8')+'\n'+await readFile(new URL('../src/painel/lume-auto.css',import.meta.url),'utf8');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
async function setup(t){
  const page=await browser.newPage({viewport:{width:1024,height:768},reducedMotion:'reduce'});t.after(()=>page.close());
  await page.setContent('<head><link id="lume-auto-style"></head><body class="lume-vivo"><main><section id="today"></section><section id="sales"></section><section id="deliveries"></section><section id="contacts"></section></main></body>');
  await page.addStyleTag({content:css});
  await page.evaluate(()=>{
    window.calls=[];window.sources=[];window.hold=false;window.pending=[];
    window.org={estado:'pausado',processados:3,pendentes:4,historicoCompleto:false,limitacao:'avaliacao_pendente',escopo:{tipo:'autorizadas',conversasElegiveis:2,gruposElegiveis:1,exclusoes:1},perguntas:Array.from({length:4},(_,i)=>({id:'q'+i,eventoId:i+1,trecho:'Trecho sintético do assunto '+i,pergunta:'Este assunto é do Catálogo ou da Feira?',opcoes:[{projetoId:'catalogo',nome:'Catálogo sintético'},{projetoId:'feira',nome:'Feira sintética'}]}))};
    window.people=[{id:'grupo@g.us',nome:'Grupo sintético',tipo:'grupo',tags:[],projetos:[{id:'catalogo',nome:'Catálogo sintético'},{id:'feira',nome:'Feira sintética'}],interesses:[{nome:'Catálogo sintético',projetoId:'catalogo',temperatura:'quente',motivo:'Pedido explícito no recorte.',eventoId:1},{nome:'Feira sintética',projetoId:'feira',temperatura:'frio',motivo:'Interesse distinto neste assunto.',eventoId:2}]}];
    window.items=[];
    window.lumeConnectionRequest=async(path,body)=>{
      window.calls.push({path,body});
      if(window.failure)throw Object.assign(new Error('Fonte indisponível'),{status:403});
      if(window.hold&&path.endsWith('/central'))await new Promise(resolve=>window.pending.push(resolve));
      if(path.endsWith('/central'))return {organizacao:structuredClone(window.org),acontecimentos:[],comunicados:[]};
      if(path.endsWith('/organizacao/escopo')){window.org.escopo.tipo=body.escopo;return {ok:true};}
      if(path.endsWith('/organizacao/pergunta')){window.org.perguntas=window.org.perguntas.filter(q=>q.id!==body.id);return {ok:true};}
      if(path.endsWith('/organizacao/temperatura'))return {ok:true};
      if(path.includes('/pessoas?'))return {pessoas:window.people,lacunas:[],proximaPagina:null};
      if(path.includes('/timeline?'))return {itens:[],lacunas:[]};
      if(path.startsWith('/api/v3/experiencia'))return {versao:1,itens:window.items,atualizadoEm:new Date().toISOString(),lacunas:[]};
      throw Error('Unexpected synthetic endpoint: '+path);
    };
    window.abrirFonteTarefa=id=>window.sources.push(id);
  });
  await page.addScriptTag({content:experience});await page.addScriptTag({content:source});return page;
}
async function load(page,view='today'){await page.evaluate(view=>LumeVivo.carregar(view),view);await page.locator('.la-coverage').first().getByText('Ver cobertura e controles',{exact:true}).waitFor();}

test('escopo não é ativado ao carregar e requer escolha explícita com consentimento',async t=>{
  const page=await setup(t);await load(page);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.body).length),0);
  await page.getByText('Ver cobertura e controles',{exact:true}).click();await page.getByText('Conversas que o Lume organiza',{exact:true}).click();
  const consent=page.getByRole('checkbox');assert.match(await page.locator('.la-consent').innerText(),/ChatGPT[\s\S]*atuais e futuras[\s\S]*grupos[\s\S]*exclusões[\s\S]*não autoriza enviar/);
  await page.getByRole('button',{name:'Organizar todas as conversas',exact:true}).click();assert.equal(await page.evaluate(()=>calls.filter(c=>c.body).length),0);
  await consent.check();await page.getByRole('button',{name:'Organizar todas as conversas',exact:true}).click();
  await page.waitForFunction(()=>window.org.escopo.tipo==='todas');
  assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.path.endsWith('/escopo')).body),{escopo:'todas',confirmar:true});
  assert.match(await page.locator('.la-coverage-summary').innerText(),/atuais e futuras/);
});
test('até três perguntas com resposta curta, fonte e adiar; releitura substitui a pergunta persistida',async t=>{
  const page=await setup(t);await load(page);assert.equal(await page.locator('.la-question').count(),3);
  await page.locator('.la-question').first().getByRole('button',{name:'Conferir fonte'}).click();assert.deepEqual(await page.evaluate(()=>sources),[1]);
  await page.locator('.la-question').first().getByRole('button',{name:'Catálogo sintético',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-question-id=q0]'));
  assert.equal(await page.locator('.la-question').count(),3);assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.path.endsWith('/pergunta')).body),{id:'q0',projetoId:'catalogo'});
  await page.locator('.la-question').first().getByRole('button',{name:'Adiar',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-question-id=q1]'));
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.path.endsWith('/pergunta')).at(-1).body),{id:'q1',adiar:true});
});
test('Pessoas mantém dois interesses por assunto e abre projeto com filtro e fonte corretos',async t=>{
  const page=await setup(t);await page.evaluate(()=>LumeUm.pessoas());
  assert.equal(await page.locator('.l1-person').count(),1);assert.equal(await page.locator('.la-person-interest').count(),2);
  assert.equal(await page.locator('.la-person-interest [data-temperature=quente]').count(),1);assert.equal(await page.locator('.la-person-interest [data-temperature=frio]').count(),1);
  await page.locator('.la-person-interest').last().getByRole('button',{name:'Conferir fonte'}).click();assert.deepEqual(await page.evaluate(()=>sources),[2]);
  await page.locator('.la-project-links').getByRole('button',{name:'Feira sintética'}).click();
  const path=await page.evaluate(()=>calls.find(c=>c.path.includes('/timeline?')).path);const params=new URL(path,'http://local').searchParams;assert.equal(params.get('projeto'),'feira');assert.equal(params.get('conversa'),'grupo@g.us');
});
test('interesse incerto, ausente ou desatualizado não fica quente; enums válidos têm texto além de cor',async t=>{
  const page=await setup(t);const values=await page.evaluate(()=>{
    return [{temperatura:'quente',desatualizada:true},{temperatura:'quente',incerta:true},{},...['frio','morno','quente'].map(temperatura=>({temperatura}))].map(item=>{const node=LumeUm.interesse(item);return {value:node.dataset.temperature,text:node.textContent};});
  });assert.deepEqual(values.map(v=>v.value),['insuficiente','insuficiente','insuficiente','frio','morno','quente']);for(const item of values)assert.match(item.text,/Interesse:/);
});
test('invalidação remove perguntas e rejeita resposta tardia sem restaurar conteúdo',async t=>{
  const page=await setup(t);await load(page);await page.evaluate(()=>window.dispatchEvent(new Event('lume:invalidate')));assert.equal(await page.locator('.la-question').count(),0);
  await page.evaluate(()=>{window.hold=true;void LumeVivo.carregar('today');});await page.waitForFunction(()=>pending.length>0);
  await page.evaluate(()=>{window.dispatchEvent(new Event('lume:invalidate'));pending.forEach(resolve=>resolve());});await page.waitForTimeout(50);assert.equal(await page.locator('.la-question').count(),0);
});
test('Projetos expõe cobertura sem exigir formulário e preparação não pede classificação manual',async t=>{
  const page=await setup(t);await load(page,'deliveries');assert.equal(await page.locator('.la-question').count(),0);assert.match(await page.locator('.la-coverage').innerText(),/Organização ainda em preparação/);
  assert.equal(await page.locator('.la-scope-form:visible').count(),0);assert.doesNotMatch(await page.locator('.la-coverage').innerText(),/100 classificações|avalie 100/);
});
test('correção de interesse guarda somente trecho avaliado e nunca confirma negócio ou envio',async t=>{
  const page=await setup(t);await page.evaluate(()=>{const root=document.createElement('section');root.id='correction-test';document.body.append(root);LumeUm.reverInteresse({temperatura:'quente',etapa:'proposta',fontes:[{eventoId:42,trecho:'Trecho sintético específico do orçamento.'}]},root,{valid:()=>root.isConnected,refresh:async()=>{window.refreshed=true;}});});
  await page.getByText('Corrigir avaliação deste assunto',{exact:true}).click();await page.getByLabel('Interesse neste assunto',{exact:true}).selectOption('morno');await page.getByLabel('Etapa avaliada neste assunto',{exact:true}).selectOption('conversa');await page.getByRole('button',{name:'Salvar minha avaliação',exact:true}).click();await page.waitForFunction(()=>window.refreshed===true);
  assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.path.endsWith('/temperatura')).body),{eventoId:42,trecho:'Trecho sintético específico do orçamento.',temperatura:'morno',etapa:'conversa'});
  assert.match(await page.locator('#correction-test').innerText(),/Não confirma uma venda nem autoriza envio/);
});

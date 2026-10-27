// Renderer/HTTP reais e banco isolado; somente dados fictícios, sem inferência.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
const out='work/beta06-conversation-actions';mkdirSync(out,{recursive:true});
const db=abrirBanco(':memory:'),f=perfilGrafo(db),actions=new AcoesLume(db);
f.desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});f.desktop.configurarGuia({dispensado:true});
function seed(conversa,nome,trechos){
  f.conversa(conversa,nome);actions.autorizar({conversa,permitida:true});
  const eventoId=f.evento(conversa,'ana',{texto:trechos.join(' '),permissao:'dirigida'});
  actions.registrar({eventoId,candidatas:trechos.map(trecho=>({fonte:'E'+eventoId,tipo:'pendencia',resumo:trecho,trecho,prazo_citado:''}))});
  return {eventoId,items:actions.listar({conversa,limite:100})};
}
const principal='ana%_exata',nome='Ana · teste de ações';
const own=seed(principal,nome,['Preparar contrato do site Aurora.','Confirmar reunião de revisão com Ana.']);
actions.revisar({id:own.items[0].id,acao:'confirmar'});
for(let c=0;c<5;c++){
  const other=seed('outra-'+c,'Outra conversa '+c,Array.from({length:25},(_,i)=>`Conferir item externo ${c}-${i}.`));
  for(const item of other.items)actions.revisar({id:item.id,acao:'confirmar'});
}
db.prepare("UPDATE lume_acoes SET atualizada_em='2099-01-01T00:00:00.000Z' WHERE evento_id<>?").run(own.eventoId);
assert.equal(actions.listar({estado:'ativos',limite:100}).some(a=>a.conversa_id===principal),false);
let provider=0;const errors=[],external=[],requests=[],screens=[],checks=[];
const forbidden=async()=>{provider++;throw Error('Provider forbidden');};
const server=criarServidor(db,{contexto:f.contexto,desktop:true,gerarIA:forbidden,avaliarJev:forbidden,conexao:{estado:()=>({estado:'desconectada',qr:null}),iniciar:forbidden,parar:async()=>{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(12000);
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>{const u=route.request().url();if(!u.startsWith(origin)){external.push(u);return route.abort();}if(u.includes('/api/v3/acoes?'))requests.push(new URL(u).search);return route.continue();});
const card=()=>page.locator('.conversation-card').filter({hasText:nome});
const count=async n=>page.waitForFunction(n=>[...document.querySelectorAll('.conversation-summary>div')].some(e=>e.querySelector('dt')?.textContent==='ações abertas'&&e.querySelector('dd')?.textContent===String(n)),n);
const open=async()=>{
  await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();
  if(await page.locator('#conversation-detail').isVisible())await page.locator('#conversation-detail').getByRole('button',{name:'Voltar à lista',exact:true}).click();
  await page.locator('#conversation-name').fill('Ana');await page.locator('#conversation-filter').selectOption('acoes');await page.locator('#conversation-filters button').click();
  await card().getByRole('button',{name:'Abrir conversa',exact:true}).click();await count(actions.listar({estado:'ativos',conversa:principal}).length);
  await page.waitForFunction(()=>document.querySelector('#conversation-detail')?.getAttribute('aria-busy')==='false');
};
const shot=async name=>{
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,name);
  await page.screenshot({path:`${out}/${name}.png`,fullPage:true});screens.push(name+'.png');
};
try{
  await page.goto(origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();
    await page.locator('#conversation-name').fill('Ana');await page.locator('#conversation-filter').selectOption('acoes');await page.locator('#conversation-filters button').click();
    await card().getByText('2 ações',{exact:true}).waitFor();await shot('lista-'+width);
    await card().getByRole('button',{name:'Abrir conversa',exact:true}).click();await count(2);
    await page.waitForFunction(()=>document.querySelectorAll('.conversation-agreements .acoes06-card').length===2);
    assert.equal(await page.locator('.conversation-tasks').count(),0);
    assert.doesNotMatch(await page.locator('#conversation-detail').innerText(),/Nenhuma ação aberta/);
    await page.waitForFunction(()=>document.activeElement.id==='conversation-heading');await shot('duas-acoes-'+width);
    await page.locator('#conversation-detail').getByRole('button',{name:'Voltar à lista',exact:true}).click();
  }
  checks.push('lista, filtro e detalhe = 2 apesar de 125 ações alheias','390/1440 sem overflow e sem seção vazia contraditória');
  await open();
  await page.locator('.conversation-agreements').getByRole('button',{name:'Conferir fonte E'+own.eventoId,exact:true}).first().click();
  await page.waitForFunction(id=>document.querySelector('#search-context')?.textContent.startsWith('Fonte E'+id+' ·')&&document.querySelectorAll('#results .source').length===1,own.eventoId);
  assert.match(await page.locator('#results .source').innerText(),/Preparar contrato do site Aurora/);checks.push('fonte real acessível');
  // Voltar ao modo de conversas conserva a conversa selecionada.
  await page.locator('#memory-mode-conversations').click();await count(2);
  await page.locator('.conversation-agreements').getByRole('button',{name:'Resolvida',exact:true}).click();await count(1);
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-agreements .acoes06-card').length===1&&document.activeElement.id==='conversation-heading');
  const remaining=actions.listar({estado:'ativos',conversa:principal})[0];
  await page.locator('.conversation-agreements input[type=datetime-local]').fill('2099-01-01T10:00');
  await page.locator('.conversation-agreements').getByRole('button',{name:'Estacionar',exact:true}).click();await count(0);
  await page.locator('#conversation-detail').getByText('Nenhuma ação aberta.',{exact:true}).waitFor();await shot('vazio-390');
  checks.push('resolver e estacionar atualizam contador/fichas/vazio e devolvem foco');

  // A mensagem original não muda; reabrir a ação estacionada é um gesto explícito.
  actions.revisar({id:remaining.id,acao:'confirmar'});
  await page.evaluate(()=>window.carregarConversas());await count(1);
  const origem=db.prepare('SELECT origem_id FROM eventos WHERE id=?').get(own.eventoId).origem_id;
  db.prepare("INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em) VALUES(?,?,'pendencia',?,'2026-09-26')").run(principal,origem,remaining.resumo);
  await page.evaluate(()=>window.carregarConversas());await count(2);
  await page.getByRole('heading',{name:'Outras ações registradas',exact:true}).waitFor();
  assert.equal(await page.locator('.conversation-action').count(),1);assert.equal(await page.locator('.conversation-agreements .acoes06-card').count(),1);
  await shot('registros-preservados-390');checks.push('resumos iguais preservam dois registros com fontes próprias');
  const legacyId=db.prepare('SELECT id FROM itens_crm WHERE conversa_id=?').get(principal).id;f.desktop.resolver({id:legacyId});
  await page.evaluate(()=>window.carregarConversas());await count(1);

  const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética ao consultar ações'})});
  const selectedQuery=url=>url.pathname==='/api/v3/acoes'&&url.searchParams.get('conversa')===principal;
  await page.route(selectedQuery,fail);await page.evaluate(()=>window.carregarConversas());
  await page.locator('#conversation-detail').getByRole('button',{name:'Tentar novamente'}).waitFor();
  assert.equal(await page.locator('.conversation-agreements .acoes06-card').count(),0);await shot('erro-390');
  await page.unroute(selectedQuery,fail);await page.locator('#conversation-detail').getByRole('button',{name:'Tentar novamente'}).click();await count(1);
  await page.locator('.conversation-agreements .acoes06-card').waitFor();checks.push('erro elimina conteúdo antigo e permite tentar novamente');

  // Retorno tardio de mutação após navegar não deve redesenhar/focar Conversas.
  let releaseMutation,startedMutation;
  const mutationStarted=new Promise(r=>startedMutation=r),mutationHeld=new Promise(r=>releaseMutation=r);
  const delayMutation=async route=>{const response=await route.fetch();startedMutation();await mutationHeld;await route.fulfill({response});};
  await page.route('**/api/v3/acoes/revisar',delayMutation);
  await page.locator('.conversation-agreements').getByRole('button',{name:'Resolvida',exact:true}).click();await mutationStarted;
  await page.locator('nav [data-view=settings]').click();await page.locator('nav [data-view=settings]').focus();
  const detailsBefore=await page.locator('#conversation-detail').textContent();
  const reply=page.waitForResponse(r=>r.url().endsWith('/api/v3/acoes/revisar'));
  releaseMutation();await reply;await page.getByText('Ação atualizada.',{exact:true}).waitFor();
  assert.equal(await page.locator('#memory').isVisible(),false);
  assert.equal(await page.locator('nav [data-view=settings]').evaluate(e=>e===document.activeElement),true);
  assert.equal(await page.locator('#conversation-detail').textContent(),detailsBefore);
  await page.unroute('**/api/v3/acoes/revisar',delayMutation);checks.push('resposta tardia da revisão preserva tela e foco após navegação');

  actions.revisar({id:remaining.id,acao:'reabrir'});await open();await count(1);
  let release,started;const began=new Promise(r=>started=r),held=new Promise(r=>release=r);
  const delay=async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});};
  await page.route(selectedQuery,delay);
  const pending=page.evaluate(()=>window.carregarConversas());await began;
  actions.autorizar({conversa:principal,permitida:false});await page.evaluate(()=>window.limparDadosVisiveis());
  release();await pending;assert.equal(await page.locator('#conversation-detail').innerText(),'');
  await page.unroute(selectedQuery,delay);checks.push('revogação limpa resposta de ações em trânsito');
  actions.autorizar({conversa:principal,permitida:true});
  await page.locator('nav [data-view=memory]').click();await page.locator('#memory-mode-conversations').click();
  await page.locator('#conversation-name').fill('Ana');await page.locator('#conversation-filter').selectOption('acoes');await page.locator('#conversation-filters button').click();
  await page.getByText('Nenhuma conversa neste filtro.',{exact:true}).waitFor();
  checks.push('reativação não restaura ações antigas no filtro');
  assert.ok(requests.some(q=>new URLSearchParams(q).get('conversa')===principal));
  assert.equal(provider,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const paths=['src/acoes-lume.js','src/conversas-desktop.js','src/painel/acoes.js','src/painel/conversas.js','src/painel/servidor.js'];
  const hashes=Object.fromEntries(paths.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
  const evidence={date:new Date().toISOString(),synthetic:true,passed:true,checks,widths:[390,1440],reducedMotion:true,provider,external,errors,otherActions:125,requests,hashes,screens};
  writeFileSync(out+'/evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}

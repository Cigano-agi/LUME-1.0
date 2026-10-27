import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';

// Synthetic boundary tests, isolated browser. These are not real-profile acceptance.
const script=await readFile(new URL('../src/painel/lume-1-interface.js',import.meta.url),'utf8');
const css=await readFile(new URL('../src/painel/experiencia.css',import.meta.url),'utf8');
const output='work/lume-1-20261026/ui-synthetic';
let browser;
before(async()=>{await mkdir(output,{recursive:true});browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
async function setup(t){
  const page=await browser.newPage({viewport:{width:1024,height:768},reducedMotion:'reduce'});const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[]);});
  await page.setContent('<body class="lume-vivo"><main><form id="lv-global-search"><input aria-label="Busca global"></form><div id="lv-memory-tools"></div><section id="contacts"></section><section id="graph"><form id="graph-filters"></form><div class="graph-panel"><svg id="network" aria-busy="false"></svg></div><div id="graph-count"></div><div id="graph-list"></div></section></main></body>');
  await page.addStyleTag({content:css});
  await page.evaluate(()=>{
    window.calls=[];window.openedSources=[];window.fail=null;window.pending=[];window.hold=false;
    window.prefs={som:false,tema:'system',enabled:false,disponivel:true};
    window.LumePreferencias={estado:()=>({...window.prefs}),carregar:async()=>{},atualizar:async patch=>{window.calls.push({path:'preferences',body:patch});Object.assign(window.prefs,patch);window.dispatchEvent(new Event('lume:preferences'));}};
    window.people=[{id:'group@g.us',nome:'Grupo sintético',tipo:'grupo',tags:[{valor:'cliente',origem:'sugerido',fontes:[{eventoId:1}]}]},{id:'person@s.whatsapp.net',nome:'Pessoa sintética',tipo:'pessoa',tags:[]}];
    window.rows=[{id:1,autor:'Autora sintética',texto:'Trecho sintético de orçamento.',recebidoEm:'2026-10-26T12:00:00Z',conversa:'Grupo sintético',tipo:'texto',fonte:{eventoId:1},assuntos:['Orçamento'],projetos:[{id:'proj1',nome:'Projeto sintético'}]}];
    window.lumeConnectionRequest=async(path,body,options)=>{
      window.calls.push({path,body});if(window.fail)throw Object.assign(new Error('Permissão revogada'),{status:window.fail});
      if(window.hold)return new Promise(resolve=>window.pending.push(resolve));
      if(path.includes('/pessoas/correcao')){window.people[0].tags=body.tags.map(valor=>({valor,origem:'corrigido'}));return {ok:true};}
      if(path.includes('/pessoas?'))return {versao:1,pessoas:window.people,proximaPagina:null,lacunas:[]};
      if(path.includes('/timeline?')){const p=new URL(path,'http://local').searchParams;return {itens:p.get('pagina')==='1'?window.rows:[window.rows[0],{...window.rows[0],id:2,texto:'Segundo trecho sintético',fonte:{eventoId:2}}],proximaPagina:p.get('pagina')==='1'?2:null};}
      if(path.includes('/central'))return {acontecimentos:[{titulo:'Fonte recebida',texto:'Mensagem salva',fonte:{eventoId:1}}],comunicados:[],organizacao:{estado:'pausado',processados:7,pendentes:2,cobertura:'Recorte autorizado, histórico parcial',limitacao:'Sem conta conectada'}};
      if(path.includes('/organizacao/vinculo')){const items=body.nome?[{nome:body.nome,trecho:body.trecho,origem:'manual',fontes:[{eventoId:body.eventoId,trecho:body.trecho}]}]:[];window.people[0].organizacoes=items;window.rows[0].organizacoes=items;return {ok:true};}
      if(path.includes('/organizacao'))return {ok:true};
      if(path.includes('/projetos-comerciais')){const params=new URL(path,'http://local').searchParams;if(window.projectPages)return params.get('q')?{projetos:[{id:'proj120',nome:'Projeto distante sintético'}],proximaPagina:null}:params.get('pagina')==='2'?{projetos:[{id:'proj101',nome:'Projeto 101 sintético'}],proximaPagina:null}:{projetos:[{id:'proj1',nome:'Projeto sintético'}],proximaPagina:2};return {projetos:[{id:'proj1',nome:'Projeto sintético'}]};}
      if(path.includes('/vinculo'))return {ok:true};
      throw Error('Endpoint não esperado: '+path);
    };
    window.abrirFonteTarefa=id=>window.openedSources.push(id);
    window.carregarGrafo=async()=>{document.getElementById('network').setAttribute('aria-busy','true');};
    window.limparGrafo=()=>{document.getElementById('network').setAttribute('aria-busy','false');window.mapCleared=true;};
  });
  await page.addScriptTag({content:script});return page;
}

test('Pessoas distingue grupo, salva correção e reconsulta o dado persistido',async t=>{
  const p=await setup(t);await p.evaluate(()=>LumeUm.pessoas());
  assert.equal(await p.locator('.l1-person').count(),2);assert.match(await p.locator('.l1-person').first().innerText(),/Grupo[\s\S]*Cliente · sugestão/);
  await p.getByRole('button',{name:'Corrigir tags',exact:true}).first().click();await p.getByLabel('Cliente',{exact:true}).uncheck();await p.getByLabel('Parceiro',{exact:true}).check();await p.getByRole('button',{name:'Salvar correção',exact:true}).click();
  await p.waitForFunction(()=>!document.querySelector('dialog'));assert.match(await p.locator('.l1-person').first().innerText(),/Parceiro · corrigido por você/);
  assert.deepEqual(await p.evaluate(()=>calls.find(c=>c.path.includes('/pessoas/correcao')).body),{conversaId:'group@g.us',tags:['parceiro']});
  await p.screenshot({path:output+'/pessoas-claro.png'});
});

test('Timeline de grupo combina filtros, pagina sem duplicar e corrige projeto com fonte',async t=>{
  const p=await setup(t);await p.evaluate(()=>LumeUm.pessoas());await p.getByRole('button',{name:'Ver timeline',exact:true}).first().click();await p.waitForSelector('.l1-timeline-item');
  await p.getByLabel('Assunto',{exact:true}).fill('Orçamento');await p.getByLabel('Pessoa',{exact:true}).fill('Autora');await p.getByLabel('Projeto',{exact:true}).fill('Projeto');await p.getByRole('button',{name:'Filtrar timeline',exact:true}).click();
  await p.waitForFunction(()=>calls.some(c=>c.path.includes('assunto=Or%C3%A7amento')&&c.path.includes('pessoa=Autora')&&c.path.includes('projeto=Projeto')));
  await p.getByRole('button',{name:'Mais mensagens',exact:true}).click();await p.waitForFunction(()=>document.querySelectorAll('.l1-timeline-item').length===2);
  assert.match(await p.locator('.l1-timeline-item').first().innerText(),/Autora sintética[\s\S]*26\/10\/2026[\s\S]*Grupo sintético/);
  await p.locator('.l1-timeline-item summary').first().click();await p.waitForSelector('.l1-timeline-item details select');await p.locator('.l1-timeline-item details select').selectOption('proj1');await p.getByRole('button',{name:'Salvar vínculo',exact:true}).click();await p.getByText('Vínculo salvo.',{exact:false}).waitFor();
  assert.deepEqual(await p.evaluate(()=>calls.find(c=>c.path.includes('/vinculo')).body),{eventoId:1,projetoId:'proj1',trecho:'Trecho sintético de orçamento.'});
  await p.evaluate(()=>document.documentElement.dataset.theme='dark');await p.screenshot({path:output+'/timeline-escuro.png'});
  await p.getByRole('button',{name:'Conferir fonte',exact:true}).last().click();assert.deepEqual(await p.evaluate(()=>openedSources),[2]);
});

test('Revogação durante paginação limpa timeline e resposta tardia não reaparece',async t=>{
  const p=await setup(t);await p.evaluate(()=>LumeUm.timeline());await p.waitForSelector('.l1-timeline-item');await p.evaluate(()=>window.fail=403);
  await p.getByRole('button',{name:'Mais mensagens',exact:true}).click();await p.getByText('Permissão revogada',{exact:true}).waitFor();assert.equal(await p.locator('.l1-timeline-item').count(),0);
  await p.evaluate(()=>{window.fail=null;window.hold=true;});await p.getByRole('button',{name:'Tentar novamente',exact:true}).click();await p.waitForFunction(()=>pending.length===1);
  await p.keyboard.press('Escape');await p.evaluate(()=>pending[0]({itens:rows,proximaPagina:null}));assert.equal(await p.locator('dialog').count(),0);
});

test('Central separa registros de comunicados e retoma sem ampliar autorização',async t=>{
  const p=await setup(t);await p.getByRole('button',{name:'Acontecimentos',exact:true}).click();await p.getByRole('heading',{name:'Comunicados do Lume'}).waitFor();
  assert.match(await p.locator('dialog').innerText(),/7 processados · 2 pendentes[\s\S]*histórico parcial[\s\S]*Nenhum comunicado disponível/);
  await p.getByRole('button',{name:'Retomar organização'}).click();await p.waitForFunction(()=>calls.some(c=>c.path.endsWith('/organizacao')));
  assert.deepEqual(await p.evaluate(()=>calls.find(c=>c.path.endsWith('/organizacao')).body),{acao:'retomar'});
  assert.equal(await p.evaluate(()=>calls.some(c=>/enviar|aprovar|autorizacao/.test(c.path))),false);await p.screenshot({path:output+'/central-claro.png'});
});

test('Timeline mostra compromisso, execução e mudanças separados; revisão mantém id real',async t=>{
  const p=await setup(t);await p.evaluate(()=>{window.actions=[];window.abrirAcaoDoAviso=id=>window.actions.push(id);window.rows[0].compromissos=[{id:'acao-real-81',resumo:'Revisar catálogo',estado:'resolvido',prazo:'sexta-feira',trecho:'Trecho sintético de orçamento.',execucao:{estado:'verificado'},mudancas:[{estado_anterior:'sugerido',estado_novo:'confirmado',alterada_em:'2026-10-26T12:00:00Z',motivo:'Correção do dono'}]}];});
  await p.evaluate(()=>LumeUm.timeline());await p.locator('.l1-commitment').waitFor();
  assert.match(await p.locator('.l1-commitment').innerText(),/Compromisso: Conclusão informada[\s\S]*Execução: Resultado verificado[\s\S]*Prazo citado: sexta-feira/);
  assert.doesNotMatch(await p.locator('.l1-commitment').innerText(),/Envio registrado|Aceite registrado/);
  await p.getByText('Mudanças do compromisso',{exact:true}).click();assert.match(await p.locator('.l1-commitment').innerText(),/Sugerido · confira a fonte → Confirmado · Correção do dono/);
  await p.getByRole('button',{name:'Rever compromisso',exact:true}).click();assert.deepEqual(await p.evaluate(()=>actions),['acao-real-81']);assert.equal(await p.locator('dialog').count(),0);
});

test('Timeline apresenta decisões, mudanças e resultados citados com fonte sem inventar verificação',async t=>{
  const p=await setup(t);await p.evaluate(()=>{window.rows[0].acontecimentos=['decisao','mudanca','resultado'].map((tipo,i)=>({tipo,resumo:'Registro sintético '+tipo,trecho:'Trecho sintético de orçamento.',origem:'sugerido',confianca:.96,atualizadoEm:'2026-10-26T12:00:00Z',fonte:{eventoId:1}}));});
  await p.evaluate(()=>LumeUm.timeline());await p.locator('.l1-occurrence').first().waitFor();assert.equal(await p.locator('.l1-occurrence').count(),3);
  assert.match(await p.locator('.l1-timeline').innerText(),/Decisão[\s\S]*Mudança[\s\S]*Resultado citado/);assert.match(await p.locator('.l1-occurrence').last().innerText(),/Inferido · confira a fonte/);assert.doesNotMatch(await p.locator('.l1-occurrence').last().innerText(),/Resultado verificado|Envio registrado|Aceite registrado/);
  await p.locator('.l1-occurrence').last().getByRole('button',{name:'Conferir fonte'}).click();assert.deepEqual(await p.evaluate(()=>openedSources),[1]);
});

test('Organização não transforma grupo em empresa; nome corrigido e remoção reconsultam fonte',async t=>{
  const p=await setup(t);await p.evaluate(()=>{const org={nome:'Empresa sintética',trecho:'Trecho sintético de orçamento.',origem:'sugerido',fontes:[{eventoId:1,trecho:'Trecho sintético de orçamento.'}]};window.people[0].organizacoes=[org];window.rows[0].organizacoes=[org];});
  await p.evaluate(()=>LumeUm.pessoas());const card=p.locator('.l1-person').first();await card.locator('.l1-organization').waitFor();assert.equal(await card.locator('.l1-entity-kind').textContent(),'Grupo');assert.match(await card.innerText(),/Empresa sintética[\s\S]*Inferido · confira a fonte/);
  await card.getByText('Rever organização',{exact:true}).click();await card.getByLabel('Nome da organização',{exact:true}).fill('Empresa corrigida');await card.getByRole('button',{name:'Salvar organização',exact:true}).click();await card.getByText('Empresa corrigida',{exact:true}).waitFor();assert.match(await card.innerText(),/Corrigido por você/);
  await card.getByRole('button',{name:'Ver timeline'}).click();await p.locator('.l1-timeline-item .l1-organization').waitFor();await p.locator('.l1-timeline-item').first().getByText('Rever organização',{exact:true}).click();await p.getByRole('button',{name:'Remover vínculo de organização',exact:true}).click();await p.waitForFunction(()=>calls.filter(c=>c.path.includes('/organizacao/vinculo')).length===2&&document.querySelectorAll('.l1-timeline-item .l1-organization').length===0);
  assert.deepEqual(await p.evaluate(()=>calls.filter(c=>c.path.includes('/organizacao/vinculo')).map(c=>c.body)),[{eventoId:1,trecho:'Trecho sintético de orçamento.',nome:'Empresa corrigida'},{eventoId:1,trecho:'Trecho sintético de orçamento.',nome:''}]);
});

test('Correção de projeto pagina e busca além dos primeiros cem sem perder seleção',async t=>{
  const p=await setup(t);await p.evaluate(()=>{window.projectPages=true;LumeUm.timeline();});await p.locator('.l1-timeline-item').waitFor();const row=p.locator('.l1-timeline-item').first();await row.getByText('Corrigir projeto',{exact:true}).click();await row.getByLabel('Projeto da fonte',{exact:true}).selectOption('proj1');await row.getByRole('button',{name:'Mais projetos',exact:true}).click();await row.locator('option[value=proj101]').waitFor({state:'attached'});assert.equal(await row.getByLabel('Projeto da fonte',{exact:true}).inputValue(),'proj1');
  await row.getByLabel('Buscar projeto por nome',{exact:true}).fill('distante');await row.getByRole('button',{name:'Buscar projetos',exact:true}).click();await row.locator('option[value=proj120]').waitFor({state:'attached'});await row.getByLabel('Projeto da fonte',{exact:true}).selectOption('proj120');await row.getByRole('button',{name:'Salvar vínculo',exact:true}).click();await row.getByText('Vínculo salvo.',{exact:false}).waitFor();assert.equal(await p.evaluate(()=>calls.find(c=>c.path.endsWith('/lume-1/vinculo')).body.projetoId),'proj120');assert.ok(await p.evaluate(()=>calls.some(c=>c.path.includes('pagina=2')&&c.path.includes('limite=20'))));
});

test('Globais salvam tema e som opt-in, Mostrar Lume sem atendimento',async t=>{
  const p=await setup(t);assert.equal(await p.locator('#l1-global-sound').getAttribute('aria-pressed'),'false');
  await p.locator('#l1-global-theme').selectOption('dark');await p.locator('#l1-global-sound').click();await p.locator('#l1-global-companion').click();
  assert.deepEqual(await p.evaluate(()=>calls.filter(c=>c.path==='preferences').map(c=>c.body)),[{tema:'dark'},{som:true},{enabled:true}]);
  assert.equal(await p.locator('#l1-global-sound').getAttribute('aria-pressed'),'true');
});

test('Mapa pendente encerra em 15s, permite retry e lista com teclado',async t=>{
  const p=await setup(t);await p.clock.install();await p.evaluate(()=>carregarGrafo());await p.clock.fastForward(15001);
  assert.match(await p.locator('#l1-map-status').innerText(),/demorou mais de 15 segundos/);assert.equal(await p.evaluate(()=>mapCleared),true);
  await p.getByRole('button',{name:'Tentar mapa novamente',exact:true}).click();assert.equal(await p.locator('#network').getAttribute('aria-busy'),'true');
  await p.getByRole('button',{name:'Usar lista',exact:true}).focus();await p.keyboard.press('Enter');assert.equal(await p.locator('#graph').getAttribute('data-map-mode'),'list');assert.equal(await p.locator('.graph-panel').isVisible(),false);
  await p.evaluate(()=>window.dispatchEvent(new CustomEvent('lume:navigate',{detail:{view:'memory'}})));assert.equal(await p.locator('#network').getAttribute('aria-busy'),'false');
  await p.evaluate(()=>{document.getElementById('graph-count').textContent='Não consegui carregar o mapa.';document.getElementById('network').setAttribute('aria-busy','false');});await p.getByRole('button',{name:'Tentar mapa novamente',exact:true}).waitFor();
});

test('1024x768 e escala 200% não criam overflow global; modal mantém Escape e reduced motion',async t=>{
  const p=await setup(t);await p.evaluate(()=>LumeUm.pessoas());await p.evaluate(()=>document.documentElement.style.zoom='2');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await p.getByRole('button',{name:'Ver timeline',exact:true}).first().click();await p.waitForSelector('.l1-timeline-item');
  assert.equal(await p.evaluate(()=>document.querySelector('dialog').scrollWidth>document.querySelector('dialog').clientWidth+1),false);
  assert.equal(await p.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);await p.screenshot({path:output+'/timeline-200.png'});await p.keyboard.press('Escape');assert.equal(await p.locator('dialog').count(),0);
});

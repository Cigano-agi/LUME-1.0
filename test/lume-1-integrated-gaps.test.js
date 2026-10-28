import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO} from '../src/pessoal/organizador.js';
import {criarServidor} from '../src/painel/servidor.js';
const DM='550000001907@s.whatsapp.net',TEXT='Empresa Aurora decidiu cancelar a proposta anterior.';
const SUMMARY='Decisão sintética extraída sem compromisso';
const empty=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[]});
async function fixture(t){
  const db=abrirBanco(),contexto=new ContextoApp(db);new Desktop(db).aceitar({nome:'Synthetic integration gaps review',aceito:true,versao:VERSAO_TERMOS});
  let result={...empty(),vinculos:[{tipo:'organizacao',nome:'Empresa Aurora',trecho:TEXT,confianca:.95}],acontecimentos:[{tipo:'decisao',resumo:SUMMARY,trecho:TEXT,confianca:.95}]},sequence=0;
  const chatgpt={estado:async()=>({connected:true,planEnabled:true,paused:false,model:'synthetic-gap-review'}),responder:async request=>{assert.equal(request.validar(),true);return{completed:true,model:'synthetic-gap-review',requestId:'synthetic-gap-'+(++sequence),text:JSON.stringify(result)};}};
  const org=new OrganizadorConversas(db,{chatgpt,agora:()=>new Date('2026-10-27T10:00:00Z')});
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(DM,'Pessoa sintética');org.politica.configurar({conversaId:DM,categoria:'team',modo:'observar',remoto:true});db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,1,?)').run(DM,'2026-10-27T09:00:00Z');
  org.aprovarAvaliacao({modelo:'synthetic-gap-review',total:100,acertos:100,criticos:20,errosCriticos:0,evidencia:'SYNTHETIC; no product quality approval',revisor:'independent synthetic review',contrato:CONTRATO_ORGANIZACAO});org.configurar({acao:'retomar'});
  const id=contexto._registrarEvento({conversaId:DM,origemId:'synthetic-gap-source',autorId:DM,direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:TEXT,recebidoEm:new Date('2026-10-27T09:00:00Z')},'dirigida').id;
  assert.equal(await org.passo(),true);
  const server=criarServidor(db,{desktop:true,pessoal:{organizador:org,politica:org.politica,ativa:()=>false},conexao:{estado:()=>({estado:'desconectada'})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(origin+'/api/sessao')).json();
  t.after(async()=>{await new Promise(r=>{server.close(r);server.closeAllConnections();});await org.encerrar();db.close();});
  const request=async(route,body)=>{const response=await fetch(origin+route,{method:body?'POST':'GET',headers:{'x-assessor-token':token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json()};};
  // This fixture requests immediate reprocessing, independently of the bounded sweep cursor.
  return{db,org,id,get:request,post:request,setResult:value=>{result=value;},reprocess:async()=>{db.prepare("DELETE FROM etapas WHERE evento_id=? AND etapa='organizacao_chatgpt'").run(id);org.config('cursor',null);return org.passo();}};
}

test('G01 backend: acontecimento sem compromisso aparece na central com fonte e sem assunto fabricado',async t=>{
  const f=await fixture(t);assert.equal(f.db.prepare('SELECT count(*) n FROM lume_acoes').get().n,0);
  assert.equal(f.org.timeline({conversa:DM}).itens[0].acontecimentos[0].resumo,SUMMARY);
  const {status,data}=await f.get('/api/v3/lume-1/central');assert.equal(status,200);
  const item=data.acontecimentos.find(x=>x.titulo===SUMMARY||x.resumo===SUMMARY||x.assunto===SUMMARY);assert.ok(item,'standalone extracted decision must be visible');assert.equal(item.fonte.eventoId,f.id);assert.equal(item.acaoId,null);
  assert.equal(item.id,`acontecimento:${f.id}:0`);const detail=await f.get('/api/v3/experiencia?id='+encodeURIComponent(item.id));assert.equal(detail.status,200);assert.equal(detail.data.itens.length,1);assert.equal(detail.data.itens[0].acaoId,null);assert.equal(detail.data.itens[0].fonte.eventoId,f.id);
});

test('G02 backend: organização sugerida tem projeção própria sem transformar pessoa em organização',async t=>{
  const f=await fixture(t),person=f.org.pessoas({}).pessoas[0],row=f.org.timeline({conversa:DM}).itens[0];
  assert.equal(person.tipo,'pessoa');assert.equal(person.id,DM);
  for(const entity of [person,row]){assert.equal(entity.organizacoes?.[0]?.nome,'Empresa Aurora');assert.equal(entity.organizacoes[0].origem,'sugerido');assert.equal(entity.organizacoes[0].fontes[0].eventoId,f.id);}
  f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);
  assert.deepEqual(f.org.pessoas({}).pessoas[0].organizacoes,[]);assert.deepEqual(f.org.timeline({conversa:DM}).itens[0].organizacoes,[]);
});

test('G03 backend: seletor de projeto alcança o centésimo primeiro e busca sem truncamento',async t=>{
  const f=await fixture(t);for(let n=0;n<101;n++)f.org.projetos.criarRascunho({nome:'Projeto sintético '+String(n).padStart(3,'0'),chave:'gap-project-'+n,fontes:[{eventoId:f.id,trecho:TEXT}]});
  const first=await f.get('/api/v3/projetos-comerciais?pagina=1&limite=100'),second=await f.get('/api/v3/projetos-comerciais?pagina=2&limite=100');
  assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(first.data.proximaPagina,2);assert.equal(second.data.proximaPagina,null);assert.equal(new Set([...first.data.projetos,...second.data.projetos].map(p=>p.id)).size,101);
  const search=await f.get('/api/v3/projetos-comerciais?q=Projeto%20sint%C3%A9tico%20100&pagina=1&limite=20');assert.equal(search.status,200);assert.deepEqual(search.data.projetos.map(p=>p.nome),['Projeto sintético 100']);
});

for(const mutation of ['remote','source','read'])test(`G01 backend: ${mutation} invalidates central and standalone event detail`,async t=>{
  const f=await fixture(t),eventId=`acontecimento:${f.id}:0`;
  if(mutation==='remote')f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);
  if(mutation==='source')f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(TEXT+' Atualizada.',f.id);
  if(mutation==='read')f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(f.id);
  const central=await f.get('/api/v3/lume-1/central');assert.equal(central.status,200);assert.ok(!central.data.acontecimentos.some(x=>x.id===eventId));
  const detail=await f.get('/api/v3/experiencia?id='+encodeURIComponent(eventId));assert.equal(detail.status,200);assert.deepEqual(detail.data.itens,[]);assert.ok(detail.data.lacunas.length>0);assert.equal(f.org.acontecimento(f.id,0),null);
  assert.equal(f.db.prepare('SELECT count(*) n FROM lume_acoes').get().n,0);
});

test('G02 backend: manual organization replaces inference, survives reprocessing and remote revocation only',async t=>{
  const f=await fixture(t),route='/api/v3/lume-1/organizacao/vinculo';
  const correction=await f.post(route,{eventoId:f.id,trecho:TEXT,nome:'Organizacao corrigida'});assert.equal(correction.status,200);
  const check=()=>{const links=f.org.organizacoes(f.id);assert.deepEqual(links.map(x=>x.nome),['Organizacao corrigida']);assert.equal(links[0].origem,'manual');};check();
  assert.equal(await f.reprocess(),true);check();assert.deepEqual(f.org.pessoas({}).pessoas[0].organizacoes.map(x=>x.nome),['Organizacao corrigida']);
  f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);check();
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(f.id);assert.deepEqual(f.org.organizacoes(f.id),[]);assert.deepEqual(f.org.pessoas({}).pessoas,[]);
  const refused=await f.post(route,{eventoId:f.id,trecho:TEXT,nome:'Proibida'});assert.notEqual(refused.status,200);
});

test('G02 backend: removing a manual organization suppresses inference after reprocessing; edit invalidates correction',async t=>{
  const f=await fixture(t),route='/api/v3/lume-1/organizacao/vinculo';
  assert.equal((await f.post(route,{eventoId:f.id,trecho:TEXT,nome:''})).status,200);assert.deepEqual(f.org.organizacoes(f.id),[]);
  assert.equal(await f.reprocess(),true);assert.deepEqual(f.org.organizacoes(f.id),[]);
  assert.equal((await f.post(route,{eventoId:f.id,trecho:TEXT,nome:'Manual'})).status,200);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(TEXT+' Fonte revisada.',f.id);assert.deepEqual(f.org.organizacoes(f.id),[]);
  assert.equal(await f.org.passo(),true);assert.deepEqual(f.org.organizacoes(f.id).map(x=>[x.nome,x.origem]),[['Empresa Aurora','sugerido']]);
});

test('G02 backend: corrections to distinct source intervals are preserved independently',async t=>{
  const f=await fixture(t),route='/api/v3/lume-1/organizacao/vinculo';
  for(const [trecho,nome] of [['Empresa Aurora','Primeira'],['a proposta anterior','Segunda']])assert.equal((await f.post(route,{eventoId:f.id,trecho,nome})).status,200);
  assert.deepEqual(f.org.organizacoes(f.id).map(x=>x.nome),['Primeira','Segunda']);
  assert.equal((await f.post(route,{eventoId:f.id,trecho:'Empresa Aurora',nome:''})).status,200);assert.deepEqual(f.org.organizacoes(f.id).map(x=>x.nome),['Segunda']);
  assert.equal(await f.reprocess(),true);assert.deepEqual(f.org.organizacoes(f.id).map(x=>x.nome),['Segunda']);
});

test('G04 backend: successful empty extraction is included in abstention coverage',async t=>{
  const f=await fixture(t);f.setResult(empty());assert.equal(await f.reprocess(),true);
  const state=f.org.estado();assert.equal(state.processados,1);assert.equal(state.abstidos,1);assert.equal(state.cobertura,1);assert.equal(state.pendentes,0);
  assert.deepEqual(f.org.organizacoes(f.id),[]);assert.equal(f.org.acontecimento(f.id,0),null);
});

let browser;before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});after(async()=>{await browser?.close();});
const uiScript=await readFile(new URL('../src/painel/lume-1-interface.js',import.meta.url),'utf8');
async function ui(t){
  const page=await browser.newPage();t.after(()=>page.close());await page.route('**/*',route=>route.abort());
  await page.setContent('<body><form id="lv-global-search"></form><div id="lv-memory-tools"></div><section id="contacts"></section><section id="graph"><div id="graph-filters"></div><svg id="network"></svg><div id="graph-count"></div><div id="graph-list"></div></section></body>');
  await page.evaluate(({text,summary})=>{
    window.prefs={som:false,tema:'system',enabled:false,disponivel:false};window.LumePreferencias={estado:()=>prefs};window.calls=[];
    const org={nome:'Empresa Aurora',origem:'sugerido',trecho:text,inicio:0,fontes:[{eventoId:1,trecho:text}]};
    const row={id:'evento:1',autor:'Pessoa sintética',texto:text,fonte:{eventoId:1},recebidoEm:'2026-10-27T09:00:00Z',organizacoes:[org],acontecimentos:[{tipo:'decisao',resumo:summary,trecho:text,inicio:0,confianca:.95}],compromissos:[],assuntos:[],projetos:[]};
    window.lumeConnectionRequest=async url=>{calls.push(url);const u=new URL(url,'http://synthetic');
      if(u.pathname.endsWith('/timeline'))return{itens:[row],proximaPagina:null};
      if(u.pathname.endsWith('/pessoas'))return{pessoas:[{id:'synthetic',nome:'Pessoa sintética',tipo:'pessoa',tags:[],organizacoes:[org]}],proximaPagina:null};
      if(u.pathname.endsWith('/projetos-comerciais'))return u.searchParams.get('pagina')==='2'?{projetos:[{id:'project-101',nome:'Projeto distante'}],pagina:2,proximaPagina:null}:{projetos:[{id:'project-1',nome:'Primeiro projeto'}],pagina:1,proximaPagina:2};
      throw Error('unexpected synthetic route');};
  },{text:TEXT,summary:SUMMARY});await page.addScriptTag({content:uiScript});return page;
}

test('G01 UI: timeline mostra decisão extraída como sugestão e conserva trecho/fonte',async t=>{
  const page=await ui(t);await page.evaluate(()=>LumeUm.timeline());await page.waitForSelector('.l1-timeline-item');const body=await page.locator('.l1-timeline-item').innerText();assert.ok(body.includes(SUMMARY),'decision summary is not rendered');assert.match(body,/sugeri|sugestão|inferido/i);assert.match(body,/Decisão/i);assert.equal(await page.getByRole('button',{name:'Conferir fonte',exact:true}).count()>0,true);
});

test('G02 UI: cartão da pessoa mostra organização vinculada em seção distinta',async t=>{
  const page=await ui(t);await page.evaluate(()=>LumeUm.pessoas());await page.waitForSelector('.l1-person');const body=await page.locator('.l1-person').innerText();assert.ok(body.includes('Empresa Aurora'),'organization link is not rendered on person');assert.match(body,/Organizaç(?:ão|ões)/i);assert.match(body,/sugeri|sugestão|inferido/i);
});

test('G03 UI: correção de vínculo permite carregar projeto da página seguinte',async t=>{
  const page=await ui(t);await page.evaluate(()=>LumeUm.timeline());await page.waitForSelector('.l1-timeline-item');await page.getByText('Corrigir projeto',{exact:true}).click();await page.waitForSelector('.l1-timeline-item select');
  const more=page.getByRole('button',{name:'Mais projetos',exact:true});assert.equal(await more.count(),1,'selector has no next page control');await more.click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.l1-timeline-item select option')).some(x=>x.value==='project-101'));assert.ok((await page.evaluate(()=>calls)).some(u=>u.includes('pagina=2')));
});

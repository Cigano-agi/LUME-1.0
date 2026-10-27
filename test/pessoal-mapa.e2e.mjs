// Real graph module, layout and product CSS; isolated HTTP/SQLite fixtures only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa} from '../src/pessoas.js';
import {grafoDesktop,fontesGrafo} from '../src/grafo-desktop.js';
const baseline=process.argv.includes('--baseline'),output=new URL('../work/pessoal-qa-20261026/',import.meta.url);
await mkdir(output,{recursive:true});
const db=abrirBanco(),e=perfilGrafo(db),grupo='120000000001@g.us',pessoa='123456789@lid';
e.conversa(grupo,'Equipe Fixture');e.conversa('120000000002@g.us','Outro Projeto');
registrarPessoa(db,{identificador:pessoa,nomeCru:'Álvaro Fixture'});
registrarPessoa(db,{identificador:'222222222@lid',nomeCru:'Bianca Fixture'});
for(let i=0;i<13;i++)e.evento(grupo,pessoa,{dia:'2026-10-26',texto:'Fonte sintética do par '+i});
e.evento(grupo,'222222222@lid',{dia:'2026-10-26'});e.evento('120000000002@g.us','222222222@lid',{dia:'2026-10-26'});
e.evento(grupo,'privado@lid',{dia:'2026-10-26',permissao:null,texto:'CONTEUDO_REVOGADO'});
const html=await readFile(new URL('../src/painel/app.html',import.meta.url),'utf8');
const section=html.slice(html.indexOf('<section id="graph"'),html.indexOf('<section id="settings"')).replace('class="view" hidden','class="view"');
const css=['app.css','workspace.css','lume-theme.css','lume-dark.css'];
const primitives=`
const $=id=>document.getElementById(id),number=n=>String(n);let revisaoDadosVisiveis=0;
function element(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
async function run(fn){return fn();}
function action(text,fn,cls='secondary'){const b=element('button',text,cls);b.type='button';b.onclick=()=>run(fn);return b;}
async function api(path){const r=await fetch(path);if(!r.ok)throw Error('Falha sintética');return r.json();}
function source(m){const n=element('article',m.texto,'source');n.dataset.id=m.id;return n;}
window.opened=[];function openConversation(id,name){window.opened.push({id,name});}
window.invalidate=()=>{revisaoDadosVisiveis++;window.limparGrafo();};
`;
const files=new Map(await Promise.all([...css,'graph.js','graph-layout.js'].map(async name=>['/'+name,await readFile(new URL('../src/painel/'+name,import.meta.url))])));
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${css.map(f=>`<link rel="stylesheet" href="/${f}">`).join('')}<style>body{margin:0}.main-content{max-width:1120px;margin:auto}.fixture-note{padding:16px 28px;margin:0;font-size:12px}[hidden]{display:none!important}</style></head><body class="workspace"><p class="fixture-note">Lume · prova isolada com dados sintéticos</p><div class="main-content">${section}</div><script>${primitives}</script><script src="/graph.js"></script><script>carregarGrafo();</script></body></html>`);return;
  }
  if(files.has(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(files.get(url.pathname));return;}
  if(url.pathname==='/api/v3/grafo'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(grafoDesktop(db,{...Object.fromEntries(url.searchParams),pagina:Number(url.searchParams.get('pagina')||1)},new Date('2026-10-26T12:00:00Z'))));return;}
  if(url.pathname==='/api/v3/grafo/fontes'){
    const filtro={...Object.fromEntries(url.searchParams)};if(filtro.antes)filtro.antes=Number(filtro.antes);
    const r=fontesGrafo(db,filtro);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mensagens:r.ids.map(id=>db.prepare('SELECT id,texto,autor_id,conversa_id FROM eventos WHERE id=?').get(id)),proximoAntes:r.proximoAntes}));return;
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce'});
const page=await context.newPage(),errors=[],external=[],checks=[];page.setDefaultTimeout(10000);
await page.addInitScript(()=>{
  window.graphScrolls=[];const original=Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView=function(options){if(['graph-selection','graph-sources'].includes(this.id))window.graphScrolls.push({id:this.id,...options});return original.call(this,options);};
});
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',route=>{if(route.request().url().startsWith(origin+'/'))return route.continue();external.push(route.request().url());return route.abort();});
const check=(name,pass,detail={})=>checks.push({name,pass,...detail});
const settle=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const ready=()=>page.waitForFunction(()=>document.querySelector('#network')?.getAttribute('aria-busy')==='false'&&document.querySelector('#network .graph-node'));
const selectionMetrics=()=>page.evaluate(()=>{const p=document.getElementById('graph-selection'),h=p.querySelector('h2'),b=h?.getBoundingClientRect();return {shown:!p.hidden,focused:p===document.activeElement||p.contains(document.activeElement),inViewport:Boolean(b&&b.top>=0&&b.bottom<=innerHeight),heading:h?.textContent};});
try{
  await page.goto(origin);await ready();
  if(!baseline)await page.locator('.graph-panel').screenshot({path:new URL('mapa-visao-geral.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  const node=page.locator('#network [data-id="c:'+grupo+'"]');
  const initialView=await page.locator('#network').getAttribute('viewBox');
  await node.focus();const label=await node.locator('text').boundingBox();
  await page.mouse.click(label.x+label.width/2,label.y+label.height/2);await settle();
  check('clique no rótulo SVG seleciona a conversa',(await selectionMetrics()).shown);
  check('clique no rótulo não inicia pan',await page.locator('#network').getAttribute('viewBox')===initialView);
  await page.reload();await ready();
  if(!baseline){
    const rect=await page.locator('#network').boundingBox();await page.mouse.move(rect.x+12,rect.y+12);await page.mouse.down();await page.mouse.move(rect.x+72,rect.y+32);await page.mouse.up();
    check('arrastar fundo move a câmera',await page.locator('#network').getAttribute('viewBox')!==initialView);
    await page.locator('#graph-reset').click();assert.equal(await page.locator('#network').getAttribute('viewBox'),initialView);
  }
  await page.locator('#network [data-id="c:'+grupo+'"] circle').click();await settle();
  const metrics=await selectionMetrics();check('seleção recebe foco',metrics.focused,metrics);check('seleção aparece na viewport',metrics.inViewport,metrics);
  await page.screenshot({path:new URL(baseline?'mapa-baseline.png':'mapa-selecao-desktop.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
  if(!baseline){
    assert.equal(metrics.heading,'Equipe Fixture');
    await page.locator('#graph-selection').getByRole('button',{name:'Abrir conversa',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.opened),[{id:grupo,name:'Equipe Fixture'}]);check('abrir conversa usa ID exato',true);
    await page.locator('#graph-selection .graph-relation').filter({hasText:'Álvaro Fixture'}).getByRole('button',{name:'Conferir mensagens'}).click();
    await page.locator('#graph-sources .source').first().waitFor();assert.equal(await page.locator('#graph-sources .source').count(),10);
    assert.doesNotMatch(await page.locator('#graph-sources').innerText(),/CONTEUDO_REVOGADO/);
    await page.getByRole('button',{name:'Mais mensagens desta ligação'}).click();await page.waitForFunction(()=>document.querySelectorAll('#graph-sources .source').length===13);
    check('fontes do par exato com paginação',true);
    await page.locator('#graph-selection').getByRole('button',{name:'Focar conversa',exact:true}).click();await ready();await settle();
    check('foco após recarregar mantém seleção',(await selectionMetrics()).shown&&(await selectionMetrics()).focused);
    await page.locator('#graph-back').click();await ready();
    const person=page.locator('#network [data-id="p:'+pessoa+'"]');await person.focus();await page.keyboard.press('Space');await settle();
    check('teclado seleciona pessoa',(await selectionMetrics()).heading==='Álvaro Fixture'&&(await selectionMetrics()).focused);
    await page.keyboard.press('Escape');check('Escape retorna ao mapa',await person.evaluate(n=>document.activeElement===n));
    await page.locator('#graph-query').fill('alvaro');await page.locator('#graph-filters button').click();await ready();
    assert.equal(await page.locator('#network .person[data-id="p:'+pessoa+'"]').count(),1);check('busca pelo nome da pessoa',true);
    for(const width of [390,820]){
      await page.setViewportSize({width,height:844});await page.locator('#graph-list [data-id="p:'+pessoa+'"]').click();await settle();
      const m=await selectionMetrics();check('seleção visível/focada em '+width,m.focused&&m.inViewport);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:new URL('mapa-selecao-'+width+'.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
    }
    check('reduced-motion usa rolagem imediata',await page.evaluate(()=>window.graphScrolls.length>0&&window.graphScrolls.every(s=>s.behavior==='auto')));
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.locator('#graph-list [data-id="p:'+pessoa+'"]').click();
    check('rolagem suave somente quando permitida',await page.evaluate(()=>window.graphScrolls.at(-1)?.behavior==='smooth'));
    await page.emulateMedia({reducedMotion:'reduce'});
    // Late source responses cannot resurrect selection after data invalidation.
    let release,started;const held=new Promise(r=>{release=r;}),seen=new Promise(r=>{started=r;});
    await page.route('**/api/v3/grafo/fontes?*',async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});});
    await page.locator('#graph-selection .graph-relation').first().getByRole('button',{name:'Conferir mensagens'}).click();await seen;
    await page.evaluate(()=>window.invalidate());const returned=page.waitForResponse(r=>r.url().includes('/grafo/fontes?'));release();await (await returned).finished();await settle();
    assert.equal(await page.locator('#graph-sources .source').count(),0);assert.equal(await page.locator('#graph-selection').isHidden(),true);check('invalidação descarta fontes atrasadas',true);
  }
  check('sem erros de página',errors.length===0,{errors});check('nenhuma chamada externa',external.length===0,{external});
  await writeFile(new URL(baseline?'mapa-baseline.json':'mapa-prova.json',output),JSON.stringify({synthetic:true,realProfile:false,browser:'Edge headless isolado',checks},null,2));
  console.log(JSON.stringify(checks,null,2));assert.ok(checks.every(c=>c.pass),'Um ou mais critérios do mapa falharam');
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r));db.close();}

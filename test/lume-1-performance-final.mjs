// Paired browser A/B: frozen f656a21 UI versus frozen current UI.
// Real shared HTTP/SQLite service, identical synthetic sources, no external accounts.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import {AsyncLocalStorage} from 'node:async_hooks';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {criarServidor} from '../src/painel/servidor.js';
import {Novidades} from '../src/novidades.js';

if(!process.argv.includes('--run')){console.log('PREPARADO: node test/lume-1-performance-final.mjs --run; aguardar liberação da coordenação.');process.exit(0);}
const base=resolve('work/lume-1-20261026/performance-final-c7f8407');
const diagnostic=process.env.LUME_PERF_DIAGNOSTIC==='1';
const label=process.env.LUME_PERF_LABEL||'';assert.match(label,/^[a-z0-9-]{0,40}$/);
const out=join(base,(diagnostic?'diagnostic':'full')+(label?'-'+label:''));
await mkdir(out,{recursive:true});
const roots={baseline:resolve('work/lume-1-20261026/performance-ab-f656a21/baseline-tree/src/painel'),current:join(base,'current-tree/src/painel')};
const rounds=Number(process.env.LUME_PERF_ROUNDS||7);assert.ok(Number.isInteger(rounds)&&rounds>=3&&rounds<=15);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const assets={baseline:new Map(),current:new Map()};
async function collect(root,map,prefix=''){
  for(const item of await readdir(join(root,prefix),{withFileTypes:true})){const rel=prefix+item.name;if(item.isDirectory())await collect(root,map,rel+'/');else map.set('/'+rel,await readFile(join(root,rel)));}
}
await collect(roots.baseline,assets.baseline);await collect(roots.current,assets.current);
for(const variant of ['baseline','current'])assert.ok(assets[variant].has('/app.html'));
const manifest=Object.fromEntries(Object.entries(assets).map(([variant,map])=>[variant,Object.fromEntries([...map].map(([name,body])=>[name,hash(body)]))]));
await writeFile(join(out,'asset-manifest.json'),JSON.stringify(manifest,null,2));
const db=abrirBanco(':memory:'),sqlScope=new AsyncLocalStorage();
const traceSQL=diagnostic&&process.env.LUME_PERF_TRACE_SQL==='1';
if(traceSQL){
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{const statement=prepare(sql);return new Proxy(statement,{get(target,key){const method=Reflect.get(target,key,target);if(typeof method!=='function')return method;if(!['all','get','run'].includes(key))return method.bind(target);return(...args)=>{const span=sqlScope.getStore();if(!span)return method.apply(target,args);const started=performance.now();try{return method.apply(target,args);}finally{span.sql.push({method:key,sql,ms:performance.now()-started});}};}});};
}
const desktop=new Desktop(db);new ContextoApp(db);
desktop.aceitar({nome:'Comparação A/B · massa sintética',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
let externalAttempts=0;const forbidden=()=>{externalAttempts++;throw Error('External calls forbidden in A/B');};
const conexao={estado:()=>({estado:'desconectada',qr:null}),enviarTexto:forbidden,parar:async()=>{}};
const novidades=new Novidades(db,{versao:JSON.parse(await readFile('package.json','utf8')).version,buscar:forbidden});
const chatgpt={estado:async()=>({available:false,connected:false,accounts:[]}),modelos:async()=>[],encerrar(){},responder:forbidden};
const pessoal=new LumePessoal(db,{desktop,conexao,chatgpt,telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,publicar:()=>{}});
const projectSources=[];db.exec('BEGIN');
try{
  for(let c=0;c<100;c++){
    const id=c<80?`55000000${String(c).padStart(4,'0')}@s.whatsapp.net`:`12000000${String(c).padStart(4,'0')}@g.us`,name=(c<80?'Pessoa ':'Grupo ')+String(c).padStart(3,'0')+' · sintético';
    db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,name);
    for(let i=0;i<40;i++){
      const text=`Conversa sintética ${c}. Revisar catálogo página ${i+1} e conferir proposta de projeto. Fonte de ensaio, sem pessoa real.`;
      const event=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-26T12:00:00.000Z','2026-10-26','dirigida')`).run(id,`ab-${c}-${i}`,id,text).lastInsertRowid);
      if(i===0){pessoal.contexto.registrarDemanda({eventoId:event,resumo:`Revisar catálogo da conversa ${c}`,trecho:text,tipo:'pendencia'});if(c<8)projectSources.push({eventoId:event,trecho:text});}
    }
  }
  db.exec('COMMIT');
}catch(error){db.exec('ROLLBACK');throw error;}
const projects=new ProjetosComerciais(db);for(const [i,source]of projectSources.entries())projects.criarRascunho({nome:'Projeto sintético '+(i+1),fontes:[source]});
const fixtureHash=()=>hash(JSON.stringify(db.prepare('SELECT id,conversa_id,origem_id,texto,recebido_em FROM eventos ORDER BY id').all()));
const report={synthetic:true,baselineCommit:'f656a2108dc7b8a4d5facce7d8be941650613695',started:new Date().toISOString(),machine:{platform:process.platform,arch:process.arch,node:process.version,cpu:os.cpus()[0]?.model,totalMemoryBytes:os.totalmem()},fixture:{events:4000,conversations:100,groups:20,actions:100,projects:8,hashBefore:fixtureHash()},rounds,warmupPairs:1,samples:[],externalAttempts:0,method:{browser:'Edge headless Playwright; one launched browser, fresh context/cache per run',viewport:{width:1440,height:1000},motion:'reduce',theme:'light',ordering:'paired AB/BA alternating; same rotated route order per pair',backend:'same in-process real HTTP/SQLite service and same session token for both frozen UIs',assets:'both variants served from memory snapshots through identical route interception',readiness:'DOMContentLoaded + visible Agora finished + fonts ready + two animation frames; navigation awaits product function + visible busy false + two animation frames',networkIdle:'not part of measured intervals (avoids arbitrary500ms floor)',account:'synthetic unavailable; no credentials; no remote calls',concurrency:'runs during owner-authorized backup; alternating pairs reduce order bias; machine contention remains recorded limitation'},limits:['Measures synthetic 4000-event workload, not the private profile, Electron, macOS or8GB hardware.','Baseline UI uses the current compatible backend; this isolates UI change plus its changed request choices, not a complete historical binary.','Contacts baseline/new display scope and API choices differ intentionally; request timings and payloads are recorded.','Snapshot/other host activity may affect absolute timing; paired alternating rounds and distributions are retained.']};
report.backendHashes=Object.fromEntries(await Promise.all(['src/painel/servidor.js','src/pessoal/organizador.js','src/experiencia-lume.js'].map(async file=>{try{return[file,hash(await readFile(file))];}catch{return[file,null];}})));
report.diagnostic=diagnostic;report.serverRequests=[];
report.currentCommit='c7f8407';report.traceSQL=traceSQL;report.preparedNotHistorical=true;
report.method.concurrency=process.env.LUME_PERF_CONDITIONS||'Condição deve ser confirmada pela coordenação antes da execução; não presumir repouso.';
if(process.env.LUME_PERF_CONDITIONS)report.method.concurrency=process.env.LUME_PERF_CONDITIONS;
report.fixture.localServices={novidades:'Real Novidades instance, default disabled policy, forbidden remote fetch; unlike preserved first attempt where dependency was absent.'};
const server=criarServidor(db,{desktop:true,pessoal,conexao,novidades});let browser;
if(diagnostic)server.prependListener('request',(req,res)=>{
  const path=new URL(req.url,'http://local').pathname,started=performance.now(),cpu=process.cpuUsage(),span={path,target:req.url,started,sql:[]};
  if(traceSQL)sqlScope.enterWith(span);
  const end=res.end;res.end=function(chunk,...args){if(chunk!=null){const body=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));span.bytes=body.length;span.bodyHash=hash(body);if(path==='/api/v3/experiencia'){try{const parsed=JSON.parse(body);span.itemIds=parsed.itens?.map(i=>i.id);span.comparableBodyHash=hash(JSON.stringify({...parsed,atualizadoEm:'<request timestamp>'}));span.comparableHashExcludes=['atualizadoEm (root request timestamp only)'];}catch{}}}return end.call(this,chunk,...args);};
  res.once('finish',()=>{const consumed=process.cpuUsage(cpu);report.serverRequests.push({...span,ms:performance.now()-started,cpuMs:(consumed.user+consumed.system)/1000,status:res.statusCode});});
});
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2','.json':'application/json'};
const supportedRoutes=['today','memory','sales','deliveries','contacts','settings','graph'];
const focus=(process.env.LUME_PERF_FOCUS||'sales,today').split(',');assert.ok(focus.length&&focus.every(r=>supportedRoutes.includes(r))&&new Set(focus).size===focus.length);
const allRoutes=diagnostic?focus:supportedRoutes;
async function readiness(page){
  await page.waitForFunction(()=>![...document.querySelectorAll('[aria-busy="true"]')].some(n=>n.getClientRects().length));
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
}
async function perf(cdp){const r=await cdp.send('Performance.getMetrics');return Object.fromEntries(r.metrics.filter(m=>['TaskDuration','ScriptDuration','LayoutDuration','JSHeapUsedSize','Nodes','Documents'].includes(m.name)).map(m=>[m.name,m.value]));}
async function run(variant,pair,origin,warmup){
  const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light',reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(30000);
  const errors=[],requests=[],responses=[],failedRequests=[],blocked=[],inFlight=new Map();let assetBytes=0,contextClosing=false;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',r=>{const u=new URL(r.url());responses.push({target:u.pathname+u.search,path:u.pathname,status:r.status(),resourceType:r.request().resourceType(),at:performance.now()});});
  page.on('requestfailed',r=>{const u=new URL(r.url());failedRequests.push({target:u.pathname+u.search,method:r.method(),error:r.failure()?.errorText,at:performance.now(),contextClosing});});
  page.on('request',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/api/'))inFlight.set(r,{path:url.pathname,target:url.pathname+url.search,started:performance.now(),method:r.method()});});
  page.on('requestfinished',async r=>{const item=inFlight.get(r);if(!item)return;item.finished=performance.now();item.ms=item.finished-item.started;item.status=(await r.response())?.status();requests.push(item);});
  await page.route('**/*',route=>{
    const r=route.request(),url=new URL(r.url());
    if(url.origin!==origin||r.method()!=='GET'){blocked.push({path:url.pathname,method:r.method()});return route.abort();}
    if(url.pathname.startsWith('/api/'))return route.continue();
    const path=url.pathname==='/app'?'/app.html':decodeURIComponent(url.pathname),body=assets[variant].get(path);if(!body)return route.fulfill({status:404,body:'Snapshot asset absent'});
    assetBytes+=body.length;return route.fulfill({status:200,contentType:mime[extname(path)]||'application/octet-stream',body});
  });
  const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
  const started=performance.now(),startedAt=new Date().toISOString(),cpuStart=process.cpuUsage();
  await page.goto(origin+'/app',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!document.getElementById('workspace').hidden&&document.getElementById('lv-today')?.getAttribute('aria-busy')==='false'&&document.querySelector('#lv-today h1'));
  await page.evaluate(()=>document.fonts.ready);await readiness(page);
  const openingMs=performance.now()-started,openingPerformance=await perf(cdp);
  const sample={variant,pair,warmup,started:startedAt,startPerf:started,openingMs,openingPerformance,navigation:[],errors,requests,responses,failedRequests,blocked};
  const routeOrder=allRoutes.slice(pair%allRoutes.length).concat(allRoutes.slice(0,pair%allRoutes.length));
  for(const route of routeOrder){
    const before=await perf(cdp),t=performance.now();
    await page.evaluate(async route=>{if(route==='memory')window.lumeSetMemoryMode?.('search');await window.navegarLume(route);},route);await readiness(page);
    const ms=performance.now()-t,after=await perf(cdp);
    sample.navigation.push({route,ms,start:t,end:t+ms,renderer:{taskMs:(after.TaskDuration-before.TaskDuration)*1000,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,heapBytes:after.JSHeapUsedSize},visible:await page.locator('.view:visible').evaluateAll(nodes=>nodes.map(n=>n.id))});
    if(!diagnostic&&pair===1&&!warmup&&['today','contacts','graph'].includes(route))await page.screenshot({path:join(out,variant+'-'+route+'.png')});
  }
  sample.assetBytes=assetBytes;sample.serverAndHarnessCpuMicroseconds=process.cpuUsage(cpuStart);sample.performance=await perf(cdp);sample.totalMs=performance.now()-started;
  for(const row of sample.navigation){row.api=requests.filter(r=>r.started>=row.start&&r.started<=row.end).map(({path,target,ms,status})=>({path,target,ms,status}));row.server=report.serverRequests.filter(r=>r.started>=row.start&&r.started<=row.end);row.responses=responses.filter(r=>r.at>=row.start&&r.at<=row.end);}
  contextClosing=true;await context.close();sample.httpErrors=responses.filter(r=>r.status>=400);report.samples.push(sample);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  console.log(JSON.stringify({pair,variant,warmup,openingMs:Math.round(openingMs),routes:sample.navigation.map(r=>[r.route,Math.round(r.ms)])}));
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const stats=values=>{const v=[...values].sort((a,b)=>a-b);return{median:median(v),min:v[0],p25:v[Math.floor(v.length*.25)],p75:v[Math.floor(v.length*.75)],max:v.at(-1),samples:values};};
function analyze(){
  const samples=report.samples.filter(s=>!s.warmup),metrics=[];
  for(const name of ['opening',...allRoutes]){
    const extract=s=>name==='opening'?s.openingMs:s.navigation.find(n=>n.route===name)?.ms;
    const baseline=samples.filter(s=>s.variant==='baseline'),current=samples.filter(s=>s.variant==='current');
    const before=stats(baseline.map(extract)),after=stats(current.map(extract));
    const paired=baseline.map(b=>{const c=current.find(c=>c.pair===b.pair);return{pair:b.pair,before:extract(b),after:extract(c),deltaPercent:(extract(c)/extract(b)-1)*100};});
    const m={name,before,after,deltaMs:after.median-before.median,deltaPercent:(after.median/before.median-1)*100,paired,pairedMedianPercent:median(paired.map(p=>p.deltaPercent))};
    if(name!=='opening')m.renderer=Object.fromEntries(['taskMs','scriptMs','layoutMs'].map(k=>[k,{baseline:median(baseline.map(s=>s.navigation.find(n=>n.route===name).renderer[k])),current:median(current.map(s=>s.navigation.find(n=>n.route===name).renderer[k]))}]));
    metrics.push(m);
  }
  report.comparison={metrics,over10Percent:metrics.filter(m=>m.deltaPercent>10).map(m=>m.name)};
  const allResponses=report.samples.flatMap(s=>s.responses.map(r=>({...r,variant:s.variant,pair:s.pair,warmup:s.warmup})));
  report.httpReview={scope:'Every observed response: API and assets, all prefixes, including warmup. Failures do not disappear behind a route allowlist.',byVariant:{},nonSuccess:allResponses.filter(r=>r.status>=400),failedRequests:report.samples.flatMap(s=>s.failedRequests.map(r=>({...r,variant:s.variant,pair:s.pair,warmup:s.warmup}))),analysisRequired:allResponses.some(r=>r.status>=400)};
  for(const variant of ['baseline','current']){const rows=allResponses.filter(r=>r.variant===variant);report.httpReview.byVariant[variant]=Object.fromEntries([...new Set(rows.map(r=>r.target))].map(target=>[target,Object.fromEntries([...new Set(rows.filter(r=>r.target===target).map(r=>r.status))].map(status=>[status,rows.filter(r=>r.target===target&&r.status===status).length]))]));}
  report.httpReview.failedBeforeClose=report.httpReview.failedRequests.filter(r=>!r.contextClosing);report.httpReview.analysisRequired ||= report.httpReview.failedBeforeClose.length>0;
  report.performanceAssessment={status:report.comparison.over10Percent.length?'diagnostic-required':'measured-within-threshold',automaticProductApproval:false,reason:'Any route above10% needs a causal investigation; a completed benchmark does not itself approve the product or8GB hardware.'};
  for(const name of report.comparison.over10Percent){
    const metric=metrics.find(m=>m.name===name);metric.investigation={status:'measured, investigate request/render evidence below',apiByVariant:{}};
    for(const variant of ['baseline','current']){
      const list=samples.filter(s=>s.variant===variant).flatMap(s=>name==='opening'?s.requests.filter(r=>r.started>=s.startPerf&&r.started<=s.startPerf+s.openingMs):s.navigation.find(n=>n.route===name).api);
      metric.investigation.apiByVariant[variant]=Object.fromEntries([...new Set(list.map(r=>r.path))].map(path=>{const rows=list.filter(r=>r.path===path);return[path,{count:rows.length,medianMs:median(rows.map(r=>r.ms)),maxMs:Math.max(...rows.map(r=>r.ms))}];}));
    }
  }
}
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});report.browserVersion=browser.version();
  await run('baseline',0,origin,true);await run('current',0,origin,true);
  for(let pair=1;pair<=rounds;pair++)for(const variant of pair%2?['baseline','current']:['current','baseline'])await run(variant,pair,origin,false);
  assert.equal(fixtureHash(),report.fixture.hashBefore);assert.equal(externalAttempts,0);analyze();
  assert.deepEqual(report.httpReview.nonSuccess,[],'All HTTP responses must be analyzed; non-success remains a failed gate, including legacy compatibility endpoints.');
  assert.deepEqual(report.httpReview.failedBeforeClose,[],'Requests failed during the measured application flow; cancellation after context closing is recorded separately.');
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{
  await writeFile(join(out,'checkpoint-before-close.json'),JSON.stringify({...report,encerramentoPendente:true},null,2));
  await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await pessoal.encerrar();report.fixture.hashAfter=fixtureHash();db.close();report.externalAttempts=externalAttempts;report.finished=new Date().toISOString();await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({failure:report.failure||null,comparison:report.comparison?.metrics.map(({name,deltaPercent,deltaMs})=>({name,deltaPercent,deltaMs})),over10:report.comparison?.over10Percent}));
}

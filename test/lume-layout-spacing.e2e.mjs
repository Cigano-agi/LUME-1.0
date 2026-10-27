// Real HTTP/SQLite with synthetic content only. Baseline assets come from Git.
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,extname} from 'node:path';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {CompanheiroPessoal} from '../src/pessoal/companheiro.js';
import {AtividadeApps} from '../src/atividade-apps.js';
import {Novidades} from '../src/novidades.js';
import {criarServidor} from '../src/painel/servidor.js';
if(!process.argv.includes('--run')){console.log('PREPARADO: --run [--baseline] creates synthetic screenshots, never uses the personal profile.');process.exit(0);}
const baseline=process.argv.includes('--baseline'),appearanceOnly=process.argv.includes('--appearance-only'),ref=process.argv.find(arg=>arg.startsWith('--baseline-ref='))?.slice('--baseline-ref='.length)||'d1dd9ac';
if(!/^[0-9a-f]{7,40}$/i.test(ref))throw Error('BASELINE_REF_MUST_BE_COMMIT_SHA');
const output=resolve('work/lume-layout-20261027',`${baseline?'checkout-baseline':'checkout-current'}-${Date.now()}`);await mkdir(output,{recursive:true});
const report={started:new Date().toISOString(),synthetic:true,baseline,appearanceOnly,baselineRef:baseline?ref:null,scope:'Isolated headless browser, real HTTP/SQLite, synthetic content, CSS zoom200 not native OS zoom',screens:[],measurements:[],violations:[],errors:[],external:0};
const db=abrirBanco(':memory:'),desktop=new Desktop(db);new ContextoApp(db);desktop.aceitar({nome:'Ensaio de espaçamento · fictício',aceito:true,versao:VERSAO_TERMOS});desktop.configurarGuia({dispensado:true});
const forbidden=()=>{report.external++;throw Error('External forbidden in synthetic QA');};
const conexao={estado:()=>({estado:'desconectada',qr:null}),enviarTexto:forbidden,parar:async()=>{}};
const pessoal=new LumePessoal(db,{desktop,conexao,chatgpt:{estado:async()=>({available:false,connected:false,accounts:[]}),modelos:async()=>[],encerrar(){},responder:forbidden},telegram:{estado:async()=>({enabled:false}),agendar:forbidden},fetchImpl:forbidden});
pessoal.companheiro=new CompanheiroPessoal(db,{pessoal,conexao,publicar(){}});
const atividadeApps=new AtividadeApps(db,{disponivel:true,coletar:async()=>null}),novidades=new Novidades(db,{versao:'3.2.0-beta.8',buscar:forbidden});
for(let p=1;p<=3;p++){
 const person='55000000000'+p+'@s.whatsapp.net';db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(person,'Pessoa fictícia '+p);
 for(let i=0;i<3;i++){const texto='Revisar material de ensaio '+i+'. Dados fictícios.';const id=Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada',?,0,'texto','{}',?,'2026-10-27T12:00:00.000Z','2026-10-27','dirigida')`).run(person,'layout-'+p+'-'+i,person,texto).lastInsertRowid);pessoal.contexto.registrarDemanda({eventoId:id,resumo:'Material fictício '+p+'-'+i,trecho:texto,tipo:'pendencia'});}
}
const server=criarServidor(db,{desktop:true,pessoal,conexao,atividadeApps,novidades});let browser,page;
const save=()=>writeFile(output+'/result.json',JSON.stringify(report,null,2)+'\n');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function click(selector){await page.locator(selector).evaluate(n=>n.click());}
async function openDetails(selector){if(!await page.locator(selector).evaluate(n=>n.open))await click(selector+' > summary');}
async function settled(){await page.waitForFunction(()=>![...document.querySelectorAll('[aria-busy="true"]')].some(n=>n.getClientRects().length),{},{timeout:15000});await pause(100);}
async function settings(group){await click('.sidebar [data-view="settings"]');await settled();if(group)await click('#settings-choice-'+group);}
async function shot(name,{scrollSelector}={}){
 await settled();await page.evaluate(()=>window.scrollTo(0,0));
 if(scrollSelector)await page.locator(scrollSelector).evaluate(n=>n.scrollIntoView({block:'center'}));
 const measurement=await page.evaluate(()=>{
  const zoom=Number(getComputedStyle(document.documentElement).zoom)||1;
  const visible=n=>n.getClientRects().length&&n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0;
  const rect=n=>{const r=n.getBoundingClientRect();return{x:r.x/zoom,y:r.y/zoom,w:r.width/zoom,h:r.height/zoom};};
  const groups=[],violations=[];
  for(const [selector,min]of[['#lv-global-search',12],['.l1-global-controls',12],['.lv-toolbar',12],['.lv-memory-more-actions',12],['.lv-filters',12],['.settings-choices',16],['.settings-group-cards',16],['.l1-people-list',16]]){
   for(const group of[...document.querySelectorAll(selector)].filter(visible)){
    const children=[...group.children].filter(visible),bounds=children.map(rect),style=getComputedStyle(group),pairs=[];
    for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){
     const a=bounds[i],b=bounds[j],overX=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),overY=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
     let axis,gap;if(overX>1&&overY>1){axis='overlap';gap=-Math.min(overX,overY);}else if(overY>1){axis='horizontal';gap=Math.max(a.x,b.x)-Math.min(a.x+a.w,b.x+b.w);}else if(overX>1){axis='vertical';gap=Math.max(a.y,b.y)-Math.min(a.y+a.h,b.y+b.h);}else continue;
     pairs.push({i,j,axis,gap});if(gap<min-.5)violations.push({selector,axis,gap,min,i,j});
    }
    groups.push({selector,min,padding:style.padding,gap:style.gap,bounds,pairs});
   }
  }
  for(const input of [...document.querySelectorAll('#lv-preferences-form input[type="checkbox"]')].filter(visible)){
   const label=input.closest('label'),text=[...label.childNodes].find(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim());if(!text)continue;
   const range=document.createRange(),content=text.textContent;range.setStart(text,content.search(/\S/));range.setEnd(text,content.trimEnd().length);const r=[...range.getClientRects()].find(r=>r.width>0&&r.height>0);if(!r)continue;
   const a=rect(input),b={x:r.x/zoom,y:r.y/zoom,w:r.width/zoom,h:r.height/zoom},overlapY=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
   groups.push({selector:'#'+input.id+'-label',input:a,text:b,overlapY});if(overlapY<=0)violations.push({selector:'checkbox-label-alignment',input:input.id,overlapY});
  }
  const search=document.querySelector('#lv-global-search'),controls=document.querySelector('.l1-global-controls'),header=document.querySelector('.lv-global-header'),main=document.querySelector('.workspace main');
  if(search&&controls&&visible(search)&&visible(controls)){const a=rect(search),b=rect(controls),gap=b.y-a.y-a.h;groups.push({selector:'search-to-controls',gap,min:12});if(gap<11.5)violations.push({selector:'search-to-controls',gap,min:12});}
  if(main&&search&&visible(search)){const m=rect(main),s=rect(search),gutters={left:s.x-m.x,right:m.x+m.w-s.x-s.w};groups.push({selector:'global-gutters',...gutters,min:16});if(gutters.left<15.5||gutters.right<15.5)violations.push({selector:'global-gutters',...gutters,min:16});}
  const overflow=document.documentElement.scrollWidth>innerWidth+1;if(overflow)violations.push({selector:'document',overflow:true});
  return{viewport:{width:innerWidth,height:innerHeight},zoom,headerPresent:!!header,groups,violations,overflow};
 });
 const path=output+'/'+name+'.png';await page.screenshot({path,fullPage:false});report.screens.push({name,path});report.measurements.push({name,...measurement});report.violations.push(...measurement.violations.map(v=>({name,...v})));await save();console.log(JSON.stringify({shot:name,violations:measurement.violations.length,path}));
}
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const gitFiles=baseline?new Set(execFileSync('git',['ls-tree','-r','--name-only',ref,'--','src/painel'],{encoding:'utf8'}).trim().split(/\r?\n/)):null,cache=new Map();
 const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--mute-audio']});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(15000);
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){report.external++;return route.abort();}if(baseline&&route.request().method()==='GET'&&!u.pathname.startsWith('/api/')){const path='src/painel/'+(['/','/app'].includes(u.pathname)?'app.html':decodeURIComponent(u.pathname.slice(1)));if(gitFiles.has(path)){if(!cache.has(path))cache.set(path,execFileSync('git',['show',ref+':'+path],{maxBuffer:20*1024*1024}));return route.fulfill({body:cache.get(path),contentType:types[extname(path)]||'application/octet-stream'});}}return route.continue();});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(origin+'/app',{waitUntil:'load'});await page.locator('#workspace').waitFor();await page.evaluate(()=>document.fonts.ready);
 for(const theme of['light','dark']){
  await page.locator('#l1-global-theme').evaluate((n,value)=>{n.value=value;n.dispatchEvent(new Event('change',{bubbles:true}));},theme);await page.waitForFunction(t=>document.documentElement.dataset.theme===t,theme);
  for(const width of appearanceOnly?[1440,1024,512]:[1440,1024]){
   await page.setViewportSize({width,height:width===1440?1000:width===512?384:768});const suffix=theme+'-'+width;
   for(const view of appearanceOnly?[]:['today','memory','sales','deliveries','contacts']){await click('.sidebar [data-view="'+view+'"]');await shot(view+'-'+suffix);}
   if(!appearanceOnly){await settings();await shot('settings-'+suffix);}
   for(const group of appearanceOnly?['appearance']:['connections','work','appearance','data']){await settings(group);await shot('settings-'+group+'-'+suffix,appearanceOnly&&width===512?{scrollSelector:'#lv-pref-enabled'}:{});}
   if(appearanceOnly&&width===1440)await shot('appearance-volume-preview-'+suffix,{scrollSelector:'#lv-pref-volume'});
   if(appearanceOnly&&width===512){await page.locator('#l1-global-theme').focus();await page.keyboard.press('Tab');const focused=await page.evaluate(()=>({id:document.activeElement?.id,visible:!!document.activeElement?.getClientRects().length}));report.keyboard??=[];report.keyboard.push({theme,width,scope:'Isolated browser CDP Tab only',...focused});if(focused.id!=='l1-global-sound'||!focused.visible)report.violations.push({name:suffix,selector:'keyboard-global-sound',focused});}
   if(appearanceOnly)continue;
   await click('.sidebar [data-view="memory"]');await openDetails('#lv-memory-tools details');await shot('memory-more-'+suffix);await openDetails('#lv-memory-filters');await shot('memory-filters-'+suffix);
   await click('.sidebar [data-view="today"]');await click('#l1-sound-summary');await shot('sound-open-'+suffix);await click('#l1-sound-summary');
   await click('#l1-global-central');await shot('central-'+suffix);await page.evaluate(()=>document.querySelector('dialog[open]')?.close());
  }
  await page.setViewportSize({width:1024,height:768});await page.evaluate(()=>document.documentElement.style.zoom='2');
  for(const view of appearanceOnly?[]:['today','memory','contacts']){await click('.sidebar [data-view="'+view+'"]');await shot(view+'-'+theme+'-1024-zoom200');}
  for(const group of appearanceOnly?['appearance']:['appearance','data']){await settings(group);await shot('settings-'+group+'-'+theme+'-1024-zoom200');}
  if(!appearanceOnly){await click('#l1-sound-summary');await shot('sound-open-'+theme+'-1024-zoom200');await click('#l1-sound-summary');}await page.evaluate(()=>document.documentElement.style.zoom='1');
 }
 report.status=baseline?'baseline-observed':report.violations.length||report.errors.length||report.external?'failed':'passed';if(!baseline&&report.status==='failed')process.exitCode=1;
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;}
finally{report.finished=new Date().toISOString();await save();await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await atividadeApps.encerrar();await pessoal.encerrar();db.close();console.log(JSON.stringify({status:report.status,screens:report.screens.length,violations:report.violations.length,output}));}

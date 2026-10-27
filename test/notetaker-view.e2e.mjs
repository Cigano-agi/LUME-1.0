import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const files = new Map([
  ['/', ['test/fixtures/notetaker-view/index.html', 'text/html; charset=utf-8']],
  ...['lume-theme.css','lume-dark.css','beta05.css','notetaker.css','notetaker-view.js'].map(name => [`/${name}`, [`src/painel/${name}`, name.endsWith('.css') ? 'text/css' : 'text/javascript']])
]);
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const font = path.startsWith('/fonts/') && /^[\w.-]+\.woff2$/.test(path.slice(7));
  const match = font ? [`src/painel${path}`, 'font/woff2'] : files.get(path);
  if (!match) { res.writeHead(404); res.end(); return; }
  try { const bytes = await readFile(join(root, match[0])); res.writeHead(200, { 'content-type': match[1] }); res.end(bytes); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = join(root, 'work/beta07-notetaker-view/capturas');
await mkdir(output, {recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:true});
const page = await browser.newPage({viewport:{width:1440,height:900}});
const errors=[]; const external=[];
page.on('pageerror', e=>errors.push(e.message));
page.on('request', req=>{if(!req.url().startsWith(origin)) external.push(req.url());});
const fit = async label => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`horizontal overflow: ${label}`);
const shot = async (name,width,height=900) => {await page.setViewportSize({width,height}); await page.waitForTimeout(250); await fit(name); await page.screenshot({path:join(output,`${name}.png`),fullPage:true});};
try {
  await page.goto(origin);
  await page.locator('.nt-view').waitFor();
  for (const name of ['vazio','importando','gravando','pausado','interrompido','processando','modelo-ausente','revisavel','silencio','audio-ausente','erro']) {
    await page.evaluate(n=>window.showState(n),name);
    assert.equal(await page.locator('.nt-view').getAttribute('data-state'), ['silencio','audio-ausente'].includes(name)?'revisavel':name);
    assert.ok((await page.locator('.nt-state').textContent()).trim());
    await fit(name);
  }
  await page.evaluate(()=>window.showState('revisavel'));
  await page.evaluate(()=>window.setActionHandler('ouvir',payload=>new Promise(resolve=>{window.resolveListen=()=>{window.calls.push(payload);resolve()}})));
  await page.getByRole('button',{name:'Ouvir original'}).click();
  assert.equal(await page.getByRole('button',{name:'Ouvir original'}).isDisabled(),true);
  await page.evaluate(()=>window.resolveListen());
  await page.waitForTimeout(20);
  assert.equal(await page.getByRole('button',{name:'Ouvir original'}).isEnabled(),true,'ouvir deve voltar após callback resolvido sem snapshot');
  assert.equal(await page.evaluate(()=>window.showState('revisavel')),false,'snapshot idêntico não cria nova renderização');
  await page.evaluate(()=>{window.setActionHandler('ouvir',payload=>window.calls.push(payload));window.showState('vazio')});
  await page.locator('[data-action="selecionar-entrada"]').first().click();
  await page.waitForTimeout(20);
  assert.equal(await page.locator('[data-action="selecionar-entrada"]').first().isEnabled(),true,'seleção sem snapshot não pode travar');
  await page.evaluate(()=>window.showState('revisavel'));
  await page.getByRole('button',{name:'Criar ação'}).first().click();
  await page.waitForTimeout(20);
  assert.equal(await page.getByRole('button',{name:'Criar ação'}).first().isEnabled(),true,'mutação com resposta no-op não pode travar');
  assert.doesNotMatch(await page.locator('.nt-action-feedback').textContent(),/concluíd|salv[ao]/i);
  await page.evaluate(()=>{
    window.setActionHandler('criar-acao',payload=>window.calls.push(payload));
    window.updateRaw({...window.states.revisavel,id:'sessao-a'});
    document.querySelector('[data-action="criar-acao"]').click();
    window.updateRaw({...window.states.revisavel,id:'sessao-b'});
  });
  await page.waitForFunction(()=>window.calls.at(-1)?.sessaoId==='sessao-a');
  assert.equal(await page.evaluate(()=>window.calls.at(-1).sessaoId),'sessao-a','payload deve ser capturado no clique');
  await page.evaluate(()=>{
    window.setActionHandler('criar-acao',payload=>new Promise(resolve=>{window.calls.push(payload);window.resolveLate=resolve}));
    window.updateRaw({...window.states.revisavel,id:'sessao-tardia-a'});
    document.querySelector('[data-action="criar-acao"]').click();
  });
  await page.waitForFunction(()=>typeof window.resolveLate==='function');
  await page.evaluate(()=>window.updateRaw({...window.states.revisavel,id:'sessao-tardia-b',titulo:'Sessão B'}));
  await page.evaluate(()=>window.resolveLate());
  await page.waitForTimeout(20);
  assert.equal(await page.locator('[data-action="criar-acao"]').first().isEnabled(),true,'resposta tardia não bloqueia nova sessão');
  assert.equal(await page.locator('.nt-action-feedback').textContent(),'','resposta tardia não altera UI nova');
  assert.match(await page.locator('.nt-hero h1').textContent(),/Sessão B/);
  await page.evaluate(()=>{
    window.setActionHandler('criar-acao',payload=>new Promise((_,reject)=>{window.calls.push(payload);window.rejectLate=reject}));
    window.updateRaw({...window.states.revisavel,id:'sessao-rejeitada-a'});
    document.querySelector('[data-action="criar-acao"]').click();
  });
  await page.waitForFunction(()=>typeof window.rejectLate==='function');
  await page.evaluate(()=>window.updateRaw({...window.states.revisavel,id:'sessao-rejeitada-b',titulo:'Sessão após erro tardio'}));
  await page.evaluate(()=>window.rejectLate(new Error('falha sintética')));
  await page.waitForTimeout(20);
  assert.match(await page.locator('.nt-hero h1').textContent(),/Sessão após erro tardio/);
  assert.equal(await page.locator('.nt-action-feedback').textContent(),'');
  await page.evaluate(()=>{window.setActionHandler('criar-acao',payload=>window.calls.push(payload));window.showState('vazio');window.showState('revisavel')});
  await page.getByRole('button',{name:'Criar ação'}).first().click();
  assert.equal(await page.evaluate(()=>window.calls.at(-1)?.acao),'criar-acao');
  assert.match(await page.locator('.nt-state').textContent(),/Pronta para revisar/);
  assert.match(await page.locator('.nt-action-feedback').textContent(),/Ainda sem confirmação/);
  await page.evaluate(()=>window.showState('audio-ausente'));
  assert.equal(await page.locator('[data-action="criar-acao"]').count(),0);
  await page.evaluate(()=>window.showState('gravando'));
  assert.equal(await page.getByRole('button',{name:'Parar'}).count(),1);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
  assert.equal(await page.getByRole('button',{name:'Parar'}).evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}),true);
  await page.getByRole('button',{name:'Parar'}).click();
  assert.equal(await page.evaluate(()=>window.calls.at(-1)?.acao),'parar');
  assert.match(await page.locator('.nt-state').textContent(),/Gravando/);
  await page.evaluate(()=>window.showState('revisavel'));
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('nt-state')),true);
  assert.equal(await page.locator('.nt-button').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height>=44)),true);
  for(const width of [390,820,1440]) for(const theme of ['light','dark']) {
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await shot(`${width}-${theme}-revisavel`,width);
  }
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.evaluate(()=>window.showState('vazio'));
  await shot('390-light-vazio',390,844);
  await page.evaluate(()=>window.showState('gravando'));
  await shot('390-light-gravando',390,844);
  await page.evaluate(()=>window.showState('silencio'));
  await shot('820-light-silencio-lacuna',820);
  await page.evaluate(()=>window.showState('audio-ausente'));
  await shot('820-light-audio-ausente',820);
  await page.evaluate(()=>window.showState('erro'));
  await shot('390-light-erro',390,844);
  await page.evaluate(()=>window.showState('revisavel'));
  const zoomPage=await browser.newPage({viewport:{width:720,height:900},deviceScaleFactor:2});
  await zoomPage.goto(origin);
  await zoomPage.evaluate(()=>window.showState('gravando'));
  await zoomPage.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
  assert.equal(await zoomPage.getByRole('button',{name:'Parar'}).evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}),true);
  assert.equal(await zoomPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await zoomPage.evaluate(()=>window.showState('revisavel'));
  assert.equal(await zoomPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await zoomPage.waitForTimeout(250);
  await zoomPage.screenshot({path:join(output,'proxy720-2x.png'),fullPage:true});
  await zoomPage.close();
  const cssZoomPage=await browser.newPage({viewport:{width:1440,height:900}});
  await cssZoomPage.goto(origin);
  await cssZoomPage.evaluate(()=>{window.showState('gravando');document.documentElement.style.zoom='2';scrollTo(0,document.documentElement.scrollHeight);});
  assert.equal(await cssZoomPage.getByRole('button',{name:'Parar'}).evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight}),true);
  assert.equal(await cssZoomPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await cssZoomPage.evaluate(()=>window.showState('revisavel'));
  assert.equal(await cssZoomPage.evaluate(()=>{const grid=document.querySelector('.nt-grid');return grid.firstElementChild.getBoundingClientRect().width>=grid.getBoundingClientRect().width-2}),true);
  assert.equal(await cssZoomPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await cssZoomPage.waitForTimeout(250);
  await cssZoomPage.screenshot({path:join(output,'1440-csszoom200.png'),fullPage:true});
  await cssZoomPage.close();
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>window.showState('pausado'));
  assert.equal(await page.locator('.nt-enter').evaluate(el=>getComputedStyle(el).animationName),'none');
  await shot('820-reduced-motion',820);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'BUTTON');
  await shot('820-focus',820);
  await page.evaluate(()=>window.destroyView());
  assert.equal(await page.locator('.nt-view').count(),0);
  assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
  console.log(`OK: vista isolada, estados, callbacks, tema, foco e capturas em ${output}`);
} finally { await browser.close(); await new Promise(r=>server.close(r)); }

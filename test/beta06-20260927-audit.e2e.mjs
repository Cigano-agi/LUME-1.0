// Recorte visual audit-prod, 27/09/2026. API e HTML reais, perfil sintético isolado.
import {chromium} from 'playwright';
import {mkdirSync, writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {prepararEsquemaPessoas, registrarPessoa} from '../src/pessoas.js';
import {AcoesLume} from '../src/acoes-lume.js';

const output = 'docs/beta-06/evidencias-ui/2026-09-27-audit';
mkdirSync(output, {recursive:true});
const db = abrirBanco(':memory:');
const {contexto, desktop, fontes, mensagem} = perfilBeta05(db, {agora:new Date('2026-09-27T14:00:00Z')});
prepararEsquemaPessoas(db);
for (const [i,nome,texto] of [
  [1,'Ana Ribeiro','Envio os documentos para a revisão.'],
  [2,'Marcos Almeida','Podemos alinhar a proposta.'],
  [3,'Clara Martins','Obrigada pelo retorno.']
]) {
  const conversa=`551199999000${i}@s.whatsapp.net`;
  registrarPessoa(db,{identificador:conversa,nomeCru:nome,origem:'manual'});
  mensagem({conversa,nome,texto});
}
const actions = new AcoesLume(db);
actions.autorizar({conversa:'demo-ana',permitida:true});
actions.registrar({eventoId:fontes.ana.id,candidatas:[{fonte:'E'+fontes.ana.id,tipo:'compromisso',resumo:'Preparar a reunião de revisão com Ana',trecho:'Nossa reunião de revisão ficou para 24/09 às 10h.',prazo_citado:'24/09 às 10h'}]});
desktop.configurarGuia({dispensado:true});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{throw Error('Conexão vedada no ensaio');}}});
let browser;
const evidence={date:'2026-09-27',synthetic:true,origin:'app.html/API em memória',screens:[],errors:[],external:[],checks:[]};
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  page.on('pageerror',e=>evidence.errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith(origin)) evidence.external.push(r.url());});
  await page.route(/^(?!http:\/\/127\.0\.0\.1:).*$/u,route=>route.abort());
  await page.goto(origin+'/app');
  await page.locator('#clarity-content:not([hidden])').waitFor();
  const measure=async(view,theme,width)=>{
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(100);
    const file=`${view}-${theme}-${width}.png`;
    await page.screenshot({path:`${output}/${file}`,fullPage:view!=='resolver'});
    const metrics=await page.evaluate(view=>{
      const root=view==='resolver'?document.querySelector('#resolver-dialog'):document.documentElement;
      const banner=document.querySelector('#luminus-banner');
      const cta=document.querySelector('#luminus-body .resolver-open');
      const person=document.querySelector('.contact-card h3');
      const label=document.querySelector('.acoes06-card .action-type-label');
      const css=n=>n?getComputedStyle(n):null;
      const box=n=>n?.getBoundingClientRect().toJSON()??null;
      return {overflow:root.scrollWidth>root.clientWidth,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,
        scrollHeight:root.scrollHeight,clientHeight:root.clientHeight,
        bannerBackground:css(banner)?.backgroundImage,primaryCta:box(cta),
        contactColor:css(person)?.color,actionColor:css(label)?.color,
        activeElement:document.activeElement?.outerHTML.slice(0,200),
        focusVisible:document.activeElement?.matches(':focus-visible')??false,
        runningAnimations:root.getAnimations({subtree:true}).filter(a=>a.playState==='running').length,
        visibleButtons:[...document.querySelectorAll('main button, #resolver-dialog button')].filter(n=>{const r=n.getBoundingClientRect();return r.width&&r.height&&r.top<innerHeight&&r.bottom>0}).slice(0,24).map(n=>n.textContent.trim().replace(/\s+/g,' ').slice(0,60))};
    },view);
    evidence.screens.push({view,theme,width,file,...metrics});
  };
  for(const theme of ['light','dark']){
    if(theme==='dark'){
      await page.locator('nav [data-view=settings]').click();
      await page.locator('#settings-choice-data').click();
      await page.locator('#theme-mode').selectOption('dark');
    }
    await page.locator('nav [data-view=today]').click();
    await page.locator('#luminus-body .resolver-open').first().waitFor();
    for(const width of [1440,390])await measure('today',theme,width);
    await page.locator('#luminus-body .resolver-open').first().focus();
    const trigger=await page.locator('#luminus-body .resolver-open').first().elementHandle();
    evidence.checks.push({theme,check:'resolver-trigger-focus',value:await page.locator('#luminus-body .resolver-open').first().evaluate(n=>({focused:document.activeElement===n,focusVisible:n.matches(':focus-visible')}))});
    await page.keyboard.press('Enter');
    await page.locator('#resolver-dialog[open]').waitFor();
    for(const width of [1440,390])await measure('resolver',theme,width);
    await page.locator('#resolver-dialog').getByRole('button',{name:'Autorizar contexto →'}).focus();
    evidence.checks.push({theme,check:'resolver-mobile-action-reachable',value:await page.evaluate(()=>{const d=document.querySelector('#resolver-dialog'),b=[...d.querySelectorAll('button')].find(n=>n.textContent.includes('Autorizar contexto'));const x=b.getBoundingClientRect(),y=d.getBoundingClientRect();return {buttonExists:!!b,focused:document.activeElement===b,buttonBottom:x.bottom,dialogBottom:y.bottom,withinViewport:x.top>=0&&x.bottom<=innerHeight,dialogScrollTop:d.scrollTop,dialogScrollHeight:d.scrollHeight,dialogClientHeight:d.clientHeight};})});
    const tab=[];
    for(let i=0;i<12;i++){
      await page.keyboard.press('Tab');
      tab.push(await page.evaluate(()=>({inside:document.querySelector('#resolver-dialog').contains(document.activeElement),tag:document.activeElement.tagName,text:document.activeElement.textContent?.trim().slice(0,40)})));
    }
    evidence.checks.push({theme,check:'resolver-tab-cycle',value:tab});
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    evidence.checks.push({theme,check:'resolver-escape-return',value:await trigger.evaluate(n=>({closed:!document.querySelector('#resolver-dialog').open,triggerConnected:n.isConnected,focusReturned:document.activeElement===n,active:document.activeElement?.tagName,activeClass:document.activeElement?.className?.toString().slice(0,120)}))});
    await page.locator('nav [data-route=contacts]').click();
    await page.waitForFunction(()=>document.querySelector('#memory').dataset.mode==='contacts');
    await page.locator('.contact-card').first().waitFor();
    for(const width of [1440,390])await measure('people',theme,width);
    await page.keyboard.press('Tab');
    evidence.checks.push({theme,check:'people-tab',value:await page.evaluate(()=>({element:document.activeElement?.outerHTML.slice(0,200),focusVisible:document.activeElement?.matches(':focus-visible')}))});
  }
  writeFileSync(`${output}/evidence.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({ok:true,output,screens:evidence.screens.length,errors:evidence.errors,external:evidence.external,checks:evidence.checks.map(c=>c.check)}));
} catch(error){
  evidence.failure={message:error.message,stack:error.stack};
  writeFileSync(`${output}/evidence.json`,JSON.stringify(evidence,null,2));
  console.error(error);
  process.exitCode=1;
} finally {
  if(browser)await browser.close();
  if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  db.close();
}

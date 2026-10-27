// 03A33 visual QA: real local API/renderer, synthetic in-memory profile only.
import {chromium} from 'playwright';
import {mkdirSync,writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {registrarPessoa} from '../src/pessoas.js';
import {AcoesLume} from '../src/acoes-lume.js';

const output=process.argv[2]||process.env.LUME_03A33_OUTPUT||'docs/beta-06/evidencias-ui/03A33-2026-09-27';
mkdirSync(output,{recursive:true});
const db=abrirBanco(':memory:'),now=new Date('2026-09-27T15:00:00Z');
const {contexto,desktop,fontes,mensagem}=perfilBeta05(db,{agora:now});
const direct='5511999990001@s.whatsapp.net';
registrarPessoa(db,{identificador:direct,nomeCru:'Ana Ribeiro',origem:'manual'});
const directSource=mensagem({conversa:direct,nome:'Ana Ribeiro',texto:'Combinamos preparar a revisão amanhã.',data:now.toISOString()});
const actions=new AcoesLume(db,{agora:()=>now});
for(const conversation of ['demo-ana','demo-marcos',direct])actions.autorizar({conversa:conversation,permitida:true});
const candidate=(source,summary,excerpt)=>actions.registrar({eventoId:source.id,candidatas:[{fonte:'E'+source.id,tipo:'compromisso',resumo:summary,trecho:excerpt,prazo_citado:''}]});
candidate(fontes.ana,'Preparar a reunião de revisão com Ana','Nossa reunião de revisão ficou para 24/09 às 10h.');
candidate(directSource,'Preparar revisão','Combinamos preparar a revisão amanhã.');
candidate(fontes.marcos,'Conferir escopo com Marcos','Quero conversar sobre o escopo antes de decidir.');
const confirmed=actions.listar({estado:'sugerido'}).find(item=>item.evento_id===fontes.ana.id);
actions.revisar({id:confirmed.id,acao:'confirmar'});
const directAction=actions.listar({estado:'sugerido'}).find(item=>item.evento_id===directSource.id);
actions.revisar({id:directAction.id,acao:'confirmar'});
desktop.configurarGuia({dispensado:true});
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{},iniciar:async()=>{throw Error('Conexão vedada no ensaio');}}});
const evidence={synthetic:true,head:'03A33',screens:[],checks:[],errors:[],external:[]};
let browser;
const check=(name,value)=>{evidence.checks.push({name,value});if(value!==true)throw Error(name+': '+JSON.stringify(value));};
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  page.on('pageerror',error=>evidence.errors.push(error.message));
  page.on('request',request=>{if(!request.url().startsWith(origin))evidence.external.push(request.url());});
  await page.route(/^(?!http:\/\/127\.0\.0\.1:).*$/u,route=>route.abort());
  await page.goto(origin+'/app');
  await page.locator('#luminus-body .resolver-open').waitFor();
  const inspect=async(view,theme,width)=>{
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(100);
    const file=`${view}-${theme}-${width}.png`;
    await page.screenshot({path:`${output}/${file}`,fullPage:view!=='resolver'});
    const measurement=await page.evaluate(view=>{
      const root=view==='resolver'?document.querySelector('#resolver-dialog'):document.documentElement;
      const controls=[...document.querySelectorAll('#luminus-body .acoes06-card,.acoes06-list .acoes06-card')].map(card=>({id:card.dataset.acao,primary:card.querySelectorAll('.button-row>button.primary').length}));
      const list=document.querySelector('#contact-list'),filter=document.querySelector('#contact-filters');
      const summary=document.querySelector('.acoes06-list .acoes06-options>summary'),card=summary?.closest('.acoes06-card');
      const rgb=value=>(value?.match(/[\d.]+/gu)||[]).slice(0,3).map(Number);
      const luminance=value=>{const parts=rgb(value).map(x=>{const v=x/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return parts.length===3?parts[0]*.2126+parts[1]*.7152+parts[2]*.0722:null;};
      const textL=luminance(summary?getComputedStyle(summary).color:null),backgroundL=luminance(card?getComputedStyle(card).backgroundColor:null);
      return{overflow:root.scrollWidth>root.clientWidth,scrollWidth:root.scrollWidth,clientWidth:root.clientWidth,
        cardActions:controls,peopleBeforeFilter:list&&filter?list.getBoundingClientRect().top<filter.getBoundingClientRect().top:null,
        lastContact:document.querySelector('.contact-card:last-child')?.getBoundingClientRect().bottom,
        summaryContrast:textL===null||backgroundL===null?null:(Math.max(textL,backgroundL)+.05)/(Math.min(textL,backgroundL)+.05),
        runningAnimations:root.getAnimations({subtree:true}).filter(a=>a.playState==='running').length};
    },view);
    evidence.screens.push({view,theme,width,file,...measurement});
    check(`${view}-${theme}-${width}-overflow`,measurement.overflow===false);
    if(view==='today'){
      check(`${view}-${theme}-${width}-one-primary`,measurement.cardActions.every(x=>x.primary<=1));
      check(`${view}-${theme}-${width}-summary-contrast`,measurement.summaryContrast>=4.5);
    }
    if(view==='people')check(`${view}-${theme}-${width}-list-first`,measurement.peopleBeforeFilter===true);
  };
  for(const theme of ['light','dark']){
    if(theme==='dark'){
      await page.locator('nav [data-view=settings]').click();
      await page.locator('#settings-choice-data').click();
      await page.locator('#theme-mode').selectOption('dark');
    }
    await page.locator('nav [data-view=today]').click();
    await page.locator('#luminus-body .resolver-open').waitFor();
    for(const width of [390,820,1440])await inspect('today',theme,width);
    const trigger=page.locator('#luminus-body .resolver-open').first();
    await trigger.focus();await page.keyboard.press('Enter');await page.locator('#resolver-dialog[open]').waitFor();
    for(const width of [390,820,1440])await inspect('resolver',theme,width);
    await page.keyboard.press('Escape');
    check(`resolver-${theme}-focus-return`,await trigger.evaluate(node=>document.activeElement===node&&!document.querySelector('#resolver-dialog').open));
    await page.locator('nav [data-route=contacts]').click();
    await page.locator('.contact-card').first().waitFor();
    for(const width of [390,820,1440])await inspect('people',theme,width);
    check(`people-${theme}-source`,await page.locator('.contact-card').first().getByRole('button',{name:'Ver compromisso'}).count()>0);
    check(`people-${theme}-period`,(await page.locator('#contact-order').textContent()).includes('Últimos 7 dias'));
    await page.locator('.contact-card').first().getByRole('button',{name:'Ver compromisso'}).click();
    await page.locator('#results .source').first().waitFor();
    await page.waitForFunction(()=>document.querySelector('#search-context')?.textContent.includes('Fonte E'));
    check(`people-${theme}-source-opened`,(await page.locator('#search-context').textContent()).includes('Fonte E'));
  }
  await page.setViewportSize({width:820,height:900});
  await page.evaluate(()=>document.documentElement.style.zoom='200%');
  const zoom=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,zoom:getComputedStyle(document.documentElement).zoom}));
  check('zoom-200-no-overflow',!zoom.overflow);
  await page.evaluate(()=>document.documentElement.style.zoom='');
  await page.locator('nav [data-view=today]').click();
  const suggested=page.locator('#acoes06-list .acoes06-card').filter({hasText:'Conferir escopo com Marcos'});
  check('suggestion-only-confirm',await suggested.locator('.button-row>button.primary').allTextContents().then(values=>values.length===1&&values[0].trim()==='Confirmar'));
  await suggested.getByRole('button',{name:'Confirmar'}).click();
  await suggested.locator('.resolver-open').waitFor();
  const promoted=suggested.locator('.resolver-open');
  await promoted.focus();await page.keyboard.press('Enter');await page.locator('#resolver-dialog[open]').waitFor();
  await page.locator('#resolver-dialog').getByRole('button',{name:'Fechar Resolver com'}).click();
  check('confirm-resolve-close-focus',await promoted.evaluate(node=>document.activeElement===node&&!document.querySelector('#resolver-dialog').open));
  await page.route('**/api/v3/execucoes/iniciar',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética ao salvar autorização'})}));
  await promoted.click();await page.locator('#resolver-dialog[open]').waitFor();
  check('resolver-cost-visible',(await page.locator('#resolver-dialog').textContent()).includes('custo do assistente escolhido'));
  await page.locator('#resolver-consent').check();
  await page.locator('#resolver-dialog').getByRole('button',{name:'Autorizar contexto →'}).click();
  await page.locator('#resolver-dialog .resolver-form-status').getByText('Falha sintética ao salvar autorização').waitFor();
  check('resolver-error-keeps-consent',await page.locator('#resolver-consent').isChecked());
  await page.keyboard.press('Escape');
  await page.unroute('**/api/v3/execucoes/iniciar');
  await page.route('**/api/v3/contatos?*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha sintética de consulta'})}));
  await page.locator('nav [data-view=today]').click();await page.locator('nav [data-route=contacts]').click();
  await page.locator('#contact-list').getByRole('button',{name:'Tentar novamente'}).waitFor();
  check('people-error-visible',(await page.locator('#contact-list').textContent()).includes('Falha sintética de consulta'));
  await page.unroute('**/api/v3/contatos?*');
  await page.route('**/api/v3/contatos?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    contatos:[],pagina:{total:0,numero:1,paginas:1,porPagina:12},periodo:'semana',janela:{inicio:'2026-09-20T15:00:00Z',fim:'2026-09-27T15:00:00Z'}})}));
  await page.locator('nav [data-view=today]').click();await page.locator('nav [data-route=contacts]').click();
  await page.locator('#contact-list').getByText('Nenhuma pessoa neste recorte.').waitFor();
  check('people-empty-filter-available',await page.locator('#contact-filters>summary').isVisible());
  check('reduced-motion-settled',evidence.screens.every(screen=>screen.runningAnimations===0));
  check('page-errors',evidence.errors.length===0);
  check('external-requests',evidence.external.length===0);
  writeFileSync(`${output}/03A33-evidence.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({ok:true,output,screens:evidence.screens.length,checks:evidence.checks.length}));
}catch(error){
  evidence.failure={message:error.message,stack:error.stack};
  writeFileSync(`${output}/03A33-evidence.json`,JSON.stringify(evidence,null,2));
  console.error(error);process.exitCode=1;
}finally{
  if(browser)await browser.close();
  if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  db.close();
}

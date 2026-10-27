// Gate de confianca visual. Usa apenas HTTP local e dados sinteticos declarados.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilHoje} from './fixtures/hoje-profile.js';

const out='work/ui-spice-qa';
mkdirSync(out,{recursive:true});
const gaps=[];
const check=(condition,message)=>{if(!condition)gaps.push(message);};
const appMarkup=readFileSync(new URL('../src/painel/app.html',import.meta.url),'utf8');
check(appMarkup.includes('id="connection" class="connection" data-state="loading"'),'Cabeçalho: estado inicial loading ausente do HTML');
check(appMarkup.includes('class="connection-compact-label">Conferindo</span>'),'Cabeçalho: loading sem rótulo compacto Conferindo');
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));

function app(db,contexto,{connected=true}={}){
  return criarServidor(db,{
    contexto,
    desktop:true,
    conexao:{
      estado:()=>({estado:connected?'conectada':'desconectada',qr:null}),
      iniciar:async()=>{},
      parar:async()=>{}
    },
    gerarIA:async()=>{throw new Error('Provider forbidden in trust gate');}
  });
}

async function prepare(page,origin,owner='Pessoa de teste'){
  const errors=[];
  const external=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
    const url=route.request().url();
    if(/^https?:/.test(url)&&!url.startsWith(origin)){
      external.push(url);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(origin+'/app');
  await page.locator('#owner').fill(owner);
  await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();
  await page.locator('#skip').click();
  await page.locator('#first-actions').click();
  await page.locator('#first-use').waitFor({state:'hidden'});
  await page.locator('#stat-messages').filter({hasNotText:'…'}).waitFor();
  return {errors,external};
}

async function sessionToken(page,origin){
  const response=await page.request.get(origin+'/api/sessao');
  check(response.ok(),'sessao local nao respondeu para a prova endpoint-vs-DOM');
  return (await response.json()).token;
}

async function hasOverflow(page){
  return page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);
}

async function keyboardAudit(page,scope,label){
  const expected=await page.evaluate(rootSelector=>{
    const root=document.querySelector(rootSelector);
    if(!root)return [];
    const query='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
    return [...document.querySelectorAll(query)].filter((element,index)=>{
      if(element.tabIndex<0||element.closest('[hidden],[inert]'))return false;
      const closed=element.closest('details:not([open])');
      if(closed&&element!==closed.querySelector(':scope > summary'))return false;
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      if(style.display==='none'||style.visibility==='hidden'||rect.width<1||rect.height<1)return false;
      element.dataset.trustFocus=`trust-${index}`;
      element.dataset.trustLabel=element.id||element.getAttribute('data-view')||element.getAttribute('aria-label')||element.textContent.trim().replace(/\s+/g,' ').slice(0,50);
      return true;
    }).map(element=>({key:element.dataset.trustFocus,label:element.dataset.trustLabel}));
  },scope);
  await page.evaluate(()=>{
    document.body.tabIndex=-1;
    document.body.focus();
  });
  const reached=new Set();
  for(let index=0;index<Math.min(expected.length+3,120);index++){
    await page.keyboard.press('Tab');
    const focus=await page.evaluate(()=>{
      const element=document.activeElement;
      if(!element||element===document.body)return null;
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      return {
        key:element.dataset.trustFocus||'',label:element.dataset.trustLabel||element.id||element.textContent.trim().replace(/\s+/g,' ').slice(0,50),
        outlineStyle:style.outlineStyle,
        outlineWidth:parseFloat(style.outlineWidth)||0,
        rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom},
        viewport:{width:innerWidth,height:innerHeight}
      };
    });
    if(!focus)continue;
    reached.add(focus.key);
    check(focus.outlineStyle!=='none'&&focus.outlineWidth>=2,`${label}: foco invisivel em ${focus.label||focus.key||'controle sem id'}`);
    check(focus.rect.left>=-1&&focus.rect.right<=focus.viewport.width+1&&focus.rect.top>=-1&&focus.rect.bottom<=focus.viewport.height+1,`${label}: foco cortado em ${focus.label||focus.key||'controle sem id'}`);
  }
  for(const item of expected)check(reached.has(item.key),`${label}: teclado nao alcancou ${item.label||item.key}`);
  await page.evaluate(()=>{
    document.body.removeAttribute('tabindex');
    document.querySelectorAll('[data-trust-focus]').forEach(element=>{element.removeAttribute('data-trust-focus');element.removeAttribute('data-trust-label');});
  });
  return {expected:expected.length,reached:reached.size};
}

async function contrastAudit(page,rootSelector){
  return page.evaluate(rootSelector=>{
    const parse=value=>{
      if(!value||value==='transparent')return [0,0,0,0];
      const numbers=value.match(/[\d.]+/g)?.map(Number)||[];
      if(numbers.length<3)return [0,0,0,0];
      return [numbers[0],numbers[1],numbers[2],numbers.length>3?numbers[3]:1];
    };
    const over=(front,back)=>{
      const alpha=front[3]+back[3]*(1-front[3]);
      if(alpha===0)return [255,255,255,1];
      return [0,1,2].map(index=>(front[index]*front[3]+back[index]*back[3]*(1-front[3]))/alpha).concat(alpha);
    };
    const background=element=>{
      const chain=[];
      for(let node=element;node;node=node.parentElement)chain.unshift(node);
      return chain.reduce((color,node)=>over(parse(getComputedStyle(node).backgroundColor),color),[255,255,255,1]);
    };
    const luminance=color=>{
      const linear=color.slice(0,3).map(value=>{const channel=value/255;return channel<=.03928?channel/12.92:Math.pow((channel+.055)/1.055,2.4);});
      return .2126*linear[0]+.7152*linear[1]+.0722*linear[2];
    };
    const ratio=(front,back)=>{const values=[luminance(front),luminance(back)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05);};
    const selector=['.sidebar button','.sidebar .brand','.sidebar .connection',...['h1','h2','h3','p','button','summary','label','strong','small','.pill','.eyebrow','.action-type-label'].map(part=>`${rootSelector} ${part}`)].join(',');
    const failures=[];
    for(const element of document.querySelectorAll(selector)){
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      if(rect.width<1||rect.height<1||style.visibility==='hidden'||style.display==='none')continue;
      const text=[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent.trim()).join(' ')||element.getAttribute('aria-label')||'';
      if(!text)continue;
      const foreground=parse(style.color),back=background(element),value=ratio(foreground,back);
      const size=parseFloat(style.fontSize)||16,weight=parseInt(style.fontWeight,10)||400;
      const large=size>=24||(size>=18.66&&weight>=700),minimum=large?3:4.5;
      if(value+0.01<minimum)failures.push({selector:element.id?`#${element.id}`:element.className||element.tagName,text:text.slice(0,70),ratio:Number(value.toFixed(2)),minimum});
    }
    return failures;
  },rootSelector);
}

async function antiSlopAudit(page){
  return page.evaluate(()=>{
    const visible=element=>{
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight;
    };
    const roots=[...document.querySelectorAll('.sidebar,#today,#today *')].filter(visible);
    const gradients=[],glass=[],cursors=[],infinite=[];
    let greenArea=0;
    const foldArea=innerWidth*innerHeight;
    for(const element of roots){
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      if(/gradient/i.test(style.backgroundImage))gradients.push(element.id||element.className||element.tagName);
      if(style.backdropFilter!=='none'||style.webkitBackdropFilter&&style.webkitBackdropFilter!=='none')glass.push(element.id||element.className||element.tagName);
      if(/url\(|^none$/i.test(style.cursor))cursors.push(element.id||element.className||element.tagName);
      if(style.animationIterationCount.split(',').some(value=>value.trim()==='infinite'))infinite.push(element.id||element.className||element.tagName);
      const color=style.backgroundColor.match(/[\d.]+/g)?.map(Number)||[];
      if(color.length>=3&&color[1]>color[0]*1.18&&color[1]>color[2]*1.08&&color[3]!==0){
        const width=Math.max(0,Math.min(rect.right,innerWidth)-Math.max(rect.left,0));
        const height=Math.max(0,Math.min(rect.bottom,innerHeight)-Math.max(rect.top,0));
        greenArea+=width*height;
      }
    }
    const cards=[...document.querySelectorAll('#today .stats>article')].filter(visible).map(element=>{const style=getComputedStyle(element);return {radius:parseFloat(style.borderRadius)||0,shadow:style.boxShadow,background:style.backgroundColor};});
    const raisedCards=cards.filter(card=>card.radius>=8||card.shadow!=='none'||!/rgba?\([^)]*,\s*0\)/.test(card.background));
    return {
      gradients:[...new Set(gradients)],glass:[...new Set(glass)],cursors:[...new Set(cursors)],infinite:[...new Set(infinite)],
      greenAreaRatio:Number((greenArea/foldArea).toFixed(3)),
      equalRaisedMetricCards:raisedCards.length,
      runningAnimations:document.getAnimations().filter(animation=>animation.playState==='running').length
    };
  });
}

async function targetAudit(page,rootSelector='body'){
  return page.evaluate(rootSelector=>{
    const root=document.querySelector(rootSelector);
    const selector='button,a[href],summary,input:not([type="checkbox"]):not([type="radio"]),select,textarea';
    return [...root.querySelectorAll(selector)].filter(element=>{
      if(element.disabled||element.closest('[hidden],[inert]'))return false;
      const closed=element.closest('details:not([open])');
      if(closed&&element!==closed.querySelector(':scope > summary'))return false;
      const style=getComputedStyle(element),rect=element.getBoundingClientRect();
      return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0&&(rect.width<44||rect.height<44);
    }).map(element=>{const rect=element.getBoundingClientRect();return{name:element.id||element.getAttribute('aria-label')||element.textContent.trim().replace(/\s+/g,' ').slice(0,45),width:Number(rect.width.toFixed(1)),height:Number(rect.height.toFixed(1))};});
  },rootSelector);
}

async function effectAudit(page){
  return page.evaluate(()=>{
    const gradients=[],blur=[];
    const inspect=(element,pseudo='')=>{
      const style=getComputedStyle(element,pseudo||null),name=(element.id?`#${element.id}`:element.className||element.tagName)+(pseudo||'');
      if(/gradient/i.test(style.backgroundImage))gradients.push(name);
      const backdrop=style.backdropFilter||style.webkitBackdropFilter;
      if(backdrop&&backdrop!=='none')blur.push(name);
    };
    for(const element of [document.body,...document.body.querySelectorAll('*')]){
      inspect(element);inspect(element,'::before');inspect(element,'::after');
    }
    for(const dialog of document.querySelectorAll('dialog'))inspect(dialog,'::backdrop');
    return{gradients:[...new Set(gradients)],blur:[...new Set(blur)]};
  });
}

async function headerStateAudit(page){
  const scenarios=[
    ['conectada','connected','Rodando'],
    ['conectando','working','Conectando'],
    ['aguardando_qr','waiting','Aguardando'],
    ['desconectada','off','Desconectado'],
    ['erro','error','Falha']
  ],results=[];
  for(const [raw,expected,label] of scenarios){
    await page.evaluate(async raw=>{
      const original=window.fetch.bind(window);
      window.fetch=(input,init)=>new URL(input,location.href).pathname==='/api/estado'
        ? Promise.resolve(new Response(JSON.stringify({conexao:{estado:raw,qrDisponivel:false}}),{status:200,headers:{'Content-Type':'application/json'}}))
        : original(input,init);
      try{await (0,eval)('status()');}finally{window.fetch=original;}
    },raw);
    const actual=await page.locator('#connection').evaluate(element=>({state:element.dataset.state,compact:element.querySelector('.connection-compact-label')?.textContent,aria:element.getAttribute('aria-label')}));
    check(actual.state===expected,`Cabeçalho: ${raw} renderizou data-state=${actual.state}, esperado ${expected}`);
    check(actual.compact===label,`Cabeçalho: ${raw} não mostrou o rótulo compacto ${label}`);
    check(Boolean(actual.aria),`Cabeçalho: ${raw} ficou sem rótulo acessível`);
    results.push({raw,...actual});
  }
  const networkFailure=await page.evaluate(async()=>{
    const original=window.fetch.bind(window);
    window.fetch=(input,init)=>new URL(input,location.href).pathname==='/api/estado'?Promise.reject(new Error('falha sintética')):original(input,init);
    try{await (0,eval)('status()');}catch{}finally{window.fetch=original;}
    const element=document.querySelector('#connection');
    return{state:element.dataset.state,compact:element.querySelector('.connection-compact-label')?.textContent,title:document.querySelector('#home-status-title').textContent};
  });
  check(networkFailure.state==='error'&&networkFailure.compact==='Falha','Cabeçalho: falha ao consultar o estado não virou error/Falha');
  check(networkFailure.title==='Não foi possível atualizar','Copy: erro geral não usa a mensagem canônica');
  results.push({raw:'fetch-error',...networkFailure});
  await page.evaluate(()=>new Promise((resolve,reject)=>(0,eval)('status()').then(resolve,reject)));
  return results;
}

const populatedDb=abrirBanco();
const populatedProfile=perfilHoje(populatedDb);
for(const [tipo,texto] of [
  ['compromisso','Confirmar a revisao da proposta - exemplo sintetico'],
  ['lead','Retomar a conversa sobre orcamento - exemplo sintetico'],
  ['pendencia','Conferir os dados do contrato - exemplo sintetico'],
  ['decisao','Registrar a condicao aprovada - exemplo sintetico']
])populatedProfile.adicionar({tipo,texto});
const populatedServer=app(populatedDb,populatedProfile.contexto);

const emptyDb=abrirBanco();
const emptyServer=app(emptyDb,new ContextoApp(emptyDb));

await Promise.all([listen(populatedServer),listen(emptyServer)]);
const populatedOrigin=`http://127.0.0.1:${populatedServer.address().port}`;
const emptyOrigin=`http://127.0.0.1:${emptyServer.address().port}`;
const browser=await chromium.launch({channel:'msedge',headless:true});
const evidence={date:new Date().toISOString(),synthetic:true,widths:[390,820,1320],checks:{},gaps};

try{
  const context=await browser.newContext({viewport:{width:1320,height:950},reducedMotion:'reduce'});
  const page=await context.newPage();
  const runtime=await prepare(page,populatedOrigin);
  const token=await sessionToken(page,populatedOrigin);
  const expected=await (await page.request.get(populatedOrigin+'/api/v3/resumo?ordem=compromissos&pagina=1',{headers:{'X-Assessor-Token':token}})).json();
  const domMetrics=await page.evaluate(()=>({
    mensagens:Number(document.querySelector('#stat-messages').textContent),
    hoje:Number(document.querySelector('#stat-today').textContent),
    fila:Number(document.querySelector('#stat-actions').textContent),
    conversas:Number(document.querySelector('#stat-conversations').textContent)
  }));
  check(domMetrics.mensagens===expected.mensagens,`Hoje: fontes no DOM (${domMetrics.mensagens}) diferem da API (${expected.mensagens})`);
  check(domMetrics.hoje===expected.hoje,`Hoje: total do dia no DOM (${domMetrics.hoje}) difere da API (${expected.hoje})`);
  check(domMetrics.fila===expected.fila.total,`Hoje: acoes no DOM (${domMetrics.fila}) diferem da API (${expected.fila.total})`);
  check(domMetrics.conversas===expected.conversas,`Hoje: conversas no DOM (${domMetrics.conversas}) diferem da API (${expected.conversas})`);
  evidence.checks.endpointVsDom={expected:{mensagens:expected.mensagens,hoje:expected.hoje,fila:expected.fila.total,conversas:expected.conversas},actual:domMetrics};
  evidence.checks.headerStates=await headerStateAudit(page);
  const sectionOrder=await page.evaluate(()=>{
    const selectors=['#today .attention-panel','#negocios-today','#today .recent-panel'];
    return selectors.map(selector=>{const element=document.querySelector(selector),rect=element?.getBoundingClientRect();return{selector,visible:Boolean(element&&getComputedStyle(element).display!=='none'&&rect.width>0&&rect.height>0),top:rect?.top??null};});
  });
  check(sectionOrder.every(section=>section.visible),'Hoje: Precisa de você, Negócios e Atividade recente devem ficar visíveis');
  check(sectionOrder.every((section,index)=>index===0||section.top>sectionOrder[index-1].top),'Hoje: Negócios e Atividade recente estão fora da ordem contratada');
  evidence.checks.todaySections=sectionOrder;
  const recentCount=await page.locator('#recent .source').count();
  check(recentCount<=2,`Densidade: Atividade recente mostrou ${recentCount} fontes; o limite da tela Hoje é 2`);
  evidence.checks.recentSources=recentCount;

  for(const width of [390,820,1320]){
    await page.setViewportSize({width,height:950});
    await page.evaluate(()=>scrollTo(0,0));
    check(!await hasOverflow(page),`Hoje: overflow horizontal em ${width}px`);
    const header=await page.locator('.sidebar').boundingBox(),main=await page.locator('main').boundingBox();
    check(Boolean(header&&Math.abs(header.x)<=1&&Math.abs(header.width-width)<=1),`Casca: navegacao superior nao ocupa a largura em ${width}px`);
    check(Boolean(main&&Math.abs(main.x)<=1),`Casca: deslocamento de menu lateral ainda existe em ${width}px`);
    const smallTargets=await targetAudit(page,'.workspace');
    check(smallTargets.length===0,`Alvos: ${smallTargets.length} controle(s) menores que 44x44 em ${width}px: ${smallTargets.map(item=>`${item.name} (${item.width}x${item.height})`).join(', ')}`);
    evidence.checks[`targets${width}`]=smallTargets;
    await page.screenshot({path:`${out}/today-${width}.png`,fullPage:true});
  }

  await page.setViewportSize({width:1320,height:950});
  evidence.checks.keyboardToday=await keyboardAudit(page,'#today','Hoje');
  const contrast=await contrastAudit(page,'#today');
  contrast.forEach(item=>gaps.push(`Contraste ${item.ratio}:1 abaixo de ${item.minimum}:1 em ${item.selector} (${item.text})`));
  evidence.checks.contrast={audited:true,failures:contrast};

  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForTimeout(250);
  const antiSlop=await antiSlopAudit(page);
  check(antiSlop.gradients.length===0,`Anti-slop: gradiente visivel em ${antiSlop.gradients.join(', ')}`);
  check(antiSlop.glass.length===0,`Anti-slop: vidro/backdrop visivel em ${antiSlop.glass.join(', ')}`);
  check(antiSlop.cursors.length===0,`Anti-slop: cursor decorativo em ${antiSlop.cursors.join(', ')}`);
  check(antiSlop.infinite.length===0,`Movimento: animacao infinita sem processamento em ${antiSlop.infinite.join(', ')}`);
  check(antiSlop.runningAnimations===0,`Movimento reduzido: ${antiSlop.runningAnimations} animacao(oes) continuam rodando`);
  check(antiSlop.greenAreaRatio<=.2,`Marca: superficies verdes ocupam ${(antiSlop.greenAreaRatio*100).toFixed(1)}% da primeira dobra`);
  check(antiSlop.equalRaisedMetricCards<3,'Anti-slop: tres cartoes de metrica elevados e iguais dominam a tela Hoje');
  evidence.checks.antiSlop=antiSlop;
  const effects=await effectAudit(page);
  check(effects.gradients.length===0,`Acabamento: gradientes computados em ${effects.gradients.join(', ')}`);
  check(effects.blur.length===0,`Acabamento: blur/backdrop computado em ${effects.blur.join(', ')}`);
  evidence.checks.effects=effects;
  const typography=await page.evaluate(async()=>{await document.fonts.ready;return{family:getComputedStyle(document.body).fontFamily,manrope:document.fonts.check('16px Manrope')};});
  check(typography.family.includes('Manrope')&&typography.manrope,'Tipografia: Manrope local não foi aplicada');
  evidence.checks.typography=typography;
  const semanticTones=await page.locator('#tasks .task-action:visible .action-type-label').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).color));
  check(new Set(semanticTones).size>=3,'Cor semantica: compromissos, pendencias e oportunidades nao usam tons visuais distintos');
  evidence.checks.semanticTones=semanticTones;
  await page.locator('#task-options summary').click();
  const decisionTone=await page.locator('#tasks [data-action-type="decisao"] .action-type-label').evaluate(element=>getComputedStyle(element).color);
  check(decisionTone==='rgb(140, 63, 118)',`Cor semantica: Decisao usa ${decisionTone}, esperado violeta rgb(140, 63, 118)`);
  evidence.checks.decisionTone=decisionTone;
  await page.locator('#task-options summary').click();

  // No motor headless, metade da largura CSS reproduz o reflow de 820px com zoom de pagina a 200%.
  await page.setViewportSize({width:410,height:950});
  await page.evaluate(()=>scrollTo(0,0));
  await page.waitForTimeout(100);
  check(!await hasOverflow(page),'Zoom 200%: a tela Hoje cria rolagem horizontal em 820px');
  check(await page.locator('#home-status').isVisible(),'Zoom 200%: estado real deixa de ficar visivel');
  const clippedAtZoom=await page.evaluate(()=>[...document.querySelectorAll('.sidebar button,#today h1,#today h2,#today button')].filter(element=>{
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    if(style.display==='none'||style.visibility==='hidden'||rect.width<1||rect.height<1||element.closest('[hidden],[inert]'))return false;
    const closed=element.closest('details:not([open])');if(closed&&element!==closed.querySelector(':scope > summary'))return false;
    const clipsX=/hidden|clip/.test(style.overflowX)&&element.scrollWidth>element.clientWidth+4;
    const clipsY=/hidden|clip/.test(style.overflowY)&&element.scrollHeight>element.clientHeight+4;
    return clipsX||clipsY;
  }).map(element=>({name:element.id||element.getAttribute('data-view')||element.textContent.trim().slice(0,40),client:[element.clientWidth,element.clientHeight],scroll:[element.scrollWidth,element.scrollHeight]})));
  check(clippedAtZoom.length===0,`Zoom 200%: texto ou controle cortado em ${clippedAtZoom.map(item=>item.name).join(', ')}`);
  evidence.checks.zoom200={overflow:await hasOverflow(page),clipped:clippedAtZoom};
  await page.screenshot({path:`${out}/today-820-zoom-200.png`,fullPage:true});

  await page.setViewportSize({width:1320,height:950});
  await page.locator('nav [data-view="memory"]').click();
  await page.locator('.conversation-card').first().waitFor();
  const conversationResponse=await page.request.get(populatedOrigin+'/api/v3/conversas/resumo?q=&filtro=todas&pagina=1',{headers:{'X-Assessor-Token':token}});
  const conversationData=await conversationResponse.json();
  const apiNames=conversationData.conversas.map(item=>item.nome);
  const domNames=await page.locator('.conversation-card h3').allInnerTexts();
  check(JSON.stringify(domNames)===JSON.stringify(apiNames),'Conversas: nomes ou ordem no DOM diferem do endpoint real');
  evidence.checks.conversationsEndpointVsDom={expected:apiNames,actual:domNames};
  for(const width of [390,820,1320]){
    await page.setViewportSize({width,height:950});
    check(!await hasOverflow(page),`Conversas: overflow horizontal em ${width}px`);
    await page.screenshot({path:`${out}/conversations-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1320,height:950});
  evidence.checks.keyboardConversations=await keyboardAudit(page,'#memory','Conversas');
  const conversationContrast=await contrastAudit(page,'#memory');
  conversationContrast.forEach(item=>gaps.push(`Contraste Conversas ${item.ratio}:1 abaixo de ${item.minimum}:1 em ${item.selector} (${item.text})`));
  evidence.checks.conversationsContrast={audited:true,failures:conversationContrast};
  check(runtime.errors.length===0,`Runtime: ${runtime.errors.join(' | ')}`);
  check(runtime.external.length===0,`Privacidade: requisicoes externas detectadas: ${runtime.external.join(', ')}`);
  await context.close();

  const emptyContext=await browser.newContext({viewport:{width:390,height:950},reducedMotion:'reduce'});
  const emptyPage=await emptyContext.newPage();
  const emptyRuntime=await prepare(emptyPage,emptyOrigin,'Perfil vazio');
  const emptyToken=await sessionToken(emptyPage,emptyOrigin);
  const emptyExpected=await (await emptyPage.request.get(emptyOrigin+'/api/v3/resumo?ordem=compromissos&pagina=1',{headers:{'X-Assessor-Token':emptyToken}})).json();
  const emptyActual=await emptyPage.evaluate(()=>({
    mensagens:Number(document.querySelector('#stat-messages').textContent),
    hoje:Number(document.querySelector('#stat-today').textContent),
    fila:Number(document.querySelector('#stat-actions').textContent),
    conversas:Number(document.querySelector('#stat-conversations').textContent),
    actions:document.querySelectorAll('#tasks .task-action').length,
    fakeCharts:document.querySelectorAll('#today .home-snapshot canvas,#today .home-snapshot svg').length
  }));
  check(emptyExpected.mensagens===0&&emptyExpected.hoje===0&&emptyExpected.fila.total===0&&emptyExpected.conversas===0,'Fixture vazia nao retornou zeros no endpoint; a prova de conteudo falso e inconclusiva');
  check(emptyActual.mensagens===emptyExpected.mensagens&&emptyActual.hoje===emptyExpected.hoje&&emptyActual.fila===emptyExpected.fila.total&&emptyActual.conversas===emptyExpected.conversas,'Perfil vazio: numeros do DOM diferem dos zeros da API');
  check(emptyActual.actions===0,'Perfil vazio: a tela inventou uma acao');
  check(emptyActual.fakeCharts===0,'Perfil vazio: a tela renderizou grafico sem serie real');
  check(!await hasOverflow(emptyPage),'Perfil vazio: overflow horizontal em 390px');
  await emptyPage.locator('nav [data-view="memory"]').click();
  await emptyPage.getByText('Nenhuma conversa chegou ainda.').waitFor();
  check(await emptyPage.locator('.conversation-card').count()===0,'Perfil vazio: a lista inventou uma conversa');
  const emptyVisibleText=await emptyPage.locator('#memory').innerText();
  check(!/Jane Doe|John Doe|Acme|Nexus|SmartFlow|Cloudly/i.test(emptyVisibleText),'Perfil vazio: placeholder generico apareceu como dado real');
  await emptyPage.screenshot({path:`${out}/empty-profile-390.png`,fullPage:true});
  check(emptyRuntime.errors.length===0,`Perfil vazio runtime: ${emptyRuntime.errors.join(' | ')}`);
  check(emptyRuntime.external.length===0,`Perfil vazio privacidade: requisicoes externas: ${emptyRuntime.external.join(', ')}`);
  evidence.checks.emptyProfile={expected:{mensagens:emptyExpected.mensagens,hoje:emptyExpected.hoje,fila:emptyExpected.fila.total,conversas:emptyExpected.conversas},actual:emptyActual};
  await emptyContext.close();
}finally{
  evidence.passed=gaps.length===0;
  writeFileSync(`${out}/evidence.json`,JSON.stringify(evidence,null,2));
  await browser.close();
  await Promise.all([close(populatedServer),close(emptyServer)]);
  populatedDb.close();
  emptyDb.close();
}

assert.deepEqual(gaps,[],`Trust gate encontrou ${gaps.length} lacuna(s). Veja ${out}/evidence.json`);
console.log('TRUST_GATE_OK');

import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const shots=path.join(app,'work/experiencia-companhia-20261026');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});await fs.mkdir(shots,{recursive:true});});
after(async()=>{await browser?.close();});
const sample={estado:'atencao',mensagem:'Assunto sintético',som:false,pausado:false,tema:'light',movimento:'system',volume:.35,notificacaoId:'synthetic:1',assunto:{id:'acao:12345678-1234-1234-1234-123456789012',assunto:'Revisar proposta de exemplo',pessoa:'Pessoa fictícia',motivo:'Uma decisão aguarda sua leitura.',prazo:null,fonteId:1,grupo:'precisa',estado:'pendente'}};
async function basePage({prefs=false,bridge=true}={}){
  const page=await browser.newPage({viewport:{width:prefs?1024:320,height:prefs?768:240}});
  let config={enabled:false,som:false,pausado:false,tema:'system',movimento:'system',volume:.35,disponivel:true};
  const calls=[];
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());assert.equal(url.hostname,'lume.test','no external requests');
    if(url.pathname==='/api/v3/pessoal/companheiro'){
      const patch=route.request().method()==='POST'?route.request().postDataJSON():null;if(patch){calls.push(patch);config={...config,...patch};}
      return route.fulfill({json:config});
    }
    if(url.pathname==='/prefs')return route.fulfill({contentType:'text/html',body:`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><script src="/src/painel/lume-theme-mode.js"></script><link rel="stylesheet" href="/src/painel/experiencia.css"></head><body class="lume-vivo"><button class="settings-choice" data-settings-group="appearance">Aparência</button><div id="settings-group-appearance-cards"></div><section id="legacy-box"><details id="pessoal-companion"><input id="legacy-input"></details></section><label><select id="theme-mode"><option>system</option><option>light</option><option>dark</option></select></label><label><input type="checkbox" id="ui-sounds"></label><script src="/src/painel/lume-soft-audio.js"></script><script src="/src/painel/experiencia-preferencias.js"></script></body></html>`});
    const relative=decodeURIComponent(url.pathname).replace(/^\/fonts\//,'/src/painel/fonts/').replace(/^\//,'');
    const target=path.resolve(app,relative);assert(target.startsWith(app+path.sep));
    try{return route.fulfill({body:await fs.readFile(target),contentType:target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':target.endsWith('.woff2')?'font/woff2':'text/html'});}catch{return route.fulfill({status:404,body:''});}
  });
  await page.addInitScript(({bridge,prefs})=>{
    window.calls=[];window.audioNotes=[];window.audioStops=0;window.audioEnded=0;window.failCommand=false;
    class AudioMock{state='running';currentTime=0;destination={};resume(){return Promise.resolve();}close(){return Promise.resolve();}createOscillator(){const o={frequency:{setValueAtTime:f=>o.f=f},connect(){},disconnect(){},start(){window.audioNotes.push(o.f);},stop(when){window.audioStops++;setTimeout(()=>{window.audioEnded++;o.onended?.();},Number.isFinite(when)?when*1000:0);}};return o;}createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(v){window.audioGain=v;},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}}
    window.AudioContext=AudioMock;
    if(bridge&&!prefs){window.lumeCompanheiro={onState(fn){window.emit=fn;return()=>{};}};for(const key of ['abrir','ocultar','som','adiar','pausar','expandir'])window.lumeCompanheiro[key]=async arg=>{window.calls.push([key,arg]);if(window.failCommand)throw Error('synthetic failure');};}
    window.lumeConnectionRequest=async(url,body,options)=>{window.lastOptions=options;if(window.failCommand)throw Error('Falha sintética de gravação');return (await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();};
    window.abrirAjuste=async id=>{window.calls.push(['ajuste',id]);return true;};
  },{bridge,prefs});
  await page.goto('http://lume.test/'+(prefs?'prefs':'desktop/companheiro.html'));
  if(prefs)await page.evaluate(()=>window.LumePreferencias.carregar());
  return {page,calls,setConfig:v=>config={...config,...v}};
}
test('companhia não inventa contexto sem ponte ou fonte; compacto oferece alvos44',async()=>{
  const {page}=await basePage({bridge:false});
  try{assert.match(await page.locator('#mensagem').textContent(),/Disponível/);assert(await page.locator('#expandir').isDisabled());assert(await page.locator('#assunto').isHidden());}finally{await page.close();}
  const real=await basePage();try{
    await real.page.evaluate(p=>emit({...p,assunto:null}),sample);
    assert(await real.page.locator('#fonte').isHidden());assert(await real.page.locator('#prazo').isHidden());
    const small=await real.page.locator('button:visible').evaluateAll(es=>es.filter(e=>e.getBoundingClientRect().height<44||e.getBoundingClientRect().width<44).length);assert.equal(small,0);
    assert.equal(await real.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }finally{await real.page.close();}
});
test('assunto literal, expansão, abrir, adiar, pausa/retomada e erro preservam contratos IPC',async()=>{
  const {page}=await basePage();try{
    await page.evaluate(p=>emit(p),{...sample,assunto:{...sample.assunto,assunto:'<img src=x onerror=alert(1)>',prazo:'amanhã, conforme a fonte'}});
    await page.locator('#expandir').click();assert.equal(await page.locator('#expandir').getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('#assunto img').count(),0);assert.match(await page.locator('#assunto').textContent(),/<img/);
    assert.match(await page.locator('#prazo').textContent(),/amanhã/);
    await page.locator('#abrir').click();await page.locator('#adiar').click();await page.locator('#pausar').click();
    await page.evaluate(p=>emit({...p,estado:'pausado',pausado:true}),sample);assert.equal(await page.locator('#pausar').textContent(),'Retomar');await page.locator('#pausar').click();
    const calls=await page.evaluate(()=>window.calls);assert(calls.some(c=>c[0]==='adiar'));assert(calls.some(c=>c[0]==='pausar'&&c[1]===true));assert(calls.some(c=>c[0]==='pausar'&&c[1]===false));
    await page.evaluate(()=>window.failCommand=true);await page.locator('#abrir').click();await page.waitForFunction(()=>document.getElementById('control-status').textContent.includes('Não consegui'));assert(await page.locator('#abrir').isEnabled());
  }finally{await page.close();}
});
test('som tem dois motivos, volume, deduplicação, silêncio inicial/pausa/oculto e gesto finito',async()=>{
  const {page}=await basePage();try{
    const emit=async p=>page.evaluate(p=>window.emit(p),p);
    await emit({...sample,som:true});assert.deepEqual(await page.evaluate(()=>audioNotes),[]);
    const next={...sample,som:true,volume:.5,notificacaoId:'decision:2'};await emit(next);assert.deepEqual(await page.evaluate(()=>audioNotes),[620,930]);assert.equal(await page.evaluate(()=>audioGain),.03);
    await emit(next);assert.equal(await page.evaluate(()=>audioNotes.length),2);
    await emit({...next,notificacaoId:'working',assunto:{...sample.assunto,grupo:'cuidando'}});assert.equal(await page.evaluate(()=>audioNotes.length),2);
    await page.waitForFunction(()=>audioEnded>=2);
    await emit({...next,notificacaoId:'done',assunto:{...sample.assunto,grupo:'mudou',estado:'verificado'}});assert.deepEqual(await page.evaluate(()=>audioNotes.slice(2)),[523.25,659.25]);
    await emit({...next,notificacaoId:'pause',pausado:true});assert.equal(await page.evaluate(()=>audioNotes.length),4);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    await emit({...next,notificacaoId:'hidden'});assert.equal(await page.evaluate(()=>audioNotes.length),4);
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await emit({...next,notificacaoId:'hidden'});assert.equal(await page.evaluate(()=>audioNotes.length),4);
    await emit({...next,movimento:'reduce',tema:'dark',estado:'trabalhando'});assert.equal(await page.locator('.ls-body').evaluate(e=>getComputedStyle(e).animationName),'none');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    await page.reload();await emit({...next,notificacaoId:'done'});assert.equal(await page.evaluate(()=>audioNotes.length),0);
    const css=await fs.readFile(path.join(app,'src/painel/lume-soft-mascote.css'),'utf8');assert(!/\binfinite\b/.test(css));assert(css.includes('420ms'));
  }finally{await page.close();}
});
test('companhia cancela áudio já iniciado quando o volume muda para zero',async()=>{
  const {page}=await basePage();try{
    await page.evaluate(p=>emit({...p,som:true}),sample);
    await page.evaluate(p=>emit({...p,som:true,notificacaoId:'volume-change-test'}),sample);
    assert.equal(await page.evaluate(()=>audioNotes.length),2);
    const before=await page.evaluate(()=>audioStops);
    await page.evaluate(p=>emit({...p,som:true,volume:0,notificacaoId:'volume-change-test'}),sample);
    assert.equal(await page.evaluate(()=>audioStops),before+2);
    await page.evaluate(p=>emit({...p,som:true,volume:0,notificacaoId:'silenced-next'}),sample);
    assert.equal(await page.evaluate(()=>audioNotes.length),2);
  }finally{await page.close();}
});

test('preferências salvam patch, compartilham tema/movimento/som e preservam closures legadas',async()=>{
  const {page,calls}=await basePage({prefs:true});try{
    assert.equal(await page.locator('#legacy-input').evaluate(e=>e.closest('section').id),'legacy-box');assert(await page.locator('#pessoal-companion').isHidden());
    assert.equal(await page.locator('#lv-pref-som').isChecked(),false);
    await page.locator('#lv-pref-tema').selectOption('dark');await page.locator('#lv-pref-movimento').selectOption('reduce');await page.locator('#lv-pref-som').check();await page.locator('#lv-pref-save').click();
    await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('salvas'));
    assert.deepEqual(calls,[{som:true,tema:'dark',movimento:'reduce'}]);assert.equal(await page.locator('html').getAttribute('data-motion'),'reduce');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.evaluate(()=>localStorage.getItem('lume-interface-sounds')),'on');assert.equal(await page.evaluate(()=>lastOptions.timeout),15000);
    await page.reload();await page.evaluate(()=>LumePreferencias.carregar());assert(await page.locator('#lv-pref-som').isChecked());assert.equal(await page.locator('#lv-pref-tema').inputValue(),'dark');
    await page.locator('#lv-preview-decisao').click();assert.deepEqual(await page.evaluate(()=>audioNotes),[620,930]);
    await page.locator('#lv-pref-pausado').check();assert(await page.locator('#lv-preview-decisao').isDisabled());await page.locator('#lv-pref-save').click();await page.waitForFunction(()=>localStorage.getItem('lume-interface-sounds')==='off');
  }finally{await page.close();}
});
test('falha de gravação não anuncia sucesso; indisponibilidade e atualização preservam edição',async()=>{
  const {page,setConfig}=await basePage({prefs:true});try{
    await page.locator('#lv-pref-enabled').check();await page.evaluate(()=>window.failCommand=true);await page.locator('#lv-pref-save').click();
    await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('Falha sintética'));assert.equal(await page.evaluate(()=>LumePreferencias.estado().enabled),false);assert(await page.locator('#lv-pref-enabled').isChecked());
    await page.evaluate(()=>window.failCommand=false);setConfig({disponivel:false});await page.locator('#lv-pref-refresh').click();await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('instalado'));assert(await page.locator('#lv-pref-enabled').isDisabled());assert(await page.locator('#lv-pref-tema').isEnabled());
    await page.locator('#lv-pref-tema').selectOption('dark');await page.locator('#lv-pref-save').click();await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('salvas'));assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.evaluate(()=>LumePreferencias.estado().enabled),false);
  }finally{await page.close();}
});
test('tema compartilhado respeita escolha explícita e sistema após reload',async()=>{
  const {page}=await basePage({prefs:true});try{
    await page.locator('#lv-pref-tema').selectOption('dark');await page.locator('#lv-pref-save').click();await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('salvas'));
    await page.emulateMedia({colorScheme:'light'});assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
    await page.locator('#lv-pref-tema').selectOption('system');await page.locator('#lv-pref-save').click();await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('salvas'));
    await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    await page.reload();await page.evaluate(()=>LumePreferencias.carregar());assert.equal(await page.locator('#lv-pref-tema').inputValue(),'system');
    await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.soundVolume),'0.35');assert.equal(await page.evaluate(()=>document.documentElement.dataset.companionPaused),'false');
  }finally{await page.close();}
});
test('atualização concorrente não entra no patch de um campo que o usuário não alterou',async()=>{
  const {page,calls,setConfig}=await basePage({prefs:true});try{
    await page.locator('#lv-pref-tema').selectOption('dark');setConfig({som:true,volume:.7});
    await page.locator('#lv-pref-refresh').click();await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('ainda não foram salvas'));
    assert(await page.locator('#lv-pref-som').isChecked());assert.equal(await page.locator('#lv-pref-volume').inputValue(),'0.7');assert.equal(await page.locator('#lv-pref-tema').inputValue(),'dark');
    await page.locator('#lv-pref-save').click();await page.waitForFunction(()=>document.getElementById('lv-pref-status').textContent.includes('salvas'));
    assert.deepEqual(calls,[{tema:'dark'}]);assert.equal(await page.evaluate(()=>LumePreferencias.estado().volume),.7);
  }finally{await page.close();}
});
test('screenshots sintéticos de companhia compacta/expandida nos dois temas',async()=>{
  const {page}=await basePage();try{
    for(const theme of ['light','dark']){
      await page.setViewportSize({width:320,height:240});await page.evaluate(p=>emit(p),{...sample,tema:theme,movimento:'reduce'});
      await page.screenshot({path:path.join(shots,`companhia-${theme}-compacta.png`),fullPage:true});
      await page.locator('#expandir').click();await page.setViewportSize({width:320,height:400});
      await page.screenshot({path:path.join(shots,`companhia-${theme}-expandida.png`),fullPage:true});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.locator('#expandir').click();
    }
  }finally{await page.close();}
  const prefs=await basePage({prefs:true});try{await prefs.page.screenshot({path:path.join(shots,'preferencias-light.png'),fullPage:true});}finally{await prefs.page.close();}
});

import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});await mkdir(resolve(root,'work/lume-1-20261026/desktop'),{recursive:true});});
after(async()=>{await browser?.close();});
test('sete estados vetoriais, clique no personagem, teclado, movimento reduzido e suspensão invisível',async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}});
  try{
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());assert.equal(url.hostname,'lume.test');
      const path=resolve(root,'.'+decodeURIComponent(url.pathname));assert(path.startsWith(root));
      await route.fulfill({body:await readFile(path),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.woff2')?'font/woff2':'text/html'});
    });
    await page.addInitScript(()=>{
      window.actions=[];window.lumeCompanheiro={onState(fn){window.emit=fn;return()=>{};}};
      for(const action of ['abrir','ocultar','som','adiar','pausar','expandir'])window.lumeCompanheiro[action]=async value=>actions.push([action,value]);
    });
    await page.goto('http://lume.test/desktop/companheiro.html');
    for(const estado of ['aguardando','buscando','trabalhando','concluido','atencao','pausado','desconectado']){
      await page.evaluate(estado=>emit({estado,mensagem:'Estado sintético para prova visual.',som:false,pausado:estado==='pausado',tema:'light',movimento:'system',notificacaoId:null,assunto:null}),estado);
      assert.equal(await page.locator('#companheiro').getAttribute('data-state'),estado);
      assert.equal(await page.locator('.ls-lantern').count(),1);
      assert.equal(await page.locator('.ls-mascote').getAttribute('data-estado'),estado);
      assert.equal(await page.locator('#assunto').isVisible(),false);
      await page.screenshot({path:resolve(root,`work/lume-1-20261026/desktop/${estado}.png`)});
    }
    await page.locator('#personagem').click();
    assert.equal(await page.locator('#assunto-detalhe').isVisible(),true);
    assert.equal(await page.locator('#personagem').getAttribute('aria-expanded'),'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#assunto-detalhe').isVisible(),false);
    assert.equal(await page.locator('#expandir').evaluate(e=>e===document.activeElement),true);
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(()=>emit({estado:'buscando',mensagem:'Busca sintética.',tema:'dark',movimento:'system',som:false,notificacaoId:null}));
    assert.equal(await page.locator('.ls-arm-right').evaluate(e=>getComputedStyle(e).animationName),'none');
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    assert.equal(await page.locator('.ls-body').evaluate(e=>getComputedStyle(e).animationName),'none');
    assert.equal(await page.locator('html').getAttribute('data-visible'),'false');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }finally{await page.close();}
});

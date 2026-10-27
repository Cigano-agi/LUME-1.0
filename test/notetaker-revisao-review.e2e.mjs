import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const id='11000000-0000-4000-8000-000000000001';
const dto={id,eventoId:12,textoGerado:'Original sintético.',textoCorrigido:null,
  textoExibido:'Original sintético.',revisao:0,ultimaCorrecao:null,
  evidencia:{estado:'integra',parteId:id,inicioMs:0,fimMs:900}};

test('uma leitura inicial em voo; retry após falha não perde rascunho',async()=>{
  const source=resolve(import.meta.dirname,'../src/painel/notetaker-revisao.js');
  const server=createServer(async(req,res)=>{
    if(req.url==='/notetaker-revisao.js'){
      res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(source));return;
    }
    res.writeHead(200,{'content-type':'text/html'});
    res.end('<!doctype html><html lang="pt-BR"><body><main id="app"></main></body></html>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async({id})=>{
      const {montarRevisaoTrecho}=await import('/notetaker-revisao.js');
      window.pending=[];
      const fetchImpl=url=>url.endsWith('/correcoes?limite=20')
        ?Promise.resolve(new Response(JSON.stringify({correcoes:[],antes:null}),{status:200}))
        :new Promise(resolve=>window.pending.push(resolve));
      montarRevisaoTrecho(document.getElementById('app'),
        {trechoId:id,obterToken:()=> 'token-sintetico',fetchImpl});
    },{id});
    await page.waitForFunction(()=>window.pending.length===1);
    assert.equal(await page.getByRole('button',{name:'Tentar novamente'}).isVisible(),false,
      'retry não deve iniciar segundo GET enquanto o primeiro está em voo');
    await page.locator('[data-review-action="retry"]').evaluate(button=>button.click());
    assert.equal(await page.evaluate(()=>window.pending.length),1,
      'guarda do controlador também impede segunda leitura inicial');
    await page.evaluate(()=>window.pending[0](new Response(JSON.stringify({codigo:'FALHA'}),{status:500})));
    await page.getByRole('button',{name:'Tentar novamente'}).click();
    await page.waitForFunction(()=>window.pending.length===2);
    await page.evaluate(dto=>window.pending[1](new Response(JSON.stringify(dto),{status:200})),dto);
    await page.getByLabel('Sua correção').fill('Meu rascunho não pode sumir.');
    assert.equal(await page.getByLabel('Sua correção').inputValue(),'Meu rascunho não pode sumir.');
    assert.equal(await page.evaluate(()=>window.pending.length),2,'uma leitura por tentativa');
  }finally{
    if(browser)await browser.close();
    await new Promise(r=>server.close(r));
  }
});

test('comparação de conflito acompanha o rascunho editado',async()=>{
  const source=resolve(import.meta.dirname,'../src/painel/notetaker-revisao.js');
  const server=createServer(async(req,res)=>{
    if(req.url==='/notetaker-revisao.js'){
      res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(source));return;
    }
    res.writeHead(200,{'content-type':'text/html'});
    res.end('<!doctype html><html lang="pt-BR"><body><main id="app"></main></body></html>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async({id,dto})=>{
      const {montarRevisaoTrecho}=await import('/notetaker-revisao.js');
      const current={...dto,revisao:1,textoCorrigido:'Versão concorrente.',textoExibido:'Versão concorrente.',
        ultimaCorrecao:{ator:'local:owner',em:'2026-09-27T12:00:00Z'}};
      let reads=0;
      const fetchImpl=(url,options)=>{
        if(url.endsWith('/correcoes?limite=20'))return Promise.resolve(new Response(JSON.stringify({correcoes:[],antes:null}),{status:200}));
        if(options.method==='PATCH')return Promise.resolve(new Response(JSON.stringify({codigo:'CONFLITO'}),{status:409}));
        return Promise.resolve(new Response(JSON.stringify(reads++===0?dto:current),{status:200}));
      };
      montarRevisaoTrecho(document.getElementById('app'),
        {trechoId:id,obterToken:()=> 'token-sintetico',fetchImpl});
    },{id,dto});
    await page.getByLabel('Sua correção').fill('Primeira redação.');
    await page.getByRole('button',{name:'Guardar correção'}).click();
    await page.getByRole('button',{name:'Conferir versão atual'}).click();
    await page.getByText('Versão concorrente.').waitFor();
    await page.getByLabel('Sua correção').fill('Nova redação após comparar.');
    await page.getByLabel('Sua correção').evaluate(el=>el.setSelectionRange(3,7));
    assert.equal(await page.locator('.nt-review-draft').textContent(),'Nova redação após comparar.');
    assert.deepEqual(await page.getByLabel('Sua correção').evaluate(el=>({focused:document.activeElement===el,start:el.selectionStart,end:el.selectionEnd})),
      {focused:true,start:3,end:7});
  }finally{
    if(browser)await browser.close();
    await new Promise(r=>server.close(r));
  }
});

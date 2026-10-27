import test from 'node:test';
import assert from 'node:assert/strict';
import {validarTextoCorrecao, validarTrechoRevisao} from '../src/painel/notetaker-revisao.js';
import {renderizarVista} from '../src/painel/notetaker-view.js';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const id='11000000-0000-4000-8000-000000000001';
const dto={id,eventoId:12,textoGerado:'Original sintético.',textoCorrigido:null,textoExibido:'Original sintético.',revisao:0,ultimaCorrecao:null,evidencia:{estado:'integra',parteId:id,inicioMs:0,fimMs:900}};

test('texto segue o mesmo limite Unicode e UTF-8 do serviço',()=>{
  assert.deepEqual(validarTextoCorrecao('  Olá 📝  '),{valido:true,texto:'Olá 📝',pontos:5});
  assert.equal(validarTextoCorrecao('  ').valido,false);
  assert.equal(validarTextoCorrecao('a'.repeat(4001)).valido,false);
  assert.equal(validarTextoCorrecao('\ud800').valido,false);
  assert.equal(validarTextoCorrecao('📝'.repeat(4000)).valido,true);
});

test('projeção exige ID, revisão, textos e evidência coerentes',()=>{
  assert.equal(validarTrechoRevisao(dto,id),true);
  for(const bad of [{...dto,id:'outro'},{...dto,revisao:-1},{...dto,textoExibido:null},{...dto,textoCorrigido:'errado'},{...dto,evidencia:{estado:'inventado'}}])
    assert.equal(validarTrechoRevisao(bad,id),false);
});

test('vista só oferece correção a trecho explicitamente autorizado',()=>{
  const base={estado:'revisavel',fonte:{disponivel:false,persistida:false},trechos:[{id,inicio:'00:00',texto:'Texto sintético.',podeCorrigir:true,coberto:true}]};
  assert.match(renderizarVista(base),/Corrigir texto/);
  for(const trecho of [{...base.trechos[0],podeCorrigir:false},{...base.trechos[0],tipo:'silencio'},{...base.trechos[0],tipo:'lacuna'},{...base.trechos[0],texto:''}])
    assert.doesNotMatch(renderizarVista({...base,trechos:[trecho]}),/Corrigir texto/);
});

test('DOM preserva rascunho em falha, valida recibo e apaga acesso negado',async()=>{
  const source=resolve(import.meta.dirname,'../src/painel/notetaker-revisao.js');
  const server=createServer(async(req,res)=>{
    if(req.url==='/notetaker-revisao.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(source));return;}
    res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html lang="pt-BR"><body><main id="app"></main></body></html>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async({id,dto})=>{
      const {montarRevisaoTrecho}=await import('/notetaker-revisao.js');
      window.responses=[];window.requests=[];window.savedCalls=[];window.closeCalls=[];
      window.fakeFetch=async(url,options)=>{
        window.requests.push({url,options:{method:options.method,body:options.body}});
        const next=window.responses.shift();if(!next||next.reject)throw Error('falha sintética de rede');
        return new Response(JSON.stringify(next.body),{status:next.status,headers:{'content-type':'application/json'}});
      };
      window.mount=()=>montarRevisaoTrecho(document.getElementById('app'),{trechoId:id,obterToken:()=> 'token-sintetico',fetchImpl:window.fakeFetch,
        onSaved:d=>window.savedCalls.push(d),onClose:d=>window.closeCalls.push(d)});
      window.dto=dto;
    },{id,dto});
    await page.evaluate(()=>{window.responses.push({status:200,body:{...window.dto,id:'outro'}});window.controller=window.mount();});
    await page.getByText('Não foi possível abrir o trecho. Tente novamente.').waitFor();
    assert.equal(await page.locator('#nt-review-text').count(),0);
    await page.evaluate(()=>{window.controller.destruir();window.responses.push({status:200,body:window.dto},{status:200,body:{correcoes:[],antes:null}});window.controller=window.mount();});
    await page.getByLabel('Sua correção').waitFor();
    await page.getByLabel('Sua correção').fill('Rascunho sintético.');
    await page.evaluate(()=>window.responses.push({reject:true}));
    await page.getByRole('button',{name:'Guardar correção'}).click();
    await page.getByText('Sem confirmação de salvamento.',{exact:false}).waitFor();
    assert.equal(await page.getByLabel('Sua correção').inputValue(),'Rascunho sintético.');
    await page.evaluate(()=>window.responses.push({status:200,body:window.dto}));
    await page.getByRole('button',{name:'Reler trecho'}).click();
    await page.getByText('Versão conferida.',{exact:false}).waitFor();
    await page.evaluate(()=>window.responses.push({status:200,body:{...window.dto,textoCorrigido:'Rascunho sintético.',textoExibido:'Rascunho sintético.',revisao:1,ultimaCorrecao:{ator:'local:owner',em:'2026-09-27T12:00:00Z'},repetida:false}},{status:200,body:{correcoes:[],antes:null}}));
    await page.locator('[data-review-action="save"]').evaluate(button=>{button.click();button.click();});
    await page.getByText('Correção guardada neste dispositivo.').waitFor();
    assert.equal(await page.evaluate(()=>window.requests.filter(r=>r.options.method==='PATCH').length),2,'uma tentativa com falha e um PATCH após duplo clique');
    assert.equal(await page.evaluate(()=>JSON.parse(window.requests.findLast(r=>r.options.method==='PATCH').options.body).confirmar),true);
    assert.equal(await page.evaluate(()=>window.savedCalls.length),1);
    await page.getByLabel('Sua correção').fill('Outro rascunho sintético.');
    await page.evaluate(()=>window.responses.push({status:200,body:{...window.dto, revisao:2,textoExibido:'Mentira do recibo.',textoCorrigido:null}}));
    await page.getByRole('button',{name:'Guardar correção'}).click();
    await page.getByText('Sem confirmação de salvamento.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>window.savedCalls.length),1,'recibo inválido não confirma');
    assert.equal(await page.getByLabel('Sua correção').inputValue(),'Outro rascunho sintético.');
    await page.evaluate(()=>window.responses.push({status:404,body:{codigo:'AUSENTE',erro:'texto interno'}}));
    await page.getByRole('button',{name:'Reler trecho'}).click();
    await page.getByText('Este trecho não está disponível para revisão.').waitFor();
    assert.equal((await page.locator('#app').textContent()).includes('Outro rascunho sintético.'),false);
    assert.equal((await page.locator('#app').textContent()).includes('texto interno'),false);
    assert.equal(await page.evaluate(()=>window.closeCalls.at(-1)?.motivo),'indisponivel');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
});

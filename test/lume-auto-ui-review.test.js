// Independent adversarial DOM review. Synthetic strings only, no live profile.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const script=await readFile(new URL('../src/painel/lume-1-interface.js',import.meta.url),'utf8');
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
async function fixture(t){
  const page=await browser.newPage();t.after(()=>page.close());
  await page.setContent('<head><link id="lume-auto-style"></head><body><section id="contacts"></section><section id="coverage"></section><section id="questions"></section><section id="correction"></section></body>');
  await page.evaluate(()=>{
    window.calls=[];window.hold=false;window.release=null;
    window.lumeConnectionRequest=async(path,body)=>{
      calls.push({path,body});
      if(body){if(window.hold)await new Promise(resolve=>window.release=resolve);if(window.deny)throw Object.assign(new Error('Fonte revogada sintética'),{status:403});return{};}
      if(path.endsWith('/central'))return {organizacao:{estado:'pausado',escopo:{tipo:'autorizadas',conversasElegiveis:0,exclusoes:1},perguntas:[{id:'q1',eventoId:1,trecho:'Mensagem fictícia com duas possibilidades.',pergunta:'Este assunto é de qual projeto?',opcoes:[{projetoId:'a',nome:'Projeto A'},{projetoId:'b',nome:'Projeto B'}]}]}};
      throw Error('Unexpected fixture route');
    };
  });
  await page.addScriptTag({content:script});
  await page.evaluate(()=>LumeUm.cobertura(document.getElementById('coverage'),{perguntas:document.getElementById('questions')}));
  return page;
}

test('UI revisão: duas ativações simultâneas de resposta produzem um único POST',async t=>{
  const page=await fixture(t);await page.evaluate(()=>window.hold=true);
  await page.getByRole('button',{name:'Projeto A',exact:true}).evaluate(button=>{button.click();button.click();});
  await page.waitForFunction(()=>window.release!==null);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.body).length),1);
  assert.equal(await page.locator('#questions button:enabled').count(),0);
  await page.evaluate(()=>window.release());
});

test('UI revisão: recusa por fonte revogada remove pergunta e opções antigas',async t=>{
  const page=await fixture(t);await page.evaluate(()=>window.deny=true);
  await page.getByRole('button',{name:'Projeto A',exact:true}).click();
  await page.getByRole('button',{name:'Atualizar contexto',exact:true}).waitFor();
  assert.equal(await page.locator('.la-question').count(),0);
  assert.doesNotMatch(await page.locator('#questions').innerText(),/Mensagem fictícia|Projeto A|Projeto B/);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.body).length),1);
});

test('UI revisão: formulário de escopo invalidado por navegação não envia autorização',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{
    const form=document.querySelector('.la-scope-form');form.querySelector('input').checked=true;
    window.dispatchEvent(new Event('lume:navigate'));
    form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
  });
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.body).length),0);
});

test('UI revisão: pergunta permite avançar por Tab e responder por Enter no browser isolado',async t=>{
  const page=await fixture(t);
  await page.getByRole('button',{name:'Projeto A',exact:true}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Projeto B');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>calls.some(c=>c.body?.projetoId==='b'));
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.body).map(c=>c.body)),[{id:'q1',projetoId:'b'}]);
});

test('UI revisão: recusa na correção de temperatura remove trecho e controles obsoletos',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{window.deny=true;const root=document.getElementById('correction');LumeUm.reverInteresse({temperatura:'quente',etapa:'proposta',fontes:[{eventoId:2,trecho:'Trecho comercial fictício que foi revogado.'}]},root,{valid:()=>root.isConnected,refresh:async()=>{}});});
  await page.getByText('Corrigir avaliação deste assunto',{exact:true}).click();
  await page.getByRole('button',{name:'Salvar minha avaliação',exact:true}).click();
  await page.locator('#correction').getByRole('button',{name:'Atualizar contexto',exact:true}).waitFor();
  assert.equal(await page.locator('#correction select').count(),0);
  assert.doesNotMatch(await page.locator('#correction').innerText(),/Trecho comercial fictício/);
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.body).map(c=>c.path)),['/api/v3/lume-1/organizacao/temperatura']);
});

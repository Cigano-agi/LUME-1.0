import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-05.mjs';
import {casos as um} from '../scripts/laya-action-heldout-01.mjs';
import {casos as dois} from '../scripts/laya-action-heldout-02.mjs';
import {casos as tres} from '../scripts/laya-action-heldout-03.mjs';
import {casos as quatro} from '../scripts/laya-action-heldout-04.mjs';

test('quinto corpus sintético fica congelado antes de testar outro candidato',()=>{
  assert.equal(casos.length,100);
  assert.equal(new Set(casos.map(c=>c.id)).size,100);
  assert.equal(casos.filter(c=>c.critico).length,20);
  assert.equal(casos.reduce((n,c)=>n+c.esperadas.length,0),84);
  assert.equal(casos.filter(c=>c.critico).reduce((n,c)=>n+c.esperadas.length,0),12);
  assert.ok(casos.some(c=>c.canal==='grupo'&&c.esperadas.length));
  assert.ok(casos.some(c=>c.autor==='terceiro'&&!c.esperadas.length));
  assert.ok(casos.some(c=>c.esperadas.length>=2));
  assert.ok(casos.some(c=>c.critico&&!c.esperadas.length));
  const normalizar=text=>text.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu,' ').trim();
  const anteriores=new Set([...um,...dois,...tres,...quatro].map(c=>normalizar(c.texto)));
  const vistos=new Set();
  for(const c of casos){
    assert.ok(['dm','grupo'].includes(c.canal));
    assert.ok(['proprio','outro','terceiro'].includes(c.autor));
    assert.ok(c.texto.length>=8&&c.texto.length<=2000);
    assert.equal(anteriores.has(normalizar(c.texto)),false,`${c.id}: texto usado antes`);
    assert.equal(vistos.has(normalizar(c.texto)),false,`${c.id}: texto repetido`);
    vistos.add(normalizar(c.texto));
    if(c.autor==='terceiro')assert.equal(c.esperadas.length,0,`${c.id}: tarefa atribuída a terceiro`);
    for(const e of c.esperadas){
      assert.ok(['pendencia','compromisso'].includes(e.tipo));
      assert.equal(c.texto.split(e.trecho).length,2,`${c.id}: trecho ausente ou repetido`);
    }
  }
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),'a0145361dc2b358cdec34dad58c9db2a703571d6ad07e87e8c5969116f5c4bec');
});

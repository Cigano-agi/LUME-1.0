import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-04.mjs';
import {casos as anteriores} from '../scripts/laya-action-heldout-03.mjs';

test('quarto corpus sintético fica íntegro antes da primeira medição',()=>{
  assert.equal(casos.length,100);
  assert.equal(casos.filter(c=>c.critico).length,20);
  assert.equal(casos.reduce((n,c)=>n+c.esperadas.length,0),82);
  assert.equal(casos.filter(c=>c.critico).reduce((n,c)=>n+c.esperadas.length,0),12);
  assert.equal(new Set(casos.map(c=>c.id)).size,100);
  const textosAnteriores=new Set(anteriores.map(c=>c.texto.toLocaleLowerCase('pt-BR')));
  for(const c of casos){
    assert.ok(['dm','grupo'].includes(c.canal));
    assert.ok(['proprio','outro','terceiro'].includes(c.autor));
    assert.equal(textosAnteriores.has(c.texto.toLocaleLowerCase('pt-BR')),false,`${c.id}: cópia do corpus 03`);
    for(const e of c.esperadas){
      assert.ok(['pendencia','compromisso'].includes(e.tipo));
      assert.ok(c.texto.includes(e.trecho),`${c.id}: trecho ausente`);
    }
  }
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),'199afc4a321847ca7bed465f1cc4fe650cee82e0dc85f7018e0287dc47e393ba');
});

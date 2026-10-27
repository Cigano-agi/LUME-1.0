import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-01.mjs';

test('corpus 0.6 congelado: 100 casos, 20 críticos, fontes literais e autoria',()=>{
  assert.equal(casos.length,100);
  assert.equal(casos.filter(c=>c.critico).length,20);
  assert.equal(casos.reduce((n,c)=>n+c.esperadas.length,0),70);
  assert.equal(new Set(casos.map(c=>c.id)).size,100);
  assert.ok(casos.some(c=>c.canal==='grupo'&&c.autor==='terceiro'));
  assert.ok(casos.some(c=>c.esperadas.length>1));
  for(const c of casos){
    assert.ok(['dm','grupo'].includes(c.canal));
    assert.ok(['proprio','outro','terceiro'].includes(c.autor));
    assert.equal(c.critico,c.id.startsWith('c'));
    for(const a of c.esperadas){
      assert.ok(['pendencia','compromisso'].includes(a.tipo));
      assert.ok(a.trecho.length>=8);
      assert.equal(c.texto.indexOf(a.trecho),c.texto.lastIndexOf(a.trecho),c.id);
      assert.ok(c.texto.includes(a.trecho),c.id);
    }
  }
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),'167c69f3a19e088e72fc4bcf6c44f86859cdcae55022616eb4b14e6bcb40726e');
});

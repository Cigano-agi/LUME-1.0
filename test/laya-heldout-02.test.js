import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-02.mjs';

test('segundo corpus sintético preservado antes da medição da hipótese 03',()=>{
  assert.equal(casos.length,100);
  assert.equal(casos.filter(c=>c.critico).length,20);
  assert.equal(casos.reduce((n,c)=>n+c.esperadas.length,0),88);
  assert.equal(new Set(casos.map(c=>c.id)).size,100);
  for(const c of casos)for(const e of c.esperadas)assert.ok(c.texto.includes(e.trecho),`${c.id}: trecho ausente`);
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),'af414d8c2da6114e48ce4a1e94f7ddfae12635ff9235e41c01f9250f588169c2');
});

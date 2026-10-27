import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-03.mjs';

test('terceiro corpus sintético fica íntegro antes da primeira medição',()=>{
  assert.equal(casos.length,100);
  assert.equal(casos.filter(c=>c.critico).length,20);
  assert.equal(casos.reduce((n,c)=>n+c.esperadas.length,0),84);
  assert.equal(new Set(casos.map(c=>c.id)).size,100);
  for(const c of casos)for(const e of c.esperadas)assert.ok(c.texto.includes(e.trecho),`${c.id}: trecho ausente`);
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),'d73ccf7fc37c20c4c85d230d9f83f0d48627c66f311926cc7aeea924ca071269');
});

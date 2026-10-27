import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-10.mjs';
import {casos as c01} from '../scripts/laya-action-heldout-01.mjs';
import {casos as c02} from '../scripts/laya-action-heldout-02.mjs';
import {casos as c03} from '../scripts/laya-action-heldout-03.mjs';
import {casos as c04} from '../scripts/laya-action-heldout-04.mjs';
import {casos as c05} from '../scripts/laya-action-heldout-05.mjs';
import {casos as c06} from '../scripts/laya-action-heldout-06.mjs';
import {casos as c07} from '../scripts/laya-action-train-07.mjs';
import {casos as c08} from '../scripts/laya-action-heldout-08.mjs';
import {casos as c09} from '../scripts/laya-action-heldout-09.mjs';

const normalize = text => text.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ').trim();
const byId = id => casos.find(c => c.id === id);

test('corpus 10 fica congelado, inédito e com trechos literais únicos', () => {
  assert.equal(casos.length, 100);
  assert.equal(new Set(casos.map(c => c.id)).size, 100);
  assert.equal(casos.filter(c => c.critico).length, 25);
  assert.equal(casos.reduce((n, c) => n + c.esperadas.length, 0), 77);
  assert.equal(casos.filter(c => c.critico).reduce((n, c) => n + c.esperadas.length, 0), 12);

  const previous = new Set([c01, c02, c03, c04, c05, c06, c07, c08, c09].flat().map(c => normalize(c.texto)));
  const seen = new Set();
  for (const c of casos) {
    assert.match(c.id, /^k\d{3}$/u);
    assert.ok(['dm', 'grupo'].includes(c.canal), c.id);
    assert.ok(['proprio', 'outro', 'terceiro'].includes(c.autor), c.id);
    assert.ok(c.texto.length >= 8 && c.texto.length <= 2000, c.id);
    assert.equal(previous.has(normalize(c.texto)), false, `${c.id}: cópia exata de corpus anterior`);
    assert.equal(seen.has(normalize(c.texto)), false, `${c.id}: texto duplicado`);
    seen.add(normalize(c.texto));
    if (c.autor === 'terceiro') assert.equal(c.esperadas.length, 0, `${c.id}: autor terceiro`);
    for (const e of c.esperadas) {
      assert.ok(['pendencia', 'compromisso'].includes(e.tipo), c.id);
      assert.ok(e.trecho.length >= 8, c.id);
      assert.equal(c.texto.split(e.trecho).length, 2, `${c.id}: trecho ausente ou repetido`);
      assert.equal(c.autor === 'proprio', e.tipo === 'compromisso', `${c.id}: papel e ação discordam`);
    }
  }
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),
    '89d0ca0e0308b76da5737e8af4e2473b91b8618513061507b670c7a238f09d32');
});

test('corpus 10 cobre ações, grupos, ausência, negação, cancelamento e estados críticos', () => {
  assert.ok(casos.some(c => c.canal === 'dm' && c.esperadas.length));
  assert.ok(casos.some(c => c.canal === 'grupo' && c.esperadas.length));
  assert.ok(casos.some(c => c.autor === 'proprio' && c.esperadas.length));
  assert.ok(casos.some(c => c.autor === 'outro' && c.esperadas.length));
  assert.ok(casos.filter(c => c.esperadas.length >= 2).length >= 8);
  assert.ok(casos.filter(c => c.critico && !c.esperadas.length).length >= 10);

  for (const id of ['k060', 'k061', 'k067', 'k068', 'k069', 'k081', 'k083', 'k086', 'k092', 'k098']) {
    assert.equal(byId(id).esperadas.length, 0, `${id}: negativa, cancelamento, terceiro ou injeção`);
  }
  for (const id of ['k077', 'k082', 'k085', 'k088', 'k090', 'k093', 'k096', 'k099']) {
    assert.equal(byId(id).critico, true, `${id}: estado comercial sensível`);
    assert.equal(byId(id).esperadas.length, 0, `${id}: não criar aceite, pagamento ou conclusão`);
  }
  for (const id of ['k076', 'k078', 'k079', 'k080', 'k084', 'k087', 'k089', 'k091', 'k094', 'k095', 'k097', 'k100']) {
    assert.equal(byId(id).critico, true, `${id}: verificação crítica`);
    assert.ok(byId(id).esperadas.length > 0, `${id}: ação de verificação`);
  }
});

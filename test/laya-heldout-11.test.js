import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-11.mjs';
import {casos as c01} from '../scripts/laya-action-heldout-01.mjs';
import {casos as c02} from '../scripts/laya-action-heldout-02.mjs';
import {casos as c03} from '../scripts/laya-action-heldout-03.mjs';
import {casos as c04} from '../scripts/laya-action-heldout-04.mjs';
import {casos as c05} from '../scripts/laya-action-heldout-05.mjs';
import {casos as c06} from '../scripts/laya-action-heldout-06.mjs';
import {casos as c07} from '../scripts/laya-action-train-07.mjs';
import {casos as c08} from '../scripts/laya-action-heldout-08.mjs';
import {casos as c09} from '../scripts/laya-action-heldout-09.mjs';
import {casos as c10} from '../scripts/laya-action-heldout-10.mjs';

const normalize = text => text.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ').trim();
const byId = id => casos.find(c => c.id === id);

test('corpus 11 tem contagens, hash, esquema e spans imutáveis', () => {
  assert.equal(casos.length, 100);
  assert.equal(new Set(casos.map(c => c.id)).size, 100);
  assert.equal(casos.filter(c => c.critico).length, 25);
  assert.equal(casos.reduce((n, c) => n + c.esperadas.length, 0), 78);
  assert.equal(casos.filter(c => c.critico).reduce((n, c) => n + c.esperadas.length, 0), 12);

  const anteriores = new Set([c01, c02, c03, c04, c05, c06, c07, c08, c09, c10].flat().map(c => normalize(c.texto)));
  const vistos = new Set();
  for (const c of casos) {
    assert.match(c.id, /^q\d{3}$/u);
    assert.ok(['dm', 'grupo'].includes(c.canal), c.id);
    assert.ok(['proprio', 'outro', 'terceiro'].includes(c.autor), c.id);
    assert.ok(c.texto.length >= 8 && c.texto.length <= 2000, c.id);
    assert.equal(anteriores.has(normalize(c.texto)), false, `${c.id}: cópia de conjunto anterior`);
    assert.equal(vistos.has(normalize(c.texto)), false, `${c.id}: duplicata interna`);
    vistos.add(normalize(c.texto));
    if (c.autor === 'terceiro') assert.equal(c.esperadas.length, 0, `${c.id}: autor terceiro`);
    for (const e of c.esperadas) {
      assert.ok(['pendencia', 'compromisso'].includes(e.tipo), c.id);
      assert.ok(e.trecho.length >= 8, c.id);
      assert.equal(c.texto.split(e.trecho).length, 2, `${c.id}: span ausente ou não único`);
      assert.equal(c.autor === 'proprio', e.tipo === 'compromisso', `${c.id}: papel e tipo de ação`);
    }
  }
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),
    'a4eefe03ce2739a56c1f525bb34e9c379360f1b1c1f0213272d95ba89e00c6c3');
});

test('corpus 11 cobre papéis, múltiplas ações e negativos críticos sem falsa conclusão', () => {
  assert.ok(casos.some(c => c.canal === 'dm' && c.esperadas.length));
  assert.ok(casos.some(c => c.canal === 'grupo' && c.esperadas.length));
  assert.ok(casos.some(c => c.autor === 'proprio' && c.esperadas.length));
  assert.ok(casos.some(c => c.autor === 'outro' && c.esperadas.length));
  assert.ok(casos.filter(c => c.esperadas.length >= 2).length >= 8);
  assert.ok(casos.some(c => c.esperadas.length >= 3));
  assert.ok(casos.some(c => c.texto.includes('\n')));
  assert.ok(casos.filter(c => c.critico && !c.esperadas.length).length >= 10);

  for (const id of ['q060', 'q061', 'q067', 'q068', 'q069', 'q081', 'q083', 'q086', 'q092', 'q098']) {
    assert.equal(byId(id).esperadas.length, 0, `${id}: negação, cancelamento ou injeção`);
  }
  for (const id of ['q077', 'q082', 'q085', 'q088', 'q090', 'q093', 'q096', 'q099']) {
    assert.equal(byId(id).critico, true, `${id}: pagamento, aceite ou conclusão`);
    assert.equal(byId(id).esperadas.length, 0, `${id}: sem estado confirmado`);
  }
  for (const id of ['q076', 'q078', 'q079', 'q080', 'q084', 'q087', 'q089', 'q091', 'q094', 'q095', 'q097', 'q100']) {
    assert.equal(byId(id).critico, true, `${id}: ação sensível`);
    assert.ok(byId(id).esperadas.length > 0, `${id}: verificar antes de afirmar`);
  }
});

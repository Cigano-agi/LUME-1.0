import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-14.mjs';
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
import {casos as c11} from '../scripts/laya-action-heldout-11.mjs';
import {casos as c12} from '../scripts/laya-action-heldout-12.mjs';
import {casos as c13} from '../scripts/laya-action-heldout-13.mjs';

const normalizar = texto => texto.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ').trim();
const porId = id => casos.find(c => c.id === id);

test('corpus 14: esquema, trechos, unicidade, contagens e hash congelados', () => {
  assert.equal(casos.length, 100);
  assert.equal(new Set(casos.map(c => c.id)).size, 100);
  assert.equal(casos.filter(c => c.critico).length, 55);
  assert.equal(casos.reduce((n, c) => n + c.esperadas.length, 0), 110);
  assert.equal(casos.filter(c => c.critico).reduce((n, c) => n + c.esperadas.length, 0), 42);

  const anteriores = new Set([c01, c02, c03, c04, c05, c06, c07, c08, c09, c10, c11, c12, c13].flat().map(c => normalizar(c.texto)));
  const vistos = new Set();
  for (const c of casos) {
    assert.deepEqual(Object.keys(c), ['id', 'canal', 'autor', 'texto', 'esperadas', 'critico'], c.id);
    assert.match(c.id, /^t\d{3}$/u);
    assert.ok(['dm', 'grupo'].includes(c.canal), c.id);
    assert.ok(['proprio', 'outro', 'terceiro'].includes(c.autor), c.id);
    assert.equal(typeof c.texto, 'string', c.id);
    assert.ok(c.texto.length >= 8, c.id);
    assert.equal(typeof c.critico, 'boolean', c.id);
    assert.equal(anteriores.has(normalizar(c.texto)), false, `${c.id}: cópia exata normalizada anterior`);
    assert.equal(vistos.has(normalizar(c.texto)), false, `${c.id}: duplicata exata normalizada interna`);
    vistos.add(normalizar(c.texto));
    assert.ok(Array.isArray(c.esperadas), c.id);
    if (c.autor === 'terceiro') assert.equal(c.esperadas.length, 0, c.id);
    const spans = new Set();
    for (const e of c.esperadas) {
      assert.deepEqual(Object.keys(e), ['tipo', 'trecho'], c.id);
      assert.ok(['pendencia', 'compromisso'].includes(e.tipo), c.id);
      assert.ok(e.trecho.length >= 8, c.id);
      assert.equal(c.texto.split(e.trecho).length, 2, `${c.id}: trecho ausente ou repetido`);
      assert.equal(spans.has(e.trecho), false, `${c.id}: ação duplicada`);
      spans.add(e.trecho);
      assert.equal(e.tipo === 'compromisso', c.autor === 'proprio', c.id);
    }
  }
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),
    '691fe8d5a107f4db46e715faa6f4974a26c4813d019c0a697afd02d81b357e10');
});

test('corpus 14: distribuição, condições e negativos', () => {
  for (const canal of ['dm', 'grupo']) assert.ok(casos.some(c => c.canal === canal && c.esperadas.length));
  for (const autor of ['proprio', 'outro']) assert.ok(casos.some(c => c.autor === autor && c.esperadas.length));
  assert.ok(casos.filter(c => c.autor === 'terceiro').length >= 5);
  assert.ok(casos.filter(c => c.esperadas.length >= 2).length >= 25);
  assert.ok(casos.some(c => c.esperadas.length >= 3));
  assert.ok(casos.filter(c => c.critico && !c.esperadas.length).length >= 15);
  for (const id of ['t052', 't053', 't054', 't055', 't056', 't057', 't058', 't059', 't060', 't071', 't072', 't073', 't074', 't075']) {
    assert.equal(porId(id).esperadas.length, 1, `${id}: prova presente; passo contingente excluído`);
  }
  for (const id of ['t076', 't077', 't078', 't079', 't080', 't081', 't082', 't083', 't084', 't085', 't086', 't087', 't088', 't089', 't090', 't096', 't097', 't098', 't099', 't100']) {
    assert.equal(porId(id).esperadas.length, 0, `${id}: citação, terceiro, cancelamento ou conclusão`);
  }
  for (const id of ['t091', 't092', 't093', 't094', 't095']) {
    assert.equal(porId(id).esperadas.length, 1, `${id}: só ação vigente`);
  }
});

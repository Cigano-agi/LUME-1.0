import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-12.mjs';
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

const normalizar = texto => texto.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ').trim();
const porId = id => casos.find(c => c.id === id);

test('corpus 12: esquema, spans, contagens, unicidade e hash congelados', () => {
  assert.equal(casos.length, 100);
  assert.equal(new Set(casos.map(c => c.id)).size, 100);
  assert.equal(casos.filter(c => c.critico).length, 42);
  assert.equal(casos.reduce((n, c) => n + c.esperadas.length, 0), 73);
  assert.equal(casos.filter(c => c.critico).reduce((n, c) => n + c.esperadas.length, 0), 23);

  const anteriores = new Set([c01, c02, c03, c04, c05, c06, c07, c08, c09, c10, c11].flat().map(c => normalizar(c.texto)));
  const vistos = new Set();
  for (const c of casos) {
    assert.deepEqual(Object.keys(c), ['id', 'canal', 'autor', 'texto', 'esperadas', 'critico'], c.id);
    assert.match(c.id, /^r\d{3}$/u);
    assert.ok(['dm', 'grupo'].includes(c.canal), c.id);
    assert.ok(['proprio', 'outro', 'terceiro'].includes(c.autor), c.id);
    assert.equal(typeof c.texto, 'string', c.id);
    assert.ok(c.texto.length >= 8, c.id);
    assert.equal(typeof c.critico, 'boolean', c.id);
    assert.equal(anteriores.has(normalizar(c.texto)), false, `${c.id}: cópia exata normalizada de corpus anterior`);
    assert.equal(vistos.has(normalizar(c.texto)), false, `${c.id}: duplicata exata normalizada interna`);
    vistos.add(normalizar(c.texto));
    assert.ok(Array.isArray(c.esperadas), c.id);
    if (c.autor === 'terceiro') assert.equal(c.esperadas.length, 0, c.id);
    for (const e of c.esperadas) {
      assert.deepEqual(Object.keys(e), ['tipo', 'trecho'], c.id);
      assert.ok(['pendencia', 'compromisso'].includes(e.tipo), c.id);
      assert.ok(e.trecho.length >= 8, c.id);
      assert.equal(c.texto.split(e.trecho).length, 2, `${c.id}: trecho ausente ou repetido`);
      assert.equal(e.tipo === 'compromisso', c.autor === 'proprio', c.id);
    }
  }
  assert.equal(createHash('sha256').update(JSON.stringify(casos)).digest('hex'),
    '10999fa0973616d6475703c6dfd428399339029b4d06acea0f7c90d80f1500a9');
});

test('corpus 12: papéis, múltiplas ações e negativos críticos', () => {
  for (const canal of ['dm', 'grupo']) assert.ok(casos.some(c => c.canal === canal && c.esperadas.length));
  for (const autor of ['proprio', 'outro']) assert.ok(casos.some(c => c.autor === autor && c.esperadas.length));
  assert.ok(casos.some(c => c.autor === 'terceiro'));
  assert.ok(casos.filter(c => c.esperadas.length >= 2).length >= 8);
  assert.ok(casos.some(c => c.esperadas.length >= 3));
  assert.ok(casos.some(c => c.texto.includes('\n')));
  assert.ok(casos.filter(c => c.critico && !c.esperadas.length).length >= 15);
  for (const id of ['r057', 'r058', 'r059', 'r065', 'r067', 'r068', 'r083', 'r093', 'r099']) {
    assert.equal(porId(id).esperadas.length, 0, id);
  }
  for (const id of ['r077', 'r079', 'r081', 'r085', 'r087', 'r089', 'r091', 'r095', 'r097']) {
    assert.equal(porId(id).critico, true, id);
    assert.equal(porId(id).esperadas.length, 0, `${id}: estado comercial sem prova`);
  }
  for (const id of ['r076', 'r078', 'r080', 'r082', 'r084', 'r086', 'r088', 'r090', 'r092', 'r094', 'r096', 'r098', 'r100']) {
    assert.equal(porId(id).critico, true, id);
    assert.ok(porId(id).esperadas.length > 0, `${id}: verificação antes de afirmar estado`);
  }
});

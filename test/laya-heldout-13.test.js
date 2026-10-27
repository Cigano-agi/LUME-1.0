import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {casos} from '../scripts/laya-action-heldout-13.mjs';
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

const normalizar = texto => texto.normalize('NFKC').toLocaleLowerCase('pt-BR').replace(/\s+/gu, ' ').trim();
const porId = id => casos.find(c => c.id === id);

test('corpus 13: esquema, trechos, unicidade, contagens e hash congelados', () => {
  assert.equal(casos.length, 100);
  assert.equal(new Set(casos.map(c => c.id)).size, 100);
  assert.equal(casos.filter(c => c.critico).length, 50);
  assert.equal(casos.reduce((n, c) => n + c.esperadas.length, 0), 92);
  assert.equal(casos.filter(c => c.critico).reduce((n, c) => n + c.esperadas.length, 0), 23);

  const anteriores = new Set([c01, c02, c03, c04, c05, c06, c07, c08, c09, c10, c11, c12].flat().map(c => normalizar(c.texto)));
  const vistos = new Set();
  for (const c of casos) {
    assert.deepEqual(Object.keys(c), ['id', 'canal', 'autor', 'texto', 'esperadas', 'critico'], c.id);
    assert.match(c.id, /^s\d{3}$/u);
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
    '5e393c5498c822dfa88ce5dfc7c90cec0eab94552a543bf2ac17fc12370f9f64');
});

test('corpus 13: papéis, múltiplas ações, cancelamentos e estados comerciais sem prova', () => {
  for (const canal of ['dm', 'grupo']) assert.ok(casos.some(c => c.canal === canal && c.esperadas.length));
  for (const autor of ['proprio', 'outro']) assert.ok(casos.some(c => c.autor === autor && c.esperadas.length));
  assert.ok(casos.some(c => c.autor === 'terceiro'));
  assert.ok(casos.filter(c => c.esperadas.length >= 2).length >= 15);
  assert.ok(casos.some(c => c.esperadas.length >= 3));
  assert.ok(casos.filter(c => c.critico && !c.esperadas.length).length >= 25);
  for (const id of ['s051', 's052', 's053', 's057', 's059', 's061', 's062', 's064']) {
    assert.equal(porId(id).esperadas.length, 0, `${id}: negação, citação ou cancelamento`);
  }
  for (const id of ['s055', 's056', 's058', 's063', 's065']) {
    assert.equal(porId(id).esperadas.length, 1, `${id}: somente instrução vigente`);
  }
  for (let n = 66; n <= 80; n++) {
    const c = porId(`s${String(n).padStart(3, '0')}`);
    assert.equal(c.critico, true, c.id);
    assert.ok(c.esperadas.length > 0, `${c.id}: checagem com origem`);
  }
  for (let n = 81; n <= 100; n++) {
    const c = porId(`s${String(n).padStart(3, '0')}`);
    assert.equal(c.critico, true, c.id);
    assert.equal(c.esperadas.length, 0, `${c.id}: estado ou instrução sem mandato`);
  }
});

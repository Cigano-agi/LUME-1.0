import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = new URL('./fixtures/beta07-sintese-reservada.json', import.meta.url);
const cases = JSON.parse(readFileSync(path, 'utf8'));
const themes = new Set(['multiturn', 'par_minimo', 'homonimos', 'reporte', 'reuniao', 'valor', 'negacao', 'prazo', 'condicional', 'cancelamento', 'projetos', 'injecao', 'abstencao', 'silencio', 'multiplas_acoes', 'transcricao']);
const types = new Set(['pedido', 'proposta', 'compromisso', 'prazo', 'pagamento', 'cancelamento', 'reuniao', 'registro', 'condicao', 'status']);
const states = new Set(['solicitado', 'proposto', 'assumido', 'alterado', 'parcial', 'cancelado', 'relatado', 'incerto', 'nao_ocorrido', 'registrado']);

test('corpus reservado: contrato, diversidade e cobertura estrutural', () => {
  assert.equal(cases.length, 100);
  const ids = new Set();
  const signatures = new Set();
  const groups = new Map();
  const coverage = new Map();
  let critical = 0;
  let multiturn = 0;
  for (const item of cases) {
    assert.match(item.id, /^R\d{3}$/);
    assert.ok(!ids.has(item.id), `ID repetido: ${item.id}`);
    ids.add(item.id);
    assert.ok(themes.has(item.tema), `${item.id}: tema`);
    coverage.set(item.tema, (coverage.get(item.tema) ?? 0) + 1);
    assert.equal(typeof item.critico, 'boolean');
    critical += Number(item.critico);
    assert.ok(Array.isArray(item.fontes) && item.fontes.length > 0);
    multiturn += Number(item.fontes.length >= 3);
    const sourceIds = new Set();
    let previousTime = -Infinity;
    for (const [index, source] of item.fontes.entries()) {
      assert.equal(source.id, `E${index + 1}`, `${item.id}: ordem de fontes`);
      sourceIds.add(source.id);
      assert.ok(typeof source.autor === 'string' && source.autor.trim());
      assert.match(source.dataISO, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/);
      assert.ok(!Number.isNaN(Date.parse(source.dataISO)), `${item.id}: data`);
      const timestamp = Date.parse(source.dataISO);
      assert.ok(timestamp > previousTime, `${item.id}: ordem temporal`);
      previousTime = timestamp;
      assert.ok(typeof source.texto === 'string' && source.texto.trim().length >= 8);
    }
    const signature = JSON.stringify(item.fontes.map(({ autor, texto }) => [autor, texto]));
    assert.ok(!signatures.has(signature), `${item.id}: entrada repetida`);
    signatures.add(signature);
    assert.equal(typeof item.esperado.insuficiente, 'boolean');
    assert.ok(Array.isArray(item.esperado.fatos));
    assert.ok(Array.isArray(item.esperado.proibidos) && item.esperado.proibidos.length > 0);
    for (const forbidden of item.esperado.proibidos) assert.ok(typeof forbidden === 'string' && forbidden.trim().length > 8);
    for (const fact of item.esperado.fatos) {
      assert.ok(types.has(fact.tipo), `${item.id}: tipo`);
      assert.ok(states.has(fact.estado), `${item.id}: estado`);
      assert.ok(typeof fact.autor === 'string' && fact.autor.trim());
      assert.ok(typeof fact.texto === 'string' && fact.texto.trim().length > 8);
      assert.ok(Array.isArray(fact.fontes) && fact.fontes.length > 0);
      for (const ref of fact.fontes) assert.ok(sourceIds.has(ref), `${item.id}: fonte ausente ${ref}`);
    }
    if (item.grupo_id) {
      assert.match(item.grupo_id, /^P\d\d$/);
      groups.set(item.grupo_id, [...(groups.get(item.grupo_id) ?? []), item]);
    }
  }
  assert.ok(critical >= 20, `críticos: ${critical}`);
  assert.ok(multiturn >= 24, `multiturn: ${multiturn}`);
  assert.deepEqual([...ids].sort(), Array.from({ length: 100 }, (_, index) => `R${String(index + 1).padStart(3, '0')}`));
  assert.equal(groups.size, 10);
  for (const [group, pair] of groups) {
    assert.equal(pair.length, 2, group);
    assert.equal(pair[0].tema, 'par_minimo');
    assert.equal(pair[1].tema, 'par_minimo');
    assert.notDeepEqual(pair[0].esperado, pair[1].esperado, `${group}: oráculos iguais`);
    assert.equal(pair[0].fontes.length, 1, `${group}: par não mínimo`);
    assert.equal(pair[1].fontes.length, 1, `${group}: par não mínimo`);
    assert.notEqual(pair[0].fontes[0].texto, pair[1].fontes[0].texto, `${group}: textos iguais`);
  }
  for (const theme of themes) assert.ok((coverage.get(theme) ?? 0) >= (theme === 'multiturn' ? 24 : theme === 'par_minimo' ? 20 : 4), `cobertura baixa: ${theme}`);
});

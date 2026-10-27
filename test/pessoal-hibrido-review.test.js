import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {Desktop} from '../src/desktop.js';
import {ContextoPessoal} from '../src/pessoal/contexto.js';
import {Semantica} from '../src/semantica.js';

function fixture(t) {
  const db = abrirBanco(':memory:'); new ContextoApp(db); new Desktop(db); new DesktopIA(db);
  t.after(() => db.close());
  const contexto = new ContextoPessoal(db);
  for (const [id, name] of [['a', 'Ágata Oficina'], ['b', 'Ágata Estúdio'], ['c', 'Bruno']]) db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id, name);
  let seq = 0;
  const inserir = (text, {conversa = 'a', permissao = 'minha', date = '2026-10-25T10:00:00Z'} = {}) => Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada','texto','{}',?,?,?,?)`).run(conversa, String(++seq), text, date, date.slice(0, 10), permissao).lastInsertRowid);
  const allow = (id = 'a', permitted = 1) => db.prepare('INSERT OR REPLACE INTO desktop_ia_conversas VALUES(?,?,?)').run(id, permitted, '2026-10-26');
  allow();
  const row = id => db.prepare('SELECT * FROM desktop_fontes WHERE id=?').get(id);
  return {db, contexto, inserir, allow, row};
}

test('review híbrido: desativado ou não pronto nunca carrega nem consulta modelo', async t => {
  const f = fixture(t); f.inserir('Fonte autorizada');
  for (const [ativa, pronta] of [[false, false], [true, false]]) {
    let calls = 0;
    const semantica = {ativa: () => ativa, pronta: () => pronta, buscar: () => {calls++; throw Error('Não permitido');}, carregar: () => {calls++; throw Error('Não permitido');}};
    const result = await f.contexto.recuperarHibrido({remoto: true, semantica});
    assert.equal(result.modo, 'textual'); assert.equal(calls, 0);
  }
});

test('review híbrido: cap de 12 também vale no fallback textual', async t => {
  const f = fixture(t); for (let i = 0; i < 25; i++) f.inserir('Contexto sintético ' + i);
  const result = await f.contexto.recuperarHibrido({remoto: true});
  assert(result.fontes.length <= 12, `Retornou ${result.fontes.length} fontes`);
});

for (const mutation of ['opt-in', 'permissao', 'texto', 'exclusao']) {
  test(`review híbrido: revalida lexical após await — ${mutation}`, async t => {
    const f = fixture(t), id = f.inserir('Fonte antes da espera');
    const semantica = {ativa: () => true, pronta: () => true, buscar: async () => {
      await Promise.resolve();
      if (mutation === 'opt-in') f.allow('a', 0);
      else if (mutation === 'permissao') f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);
      else if (mutation === 'texto') f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte corrigida', id);
      else {f.db.prepare('DELETE FROM eventos WHERE id=?').run(id); assert.equal(f.row(id), undefined, 'DELETE realmente removeu a fonte');}
      return [];
    }};
    const result = await f.contexto.recuperarHibrido({conversaId: 'a', remoto: true, semantica});
    assert(!result.fontes.some(source => source.id === id && source.texto === 'Fonte antes da espera'), 'Fonte antiga/revogada atravessou await');
  });
}

test('review híbrido: fallback por erro também revalida fontes e ações', async t => {
  const f = fixture(t), id = f.inserir('Preparar o relatório da oficina amanhã.');
  f.contexto.registrarDemanda({eventoId: id, resumo: 'Relatório', trecho: 'Preparar o relatório da oficina amanhã.'});
  const semantica = {ativa: () => true, pronta: () => true, buscar: async () => {
    await Promise.resolve(); f.allow('a', 0); throw Error('Falha sintética');
  }};
  const result = await f.contexto.recuperarHibrido({remoto: true, semantica});
  assert.deepEqual(result.fontes, []); assert.deepEqual(result.acoes, []);
});

test('review híbrido: densas revalidam assinatura e conversa exata', async t => {
  const f = fixture(t), first = f.inserir('Fonte válida da oficina'), changed = f.inserir('Fonte a corrigir'), other = f.inserir('Outra conversa', {conversa: 'b'});
  f.allow('b'); const hit = {...f.row(changed), trecho: 'Fonte a corrigir'};
  let options, filter;
  const semantica = {ativa: () => true, pronta: () => true, buscar: async (q, o) => {
    options = o; filter = q; f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Conteúdo alterado', changed);
    return [{...f.row(first), trecho: 'Fonte válida'}, hit, {...f.row(other), trecho: 'Outra conversa'}];
  }};
  const result = await f.contexto.recuperarHibrido({pergunta: 'oficina', conversaId: 'a', remoto: true, semantica});
  assert.deepEqual(options, {remoto: true, limite: 10, limiteVetores: 500}); assert.equal(filter.conversa, 'a');
  assert(!result.fontes.some(source => source.id === other));
  assert(!result.fontes.some(source => source.id === changed && source.texto === 'Fonte a corrigir'));
  assert(result.fontes.length <= 12);
});

test('review híbrido: cancelamento externo não devolve fallback privado', async t => {
  const f = fixture(t); f.inserir('Fonte privada'); const controller = new AbortController();
  const semantica = {ativa: () => true, pronta: () => true, buscar: async () => {controller.abort(Error('Cancelamento sintético')); return new Promise(() => {});}};
  await assert.rejects(f.contexto.recuperarHibrido({remoto: true, semantica, signal: controller.signal}), /Cancelamento sintético/);
});

test('review híbrido: primeiro nome e acentos exigem candidato autorizado único', t => {
  const f = fixture(t); f.inserir('Oficina'); f.inserir('Estúdio', {conversa: 'b'});
  assert.equal(f.contexto.resolverConversa({nome: 'agata', remoto: true}).conversaId, 'a');
  f.allow('b'); const ambiguous = f.contexto.resolverConversa({nome: 'Ágata', remoto: true});
  assert.equal(ambiguous.ambigua, true); assert.equal(ambiguous.conversaId, null);
  assert.equal(f.contexto.resolverConversa({nome: 'agata oficina', remoto: true}).conversaId, 'a');
  f.allow('a', 0); assert.equal(f.contexto.resolverConversa({nome: 'a', remoto: true}).conversaId, null);
});

test('review híbrido: SQLite limita 500 vetores depois de ACL/conversa e antes de ranking', async t => {
  const f = fixture(t); const ids = [];
  for (let i = 0; i < 510; i++) ids.push(f.inserir('Vetor permitido ' + i));
  f.allow('b'); for (let i = 0; i < 30; i++) f.inserir('Outra conversa recente ' + i, {conversa: 'b'});
  for (let i = 0; i < 30; i++) f.inserir('Não permitido ' + i, {permissao: 'terceiro'});
  const sem = new Semantica(f.db, {extrair: async () => [1, 0]});
  await sem.ativar(); await sem.indexar({limite: 1000});
  // A corrupt vector outside the window would throw during distance calculation.
  f.db.prepare('UPDATE desktop_vetores SET vetor=? WHERE evento_id=?').run(Buffer.from(new Float32Array([1, 0, 0]).buffer), ids[0]);
  let scanned = 0; const prepare = f.db.prepare.bind(f.db);
  t.mock.method(f.db, 'prepare', sql => {
    const statement = prepare(sql);
    if (!sql.includes('SELECT e.id,v.inicio,v.fim,v.vetor')) return statement;
    return {iterate(...args) {return (function* () {for (const row of statement.iterate(...args)) {scanned++; yield row;}})();}};
  });
  const found = await sem.buscar({pergunta: 'Vetor', conversa: 'a', ate: '2026-10-26'}, {limite: 12, limiteVetores: 500, remoto: true});
  assert.equal(scanned, 500); assert(found.every(row => row.conversa_id === 'a' && row.permissao === 'minha'));
  assert(!found.some(row => row.id === ids[0])); assert.equal(found.length, 12);
  await sem.encerrar();
});

test('review híbrido: revogação durante vetor da pergunta fecha resultado real SQLite', async t => {
  const f = fixture(t); f.inserir('Fonte autorizada temporariamente');
  const sem = new Semantica(f.db, {extrair: async (text, type) => {if (type === 'query') {await Promise.resolve(); f.allow('a', 0);} return [1, 0];}});
  await sem.ativar(); await sem.indexar();
  assert.deepEqual(await sem.buscar({pergunta: 'Fonte', conversa: 'a', ate: '2026-10-26'}, {remoto: true, limiteVetores: 500}), []);
  await sem.encerrar();
});

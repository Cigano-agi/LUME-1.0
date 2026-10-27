import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { Semantica } from '../src/semantica.js';
import { recorte } from '../src/recuperacao.js';

function adiar() {
  let resolver, rejeitar;
  const promessa = new Promise((resolve, reject) => { resolver = resolve; rejeitar = reject; });
  return { promessa, resolver, rejeitar };
}

function fixture(t, extrair) {
  const db = abrirBanco();
  let fechado = false;
  const fechar = () => { if (!fechado) { db.close(); fechado = true; } };
  t.after(fechar);
  new ContextoApp(db); new Desktop(db); new DesktopIA(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('equipe', 'Equipe');
  db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,?,?)').run('equipe', 1, '2026-09-17');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('equipe','fonte','entrada','texto','{}','Revisar contrato','2026-09-17T12:00:00Z','2026-09-17','minha')`).run();
  return { db, fechar, sem: new Semantica(db, { extrair }), filtro: recorte({ pergunta: 'contrato', periodo: 'semana' }, new Date('2026-09-17T20:00:00Z')) };
}

test('encerrar espera inferências de indexação e busca até o finally, sem publicar vetor tardio', async t => {
  const indexacao = adiar(), busca = adiar();
  const chamadas = adiar();
  let quantidade = 0;
  const { db, fechar, sem, filtro } = fixture(t, (_texto, tipo) => {
    if (++quantidade === 2) chamadas.resolver();
    return tipo === 'query' ? busca.promessa : indexacao.promessa;
  });
  let disposes = 0;
  sem.pipeline = { dispose() { disposes++; } };
  await sem.ativar();
  const job = sem.indexar();
  const query = sem.buscar(filtro);
  await chamadas.promessa;
  let encerrado = false;
  const fim = sem.encerrar().then(() => { encerrado = true; });
  assert.equal(sem.ativa(), false);
  assert.equal(db.prepare('SELECT ativa FROM desktop_semantica_config').get().ativa, 1);
  assert.equal(sem.encerrar(), sem.encerrar());
  await assert.rejects(sem.buscar(filtro), /encerrad/i);
  await assert.rejects(sem.ativar(), /encerrad/i);
  await assert.rejects(sem.indexar(), /encerrad/i);
  indexacao.resolver([1, 0]);
  await assert.rejects(job, /encerrad/i);
  assert.equal(encerrado, false);
  assert.equal(disposes, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM desktop_vetores').get().n, 0);
  busca.resolver([1, 0]);
  await assert.rejects(query, /encerrad/i);
  await fim;
  assert.equal(encerrado, true);
  assert.equal(disposes, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM desktop_vetores').get().n, 0);
  fechar();
  await assert.rejects(sem.buscar(filtro), /encerrad/i);
  await assert.rejects(sem.indexar(), /encerrad/i);
  await assert.rejects(sem.carregar(), /encerrad/i);
  await assert.rejects(sem.vetor('contrato'), /encerrad/i);
});

test('encerrar cancela ativação concorrente antes de persistir e aguarda load', async t => {
  const load = adiar();
  const { db, sem } = fixture(t, null);
  sem.carregando = load.promessa;
  const ativacao = sem.ativar();
  const fim = sem.encerrar();
  let concluiu = false;
  fim.then(() => { concluiu = true; }, () => {});
  await Promise.resolve();
  assert.equal(concluiu, false);
  load.resolver();
  await assert.rejects(ativacao, /cancelad|encerrad/i);
  await fim;
  assert.equal(concluiu, true);
  assert.equal(db.prepare('SELECT ativa FROM desktop_semantica_config').get().ativa, 0);
});

test('encerrar aguarda inferência rejeitada e propaga somente falha de dispose', async t => {
  const inferencia = adiar();
  const { sem } = fixture(t, () => inferencia.promessa);
  let disposes = 0;
  sem.pipeline = { async dispose() { disposes++; throw new Error('Falha dispose'); } };
  await sem.ativar();
  const job = sem.indexar();
  const fim = sem.encerrar();
  inferencia.rejeitar(new Error('Falha inferência'));
  await assert.rejects(job, /inferência/);
  await assert.rejects(fim, error => error instanceof AggregateError && error.errors.length === 1 && /dispose/.test(error.errors[0].message));
  assert.equal(disposes, 1);
  assert.equal(sem.encerrar(), fim);
});

test('encerrar conclui após falha já entregue ao chamador quando dispose sucede', async t => {
  const inferencia = adiar();
  const { sem } = fixture(t, () => inferencia.promessa);
  let disposes = 0;
  sem.pipeline = { async dispose() { disposes++; } };
  await sem.ativar();
  const job = sem.indexar();
  const falha = assert.rejects(job, /Falha inferência/);
  const fim = sem.encerrar();
  inferencia.rejeitar(new Error('Falha inferência'));
  await falha;
  await fim;
  assert.equal(disposes, 1);
});

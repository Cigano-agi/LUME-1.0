import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { criarReciboUtility, observarDrenagem } from '../desktop/utility-receipt.js';
import { criarEncerramentoDesktop } from '../desktop/encerramento.js';

const require = createRequire(import.meta.url);
const { criarUtilityLifecycle } = require('../desktop/utility-lifecycle.cjs');
const perfil = { tipo: 'legado', id: 'legado', geracao: null };
const opId = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));

function par({ cortar = () => {}, fechar = () => {} } = {}) {
  const mainSent = [], utilitySent = [], terminal = [], errors = [];
  let next = 0;
  const lifecycle = criarUtilityLifecycle({ worker: { postMessage: m => mainSent.push(m), kill() {} },
    selection: perfil, onTerminal: v => terminal.push(v), randomId: () => `id-${++next}`,
    setTimer: () => 1, clearTimer() {} });
  let receipt;
  const shutdown = criarEncerramentoDesktop({ cortar: () => {}, drenar: [], fecharBanco: fechar,
    aposFecharBanco: () => receipt.aguardarAck(), sair: () => {} });
  receipt = criarReciboUtility({ selection: perfil, cortarIntake: cortar, fechar: shutdown,
    postMessage: m => utilitySent.push(m), onError: e => errors.push(e),
    setTimer: () => 1, clearTimer() {} });
  return { lifecycle, receipt, mainSent, utilitySent, terminal, errors };
}

test('corte é síncrono; ACK exato habilita shutdown de manutenção, recibo e exit0', async () => {
  const events = [];
  const x = par({ cortar: () => events.push('cut'), fechar: () => events.push('drain') });
  const pending = x.lifecycle.cortarIntake({ opId });
  const cut = x.mainSent[0];
  assert.deepEqual(Object.keys(cut).sort(), ['boot','opId','pedido','perfil','tipo']);
  assert.equal(x.receipt.receber(cut), true);
  assert.deepEqual(events, ['cut']);
  assert.equal(x.utilitySent[0].tipo, 'intake-cut-ack');
  assert.equal(x.lifecycle.receber(x.utilitySent[0]), true);
  await pending;
  assert.equal(x.lifecycle.iniciar('manutencao', { opId }), true);
  const shutdown = x.mainSent[1];
  assert.equal(shutdown.motivo, 'manutencao');
  assert.equal(shutdown.opId, opId);
  assert.equal(x.receipt.receber(shutdown), true);
  await tick();
  assert.deepEqual(events, ['cut','drain']);
  assert.equal(x.utilitySent[1].tipo, 'shutdown-recibo');
  assert.equal(x.utilitySent[1].opId, opId);
  assert.equal(x.lifecycle.receber(x.utilitySent[1]), true);
  assert.equal(x.receipt.receber(x.mainSent[2]), true);
  x.lifecycle.sair(0);
  assert.equal(x.terminal[0].confirmado, true);
});

test('utility recusa manutenção sem corte correspondente e corte que lança não ACK', () => {
  const x = par({ cortar: () => { throw Error('cut failed'); } });
  const cut = { tipo: 'intake-cut-pedido', boot: 'boot', pedido: 'cut', perfil, opId };
  const shutdown = { tipo: 'shutdown-pedido', boot: 'boot', pedido: 'shutdown', perfil,
    motivo: 'manutencao', opId };
  assert.equal(x.receipt.receber(shutdown), false);
  assert.equal(x.receipt.receber(cut), true);
  assert.equal(x.utilitySent.length, 0);
  assert.equal(x.receipt.receber(shutdown), false);
  assert.equal(x.errors.length, 1);
});

test('ACK divergente bloqueia ciclo mesmo após ACK correto tardio', async () => {
  const x = par();
  const pending = x.lifecycle.cortarIntake({ opId });
  const cut = x.mainSent[0];
  x.receipt.receber(cut);
  assert.equal(x.lifecycle.receber({ ...x.utilitySent[0], pedido: 'wrong' }), true);
  await assert.rejects(pending);
  x.lifecycle.receber(x.utilitySent[0]);
  assert.equal(x.lifecycle.iniciar('manutencao', { opId }), false);
  assert.equal(x.mainSent.length, 1);
});

test('normal/instalar preservam protocolo antigo; manutenção não inicia sem ACK', async () => {
  for (const motivo of ['normal','instalar']) {
    const x = par();
    assert.equal(x.lifecycle.iniciar(motivo), true);
    assert.deepEqual(Object.keys(x.mainSent[0]).sort(), ['boot','pedido','perfil','tipo']);
    assert.equal(x.receipt.receber(x.mainSent[0]), true);
    await tick();
    assert.deepEqual(Object.keys(x.utilitySent[0]).sort(), ['boot','pedido','perfil','tipo']);
  }
  const x = par();
  const pending = x.lifecycle.cortarIntake({ opId });
  assert.equal(x.lifecycle.iniciar('manutencao', { opId }), false);
  assert.equal(x.lifecycle.iniciar('instalar'), false);
  x.lifecycle.falhar('test');
  await assert.rejects(pending);
});

test('close falho ou recibo de manutenção sem opId nunca confirmam fim', async () => {
  for (const { close, closeFailed } of [
    { close: () => { throw Error('DB_CLOSE_FALHOU'); }, closeFailed: true },
    { close: () => {}, closeFailed: false }
  ]) {
    const x = par({ fechar: close });
    const pending = x.lifecycle.cortarIntake({ opId });
    x.receipt.receber(x.mainSent[0]); x.lifecycle.receber(x.utilitySent[0]); await pending;
    assert.equal(x.lifecycle.iniciar('manutencao', { opId }), true);
    x.receipt.receber(x.mainSent[1]); await tick();
    if (closeFailed) assert.equal(x.utilitySent.length, 1);
    else {
      const bad = { ...x.utilitySent[1] }; delete bad.opId;
      x.lifecycle.receber(bad);
      assert.equal(x.mainSent.length, 2);
    }
    x.lifecycle.sair(0);
    assert.equal(x.terminal[0].confirmado, false);
    x.receipt.cancelar();
  }
});

test('rejeição entre corte e drain tem observador imediato e continua falha no drain', async () => {
  const original = Promise.reject(new Error('FINALIZER_FALHOU'));
  const observed = observarDrenagem(original);
  assert.strictEqual(observed, original);
  await tick();
  await assert.rejects(observed, /FINALIZER_FALHOU/);
});

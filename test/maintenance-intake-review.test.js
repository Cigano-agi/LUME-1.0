import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { criarReciboUtility, observarDrenagem } from '../desktop/utility-receipt.js';
import { criarEncerramentoDesktop } from '../desktop/encerramento.js';

const require = createRequire(import.meta.url);
const { criarUtilityLifecycle } = require('../desktop/utility-lifecycle.cjs');
const perfil = Object.freeze({ tipo: 'legado', id: 'legado', geracao: null });
const outroPerfil = { tipo: 'legado', id: 'outro', geracao: null };
const opId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const outroOpId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('utility não aceita shutdown de outro boot, perfil ou operação após ACK de corte', async () => {
  const sent = [], events = [];
  const receipt = criarReciboUtility({ selection: perfil,
    cortarIntake: () => { events.push('cut'); },
    fechar: () => { events.push('close'); },
    postMessage: message => { events.push(message.tipo); sent.push(message); } });
  const cut = { tipo: 'intake-cut-pedido', boot: 'boot-a', pedido: 'cut-a', perfil, opId };
  assert.equal(receipt.receber(cut), true);
  assert.deepEqual(events, ['cut', 'intake-cut-ack']);
  assert.deepEqual(sent[0], { tipo: 'intake-cut-ack', boot: cut.boot, pedido: cut.pedido, perfil, opId });
  const shutdown = { tipo: 'shutdown-pedido', boot: cut.boot, pedido: 'shutdown-a', perfil,
    motivo: 'manutencao', opId };
  for (const changed of [
    { ...shutdown, boot: 'boot-b' },
    { ...shutdown, perfil: outroPerfil },
    { ...shutdown, opId: outroOpId },
    { ...shutdown, motivo: 'instalar' },
  ]) assert.equal(receipt.receber(changed), false);
  assert.deepEqual(events, ['cut', 'intake-cut-ack']);
  assert.equal(receipt.receber(shutdown), true);
  await tick();
  assert.ok(events.includes('close'));
});

test('lifecycle não confirma recibo de manutenção com identidade divergente', async () => {
  for (const alter of [
    message => ({ ...message, boot: 'boot-antigo' }),
    message => ({ ...message, pedido: 'pedido-antigo' }),
    message => ({ ...message, perfil: outroPerfil }),
    message => ({ ...message, opId: outroOpId }),
  ]) {
    const sent = [], terminal = [];
    let next = 0;
    const lifecycle = criarUtilityLifecycle({ worker: { postMessage: message => sent.push(message), kill() {} },
      selection: perfil, onTerminal: result => terminal.push(result), randomId: () => `id-${++next}`,
      setTimer: () => 1, clearTimer() {} });
    const ack = lifecycle.cortarIntake({ opId });
    assert.equal(lifecycle.receber({ ...sent[0], tipo: 'intake-cut-ack' }), true);
    await ack;
    assert.equal(lifecycle.iniciar('manutencao', { opId }), true);
    const receipt = { ...sent[1], tipo: 'shutdown-recibo' };
    assert.equal(lifecycle.receber(alter(receipt)), true);
    assert.equal(sent.length, 2, 'recibo divergente não gera shutdown-ack');
    lifecycle.sair(0);
    assert.equal(terminal[0].confirmado, false);
  }
});

test('finalizer rejeitado antes do drain impede close do banco e recibo de manutenção', async () => {
  const sentByMain = [], sentByUtility = [], events = [], errors = [];
  let pending, closed = 0, next = 0;
  const lifecycle = criarUtilityLifecycle({ worker: { postMessage: m => sentByMain.push(m), kill() {} },
    selection: perfil, onTerminal: () => {}, randomId: () => `id-${++next}`,
    setTimer: () => 1, clearTimer() {} });
  let receipt;
  const fechar = criarEncerramentoDesktop({ cortar: () => {}, drenar: [() => pending],
    fecharBanco: () => { closed++; }, aposFecharBanco: () => receipt.aguardarAck(), sair: () => {} });
  receipt = criarReciboUtility({ selection: perfil,
    cortarIntake: () => {
      events.push('cut');
      pending = observarDrenagem(Promise.reject(new Error('FINALIZER_ANTES_DO_DRAIN')));
    },
    fechar, onError: error => errors.push(error),
    postMessage: message => { events.push(message.tipo); sentByUtility.push(message); },
    setTimer: () => 1, clearTimer() {} });
  const ack = lifecycle.cortarIntake({ opId });
  assert.equal(receipt.receber(sentByMain[0]), true);
  assert.deepEqual(events, ['cut', 'intake-cut-ack']);
  assert.equal(lifecycle.receber(sentByUtility[0]), true);
  await ack;
  await tick(); // A rejeição antecede o pedido de shutdown, sem unhandledRejection.
  assert.equal(lifecycle.iniciar('manutencao', { opId }), true);
  assert.equal(receipt.receber(sentByMain[1]), true);
  await tick();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /FINALIZER_ANTES_DO_DRAIN/);
  assert.equal(closed, 0);
  assert.deepEqual(sentByUtility.map(message => message.tipo), ['intake-cut-ack']);
  receipt.cancelar();
});

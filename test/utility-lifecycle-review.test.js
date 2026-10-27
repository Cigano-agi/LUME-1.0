import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { criarReciboUtility } from '../desktop/utility-receipt.js';
import { criarEncerramentoDesktop } from '../desktop/encerramento.js';

const require = createRequire(import.meta.url);
const { criarUtilityLifecycle } = require('../desktop/utility-lifecycle.cjs');
const selection = Object.freeze({ tipo: 'legado', id: 'legado', geracao: null });

function main({ kill = () => true, send = () => {} } = {}) {
  const sent = [], results = [], timers = new Map();
  let nextTimer = 0;
  const worker = {
    postMessage(message) { send(message); sent.push(message); },
    kill,
  };
  const lifecycle = criarUtilityLifecycle({
    worker, selection, onTerminal: value => results.push(value),
    randomId: (() => { let id = 0; return () => `id-${++id}`; })(),
    setTimer(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimer(id) { timers.delete(id); },
  });
  const request = () => sent.find(message => message.tipo === 'shutdown-pedido');
  const receipt = () => ({ tipo: 'shutdown-recibo', boot: request().boot,
    pedido: request().pedido, perfil: { ...selection } });
  return { lifecycle, sent, results, timers, request, receipt };
}

function utility({ close = async () => {}, send = () => {} } = {}) {
  const sent = [], exits = [], errors = [], timers = new Map();
  let nextTimer = 0;
  let receipt;
  const finish = criarEncerramentoDesktop({
    cortar: () => {}, drenar: [], fecharBanco: close,
    aposFecharBanco: () => receipt.aguardarAck(),
    sair: code => { exits.push(code); },
  });
  receipt = criarReciboUtility({
    selection, fechar: finish, postMessage(message) { send(message); sent.push(message); },
    onError: error => errors.push(error),
    setTimer(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimer(id) { timers.delete(id); },
  });
  const request = (id = 'request-1') => ({ tipo: 'shutdown-pedido', boot: 'boot-1',
    pedido: id, perfil: { ...selection } });
  const ack = (id = 'request-1') => ({ tipo: 'shutdown-ack', boot: 'boot-1',
    pedido: id, perfil: { ...selection } });
  return { receipt, sent, exits, errors, timers, request, ack };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('timeout sem exit encerra tentativa uma vez mesmo quando kill falha; exit0 tardio não confirma', () => {
  for (const kill of [() => false, () => { throw Error('kill failed'); }]) {
    const x = main({ kill });
    assert.equal(x.lifecycle.iniciar('instalar'), true);
    assert.equal(x.lifecycle.receber(x.receipt()), true);
    for (const fire of [...x.timers.values()]) fire();
    assert.equal(x.results.length, 1);
    assert.equal(x.results[0].confirmado, false);
    assert.equal(x.results[0].causa, 'timeout');
    x.lifecycle.sair(0);
    assert.equal(x.results.length, 1);
  }
});

test('ACK enviado com erro nunca confirma, ainda que a utility saia com zero', () => {
  const x = main({ send: message => {
    if (message.tipo === 'shutdown-ack') throw Error('channel closed');
  } });
  x.lifecycle.iniciar('instalar');
  assert.equal(x.lifecycle.receber(x.receipt()), true);
  x.lifecycle.sair(0);
  assert.equal(x.results.length, 1);
  assert.equal(x.results[0].causa, 'ack-envio');
  assert.equal(x.results[0].confirmado, false);
  assert.equal(x.sent.filter(message => message.tipo === 'shutdown-ack').length, 0);
});

test('recibo divergente seguido do válido não recupera tentativa que falhou', () => {
  const x = main();
  x.lifecycle.iniciar('instalar');
  assert.equal(x.lifecycle.receber({ ...x.receipt(), pedido: 'outro' }), true);
  assert.equal(x.sent.length, 1);
  assert.equal(x.lifecycle.receber(x.receipt()), true);
  x.lifecycle.sair(0);
  assert.equal(x.results[0].confirmado, false);
});

test('recibo com propriedade extra no perfil não recebe ACK nem confirma', () => {
  const x = main();
  x.lifecycle.iniciar('instalar');
  assert.equal(x.lifecycle.receber({ ...x.receipt(), perfil: { ...selection, extra: 'injetado' } }), true);
  x.lifecycle.sair(0);
  assert.equal(x.sent.length, 1);
  assert.equal(x.results[0].confirmado, false);
});

test('saída e início reentrantes preservam um callback terminal e limpam timer', () => {
  const x = main();
  assert.equal(x.lifecycle.iniciar('instalar'), true);
  assert.equal(x.lifecycle.iniciar('normal'), false);
  x.lifecycle.receber(x.receipt());
  x.lifecycle.receber(x.receipt());
  assert.equal(x.sent.filter(message => message.tipo === 'shutdown-ack').length, 1);
  x.lifecycle.sair(0);
  x.lifecycle.sair(1);
  assert.equal(x.lifecycle.iniciar('instalar'), false);
  assert.equal(x.results.length, 1);
  assert.equal(x.results[0].confirmado, true);
  assert.equal(x.timers.size, 0);
});

test('pedido divergente antes do válido não bloqueia o fechamento legítimo; duplicata não fecha duas vezes', async () => {
  let closes = 0;
  const x = utility({ close: () => { closes++; } });
  assert.equal(x.receipt.receber({ ...x.request(), perfil: { ...selection, id: 'outro' } }), false);
  assert.equal(x.receipt.receber(x.request()), true);
  assert.equal(x.receipt.receber(x.request()), true);
  assert.equal(x.receipt.receber(x.request('request-2')), false);
  await tick();
  assert.equal(closes, 1);
  assert.equal(x.sent.length, 1);
  assert.equal(x.receipt.receber(x.ack()), true);
  await tick();
  assert.deepEqual(x.exits, [0]);
  assert.equal(x.receipt.receber(x.ack()), false);
  assert.deepEqual(x.exits, [0]);
});

test('ACK antes do recibo e ACK de outro pedido não autorizam saída zero', async () => {
  const x = utility();
  assert.equal(x.receipt.receber(x.ack()), false);
  assert.equal(x.receipt.receber(x.request()), true);
  assert.equal(x.receipt.receber(x.ack()), false);
  await tick();
  assert.equal(x.sent.length, 1);
  assert.equal(x.receipt.receber(x.ack('request-2')), false);
  assert.deepEqual(x.exits, []);
  for (const fire of [...x.timers.values()]) fire();
  await tick();
  assert.deepEqual(x.exits, []);
  assert.equal(x.errors.length, 1);
});

test('ACK ausente expira mesmo após DB fechado e recibo publicado', async () => {
  let closed = false;
  const x = utility({ close: () => { closed = true; } });
  x.receipt.receber(x.request());
  await tick();
  assert.equal(closed, true);
  assert.equal(x.sent.length, 1);
  assert.deepEqual(x.exits, []);
  for (const fire of [...x.timers.values()]) fire();
  await tick();
  assert.deepEqual(x.exits, []);
  assert.equal(x.errors.length, 1);
});

test('ACK errado seguido do correspondente libera uma única saída zero', async () => {
  const x = utility();
  x.receipt.receber(x.request());
  await tick();
  assert.equal(x.receipt.receber(x.ack('outro')), false);
  assert.equal(x.receipt.receber(x.ack()), true);
  await tick();
  assert.deepEqual(x.exits, [0]);
  assert.equal(x.timers.size, 0);
});

test('ACK com propriedade extra no perfil não autoriza saída zero', async () => {
  const x = utility();
  x.receipt.receber(x.request());
  await tick();
  assert.equal(x.receipt.receber({ ...x.ack(), perfil: { ...selection, extra: 'injetado' } }), false);
  assert.deepEqual(x.exits, []);
  x.receipt.cancelar();
  await tick();
  assert.deepEqual(x.exits, []);
});

test('falha de envio do recibo e falha de DB fecham sem saída zero', async () => {
  const envio = utility({ send: () => { throw Error('send failed'); } });
  envio.receipt.receber(envio.request());
  await tick();
  assert.deepEqual(envio.exits, []);
  assert.equal(envio.errors.length, 1);
  const banco = utility({ close: () => Promise.reject(Error('db failed')) });
  banco.receipt.receber(banco.request());
  await tick();
  assert.deepEqual(banco.sent, []);
  assert.deepEqual(banco.exits, []);
  assert.equal(banco.errors.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { criarUtilityLifecycle } = require('../desktop/utility-lifecycle.cjs');

function setup() {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.killed = 0;
  worker.postMessage = m => worker.sent.push(m);
  worker.kill = () => { worker.killed++; };
  const terminal = [];
  let timeout;
  const ciclo = criarUtilityLifecycle({ worker, selection: { tipo: 'legado', id: 'legado', geracao: null },
    onTerminal: v => terminal.push(v), setTimer: fn => { timeout = fn; return 1; }, clearTimer: () => {}, randomId: () => String(worker.sent.length + 1) });
  return { worker, ciclo, terminal, timeout: () => timeout };
}
const recibo = pedido => ({ tipo: 'shutdown-recibo', boot: pedido.boot, pedido: pedido.pedido, perfil: pedido.perfil });

test('exit0 sem recibo nunca confirma instalação', () => {
  const x = setup(); x.ciclo.iniciar('instalar'); x.ciclo.sair(0);
  assert.equal(x.terminal[0].confirmado, false);
});
test('recibo vinculado, ACK e exit0 confirmam; exit1 falha', () => {
  const x = setup(); x.ciclo.iniciar('instalar'); const p = x.worker.sent[0];
  x.ciclo.receber(recibo(p)); assert.equal(x.worker.sent[1].tipo, 'shutdown-ack');
  x.ciclo.sair(0); assert.equal(x.terminal[0].confirmado, true);
  const y = setup(); y.ciclo.iniciar('instalar'); y.ciclo.receber(recibo(y.worker.sent[0])); y.ciclo.sair(1);
  assert.equal(y.terminal[0].confirmado, false);
});
test('nonce, pedido e perfil divergentes não recebem ACK', () => {
  for (const key of ['boot','pedido','perfil']) {
    const x = setup(); x.ciclo.iniciar('instalar'); const r = recibo(x.worker.sent[0]);
    r[key] = key === 'perfil' ? { tipo: 'legado', id: 'outro', geracao: null } : 'errado';
    x.ciclo.receber(r); x.ciclo.sair(0);
    assert.equal(x.worker.sent.length, 1); assert.equal(x.terminal[0].confirmado, false);
  }
});
test('kill, timeout e falha de postMessage fecham sem sucesso', () => {
  const x = setup(); x.ciclo.iniciar('instalar'); x.ciclo.receber(recibo(x.worker.sent[0])); x.timeout()(); x.ciclo.sair(0);
  assert.equal(x.worker.killed, 1); assert.equal(x.terminal[0].confirmado, false);
  const y = setup(); y.worker.postMessage = () => { throw Error('broken'); }; y.ciclo.iniciar('instalar'); y.ciclo.sair(0);
  assert.equal(y.terminal[0].confirmado, false);
});
test('pedido repetido não reinicia fechamento', () => {
  const x = setup(); assert.equal(x.ciclo.iniciar('normal'), true); assert.equal(x.ciclo.iniciar('normal'), false);
  assert.equal(x.worker.sent.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { criarReciboUtility } from '../desktop/utility-receipt.js';
import { criarEncerramentoDesktop } from '../desktop/encerramento.js';
import { readFileSync } from 'node:fs';

const selection = { tipo: 'legado', id: 'legado', geracao: null };
const pedido = { tipo: 'shutdown-pedido', boot: 'boot-id', pedido: 'request-id', perfil: selection };
function setup({ close = async () => {}, send = () => {}, sair = () => {}, timer = () => 1 } = {}) {
  let utility;
  const fechar = criarEncerramentoDesktop({ cortar: () => {}, drenar: [], fecharBanco: close,
    aposFecharBanco: () => utility.aguardarAck(), sair });
  utility = criarReciboUtility({ selection, postMessage: send, fechar, setTimer: timer, clearTimer: () => {} });
  return utility;
}
test('só publica recibo após closeDB; ACK correto permite sair0', async () => {
  let resolve; const fechado = new Promise(r => { resolve = r; }); const sent = []; const exits = [];
  const x = setup({ close: () => fechado, send: v => sent.push(v), sair: code => exits.push(code) });
  x.receber(pedido); await Promise.resolve(); assert.equal(sent.length, 0);
  resolve(); await new Promise(r => setImmediate(r)); assert.equal(sent[0].tipo, 'shutdown-recibo');
  x.receber({ tipo: 'shutdown-ack', boot: pedido.boot, pedido: pedido.pedido, perfil: selection });
  await new Promise(r => setImmediate(r)); assert.deepEqual(exits, [0]);
});
test('perfil divergente, closeDB rejeitado e ACK errado não produzem saída0', async () => {
  const sent = []; const exits = [];
  const x = setup({ send: v => sent.push(v), sair: code => exits.push(code) });
  assert.equal(x.receber({ ...pedido, perfil: { ...selection, id: 'outro' } }), false);
  assert.equal(sent.length, 0);
  const y = setup({ close: () => Promise.reject(Error('db')), send: v => sent.push(v), sair: code => exits.push(code) });
  y.receber(pedido); await new Promise(r => setImmediate(r)); assert.equal(sent.length, 0); assert.deepEqual(exits, []);
  const z = setup({ send: v => sent.push(v), sair: code => exits.push(code) }); z.receber(pedido);
  await new Promise(r => setImmediate(r)); z.receber({ tipo: 'shutdown-ack', boot: pedido.boot, pedido: 'bad', perfil: selection });
  assert.deepEqual(exits, []); z.cancelar();
});
test('ACK ausente, envio falho e pedido divergente falham fechados', async () => {
  const exits = [], sent = [];
  let expire;
  const x = setup({ send: v => sent.push(v), sair: code => exits.push(code), timer: fn => { expire = fn; return 1; } });
  assert.equal(x.receber(pedido), true);
  assert.equal(x.receber(pedido), true);
  assert.equal(x.receber({ ...pedido, pedido: 'outro' }), false);
  await new Promise(r => setImmediate(r)); assert.equal(sent.length, 1);
  expire(); await new Promise(r => setImmediate(r)); assert.deepEqual(exits, []);
  const y = setup({ send: () => { throw Error('post'); }, sair: code => exits.push(code) });
  y.receber(pedido); await new Promise(r => setImmediate(r)); assert.deepEqual(exits, []);
});
test('callback terminal assíncrono é aguardado e módulos entram no build.files', async () => {
  let release; const pending = new Promise(r => { release = r; }); const events = [];
  const close = criarEncerramentoDesktop({ cortar: () => {}, drenar: [], fecharBanco: () => events.push('db'),
    aposFecharBanco: () => { events.push('ack'); return pending; }, sair: () => events.push('exit') });
  const task = close(); await new Promise(r => setImmediate(r)); assert.deepEqual(events, ['db','ack']);
  release(); await task; assert.deepEqual(events, ['db','ack','exit']);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.build.files.includes('desktop/utility-lifecycle.cjs'));
  assert.ok(manifest.build.files.includes('desktop/utility-receipt.js'));
});

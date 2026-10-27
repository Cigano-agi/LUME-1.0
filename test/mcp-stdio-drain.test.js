import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startLumeMcpStdio } from '../src/mcp/stdio-server.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Output extends EventEmitter {
  constructor() { super(); this.lines = []; this.block = false; this.throwOnWrite = false; this.destroyed = false; this.writableEnded = false; this.pending = []; }
  write(line, callback) {
    if (this.throwOnWrite) throw new Error('private output detail');
    this.lines.push(JSON.parse(line));
    if (this.block) this.pending.push(callback);
    else queueMicrotask(() => callback?.());
    return !this.block;
  }
  emit(event, ...args) {
    if (['drain', 'error', 'close'].includes(event)) {
      const pending = this.pending.splice(0);
      for (const callback of pending) callback?.(event === 'drain' ? undefined : args[0] ?? new Error('output closed'));
    }
    return super.emit(event, ...args);
  }
}

async function until(predicate, deadlineMs = 500) {
  const end = Date.now() + deadlineMs;
  while (!predicate() && Date.now() < end) await tick();
  assert.ok(predicate(), 'evento esperado não ocorreu');
}

async function started(core, options = {}) {
  const input = new PassThrough(), output = new Output();
  const server = startLumeMcpStdio({ core, clientId: 'teste', credential: 'teste', version: '1.0.0', input, output, ...options });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  await until(() => output.lines.length === 1);
  return { input, output, server };
}

const call = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'lume_teste', arguments: {} } }) + '\n';
const coreWith = executar => ({ tools: () => [{ name: 'lume_teste' }], executar });

test('stop espera core, mas não stdout sem consumidor', async () => {
  const operation = deferred(), input = new PassThrough(), output = new Output();
  let started = 0, closed = 0;
  const core = { tools: () => [{ name: 'lume_teste' }], executar: () => { started++; return operation.promise; } };
  const server = startLumeMcpStdio({ core, clientId: 'teste', credential: 'teste', version: '1.0.0', input, output, onClose: () => { closed++; } });
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
    await until(() => output.lines.length === 1);
    output.block = true;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lume_teste', arguments: {} } }) + '\n');
    await until(() => started === 1);
    const stopping = server.stop();
    assert.equal(closed, 0, 'não fecha enquanto core está pendente');
    operation.resolve({ ok: true, items: [] });
    await until(() => output.lines.length === 2);
    const result = await Promise.race([stopping.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('timeout'), 100))]);
    assert.equal(result, 'closed', 'backpressure não pode prender onClose');
    assert.equal(closed, 1);
  } finally {
    operation.resolve({ ok: true, items: [] });
    output.emit('drain');
    await server.stop();
  }
});

test('gate com stdout bloqueado não confirma fechamento', async () => {
  const input = new PassThrough(), output = new Output();
  let closedWithFailure = false;
  const server = startLumeMcpStdio({
    core: coreWith(() => ({ ok: true, items: [] })), clientId: 'teste', credential: 'teste', version: '1.0.0', input, output,
    operationGate: { begin: async () => ({ requestId: 'receipt' }), end: async () => {} },
    onClose: () => { closedWithFailure = server.drainFailed; }
  });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  await until(() => output.lines.length === 1);
  output.block = true;
  input.write(call(2));
  await until(() => output.lines.length === 2);
  await assert.rejects(server.stop(), { code: 'MCP_DRAIN_UNCONFIRMED' });
  assert.equal(closedWithFailure, true);
  output.emit('drain');
});

test('gate mantém ordem begin, core settle, end, onClose e usa ID interno', async () => {
  const pending = deferred(), events = [];
  const gate = {
    begin: ({ operationId }) => { events.push('begin'); assert.match(operationId, /^[0-9a-f-]{36}$/); assert.notEqual(operationId, '7'); return { id: operationId }; },
    end: receipt => { assert.ok(receipt.id); events.push('end'); }
  };
  const io = await started(coreWith(() => { events.push('core'); return pending.promise.finally(() => events.push('settle')); }), { operationGate: gate, onClose: () => { events.push('close'); } });
  io.input.write(call(7));
  await until(() => events.includes('core'));
  const closing = io.server.stop();
  assert.deepEqual(events, ['begin', 'core']);
  pending.resolve({ ok: true, items: [] });
  await closing;
  assert.deepEqual(events, ['begin', 'core', 'settle', 'end', 'close']);
  assert.equal(io.output.lines[1].result.structuredContent.ok, true);
  assert.equal(io.output.listenerCount('drain'), 0);
  assert.equal(io.output.listenerCount('error'), 0);
  assert.equal(io.output.listenerCount('close'), 0);
});

test('stop aguarda begin pendente e devolve receipt sem iniciar core', async () => {
  const pending = deferred(), events = [];
  const io = await started(coreWith(() => { events.push('core'); return { ok: true }; }), {
    operationGate: { begin: () => { events.push('begin'); return pending.promise; }, end: receipt => { assert.equal(receipt.id, 1); events.push('end'); } },
    onClose: () => { events.push('close'); }
  });
  io.input.write(call(2));
  await until(() => events.includes('begin'));
  const closing = io.server.stop();
  await tick();
  assert.deepEqual(events, ['begin']);
  pending.resolve({ id: 1 });
  await closing;
  assert.deepEqual(events, ['begin', 'end', 'close']);
  assert.equal(io.output.lines.length, 1);
});

test('begin recusado não entra no core nem torna fechamento incerto', async () => {
  let calls = 0, ends = 0;
  const io = await started(coreWith(() => { calls++; return { ok: true }; }), {
    operationGate: { begin: () => { throw new Error('private gate detail'); }, end: () => { ends++; } }
  });
  io.input.write(call(2));
  await until(() => io.output.lines.length === 2);
  assert.equal(io.output.lines[1].error.code, -32603);
  assert.ok(!JSON.stringify(io.output.lines[1]).includes('private'));
  await io.server.stop();
  assert.equal(calls, 0); assert.equal(ends, 0);
});

for (const mode of ['sync', 'async']) {
  test(`falha ${mode} do core ainda devolve receipt uma vez`, async () => {
    const events = [];
    const core = coreWith(() => {
      events.push('core');
      if (mode === 'sync') throw new Error('private core detail');
      return Promise.reject(new Error('private core detail'));
    });
    const io = await started(core, {
      operationGate: { begin: () => { events.push('begin'); return {}; }, end: () => { events.push('end'); } },
      onClose: () => { events.push('close'); }
    });
    io.input.write(call(2));
    await until(() => io.output.lines.length === 2);
    assert.equal(io.output.lines[1].error.code, -32603);
    assert.ok(!JSON.stringify(io.output.lines[1]).includes('private'));
    await io.server.stop();
    assert.deepEqual(events, ['begin', 'core', 'end', 'close']);
  });
}

test('gate de ciclo de vida não converte recusa do core em autorização', async () => {
  const io = await started(coreWith(() => ({ ok: false, error: { message: 'Escopo revogado.' } })), {
    operationGate: { begin: () => ({}), end: () => {} }
  });
  io.input.write(call(2));
  await until(() => io.output.lines.length === 2);
  assert.equal(io.output.lines[1].result.isError, true);
  assert.equal(io.output.lines[1].result.structuredContent.ok, false);
  await io.server.stop();
});

test('falha de end recusa fechamento em todas as chamadas sem vazar detalhe', async () => {
  let ends = 0, closes = 0;
  const io = await started(coreWith(() => ({ ok: true, items: [] })), {
    operationGate: { begin: () => ({}), end: () => { ends++; throw new Error('private receipt detail'); } },
    onClose: () => { closes++; }
  });
  io.input.write(call(2));
  await until(() => io.output.lines.length === 2);
  assert.equal(io.output.lines[1].error.code, -32603);
  assert.ok(!JSON.stringify(io.output.lines[1]).includes('private'));
  await assert.rejects(io.server.stop(), { code: 'MCP_DRAIN_UNCONFIRMED' });
  await assert.rejects(io.server.stop(), { code: 'MCP_DRAIN_UNCONFIRMED' });
  await assert.rejects(io.server.closed, { code: 'MCP_DRAIN_UNCONFIRMED' });
  assert.equal(ends, 1); assert.equal(closes, 1);
});

test('falha de onClose recusa fechamento e onClose roda uma vez', async () => {
  let closes = 0;
  const io = await started(coreWith(() => ({ ok: true })), { onClose: () => { closes++; throw new Error('private close detail'); } });
  await assert.rejects(io.server.stop(), { code: 'MCP_DRAIN_UNCONFIRMED' });
  await assert.rejects(io.server.stop(), { code: 'MCP_DRAIN_UNCONFIRMED' });
  assert.equal(closes, 1);
});

test('corte não inicia chamada já enfileirada e stop concorrente é idempotente', async () => {
  const pending = deferred(); let calls = 0, closes = 0;
  const io = await started(coreWith(() => { calls++; return pending.promise; }), { onClose: () => { closes++; } });
  io.input.write(call(2));
  await until(() => calls === 1);
  io.input.write(call(3));
  const first = io.server.stop(), second = io.server.stop();
  assert.equal(first, second);
  pending.resolve({ ok: true, items: [] });
  await first;
  assert.equal(calls, 1); assert.equal(closes, 1);
  assert.equal(io.output.lines[1].id, 2);
  assert.equal(io.output.lines.length, 2);
});

test('cancelamento não conclui core nem antecipa end', async () => {
  const pending = deferred(), events = [];
  const io = await started(coreWith(() => { events.push('core'); return pending.promise.finally(() => events.push('settle')); }), {
    operationGate: { begin: () => { events.push('begin'); return {}; }, end: () => { events.push('end'); } },
    onClose: () => { events.push('close'); }
  });
  io.input.write(call(9));
  await until(() => events.includes('core'));
  io.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }) + '\n');
  const closing = io.server.stop();
  await tick();
  assert.deepEqual(events, ['begin', 'core']);
  pending.resolve({ ok: true, items: [] });
  await closing;
  assert.deepEqual(events, ['begin', 'core', 'settle', 'end', 'close']);
  assert.equal(io.output.lines[1].error.code, -32800);
});

for (const mode of ['error', 'close', 'throw']) {
  test(`saída ${mode} abandona resposta e libera fechamento`, async () => {
    let closed = 0;
    const io = await started(coreWith(() => ({ ok: true, items: [] })), { onClose: () => { closed++; } });
    io.output.block = true;
    if (mode === 'throw') io.output.throwOnWrite = true;
    io.input.write(call(2));
    if (mode !== 'throw') {
      await until(() => io.output.lines.length === 2);
      io.output.emit(mode, mode === 'error' ? new Error('private output detail') : undefined);
    }
    await io.server.closed;
    assert.equal(closed, 1);
    assert.equal(io.output.listenerCount('drain'), 0);
    assert.equal(io.output.listenerCount('error'), 0);
    assert.equal(io.output.listenerCount('close'), 0);
  });
}

for (const mode of ['json', 'oversize']) {
  test(`${mode} inválido com stdout bloqueado não prende stop`, async () => {
    let closed = 0;
    const io = await started(coreWith(() => ({ ok: true })), { onClose: () => { closed++; } });
    io.output.block = true;
    io.input.write(mode === 'json' ? '{bad\n' : 'x'.repeat(1024 * 1024 + 1));
    await until(() => io.output.lines.length === 2);
    await io.server.stop();
    assert.equal(closed, 1);
    assert.equal(io.output.listenerCount('drain'), 0);
  });
}

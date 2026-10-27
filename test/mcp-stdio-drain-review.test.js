import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { startLumeMcpStdio } from '../src/mcp/stdio-server.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Output extends EventEmitter {
  constructor() { super(); this.lines = []; this.block = false; this.pending = []; }
  write(line, callback) {
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

async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await tick();
  assert.ok(predicate(), 'evento esperado não ocorreu');
}

async function fixture({ executar, operationGate, onClose = () => {} }) {
  const input = new PassThrough(), output = new Output();
  const server = startLumeMcpStdio({
    core: { tools: () => [{ name: 'teste' }], executar },
    clientId: 'sintetico', credential: 'sintetica', version: '1.0.0',
    input, output, operationGate, onClose
  });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  await until(() => output.lines.length === 1);
  const call = () => input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'teste', arguments: {} } }) + '\n');
  return { input, output, server, call };
}

test('end assíncrono falho após corte mantém recibo e fechamento incertos', async () => {
  const begin = deferred(), end = deferred();
  const events = [];
  const io = await fixture({
    executar: () => { events.push('core'); return { ok: true }; },
    operationGate: {
      begin: () => { events.push('begin'); return begin.promise; },
      end: receipt => { assert.equal(receipt.id, 'recibo'); events.push('end'); return end.promise; }
    },
    onClose: () => { events.push('close'); }
  });
  io.call();
  await until(() => events.includes('begin'));
  const stopping = io.server.stop();
  begin.resolve({ id: 'recibo' });
  await until(() => events.includes('end'));
  assert.deepEqual(events, ['begin', 'end']);
  end.reject(new Error('detalhe privado'));
  await assert.rejects(stopping, { code: 'MCP_DRAIN_UNCONFIRMED' });
  await assert.rejects(io.server.closed, { code: 'MCP_DRAIN_UNCONFIRMED' });
  assert.deepEqual(events, ['begin', 'end', 'close']);
  assert.equal(io.output.listenerCount('drain'), 0);
});

test('erro assíncrono de stdout durante core aguarda settle e end', async () => {
  const core = deferred(), events = [];
  const io = await fixture({
    executar: () => { events.push('core'); return core.promise.finally(() => events.push('settle')); },
    operationGate: { begin: () => { events.push('begin'); return {}; }, end: () => { events.push('end'); } },
    onClose: () => { events.push('close'); }
  });
  io.call();
  await until(() => events.includes('core'));
  setImmediate(() => io.output.emit('error', new Error('stdout sintético')));
  await tick();
  assert.deepEqual(events, ['begin', 'core']);
  core.resolve({ ok: true });
  await assert.rejects(io.server.closed, { code: 'MCP_DRAIN_UNCONFIRMED' });
  assert.deepEqual(events, ['begin', 'core', 'settle', 'end', 'close']);
  assert.equal(io.output.listenerCount('drain'), 0);
  assert.equal(io.output.listenerCount('error'), 0);
  assert.equal(io.output.listenerCount('close'), 0);
});

test('onClose assíncrono falho após stdout bloqueado não confirma fechamento', async () => {
  const close = deferred(); let closes = 0;
  const io = await fixture({
    executar: () => ({ ok: true }),
    onClose: () => { closes++; return close.promise; }
  });
  io.output.block = true;
  io.call();
  await until(() => io.output.lines.length === 2);
  const stopping = io.server.stop();
  await until(() => closes === 1);
  close.reject(new Error('detalhe privado'));
  await assert.rejects(stopping, { code: 'MCP_DRAIN_UNCONFIRMED' });
  await assert.rejects(io.server.stop(), { code: 'MCP_DRAIN_UNCONFIRMED' });
  assert.equal(closes, 1);
  assert.equal(io.output.listenerCount('drain'), 0);
});

test('erro de escrita que chega após stop não derruba o processo', () => {
  const source = `
    import { Writable, PassThrough } from 'node:stream';
    import { startLumeMcpStdio } from './src/mcp/stdio-server.js';
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(new Error('late synthetic stdout failure')), 20);
      }
    });
    output.once('close', () => setImmediate(() => {
      console.log('listeners:', output.listenerCount('error'), output.listenerCount('close'));
    }));
    const server = startLumeMcpStdio({
      core: { tools: () => [], executar: () => ({ ok: true }) },
      clientId: 'sintetico', credential: 'sintetica', version: '1.0.0',
      input: new PassThrough(), output
    });
    await server.send({ jsonrpc: '2.0', id: 1, result: {} });
    await server.stop();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 2000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /listeners: 0 0/);
});

test('callback de escrita aceita pode concluir após stop e então libera proteção', async () => {
  let complete, closes = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
  const server = startLumeMcpStdio({
    core: { tools: () => [], executar: () => ({ ok: true }) },
    clientId: 'sintetico', credential: 'sintetica', version: '1.0.0',
    input: new PassThrough(), output, onClose: () => { closes++; }
  });
  const sending = server.send({ jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(typeof complete, 'function');
  await server.stop();
  assert.equal(await sending, false, 'stop abandona a espera da resposta');
  assert.equal(closes, 1);
  assert.equal(output.listenerCount('error'), 1, 'escrita ainda pendente conserva proteção');
  complete();
  await tick();
  assert.equal(output.listenerCount('error'), 0);
  assert.equal(output.listenerCount('close'), 0);
});

test('write true não confirma entrega antes do callback de sucesso', async () => {
  let complete, settled = false;
  const output = new Writable({ write(_chunk, _encoding, callback) { complete = callback; } });
  const server = startLumeMcpStdio({
    core: { tools: () => [], executar: () => ({ ok: true }) },
    clientId: 'sintetico', credential: 'sintetica', version: '1.0.0',
    input: new PassThrough(), output
  });
  const sending = server.send({ jsonrpc: '2.0', id: 1, result: {} }).then(result => { settled = true; return result; });
  await tick();
  assert.equal(settled, false);
  complete();
  assert.equal(await sending, true);
  await server.stop();
  assert.equal(output.listenerCount('error'), 0);
  assert.equal(output.listenerCount('close'), 0);
});

test('stdout bloqueado sem callback não prende fechamento; close libera proteção', async () => {
  let closes = 0;
  const output = new Writable({ highWaterMark: 1, write() {} });
  const server = startLumeMcpStdio({
    core: { tools: () => [], executar: () => ({ ok: true }) },
    clientId: 'sintetico', credential: 'sintetica', version: '1.0.0',
    input: new PassThrough(), output, onClose: () => { closes++; }
  });
  const sending = server.send({ jsonrpc: '2.0', id: 1, result: {} });
  await server.stop();
  assert.equal(await sending, false);
  assert.equal(closes, 1);
  assert.equal(output.listenerCount('drain'), 0);
  assert.equal(output.listenerCount('error'), 1, 'callback pendente mantém guarda mínima');
  output.destroy();
  await tick();
  assert.equal(output.listenerCount('error'), 0);
  assert.equal(output.listenerCount('close'), 0);
});

test('ciclos repetidos de start/stop não acumulam listeners', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { queueMicrotask(callback); } });
  for (let i = 0; i < 12; i++) {
    const server = startLumeMcpStdio({
      core: { tools: () => [], executar: () => ({ ok: true }) },
      clientId: 'sintetico', credential: 'sintetica', version: '1.0.0',
      input: new PassThrough(), output
    });
    assert.equal(await server.send({ jsonrpc: '2.0', id: i, result: {} }), true);
    await server.stop();
    assert.equal(output.listenerCount('error'), 0);
    assert.equal(output.listenerCount('close'), 0);
    assert.equal(output.listenerCount('drain'), 0);
  }
});

for (const mode of ['success', 'error', 'core failure']) {
  test(`resposta criada após stop com write true e callback tardio: ${mode}`, async () => {
    const core = deferred(), events = [];
    let finishWrite, writeCount = 0;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writeCount++;
        if (writeCount === 1) callback();
        else finishWrite = callback;
      }
    });
    const input = new PassThrough();
    const server = startLumeMcpStdio({
      core: {
        tools: () => [{ name: 'teste' }],
        executar: () => { events.push('core'); return core.promise.finally(() => events.push('settle')); }
      },
      clientId: 'sintetico', credential: 'sintetica', version: '1.0.0',
      input, output,
      operationGate: { begin: () => { events.push('begin'); return {}; }, end: () => { events.push('end'); } },
      onClose: () => { events.push('close'); }
    });
    let timer;
    const boundedClose = () => Promise.race([
      server.closed.then(() => 'closed', () => 'uncertain'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 150); })
    ]).finally(() => clearTimeout(timer));
    try {
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
      await until(() => writeCount === 1);
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'teste', arguments: {} } }) + '\n');
      await until(() => events.includes('core'));
      const stopping = server.stop();
      assert.deepEqual(events, ['begin', 'core']);
      if (mode === 'core failure') core.reject(new Error('private core detail'));
      else core.resolve({ ok: true, items: [] });
      await until(() => typeof finishWrite === 'function');
      assert.equal(output.writableNeedDrain, false);
      assert.equal(events.includes('end'), true);
      assert.equal(await boundedClose(), 'uncertain', 'callback tardio não deve confirmar onClose');
      assert.deepEqual(events, ['begin', 'core', 'settle', 'end', 'close']);
      assert.equal(output.listenerCount('error'), 1, 'callback pendente mantém proteção');
      assert.equal(output.listenerCount('drain'), 0);
      await assert.rejects(stopping, { code: 'MCP_DRAIN_UNCONFIRMED' });
    } finally {
      if (mode === 'core failure') core.reject(new Error('private core detail'));
      else core.resolve({ ok: true, items: [] });
      finishWrite?.(mode === 'error' ? new Error('late synthetic stdout failure') : undefined);
      await server.stop().catch(() => {});
      await tick();
      assert.equal(output.listenerCount('error'), 0);
      assert.equal(output.listenerCount('close'), 0);
    }
  });
}

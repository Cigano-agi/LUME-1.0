import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';

const mod = '../src/execucao/inventario-nativo.js';
const CODE = 'PROJECT_INVENTORY_UNAVAILABLE';
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;

function frame(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function fakeSpawn(response, { stderr = '', exitCode = 0, delay = 0, neverClose = false, extra = Buffer.alloc(0), capture } = {}) {
  return (exe, args, options) => {
    capture?.({ exe, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let timer;
    child.kill = () => { child.killed = true; clearTimeout(timer); child.emit('close', null, 'SIGTERM'); return true; };
    child.stdin.on('data', chunk => {
      child.request = Buffer.concat([child.request || Buffer.alloc(0), chunk]);
      if (child.responded || child.request.length < 4) return;
      const size = child.request.readUInt32BE(0);
      if (child.request.length < size + 4) return;
      child.responded = true;
      timer = setTimeout(() => {
        if (stderr) child.stderr.write(stderr);
        const output = Buffer.isBuffer(response) ? response : frame(response);
        child.stdout.write(Buffer.concat([output, extra]));
        child.stdout.end(); child.stderr.end();
        if (!neverClose) child.emit('close', exitCode, null);
      }, delay);
    });
    return child;
  };
}

async function api() {
  const m = await import(mod);
  assert.equal(typeof m.criarClienteInventarioNativo, 'function');
  assert.equal(typeof m.listarInventarioNativo, 'function');
  return m;
}

function cliente(m, response, options = {}) {
  return m.criarClienteInventarioNativo({ helperPath: path.resolve('synthetic/lume-project-inventory.exe'), spawnImpl: fakeSpawn(response, options), timeoutMs: 100 });
}

function erroIndisponivel(promise) {
  return assert.rejects(promise, error => error?.code === CODE || error?.message === CODE);
}

test('exporta a ponte de inventário e sua API de produto', async () => {
  const m = await api();
  assert.equal(typeof m.criarClienteInventarioNativo, 'function');
  assert.equal(typeof m.listarInventarioNativo, 'function');
});

test('envia framing BE e retorna apenas inventário validado', async () => {
  const m = await api(); let request, childRef;
  const run = m.criarClienteInventarioNativo({ helperPath: path.resolve('helper'), spawnImpl: (...args) => {
    const child = fakeSpawn({ version: 1, files: [{ path: 'src/a.js', bytes: 1 }], omitted: 2 }, { capture: value => request = value })(...args);
    childRef = child;
    return child;
  }, timeoutMs: 100 });
  assert.deepEqual(await run({ origem: path.resolve('fixture-root') }), { arquivos: [{ caminho: 'src/a.js', bytes: 1 }], omitidos: 2 });
  assert.equal(request.exe, path.resolve('helper'));
  assert.equal(request.options.shell, false);
  assert.deepEqual(request.options.env, {});
  assert.deepEqual(request.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(JSON.parse(childRef.request.subarray(4).toString('utf8')), { version: 1, root: path.resolve('fixture-root') });
  assert.equal(childRef.request.readUInt32BE(0), childRef.request.length - 4);
});

test('pasta vazia válida devolve lista vazia sem inventar arquivos', async () => {
  const m = await api();
  assert.deepEqual(await cliente(m, { version: 1, files: [], omitted: 0 })({ origem: path.resolve('fixture-empty') }),
    { arquivos: [], omitidos: 0 });
});

test('rejeita origem vazia, relativa, URL e caminho acima de 32 KiB', async () => {
  const m = await api(), run = cliente(m, { version: 1, files: [], omitted: 0 });
  for (const origem of ['', 'relative/path', 'https://example.test/x', `C:/${'x'.repeat(33 * 1024)}`]) await erroIndisponivel(run({ origem }));
});

test('helper ausente, erro de spawn, bloqueio e encerramento não retornam lista parcial', async () => {
  const m = await api();
  await erroIndisponivel(m.criarClienteInventarioNativo({ helperPath: path.resolve('missing'), spawnImpl: () => { const e = Error('ENOENT'); e.code = 'ENOENT'; throw e; } })({ origem: path.resolve('.') }));
  for (const exitCode of [1, 126]) await erroIndisponivel(cliente(m, { version: 1, files: [{ path: 'ok.js', bytes: 1 }], omitted: 0 }, { exitCode })({ origem: path.resolve('.') }));
});

test('rejeita header truncado, payload truncado e bytes excedentes', async () => {
  const m = await api();
  await erroIndisponivel(cliente(m, Buffer.from([0, 0, 0]), { exitCode: 0 })({ origem: path.resolve('.') }));
  const good = frame({ version: 1, files: [], omitted: 0 });
  await erroIndisponivel(cliente(m, Buffer.concat([good.subarray(0, -1)]))({ origem: path.resolve('.') }));
  await erroIndisponivel(cliente(m, { version: 1, files: [], omitted: 0 }, { extra: Buffer.from('x') })({ origem: path.resolve('.') }));
});

test('rejeita JSON inválido, versão errada e campos de protocolo inesperados', async () => {
  const m = await api();
  for (const response of [frame(Buffer.from('{bad', 'utf8')), { version: 2, files: [], omitted: 0 }, { version: 1, files: [], omitted: 0, root: 'C:/leak' }, { version: 1, files: 'invalid', omitted: 0 }]) await erroIndisponivel(cliente(m, response)({ origem: path.resolve('.') }));
});

test('rejeita caminhos proibidos, absolutos, traversal, duplicados e tamanhos inválidos', async () => {
  const m = await api();
  const invalid = [
    [{ path: '../escape.txt', bytes: 1 }], [{ path: 'C:/outside.txt', bytes: 1 }],
    [{ path: '/outside.txt', bytes: 1 }], [{ path: '.env', bytes: 1 }],
    [{ path: 'src/a.js', bytes: 1 }, { path: 'src/a.js', bytes: 1 }],
    [{ path: 'src/A.js', bytes: 1 }, { path: 'src/a.js', bytes: 1 }],
    [{ path: 'src/a.js', bytes: -1 }], [{ path: 'src/a.js', bytes: 1.5 }],
    [{ path: 'src/a.js', bytes: MAX_FILE + 1 }]
  ];
  for (const files of invalid) await erroIndisponivel(cliente(m, { version: 1, files, omitted: 0 })({ origem: path.resolve('.') }));
});

test('rejeita limites de arquivos, bytes totais e entradas omitidas sem resultado parcial', async () => {
  const m = await api();
  for (const payload of [
    { version: 1, files: Array.from({ length: 5001 }, (_, i) => ({ path: `f${i}.txt`, bytes: 0 })), omitted: 0 },
    { version: 1, files: [{ path: 'a', bytes: MAX_FILE }, { path: 'b', bytes: MAX_FILE }, { path: 'c', bytes: 1 }], omitted: 0 },
    { version: 1, files: [], omitted: 20001 }
  ]) await erroIndisponivel(cliente(m, payload)({ origem: path.resolve('.') }));
  assert.equal(MAX_TOTAL, 512 * 1024 * 1024);
});

test('timeout mata o filho e falha fechado', async () => {
  const m = await api(); let child;
  const run = m.criarClienteInventarioNativo({ helperPath: path.resolve('helper'), timeoutMs: 10, spawnImpl: (...args) => child = fakeSpawn({ version: 1, files: [], omitted: 0 }, { delay: 1000, neverClose: true })(...args) });
  await erroIndisponivel(run({ origem: path.resolve('.') }));
  assert.equal(child.killed, true);
});

test('erro de stream encerra o filho sem propagar detalhes', async () => {
  const m = await api();
  for (const stream of ['stdout', 'stderr', 'stdin']) {
    let child;
    const run = m.criarClienteInventarioNativo({
      helperPath: path.resolve('helper'), timeoutMs: 100,
      spawnImpl: (...args) => {
        child = fakeSpawn({ version: 1, files: [], omitted: 0 }, { delay: 1000, neverClose: true })(...args);
        setImmediate(() => child[stream].emit('error', Error('synthetic private path')));
        return child;
      }
    });
    await erroIndisponivel(run({ origem: path.resolve('.') }));
    assert.equal(child.killed, true);
  }
});

test('stdout/stderr acima dos tetos e response acima de 4 MiB encerram sem inventário', async () => {
  const m = await api();
  const largePayload = Buffer.alloc(MAX_RESPONSE + 1, 0x20);
  const largeFrame = Buffer.concat([Buffer.from([0, 0, 0, 1]), largePayload]);
  await erroIndisponivel(cliente(m, largeFrame)({ origem: path.resolve('.') }));
  await erroIndisponivel(cliente(m, { version: 1, files: [], omitted: 0 }, { stderr: 'e'.repeat(MAX_RESPONSE + 1) })({ origem: path.resolve('.') }));
});

test('API de produto falha fechado quando o pacote não contém helper', async () => {
  const anterior = process.resourcesPath;
  try {
    process.resourcesPath = path.resolve('synthetic/package-without-project-inventory');
    const m = await import(`${mod}?missing-product-helper=1`);
    await erroIndisponivel(m.listarInventarioNativo({ origem: path.resolve('.') }));
  } finally {
    if (anterior === undefined) delete process.resourcesPath;
    else process.resourcesPath = anterior;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, writeFile, link, symlink, rm, access, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarClienteInventarioNativo } from '../src/execucao/inventario-nativo.js';

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/project-inventory/bin/lume-project-inventory.exe');
const testHelper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/project-inventory/bin/test/lume-project-inventory.exe');
const forbidden = ['.env', '.env.local', '.git', '.codex', '.claude', '.agents', '.ssh', '.aws', '.kube', '.gnupg', '.docker', '.npmrc', '.netrc', '.pypirc', '.gitconfig', 'AGENTS.md', 'CLAUDE.md', 'credentials.json', 'id_rsa', 'id_ed25519', 'manifesto.json', 'CON.txt', 'nul', 'bad:name.txt', 'trailing.'];
const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function frame(value) {
  return frameRaw(Buffer.from(JSON.stringify(value), 'utf8'));
}

function frameRaw(payload) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function run(input, { timeout = 12000 } = {}) {
  return spawnSync(helper, [], { input, encoding: null, timeout, windowsHide: true, shell: false, env: {} });
}

function request(root) { return frame({ version: 1, root }); }
function result(proc) {
  assert.equal(proc.error, undefined, `helper spawn error: ${proc.error?.code ?? proc.error?.message}`);
  assert.equal(proc.status, 0, `helper status=${proc.status} stderr=${proc.stderr?.toString('utf8')}`);
  assert.equal(proc.stderr.length, 0, 'helper must not print paths or diagnostics to stderr');
  assert.ok(proc.stdout.length >= 4, 'missing framed response');
  const size = proc.stdout.readUInt32BE(0);
  assert.equal(proc.stdout.length, size + 4, 'response must be exactly one frame');
  return JSON.parse(proc.stdout.subarray(4).toString('utf8'));
}

function exited(proc) {
  assert.equal(proc.error, undefined, `helper unavailable or blocked: ${proc.error?.code ?? proc.error?.message}`);
  assert.notEqual(proc.status, 0, 'malformed/unsafe request unexpectedly succeeded');
  assert.equal(proc.stdout.length, 0, 'failed request must not return a partial inventory');
  assert.equal(proc.stderr.length, 0, 'helper must not print local paths or diagnostics');
}

async function runAtHook(t, root, barrier, mutation, hookDirectory) {
  const hooks = hookDirectory ?? path.join(path.dirname(root), `hooks-${barrier}`);
  await mkdir(hooks, { recursive: true });
  const reached = path.join(hooks, `${barrier}.reached`);
  const release = path.join(hooks, `${barrier}.release`);
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs/promises');
    (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { await fs.access(workerData.reached); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      await fs.access(workerData.reached);
      await fs.rename(workerData.from, workerData.to);
      await fs.symlink(workerData.target, workerData.link, 'junction');
      const info = await fs.lstat(workerData.link);
      if (!info.isSymbolicLink()) throw new Error('replacement junction not installed');
      await fs.writeFile(workerData.release, 'continue');
      parentPort.postMessage({ ok: true });
    })().catch(async error => {
      try { await fs.writeFile(workerData.release, 'continue'); } catch {}
      parentPort.postMessage({ ok: false, error: error.code || error.message });
    });
  `;
  const worker = new Worker(workerSource, { eval: true, workerData: { reached, release, ...mutation } });
  const workerResult = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  t.after(() => worker.terminate());
  const proc = spawnSync(testHelper, [], { input: request(root), encoding: null, timeout: 12000, windowsHide: true, shell: false,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
      LUME_INVENTORY_TEST_HOOK: barrier, LUME_INVENTORY_TEST_HOOK_DIR: hooks } });
  if (proc.error) {
    await worker.terminate();
    assert.fail(`TEST_HOOKS helper could not execute: ${proc.error.code ?? proc.error.message}`);
  }
  const mutationResult = await workerResult;
  assert.deepEqual(mutationResult, { ok: true }, `race mutation failed: ${mutationResult.error}`);
  assert.equal(proc.error, undefined, `hooked helper spawn/timeout failure: ${proc.error?.code ?? proc.error?.message}`);
  const response = result(proc);
  return response;
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'lume-inventory-native-'));
  const tempRoot = path.resolve(os.tmpdir());
  const resolvedBase = path.resolve(base);
  const expectedParent = `${tempRoot}${path.sep}lume-inventory-native-`;
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  assert.equal(comparable(path.dirname(resolvedBase)), comparable(tempRoot), 'fixture parent must be the OS temp directory');
  assert.ok(comparable(resolvedBase).startsWith(comparable(expectedParent)), 'fixture must use the unique test prefix');
  t.after(() => rm(resolvedBase, { recursive: true, force: true }));
  const root = path.join(base, 'root');
  await mkdir(root);
  return { base, root };
}

test('Windows helper accepts one valid BE framed request and returns the exact relative inventory', async t => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.js'), 'hello');
  await writeFile(path.join(root, 'README.md'), 'readme');
  const response = result(run(request(root)));
  assert.deepEqual(response, { version: 1, files: [{ path: 'README.md', bytes: 6 }, { path: 'src/main.js', bytes: 5 }], omitted: 0 });
  assert.equal(JSON.stringify(response).includes(root), false, 'absolute root must not escape');
});

test('ponte de produção usa o helper real e devolve o inventário validado', async t => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'nota.txt'), 'real helper');
  const inventario = await criarClienteInventarioNativo({ helperPath: helper })({ origem: root });
  assert.deepEqual(inventario, { arquivos: [{ caminho: 'docs/nota.txt', bytes: 11 }], omitidos: 0 });
});

test('invalid, truncated and oversized framed requests fail closed without partial inventory', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'visible.txt'), 'secret-name-must-not-leak');
  for (const input of [Buffer.alloc(0), Buffer.from([0, 0, 0]), Buffer.from([0, 0, 0, 1, 0x7b]), Buffer.from([0xff, 0xff, 0xff, 0xff]), frame({ version: 2, root })]) {
    const proc = run(input);
    exited(proc);
    assert.equal(proc.stdout.includes(Buffer.from('visible.txt')), false, 'invalid request leaked inventory');
    assert.equal(proc.stderr.includes(Buffer.from(root)), false, 'diagnostics leaked absolute root');
  }
});

test('rejects single-quoted JSON accepted by JavaScriptSerializer', async t => {
  const { root } = await fixture(t);
  const singleQuotes = frameRaw(Buffer.from(`{'version':1,'root':${JSON.stringify(root)}}`, 'utf8'));
  exited(run(singleQuotes));
});

test('rejects duplicate version keys in framed JSON', async t => {
  const { root } = await fixture(t);
  const duplicateVersion = frameRaw(Buffer.from(`{"version":2,"version":1,"root":${JSON.stringify(root)}}`, 'utf8'));
  exited(run(duplicateVersion));
});

test('absent root and root file fail closed', async t => {
  const { base } = await fixture(t);
  const missing = run(request(path.join(base, 'missing')));
  exited(missing);
  assert.equal(missing.stdout.includes(Buffer.from(base)), false, 'missing-root error leaked local path to stdout');
  assert.equal(missing.stderr.includes(Buffer.from(base)), false, 'missing-root error leaked local path to stderr');
  const file = path.join(base, 'ordinary-file');
  await writeFile(file, 'x');
  const notDirectory = run(request(file));
  exited(notDirectory);
});

test('prohibited names and Windows-invalid components are omitted before descent', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'kept.txt'), 'ok');
  for (const name of forbidden) {
    if (!/[<>:"|?*]/.test(name) && !name.endsWith('.') && !reservedWindowsName.test(name)) {
      const target = path.join(root, name);
      if (name === '.git' || name === '.codex' || name === '.claude' || name === '.agents' || name === '.ssh' || name === '.aws' || name === '.kube' || name === '.gnupg' || name === '.docker') {
        await mkdir(target); await writeFile(path.join(target, 'must-not-descend.txt'), 'x');
      } else await writeFile(target, 'x');
    }
  }
  const response = result(run(request(root)));
  assert.deepEqual(response.files.map(file => file.path), ['kept.txt']);
  assert.ok(response.omitted >= 19);
  assert.equal(JSON.stringify(response).includes('must-not-descend'), false);
});

test('root manifesto is omitted regardless of Windows filename case', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'MANIFESTO.JSON'), 'private manifest');
  const response = result(run(request(root)));
  assert.deepEqual(response.files, []);
  assert.equal(response.omitted, 1);
});

test('Unicode names are preserved as UTF-8 relative paths', async t => {
  const { root } = await fixture(t);
  const unicode = '資料-ação-😀.txt';
  await writeFile(path.join(root, unicode), 'utf8');
  const response = result(run(request(root)));
  assert.deepEqual(response.files, [{ path: unicode, bytes: 4 }]);
});

test('junction traversal omits every external name', async t => {
  const { base, root } = await fixture(t);
  const outside = path.join(base, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'external-marker-7f31.txt'), 'must not escape');
  await symlink(outside, path.join(root, 'junction'), 'junction');
  const response = result(run(request(root)));
  assert.equal(response.files.some(file => file.path.includes('external-marker-7f31')), false);
  assert.equal(response.files.some(file => file.path.startsWith('junction/')), false);
  assert.ok(response.omitted >= 1);
});

test('hard-linked files are omitted without exposing their names', async t => {
  const { base, root } = await fixture(t);
  const outside = path.join(base, 'outside-secret.txt');
  await writeFile(outside, 'secret');
  await link(outside, path.join(root, 'hardlink-secret.txt'));
  const response = result(run(request(root)));
  assert.equal(response.files.some(file => /secret/.test(file.path)), false);
  assert.ok(response.omitted >= 1);
});

test('file count and total byte limits abort instead of returning partial inventory', async t => {
  const { root } = await fixture(t);
  for (let i = 0; i < 5001; i++) await writeFile(path.join(root, `f${String(i).padStart(4, '0')}.txt`), '');
  const count = run(request(root), { timeout: 30000 });
  exited(count);
});

test('individual and aggregate byte limits reject only values above each boundary', async t => {
  const maxFile = 256 * 1024 * 1024;
  const maxTotal = 512 * 1024 * 1024;

  const exactFile = await fixture(t);
  await writeFile(path.join(exactFile.root, 'exact-256.bin'), '');
  await truncate(path.join(exactFile.root, 'exact-256.bin'), maxFile);
  assert.deepEqual(result(run(request(exactFile.root))), {
    version: 1, files: [{ path: 'exact-256.bin', bytes: maxFile }], omitted: 0
  });

  const oversizedFile = await fixture(t);
  await writeFile(path.join(oversizedFile.root, 'over-256.bin'), '');
  await truncate(path.join(oversizedFile.root, 'over-256.bin'), maxFile + 1);
  exited(run(request(oversizedFile.root)));

  const exactTotal = await fixture(t);
  for (const name of ['exact-a.bin', 'exact-b.bin']) {
    const file = path.join(exactTotal.root, name);
    await writeFile(file, '');
    await truncate(file, maxFile);
  }
  const exactTotalResponse = result(run(request(exactTotal.root)));
  assert.equal(exactTotalResponse.files.length, 2);
  assert.equal(exactTotalResponse.files.reduce((sum, file) => sum + file.bytes, 0), maxTotal);

  const oversizedTotal = await fixture(t);
  for (const name of ['under-a.bin', 'under-b.bin', 'under-c.bin']) {
    const file = path.join(oversizedTotal.root, name);
    await writeFile(file, '');
    await truncate(file, 200 * 1024 * 1024);
  }
  exited(run(request(oversizedTotal.root)));
});

test('depth 64 and entry 20,000 limits fail closed without partial inventory', async t => {
  const depthFixture = await fixture(t);
  let current = depthFixture.root;
  for (let i = 0; i < 64; i++) {
    current = path.join(current, `d${String(i).padStart(2, '0')}`);
    await mkdir(current);
  }
  await writeFile(path.join(current, 'deep.txt'), 'x');
  exited(run(request(depthFixture.root)));

  const entriesFixture = await fixture(t);
  for (let i = 0; i < 20001; i++) await writeFile(path.join(entriesFixture.root, `.env.${String(i).padStart(5, '0')}`), '');
  const started = Date.now();
  exited(run(request(entriesFixture.root), { timeout: 30000 }));
  assert.ok(Date.now() - started < 10000, 'must fail at the visited-entry limit before the 10 second deadline');
});

test('failure output never includes the local selected path', async t => {
  const { base, root } = await fixture(t);
  const proc = run(request(path.join(base, 'missing-local-path-marker')));
  exited(proc);
  assert.equal(proc.stdout.includes(Buffer.from(base)), false);
  assert.equal(proc.stderr.includes(Buffer.from(base)), false);
});

test('after-root-open barrier preserves selected root when its path becomes a junction', async t => {
  await access(testHelper);
  const { base, root } = await fixture(t);
  const held = path.join(base, 'held-selected-root');
  const outside = path.join(base, 'outside-root');
  await mkdir(outside);
  await writeFile(path.join(root, 'selected-marker.txt'), 'selected');
  await writeFile(path.join(outside, 'external-marker-root-58a1.txt'), 'outside');
  const response = await runAtHook(t, root, 'after-root-open', { from: root, to: held, target: outside, link: root });
  assert.ok(response.files.some(file => file.path === 'selected-marker.txt'));
  assert.equal(JSON.stringify(response).includes('external-marker-root-58a1'), false);
  assert.equal(JSON.stringify(response).includes(base), false);
});

test('before-child-open barrier rejects a child replaced by a junction', async t => {
  await access(testHelper);
  const { base, root } = await fixture(t);
  const target = path.join(root, 'target');
  const held = path.join(root, 'held-original');
  const outside = path.join(base, 'outside-child');
  await mkdir(target); await mkdir(outside);
  await writeFile(path.join(target, 'inside-only.txt'), 'inside');
  await writeFile(path.join(outside, 'external-marker-child-331c.txt'), 'outside');
  const response = await runAtHook(t, root, 'before-child-open', { from: target, to: held, target: outside, link: target });
  assert.equal(response.files.some(file => file.path.includes('external-marker-child-331c')), false);
  assert.equal(response.files.some(file => file.path.startsWith('target/')), false);
  assert.ok(response.omitted >= 1);
  assert.equal(JSON.stringify(response).includes(base), false);
});

test('before-root-open barrier preserves selected root after its ancestor becomes a junction', async t => {
  await access(testHelper);
  const { base, root } = await fixture(t);
  const selectedParent = path.join(base, 'selected-parent');
  const selectedRoot = path.join(selectedParent, 'selected-root');
  const heldParent = path.join(base, 'held-parent');
  const outsideParent = path.join(base, 'outside-parent');
  const stableHooks = path.join(base, 'hooks-stable');
  await mkdir(selectedParent); await mkdir(selectedRoot); await mkdir(outsideParent);
  const externalRoot = path.join(outsideParent, 'selected-root');
  await mkdir(externalRoot);
  await writeFile(path.join(selectedRoot, 'selected-ancestor-marker.txt'), 'selected');
  await writeFile(path.join(externalRoot, 'external-marker-ancestor-61fa.txt'), 'outside');
  const response = await runAtHook(t, selectedRoot, 'before-root-open',
    { from: selectedParent, to: heldParent, target: outsideParent, link: selectedParent }, stableHooks);
  assert.ok(response.files.some(file => file.path === 'selected-ancestor-marker.txt'));
  assert.equal(JSON.stringify(response).includes('external-marker-ancestor-61fa'), false);
  assert.equal(JSON.stringify(response).includes(base), false);
});

test('after-child-open barrier catches replacement by junction without external names', async t => {
  await access(testHelper);
  const { base, root } = await fixture(t);
  const target = path.join(root, 'target');
  const held = path.join(root, 'held-original');
  const outside = path.join(base, 'outside');
  const hooks = path.join(base, 'hooks');
  await mkdir(target); await mkdir(outside); await mkdir(hooks);
  await writeFile(path.join(target, 'inside-only.txt'), 'inside');
  await writeFile(path.join(outside, 'external-marker-race-2b94.txt'), 'outside');
  const reached = path.join(hooks, 'after-child-open.reached');
  const release = path.join(hooks, 'after-child-open.release');
  const response = await runAtHook(t, root, 'after-child-open', { from: target, to: held, target: outside, link: target });
  assert.equal(response.files.some(file => file.path.includes('external-marker-race-2b94')), false);
  assert.ok(response.files.some(file => file.path === 'target/inside-only.txt'));
  assert.equal(JSON.stringify(response).includes(base), false);
});

test('before-enumerate barrier keeps enumeration on the opened root handle', async t => {
  await access(testHelper);
  const { base, root } = await fixture(t);
  const held = path.join(base, 'held-enumeration-root');
  const outside = path.join(base, 'outside-enumeration-root');
  await mkdir(outside);
  await writeFile(path.join(root, 'opened-root-marker.txt'), 'selected');
  await writeFile(path.join(outside, 'external-marker-enumerate-bc04.txt'), 'outside');
  const response = await runAtHook(t, root, 'before-enumerate', { from: root, to: held, target: outside, link: root });
  assert.ok(response.files.some(file => file.path === 'opened-root-marker.txt'));
  assert.equal(JSON.stringify(response).includes('external-marker-enumerate-bc04'), false);
  assert.equal(JSON.stringify(response).includes(base), false);
});

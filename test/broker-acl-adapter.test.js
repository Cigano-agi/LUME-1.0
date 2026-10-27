import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyBrokerAcl } from '../src/mcp/broker-acl-native.js';

const userData = 'C:\\Users\\Alice\\AppData\\Roaming\\Lume';
const paths = ['C:\\', 'C:\\Users', 'C:\\Users\\Alice', 'C:\\Users\\Alice\\AppData', 'C:\\Users\\Alice\\AppData\\Roaming', userData];
const bytes = Buffer.from('synthetic PE fixture, never executed');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = Buffer.from(JSON.stringify({ schema: 1, platform: 'win32', arch: 'x64', file: 'lume-acl.exe', sha256, sourceSha256: 'a'.repeat(64) }));
const regular = { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: bytes.length, dev: 1, ino: 2, mtimeMs: 1 };

function fixture(t, { output = '{"ok":true,"code":"OK"}', error = null, stderr = '', badManifest = false, badHash = false, linked = false } = {}) {
  const calls = [];
  mock.method(fs, 'lstatSync', path => ({ ...regular, size: String(path).endsWith('manifest.json') ? manifest.length : bytes.length, isSymbolicLink: () => linked }));
  mock.method(fs, 'readFileSync', path => String(path).endsWith('manifest.json') ? (badManifest ? Buffer.from('{}') : manifest) : (badHash ? Buffer.from('x'.repeat(bytes.length)) : bytes));
  mock.method(childProcess, 'execFile', (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, output, stderr);
  });
  t.after(() => mock.restoreAll());
  return calls;
}

test('adapter chama apenas PE fixo, oculto e argumentos congelados', async t => {
  const calls = fixture(t);
  await verifyBrokerAcl({ userData, paths, strictFrom: 5 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /native[\\/]win-acl[\\/]bin[\\/]lume-acl\.exe$/);
  assert.deepEqual(calls[0].args, ['--check', userData, '5', ...paths]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.maxBuffer, 4096);
});

test('adapter recusa manifesto adulterado antes da execução', async t => {
  const calls = fixture(t, { badManifest: true });
  await assert.rejects(verifyBrokerAcl({ userData, paths, strictFrom: 5 }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  assert.equal(calls.length, 0);
});

test('adapter recusa PE cujo hash diverge do manifesto', async t => {
  const calls = fixture(t, { badHash: true });
  await assert.rejects(verifyBrokerAcl({ userData, paths, strictFrom: 5 }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  assert.equal(calls.length, 0);
});

test('adapter recusa link, saída inesperada, stderr e falha do PE', async t => {
  const calls = fixture(t, { linked: true });
  await assert.rejects(verifyBrokerAcl({ userData, paths, strictFrom: 5 }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  assert.equal(calls.length, 0);
});

for (const [label, variant] of [
  ['campos ausentes', { output: '{"ok":true}' }],
  ['negação nativa', { output: '{"ok":false,"code":"ACL_UNTRUSTED"}' }],
  ['campo extra', { output: '{"ok":true,"code":"OK","sid":"secret"}' }],
  ['JSON inválido', { output: 'not json' }],
  ['saída excede limite', { output: ' '.repeat(4097) }],
  ['stderr', { output: '{"ok":true,"code":"OK"}', stderr: 'warning' }],
  ['PE bloqueado', { output: '', error: Object.assign(new Error('blocked'), { code: 'EPERM' }) }],
  ['timeout', { output: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }]
]) {
  test(`adapter falha fechado: ${label}`, async t => {
    fixture(t, variant);
    await assert.rejects(verifyBrokerAcl({ userData, paths, strictFrom: 5 }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  });
}

test('adapter recusa shape e índice inválidos antes de inspecionar artefato', async t => {
  const calls = fixture(t);
  await assert.rejects(verifyBrokerAcl({ userData, paths, strictFrom: 4 }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  await assert.rejects(verifyBrokerAcl({ userData, paths: [...paths, '\0'], strictFrom: 5 }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  assert.equal(calls.length, 0);
});

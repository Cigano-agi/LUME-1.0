import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createBootIdentity } from '../src/mcp/broker-identity.js';
import { publishBrokerDescriptor, readBrokerDescriptor, validateBrokerDescriptor } from '../src/mcp/broker-bootstrap.js';

const selection = { tipo: 'legado', id: 'legado', geracao: null };
const boot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const testParent = process.platform === 'win32' ? homedir() : tmpdir();
function safeRemove(path) {
  if (dirname(resolve(path)) !== resolve(testParent) || !basename(path).startsWith('lume-broker-')) throw Error('unsafe test cleanup');
  rmSync(path, { recursive: true, force: true });
}

test('descritor público exige campos fechados e pin do certificado', async () => {
  const identity = await createBootIdentity();
  const descriptor = { schema: 1, boot, perfil: selection, port: 41234, certPem: identity.certPem, pin: identity.pin };
  assert.deepEqual(validateBrokerDescriptor(descriptor, selection), descriptor);
  assert.throws(() => validateBrokerDescriptor({ ...descriptor, privateKey: identity.privateKey }, selection));
  assert.throws(() => validateBrokerDescriptor({ ...descriptor, pin: '0'.repeat(64) }, selection));
  assert.throws(() => validateBrokerDescriptor({ ...descriptor, port: 0 }, selection));
  assert.throws(() => validateBrokerDescriptor({ ...descriptor, perfil: { ...selection, id: 'other' } }, selection));
});

test('bootstrap ausente é recusado', async () => {
  const userData = mkdtempSync(join(testParent, 'lume-broker-bootstrap-'));
  try {
    await assert.rejects(readBrokerDescriptor({ userData, selection }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  } finally { safeRemove(userData); }
});

test('publicação positiva, leitura e release exigem prova ACL nativa', async () => {
  const userData = mkdtempSync(join(testParent, 'lume-broker-positive-'));
  try {
    const identity = await createBootIdentity();
    const { descriptor, release } = await publishBrokerDescriptor({ userData, selection, boot, port: 41234, identity });
    assert.deepEqual(await readBrokerDescriptor({ userData, selection }), descriptor);
    await release();
    await assert.rejects(readBrokerDescriptor({ userData, selection }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  } finally { safeRemove(userData); }
});

test('boot seguinte publica nova identidade e descritor antigo não persiste', async () => {
  const userData = mkdtempSync(join(testParent, 'lume-broker-next-'));
  try {
    const first = await publishBrokerDescriptor({ userData, selection, boot, port: 41234, identity: await createBootIdentity() });
    await first.release();
    const nextBoot = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const second = await publishBrokerDescriptor({ userData, selection, boot: nextBoot, port: 41235, identity: await createBootIdentity() });
    assert.deepEqual(await readBrokerDescriptor({ userData, selection }), second.descriptor);
    assert.notEqual(second.descriptor.pin, first.descriptor.pin);
    await second.release();
  } finally { safeRemove(userData); }
});

test('release preserva descritor substituto e arquivo estranho', async () => {
  const userData = mkdtempSync(join(testParent, 'lume-broker-replace-'));
  try {
    const { descriptor, release } = await publishBrokerDescriptor({ userData, selection, boot, port: 41234, identity: await createBootIdentity() });
    const control = join(userData, 'broker-control');
    const target = join(control, 'descriptor.json');
    const stranger = join(control, 'stranger.txt');
    const substitute = join(control, 'substitute.json');
    writeFileSync(stranger, 'keep', { mode: 0o600 });
    writeFileSync(substitute, JSON.stringify(descriptor) + '\n', { mode: 0o600 });
    renameSync(substitute, target);
    await assert.rejects(release(), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
    assert.equal(existsSync(target), true);
    assert.equal(existsSync(stranger), true);
  } finally { safeRemove(userData); }
});

test('controle substituído por link é recusado antes de leitura', async () => {
  const userData = mkdtempSync(join(testParent, 'lume-broker-link-'));
  const outside = mkdtempSync(join(testParent, 'lume-broker-outside-'));
  try {
    mkdirSync(join(outside, 'control'));
    symlinkSync(join(outside, 'control'), join(userData, 'broker-control'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(outside, 'control', 'descriptor.json'), '{}');
    await assert.rejects(readBrokerDescriptor({ userData, selection }));
  } finally {
    try { unlinkSync(join(userData, 'broker-control')); } catch {}
    if (!existsSync(join(userData, 'broker-control'))) safeRemove(userData);
    safeRemove(outside);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { createBootIdentity } from '../src/mcp/broker-identity.js';
import { createProfileBroker } from '../src/mcp/profile-broker.js';
import { connectProfileBroker } from '../src/mcp/profile-broker-client.js';
import { encodeFrame, FrameDecoder } from '../src/mcp/broker-frames.js';

const perfil = { tipo: 'legado', id: 'legado', geracao: null };
const credential = 'c'.repeat(64);
async function fixture(t, callbacks = {}) {
  const identity = await createBootIdentity({});
  const boot = randomUUID(), revision = randomUUID();
  const broker = createProfileBroker({ selection: perfil, boot, identity,
    authorizeHello: callbacks.hello ?? (() => ({ revision })),
    authorizeBegin: callbacks.begin ?? (() => ({ revision })) });
  const { port } = await broker.start();
  const descriptor = { schema: 1, boot, perfil, port, certPem: identity.certPem, pin: identity.pin };
  t.after(async () => { try { await broker.close(); } catch {} });
  return { broker, descriptor, identity, revision };
}
const connect = (f, extra = {}) => connectProfileBroker({ descriptor: f.descriptor, selection: perfil,
  clientId: 'claude-desktop', credential, ...extra });
test('admissão fechada até admit; ciclo autorizado só conclui após CLOSED e EOF', async t => {
  const f = await fixture(t);
  await assert.rejects(connect(f));
  f.broker.admit();
  let notifyDrain;
  const drained = new Promise(resolve => { notifyDrain = resolve; });
  const client = await connect(f, { onDrain: () => notifyDrain(true) });
  assert.equal(client.grant.revision, f.revision);
  const id = await client.begin();
  await assert.rejects(client.begin(), /UNCERTAIN/);
  await client.end(id);
  await assert.rejects(client.end(id), /UNCERTAIN/);
  const second = await client.begin();
  assert.notEqual(second.requestId, id.requestId);
  await client.end(second);
  const closing = f.broker.drain();
  const drainDeadline = setTimeout(() => notifyDrain(false), 5000);
  assert.equal(await drained, true);
  clearTimeout(drainDeadline);
  assert.deepEqual(await client.closeAfterDb(), { closed: true });
  assert.deepEqual(await closing, { closed: true });
});
test('CLOSED voluntário após DB fechado permite drain posterior', async t => {
  const f = await fixture(t); f.broker.admit();
  const client = await connect(f);
  const id = await client.begin(); await client.end(id);
  assert.deepEqual(await client.closeAfterDb(), { closed: true });
  assert.deepEqual(await f.broker.drain(), { closed: true });
});
test('revogação entre HELLO e BEGIN recusa operação', async t => {
  let enabled = true, revision;
  const f = await fixture(t, { begin: () => enabled ? { revision } : null });
  revision = f.revision; f.broker.admit();
  const client = await connect(f);
  enabled = false;
  await assert.rejects(client.begin());
  await assert.rejects(f.broker.drain(), /UNCERTAIN/);
});
test('stopAdmission recusa BEGIN em sessão já admitida', async t => {
  const f = await fixture(t); f.broker.admit();
  const client = await connect(f);
  f.broker.stopAdmission();
  await assert.rejects(client.begin(), /UNCERTAIN/);
  await assert.rejects(f.broker.drain(), /UNCERTAIN/);
});
test('frame parcial no servidor mantém prazo original após segundo byte', async t => {
  const f = await fixture(t); f.broker.admit();
  const socket = tls.connect({ host: '127.0.0.1', port: f.descriptor.port, servername: 'lume.local', ca: f.identity.certPem,
    rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const granted = new Promise(resolve => { const decoder = new FrameDecoder(); socket.on('data', chunk => {
    for (const item of decoder.push(chunk)) if (item.type === 'GRANT') resolve(item);
  }); });
  socket.write(encodeFrame({ type: 'HELLO', protocol: 1, clientId: 'claude-desktop', credential,
    boot: f.descriptor.boot, perfil, nonce: randomUUID() }));
  const grant = await granted;
  const frame = encodeFrame({ type: 'BEGIN', sessionId: grant.sessionId, boot: grant.boot, requestId: randomUUID() });
  const began = Date.now(), closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(frame.subarray(0, 1));
  await new Promise(resolve => setTimeout(resolve, 2500));
  socket.write(frame.subarray(1, 2));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('TEST_TIMEOUT')), 6500 - (Date.now() - began)))]);
  assert.ok(Date.now() - began < 6500);
  await assert.rejects(f.broker.drain(), /UNCERTAIN/);
});
test('Promise no callback de autorização é recusa, nunca GRANT', async t => {
  const f = await fixture(t, { hello: () => Promise.resolve({ revision: randomUUID() }) });
  f.broker.admit(); await assert.rejects(connect(f));
});
test('frame malformado encerra canal sem admissão', async t => {
  const f = await fixture(t); f.broker.admit();
  const socket = tls.connect({ host: '127.0.0.1', port: f.descriptor.port, servername: 'lume.local', ca: f.identity.certPem,
    rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const response = new Promise(resolve => { const decoder = new FrameDecoder(); socket.on('data', chunk => {
    for (const item of decoder.push(chunk)) if (item.type === 'ERROR') resolve(item.code);
  }); });
  const invalid = Buffer.alloc(4); invalid.writeUInt32BE(9000); socket.write(invalid);
  assert.equal(await response, 'INVALID_FRAME'); socket.destroy();
});

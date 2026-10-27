import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { createBootIdentity } from '../src/mcp/broker-identity.js';
import { createProfileBroker } from '../src/mcp/profile-broker.js';
import { connectProfileBroker } from '../src/mcp/profile-broker-client.js';
import { encodeFrame, FrameDecoder } from '../src/mcp/broker-frames.js';

const perfil = { tipo: 'legado', id: 'legado', geracao: null };
const credential = 'secret'.repeat(8);
async function fixture(t, authorizeHello) {
  const identity = await createBootIdentity({}), boot = randomUUID(), revision = randomUUID();
  const broker = createProfileBroker({ selection: perfil, boot, identity, authorizeHello: authorizeHello ?? (() => ({ revision })), authorizeBegin: () => ({ revision }) });
  const { port } = await broker.start(); broker.admit();
  t.after(async () => { try { await broker.close(); } catch {} });
  return { broker, descriptor: { schema: 1, boot, perfil, port, certPem: identity.certPem, pin: identity.pin } };
}
const connect = (descriptor, extra = {}) => connectProfileBroker({ descriptor, selection: perfil, clientId: 'claude-desktop', credential, ...extra });
test('pin falso, boot e perfil divergentes barram HELLO', async t => {
  let authCalls = 0;
  const f = await fixture(t, () => { authCalls++; return { revision: randomUUID() }; });
  await assert.rejects(connect({ ...f.descriptor, pin: '0'.repeat(64) }));
  assert.equal(authCalls, 0);
  const other = await createBootIdentity({});
  await assert.rejects(connect({ ...f.descriptor, certPem: other.certPem }));
  assert.equal(authCalls, 0);
  await assert.rejects(connect({ ...f.descriptor, boot: randomUUID() }));
  await assert.rejects(connect({ ...f.descriptor, perfil: { ...perfil, id: 'outro' } }));
});
test('canal perdido antes de CLOSED permanece incerto', async t => {
  const f = await fixture(t); let lost = false;
  const client = await connect(f.descriptor, { onLost: () => { lost = true; } });
  await client.begin();
  await assert.rejects(f.broker.drain({ timeoutMs: 30 }), /UNCERTAIN/);
  await assert.rejects(f.broker.close(), /UNCERTAIN/);
  await assert.rejects(f.broker.close(), /UNCERTAIN/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lost, true);
});
test('abort idempotente destrói TLS sem emitir CLOSED', async t => {
  const f = await fixture(t);
  const client = await connect(f.descriptor);
  assert.equal(typeof client.abort, 'function');
  client.abort();
  client.abort();
  await assert.rejects(client.closeAfterDb(), /UNCERTAIN/);
  await assert.rejects(f.broker.drain({ timeoutMs: 30 }), /UNCERTAIN/);
});
test('END sem ACK mantém sessão incerta e impede CLOSED', async t => {
  const identity = await createBootIdentity({}), boot = randomUUID(), revision = randomUUID();
  const server = tls.createServer({ key: identity.privateKey, cert: identity.certPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
    const decoder = new FrameDecoder(); let sessionId;
    socket.on('data', chunk => {
      for (const msg of decoder.push(chunk)) {
        if (msg.type === 'HELLO') {
          sessionId = randomUUID();
          socket.write(encodeFrame({ type: 'GRANT', sessionId, boot, perfil, revision, nonce: msg.nonce }));
        } else if (msg.type === 'BEGIN') {
          socket.write(encodeFrame({ type: 'BEGIN_OK', sessionId, boot, requestId: msg.requestId }));
        } else if (msg.type === 'END') socket.destroy();
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const descriptor = { schema: 1, boot, perfil, port: server.address().port, certPem: identity.certPem, pin: identity.pin };
  const client = await connect(descriptor);
  const receipt = await client.begin({ operationId: randomUUID() });
  await assert.rejects(client.end(receipt), /UNCERTAIN/);
  await assert.rejects(client.closeAfterDb(), /UNCERTAIN/);
});
test('peer autenticado recebe CLOSED mas sem EOF deixa closeAfterDb incerto em 5 s', async t => {
  const identity = await createBootIdentity({}), boot = randomUUID(), revision = randomUUID();
  let peer, sawClosed = false;
  const server = tls.createServer({ key: identity.privateKey, cert: identity.certPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
    peer = socket; const decoder = new FrameDecoder();
    socket.on('data', chunk => { for (const msg of decoder.push(chunk)) {
      if (msg.type === 'HELLO') socket.write(encodeFrame({ type: 'GRANT', sessionId: randomUUID(), boot, perfil, revision, nonce: msg.nonce }));
      if (msg.type === 'CLOSED') sawClosed = true;
    } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { peer?.destroy(); server.close(); });
  const descriptor = { schema: 1, boot, perfil, port: server.address().port, certPem: identity.certPem, pin: identity.pin };
  const client = await connect(descriptor);
  const close = client.closeAfterDb(), began = Date.now();
  await assert.rejects(Promise.race([close, new Promise((_, reject) => setTimeout(() => reject(new Error('TEST_TIMEOUT')), 6500))]), /UNCERTAIN/);
  assert.equal(sawClosed, true);
  assert.ok(Date.now() - began >= 4500 && Date.now() - began < 6500);
});
test('frame parcial no cliente mantém prazo original após segundo byte', async t => {
  const identity = await createBootIdentity({}), boot = randomUUID(), revision = randomUUID();
  let peer;
  const server = tls.createServer({ key: identity.privateKey, cert: identity.certPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
    peer = socket; const decoder = new FrameDecoder();
    socket.on('data', chunk => { for (const msg of decoder.push(chunk)) if (msg.type === 'HELLO') {
      const sessionId = randomUUID();
      socket.write(encodeFrame({ type: 'GRANT', sessionId, boot, perfil, revision, nonce: msg.nonce }));
      setTimeout(() => {
        const frame = encodeFrame({ type: 'DRAIN', sessionId, boot });
        socket.write(frame.subarray(0, 1));
        setTimeout(() => socket.write(frame.subarray(1, 2)), 2500);
      }, 20);
    } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { peer?.destroy(); server.close(); });
  let lostResolve; const lost = new Promise(resolve => { lostResolve = resolve; });
  const descriptor = { schema: 1, boot, perfil, port: server.address().port, certPem: identity.certPem, pin: identity.pin };
  await connect(descriptor, { onLost: lostResolve });
  const began = Date.now();
  await Promise.race([lost, new Promise((_, reject) => setTimeout(() => reject(new Error('TEST_TIMEOUT')), 6500))]);
  assert.ok(Date.now() - began < 6500);
});

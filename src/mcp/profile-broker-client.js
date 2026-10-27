import tls from 'node:tls';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { FrameDecoder, FrameWriter, isUuid, sameProfile, validProfile } from './broker-frames.js';

const TIMEOUT = 5000;
const profileOf = selection => ({ tipo: selection?.tipo, id: selection?.id, geracao: selection?.geracao });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fail() { return new Error('BROKER_CHANNEL_UNCERTAIN'); }

export async function connectProfileBroker({ descriptor, selection, clientId, credential, onDrain, onLost }) {
  const perfil = profileOf(selection);
  if (!descriptor || Object.keys(descriptor).sort().join(',') !== 'boot,certPem,perfil,pin,port,schema' ||
      descriptor.schema !== 1 || !isUuid(descriptor.boot) || !validProfile(perfil) || !sameProfile(descriptor.perfil, perfil) ||
      !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 ||
      typeof descriptor.certPem !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.pin) ||
      clientId !== 'claude-desktop' || typeof credential !== 'string' ||
      Buffer.byteLength(credential, 'utf8') < 32 || Buffer.byteLength(credential, 'utf8') > 512) throw new Error('BROKER_DESCRIPTOR_INVALID');
  const nonce = randomUUID(), ready = deferred();
  const socket = tls.connect({ host: '127.0.0.1', port: descriptor.port, servername: 'lume.local',
    ca: descriptor.certPem, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
  const writer = new FrameWriter(socket), decoder = new FrameDecoder();
  let grant = null, pending = null, active = null, drainSeen = false, dbClosed = false, closedAck = false;
  let lost = false, fragmentTimer = null, closeWait = null, closePromise = null, closeTimer = null, eof = false;
  const connectionTimer = setTimeout(() => socket.destroy(fail()), TIMEOUT);
  function abandon() {
    if (lost) return;
    lost = true; clearTimeout(connectionTimer); clearTimeout(fragmentTimer); clearTimeout(closeTimer);
    const error = fail();
    ready.reject(error);
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
    if (closeWait) { closeWait.reject(error); closeWait = null; }
    if (typeof onLost === 'function') { try { onLost(error); } catch {} }
  }
  function abort() {
    if (lost) return;
    abandon();
    socket.destroy();
  }
  function request(message, expected) {
    if (lost || pending) return Promise.reject(fail());
    const wait = deferred();
    pending = { ...wait, expected, requestId: message.requestId,
      timer: setTimeout(() => socket.destroy(fail()), TIMEOUT) };
    try { writer.send(message); } catch { socket.destroy(); abandon(); }
    return wait.promise;
  }
  function maybeClose() {
    if (!dbClosed || closedAck || active || pending || lost) return;
    closedAck = true;
    try { writer.send({ type: 'CLOSED', sessionId: grant.sessionId, boot: grant.boot }); }
    catch { closedAck = false; socket.destroy(); }
  }
  socket.once('secureConnect', () => {
    try {
      if (!socket.authorized || socket.getProtocol() !== 'TLSv1.3') throw fail();
      const peer = socket.getPeerCertificate(true);
      if (!peer?.raw || peer.raw.length === 0) throw fail();
      const actual = createHash('sha256').update(peer.raw).digest();
      const expected = Buffer.from(descriptor.pin, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fail();
      writer.send({ type: 'HELLO', protocol: 1, clientId, credential, boot: descriptor.boot, perfil, nonce });
    } catch { socket.destroy(); abandon(); }
  });
  socket.on('data', chunk => {
    let messages;
    try { messages = decoder.push(chunk); } catch { socket.destroy(); abandon(); return; }
    if (messages.length > 8) { socket.destroy(); abandon(); return; }
    if (messages.length) { clearTimeout(fragmentTimer); fragmentTimer = null; }
    if (decoder.pendingBytes) {
      if (!fragmentTimer) fragmentTimer = setTimeout(() => socket.destroy(fail()), TIMEOUT);
    } else { clearTimeout(fragmentTimer); fragmentTimer = null; }
    for (const msg of messages) {
      if (msg.type === 'ERROR') { socket.destroy(); abandon(); return; }
      if (!grant) {
        if (msg.type !== 'GRANT' || msg.boot !== descriptor.boot || !sameProfile(msg.perfil, perfil) || msg.nonce !== nonce) {
          socket.destroy(); abandon(); return;
        }
        grant = msg; clearTimeout(connectionTimer);
        ready.resolve({ grant: Object.freeze({ ...msg }), begin, end, closeAfterDb, abort });
        continue;
      }
      if (msg.boot !== grant.boot || msg.sessionId !== grant.sessionId) { socket.destroy(); abandon(); return; }
      if (msg.type === 'DRAIN') {
        if (drainSeen) { socket.destroy(); abandon(); return; }
        drainSeen = true;
        if (typeof onDrain === 'function') { try { onDrain(); } catch { socket.destroy(); abandon(); return; } }
        maybeClose();
      } else if (pending && msg.type === pending.expected && msg.requestId === pending.requestId) {
        const completed = pending; pending = null; clearTimeout(completed.timer); completed.resolve(msg);
        maybeClose();
      } else { socket.destroy(); abandon(); return; }
    }
  });
  socket.on('end', () => {
    eof = true;
    if (!closedAck || active || pending) { abandon(); return; }
    socket.end();
  });
  socket.on('close', () => {
    if (!closedAck || !eof || active || pending) { abandon(); return; }
    clearTimeout(closeTimer);
    if (closeWait) { closeWait.resolve({ closed: true }); closeWait = null; }
  });
  socket.on('error', () => abandon());
  async function begin({ operationId } = {}) {
    const requestId = operationId ?? randomUUID();
    if (!grant || !isUuid(requestId) || active || pending || drainSeen || dbClosed) throw fail();
    await request({ type: 'BEGIN', sessionId: grant.sessionId, boot: grant.boot, requestId }, 'BEGIN_OK');
    active = requestId;
    return Object.freeze({ requestId });
  }
  async function end(receipt) {
    const requestId = receipt?.requestId;
    if (!grant || !active || requestId !== active) throw fail();
    await request({ type: 'END', sessionId: grant.sessionId, boot: grant.boot, requestId }, 'END_OK');
    active = null; maybeClose();
  }
  function closeAfterDb() {
    if (closePromise) return closePromise;
    if (!grant || lost) return Promise.reject(fail());
    dbClosed = true; closeWait = deferred(); closePromise = closeWait.promise;
    closeTimer = setTimeout(() => { socket.destroy(fail()); abandon(); }, TIMEOUT);
    maybeClose();
    return closePromise;
  }
  return ready.promise;
}

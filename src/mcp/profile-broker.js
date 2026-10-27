import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { FrameDecoder, FrameWriter, isUuid, sameProfile, validProfile } from './broker-frames.js';

const TIMEOUT = 5000;
const profileOf = selection => ({ tipo: selection?.tipo, id: selection?.id, geracao: selection?.geracao });
function denied(result) {
  try {
    if (!result || Object.getPrototypeOf(result) !== Object.prototype || Object.keys(result).length !== 1) return true;
    const revision = Object.getOwnPropertyDescriptor(result, 'revision');
    return !revision || !Object.hasOwn(revision, 'value') || !isUuid(revision.value);
  } catch { return true; }
}

export function createProfileBroker({ selection, boot, identity, authorizeHello, authorizeBegin }) {
  const perfil = profileOf(selection);
  if (!validProfile(perfil) || !isUuid(boot) || !identity?.certPem || !identity?.privateKey || identity.servername !== 'lume.local' ||
      typeof authorizeHello !== 'function' || typeof authorizeBegin !== 'function') throw new TypeError('BROKER_CONFIG_INVALID');
  let server, admitting = false, draining = false, closed = false, uncertain = false, closeError = null;
  const sockets = new Set(), sessions = new Set();
  let drainResolve, drainReject, drainPromise;
  function settleDrain() {
    if (!draining || !drainResolve) return;
    if (uncertain) { drainReject(new Error('BROKER_DRAIN_UNCERTAIN')); drainResolve = null; return; }
    if (sockets.size === 0 && [...sessions].every(s => s.acked && s.eof && !s.operation)) {
      drainResolve({ closed: true }); drainResolve = null;
    }
  }
  function failSession(s) {
    if (s && !(s.acked && s.eof && !s.operation)) uncertain = true;
    settleDrain();
  }
  function reject(socket, writer, code) {
    try { writer.send({ type: 'ERROR', code }); socket.end(); } catch { socket.destroy(); }
  }
  function sessionConnection(socket) {
    const decoder = new FrameDecoder(), writer = new FrameWriter(socket);
    let session = null, helloTimer = setTimeout(() => socket.destroy(), TIMEOUT), fragmentTimer = null;
    const clearFragment = () => { clearTimeout(fragmentTimer); fragmentTimer = null; };
    socket.on('data', chunk => {
      let messages;
      try { messages = decoder.push(chunk); } catch { reject(socket, writer, 'INVALID_FRAME'); return; }
      if (messages.length > 8) { socket.destroy(); return; }
      if (messages.length) clearFragment();
      if (decoder.pendingBytes) {
        if (!fragmentTimer) fragmentTimer = setTimeout(() => socket.destroy(), TIMEOUT);
      } else clearFragment();
      for (const message of messages) {
        if (!session) {
          if (message.type !== 'HELLO' || !admitting || draining || message.boot !== boot || !sameProfile(message.perfil, perfil)) {
            reject(socket, writer, admitting ? 'UNAUTHORIZED' : 'ADMISSION_CLOSED'); return;
          }
          let auth;
          try { auth = authorizeHello({ clientId: message.clientId, credential: message.credential }); } catch { auth = null; }
          if (denied(auth)) { reject(socket, writer, 'UNAUTHORIZED'); return; }
          clearTimeout(helloTimer);
          session = { socket, writer, sessionId: randomUUID(), clientId: message.clientId, revision: auth.revision,
            operation: null, acked: false, eof: false, sentDrain: false };
          sessions.add(session);
          try { writer.send({ type: 'GRANT', sessionId: session.sessionId, boot, perfil, revision: session.revision, nonce: message.nonce }); }
          catch { socket.destroy(); return; }
          continue;
        }
        if (message.sessionId !== session.sessionId || message.boot !== boot) { reject(socket, writer, 'STALE_SESSION'); return; }
        if (message.type === 'BEGIN') {
          if (!admitting) { reject(socket, writer, 'ADMISSION_CLOSED'); return; }
          if (draining || session.operation || session.acked) { reject(socket, writer, 'BUSY'); return; }
          let auth;
          try { auth = authorizeBegin({ clientId: session.clientId, revision: session.revision }); } catch { auth = null; }
          if (denied(auth) || auth.revision !== session.revision) { reject(socket, writer, 'UNAUTHORIZED'); return; }
          session.operation = message.requestId;
          try { writer.send({ type: 'BEGIN_OK', sessionId: session.sessionId, boot, requestId: message.requestId }); }
          catch { socket.destroy(); }
        } else if (message.type === 'END') {
          if (session.operation !== message.requestId) { reject(socket, writer, 'STALE_SESSION'); return; }
          try { writer.send({ type: 'END_OK', sessionId: session.sessionId, boot, requestId: message.requestId }); }
          catch { socket.destroy(); return; }
          session.operation = null; settleDrain();
        } else if (message.type === 'CLOSED') {
          if (session.operation || session.acked) { reject(socket, writer, 'BUSY'); return; }
          session.acked = true; socket.end();
        } else { reject(socket, writer, 'INVALID_MESSAGE'); return; }
      }
    });
    socket.on('end', () => { if (session) { session.eof = true; failSession(session); } });
    socket.on('close', () => {
      clearTimeout(helloTimer); clearFragment(); sockets.delete(socket);
      if (session) { failSession(session); sessions.delete(session); }
      settleDrain();
    });
    socket.on('error', () => {});
  }
  async function start() {
    if (server || closed) throw new Error('BROKER_ALREADY_STARTED');
    server = tls.createServer({ key: identity.privateKey, cert: identity.certPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
      handshakeTimeout: TIMEOUT, requestCert: false }, sessionConnection);
    server.on('connection', socket => {
      if (sockets.size >= 16 || draining) { socket.destroy(); return; }
      sockets.add(socket);
      socket.on('close', () => { sockets.delete(socket); settleDrain(); });
    });
    server.on('tlsClientError', () => {});
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
    } catch (error) { server.close(); server = null; throw error; }
    return { port: server.address().port };
  }
  function admit() {
    if (!server || draining || closed) throw new Error('BROKER_ADMISSION_CLOSED');
    admitting = true;
  }
  function stopAdmission() { admitting = false; }
  function drain({ timeoutMs = 5000 } = {}) {
    if (!server) throw new Error('BROKER_NOT_STARTED');
    if (drainPromise) return drainPromise;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('BROKER_TIMEOUT_INVALID');
    stopAdmission(); draining = true;
    drainPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { uncertain = true; drainResolve = null; reject(new Error('BROKER_DRAIN_UNCERTAIN')); }, timeoutMs);
      drainResolve = value => { clearTimeout(timer); resolve(value); };
      drainReject = error => { clearTimeout(timer); reject(error); };
    });
    for (const s of sessions) {
      if (s.acked) continue;
      s.sentDrain = true;
      try { s.writer.send({ type: 'DRAIN', sessionId: s.sessionId, boot }); } catch { s.socket.destroy(); }
    }
    settleDrain();
    return drainPromise;
  }
  async function close() {
    if (closed) { if (closeError) throw closeError; return; }
    let error;
    if (server) {
      try { await drain(); } catch (cause) { error = cause; for (const socket of sockets) socket.destroy(); }
      await new Promise(resolve => server.close(resolve));
    }
    closed = true;
    closeError = error;
    if (error) throw error;
  }
  return { start, admit, stopAdmission, drain, close };
}

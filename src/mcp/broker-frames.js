import { TextDecoder } from 'node:util';

export const MAX_FRAME = 8192;
export const MAX_QUEUE = 8;
export const MAX_QUEUED_BYTES = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const profileKeys = ['tipo', 'id', 'geracao'];
const fields = {
  HELLO: ['type', 'protocol', 'clientId', 'credential', 'boot', 'perfil', 'nonce'],
  GRANT: ['type', 'sessionId', 'boot', 'perfil', 'revision', 'nonce'],
  BEGIN: ['type', 'sessionId', 'boot', 'requestId'], BEGIN_OK: ['type', 'sessionId', 'boot', 'requestId'],
  END: ['type', 'sessionId', 'boot', 'requestId'], END_OK: ['type', 'sessionId', 'boot', 'requestId'],
  DRAIN: ['type', 'sessionId', 'boot'], CLOSED: ['type', 'sessionId', 'boot'],
  ERROR: ['type', 'code']
};
const errorCodes = new Set(['INVALID_FRAME', 'INVALID_MESSAGE', 'UNAUTHORIZED', 'ADMISSION_CLOSED', 'STALE_SESSION', 'BUSY', 'INTERNAL']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const smallString = (value, max = 512) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max;
export const isUuid = value => typeof value === 'string' && UUID.test(value);
export function sameProfile(a, b) {
  return exact(a, profileKeys) && exact(b, profileKeys) && profileKeys.every(key => a[key] === b[key]);
}
export function validProfile(p) {
  return exact(p, profileKeys) && smallString(p.tipo, 64) && smallString(p.id, 256) &&
    (p.geracao === null || (Number.isSafeInteger(p.geracao) && p.geracao >= 0) || smallString(p.geracao, 64));
}
export function validateMessage(value) {
  if (!plain(value) || !Object.hasOwn(fields, value.type) || !exact(value, fields[value.type])) return false;
  if (value.type === 'ERROR') return errorCodes.has(value.code);
  if (!isUuid(value.boot)) return false;
  if (value.type === 'HELLO') return value.protocol === 1 && value.clientId === 'claude-desktop' &&
    typeof value.credential === 'string' && Buffer.byteLength(value.credential, 'utf8') >= 32 &&
    Buffer.byteLength(value.credential, 'utf8') <= 512 && validProfile(value.perfil) && isUuid(value.nonce);
  if (!isUuid(value.sessionId)) return false;
  if (value.type === 'GRANT') return validProfile(value.perfil) && isUuid(value.revision) && isUuid(value.nonce);
  if (['BEGIN', 'BEGIN_OK', 'END', 'END_OK'].includes(value.type)) return isUuid(value.requestId);
  return true;
}
export function encodeFrame(value) {
  if (!validateMessage(value)) throw new Error('BROKER_INVALID_MESSAGE');
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length < 1 || body.length > MAX_FRAME) throw new Error('BROKER_FRAME_SIZE');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0); body.copy(frame, 4);
  return frame;
}
function assertUniqueKeys(source) {
  let at = 0;
  const space = () => { while (/\s/.test(source[at] ?? '') && at < source.length) at++; };
  function string() {
    const start = at++;
    while (at < source.length) {
      if (source[at] === '\\') { at += 2; continue; }
      if (source[at++] === '"') return JSON.parse(source.slice(start, at));
    }
    throw new Error('BROKER_INVALID_JSON');
  }
  function value(depth) {
    space();
    if (source[at] === '{') {
      if (depth > 2) throw new Error('BROKER_INVALID_JSON');
      at++; space(); const keys = new Set();
      if (source[at] === '}') { at++; return; }
      for (;;) {
        space(); if (source[at] !== '"') throw new Error('BROKER_INVALID_JSON');
        const key = string();
        if (keys.has(key)) throw new Error('BROKER_DUPLICATE_KEY');
        keys.add(key); space();
        if (source[at++] !== ':') throw new Error('BROKER_INVALID_JSON');
        value(depth + 1); space();
        const next = source[at++];
        if (next === '}') return;
        if (next !== ',') throw new Error('BROKER_INVALID_JSON');
      }
    }
    if (source[at] === '"') { string(); return; }
    if (source[at] === '[') throw new Error('BROKER_INVALID_JSON');
    const start = at;
    while (at < source.length && source[at] !== ',' && source[at] !== '}') at++;
    if (start === at) throw new Error('BROKER_INVALID_JSON');
  }
  value(0); space();
  if (at !== source.length) throw new Error('BROKER_INVALID_JSON');
}
export class FrameDecoder {
  #chunks = []; #size = 0;
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new Error('BROKER_INVALID_FRAME');
    if (this.#size + chunk.length > MAX_QUEUED_BYTES) throw new Error('BROKER_BUFFER_LIMIT');
    if (chunk.length) { this.#chunks.push(chunk); this.#size += chunk.length; }
    const frames = [];
    while (this.#size >= 4) {
      const joined = Buffer.concat(this.#chunks, this.#size);
      const length = joined.readUInt32BE(0);
      if (length < 1 || length > MAX_FRAME) throw new Error('BROKER_FRAME_SIZE');
      if (joined.length < length + 4) break;
      const body = joined.subarray(4, length + 4);
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { throw new Error('BROKER_INVALID_UTF8'); }
      let value;
      try { value = JSON.parse(content); } catch { throw new Error('BROKER_INVALID_JSON'); }
      assertUniqueKeys(content);
      if (!validateMessage(value)) throw new Error('BROKER_INVALID_MESSAGE');
      frames.push(value);
      const rest = joined.subarray(length + 4);
      this.#chunks = rest.length ? [rest] : []; this.#size = rest.length;
    }
    return frames;
  }
  get pendingBytes() { return this.#size; }
}

export class FrameWriter {
  #socket; #queue = []; #queuedBytes = 0; #blocked = false; #closed = false;
  constructor(socket) {
    this.#socket = socket;
    socket.on('drain', () => { this.#blocked = false; this.#flush(); });
    socket.on('close', () => { this.#closed = true; this.#queue = []; this.#queuedBytes = 0; });
  }
  send(value) {
    const frame = encodeFrame(value);
    if (this.#closed || this.#socket.destroyed) throw new Error('BROKER_CHANNEL_LOST');
    if (this.#queue.length >= MAX_QUEUE || this.#queuedBytes + frame.length > MAX_QUEUED_BYTES) {
      this.#socket.destroy(); throw new Error('BROKER_OUTPUT_LIMIT');
    }
    this.#queue.push(frame); this.#queuedBytes += frame.length; this.#flush();
  }
  #flush() {
    while (!this.#blocked && this.#queue.length && !this.#socket.destroyed) {
      const frame = this.#queue.shift(); this.#queuedBytes -= frame.length;
      this.#blocked = !this.#socket.write(frame);
    }
  }
  get queuedFrames() { return this.#queue.length; }
}

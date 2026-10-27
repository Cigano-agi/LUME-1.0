import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { encodeFrame, FrameDecoder, FrameWriter, MAX_FRAME } from '../src/mcp/broker-frames.js';

const boot = '11111111-1111-4111-8111-111111111111';
const message = { type: 'DRAIN', sessionId: '22222222-2222-4222-8222-222222222222', boot };
test('frames fragmentados e múltiplos preservam ordem', () => {
  const decoder = new FrameDecoder(), frame = encodeFrame(message);
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2, 7)), []);
  assert.deepEqual(decoder.push(Buffer.concat([frame.subarray(7), frame])), [message, message]);
});
test('rejeita comprimento, JSON, UTF8, schema aberto e buffer sem limite', () => {
  const badLength = Buffer.alloc(4); badLength.writeUInt32BE(MAX_FRAME + 1);
  assert.throws(() => new FrameDecoder().push(badLength));
  const make = body => { const head = Buffer.alloc(4); head.writeUInt32BE(body.length); return Buffer.concat([head, body]); };
  assert.throws(() => new FrameDecoder().push(make(Buffer.from('{'))));
  assert.throws(() => new FrameDecoder().push(make(Buffer.from([0xff]))));
  assert.throws(() => new FrameDecoder().push(make(Buffer.from('{"type":"DRAIN","type":"DRAIN","sessionId":"22222222-2222-4222-8222-222222222222","boot":"11111111-1111-4111-8111-111111111111"}'))), /DUPLICATE/);
  assert.throws(() => encodeFrame({ ...message, extra: true }));
  assert.throws(() => new FrameDecoder().push(Buffer.alloc(65537)));
});
test('saída bloqueada tem fila máxima e destrói canal em excesso', () => {
  class Socket extends EventEmitter { destroyed = false; write() { return false; } destroy() { this.destroyed = true; this.emit('close'); } }
  const socket = new Socket(), writer = new FrameWriter(socket);
  for (let i = 0; i < 9; i++) writer.send(message);
  assert.equal(writer.queuedFrames, 8);
  assert.throws(() => writer.send(message), /BROKER_OUTPUT_LIMIT/);
  assert.equal(socket.destroyed, true);
});

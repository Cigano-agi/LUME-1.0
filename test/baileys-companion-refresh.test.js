import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const baileysDir = new URL('../node_modules/@whiskeysockets/baileys/lib/', import.meta.url);
const utils = await import(new URL('Utils/companion-reg-client-utils.js', baileysDir));

const notification = (child = 'companion_reg_refresh') => ({
  tag: 'notification', attrs: { type: 'companion_reg_refresh' },
  content: child ? [{ tag: child, attrs: {} }] : []
});

test('refresh rotates the unpaired secret and redraws the same QR reference', () => {
  const refs = ['current', 'next'];
  const creds = { advSecretKey: randomBytes(32).toString('base64') };
  const rendered = [];
  const updates = [];
  const renderer = utils.makePairingQRRenderer(refs, ref => rendered.push([ref, creds.advSecretKey]));
  assert.equal(renderer.next(), true);
  const originalSecret = creds.advSecretKey;
  assert.equal(utils.handleCompanionRegRefresh(notification(), {
    creds, emitCredsUpdate: update => updates.push(update),
    refreshQR: () => renderer.refresh(), logger: { warn() {}, debug() {}, info() {} }
  }), 'rotated');
  assert.notEqual(creds.advSecretKey, originalSecret);
  assert.equal(Buffer.from(creds.advSecretKey, 'base64').length, 32);
  assert.deepEqual(updates, [{ advSecretKey: creds.advSecretKey }]);
  assert.deepEqual(rendered.map(([ref]) => ref), ['current', 'current']);
  assert.equal(renderer.next(), true);
  assert.equal(rendered.at(-1)[0], 'next');
});

test('malformed or registered notifications keep the existing secret', () => {
  for (const [node, registered, expected] of [
    [notification(null), false, 'ignored_malformed'],
    [notification(), true, 'ignored_registered']
  ]) {
    const creds = { advSecretKey: 'unchanged', ...(registered ? { me: { id: 'registered' } } : {}) };
    let updates = 0; let redraws = 0;
    const outcome = utils.handleCompanionRegRefresh(node, {
      creds, emitCredsUpdate: () => updates++, refreshQR: () => redraws++,
      logger: { warn() {}, debug() {}, info() {} }
    });
    assert.equal(outcome, expected);
    assert.equal(creds.advSecretKey, 'unchanged');
    assert.equal(updates, 0);
    assert.equal(redraws, 0);
  }
});

test('socket routes the notification to the refresh handler', () => {
  const socket = readFileSync(new URL('Socket/socket.js', baileysDir), 'utf8');
  assert.match(socket, /CB:notification,type:companion_reg_refresh/);
  assert.match(socket, /handleCompanionRegRefresh\(node/);
  assert.match(socket, /refreshPairingQR\?\.\(\)/);
});

test('pre-login notification can be acknowledged without a registered device', async () => {
  const source = readFileSync(new URL('Socket/messages-recv.js', baileysDir), 'utf8');
  assert.match(source, /buildAckStanza\(node, errorCode, authState\.creds\.me\?\.id\)/);
  const { buildAckStanza } = await import(new URL('Utils/stanza-ack.js', baileysDir));
  assert.deepEqual(buildAckStanza({
    tag: 'notification', attrs: { id: 'test', from: 's.whatsapp.net', type: 'companion_reg_refresh' }
  }, undefined, undefined), {
    tag: 'ack', attrs: { id: 'test', to: 's.whatsapp.net', class: 'notification', type: 'companion_reg_refresh' }
  });
});

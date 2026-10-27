import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { createBootIdentity } from '../src/mcp/broker-identity.js';

test('identidade TLS de boot é nova, pinada e válida para lume.local', async () => {
  const first = await createBootIdentity();
  const second = await createBootIdentity();
  assert.equal(first.servername, 'lume.local');
  assert.deepEqual(Object.keys(first).sort(), ['certPem', 'pin', 'privateKey', 'servername']);
  assert.notEqual(first.certPem, second.certPem);
  assert.notEqual(first.privateKey, second.privateKey);
  const cert = new X509Certificate(first.certPem);
  assert.equal(cert.checkHost('lume.local'), 'lume.local');
  assert.equal(cert.checkHost('other.local'), undefined);
  assert.equal(cert.subjectAltName, 'DNS:lume.local');
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(cert.ca, false);
  assert.ok(cert.verify(cert.publicKey));
  assert.equal(first.pin, createHash('sha256').update(cert.raw).digest('hex'));
  assert.match(first.privateKey, /BEGIN PRIVATE KEY/);
  assert.ok(Date.parse(cert.validFrom) < Date.now());
  assert.ok(Date.parse(cert.validTo) > Date.now() + 300 * 86400000);
});

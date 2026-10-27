import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, X509Certificate as NodeCertificate } from 'node:crypto';
import { X509Certificate as ParsedCertificate } from '@peculiar/x509';
import { createBootIdentity } from '../src/mcp/broker-identity.js';

const BOOT = new Date('2026-09-27T12:00:00.000Z');
const DAY = 86_400_000;

test('certificado de boot codifica algoritmo, serial novo, prazo e extensões exigidas', async () => {
  const [first, second] = await Promise.all([
    createBootIdentity({ now: BOOT }),
    createBootIdentity({ now: BOOT })
  ]);
  const cert = new NodeCertificate(first.certPem);
  const parsed = new ParsedCertificate(first.certPem);
  const extensions = new Map(parsed.extensions.map(extension => [extension.type, extension]));

  assert.equal(cert.publicKey.asymmetricKeyType, 'ec');
  assert.equal(cert.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.deepEqual(parsed.signatureAlgorithm, { name: 'ECDSA', hash: { name: 'SHA-256' } });
  assert.match(cert.serialNumber, /^[0-9A-F]{2,}$/);
  assert.notEqual(cert.serialNumber, new NodeCertificate(second.certPem).serialNumber);
  assert.equal(Date.parse(cert.validFrom), BOOT.getTime() - 5 * 60_000);
  assert.equal(Date.parse(cert.validTo), BOOT.getTime() + 365 * DAY);

  assert.deepEqual([...extensions.keys()].sort(), ['2.5.29.15', '2.5.29.17', '2.5.29.19', '2.5.29.37']);
  for (const extension of extensions.values()) assert.equal(extension.critical, true);
  assert.equal(cert.ca, false);
  assert.equal(cert.subjectAltName, 'DNS:lume.local');
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.match(String(extensions.get('2.5.29.15')), /digitalSignature/);
  assert.equal(cert.checkHost('lume.local'), 'lume.local');
  assert.equal(cert.checkHost('wrong.local'), undefined);
  assert.equal(cert.verify(cert.publicKey), true);
  const privateKey = createPrivateKey(first.privateKey);
  assert.equal(privateKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(cert.checkPrivateKey(privateKey), true);
  assert.equal(first.pin, createHash('sha256').update(cert.raw).digest('hex'));
  assert.equal(first.certPem.includes('PRIVATE KEY'), false);
});

test('relógio inválido recusa identidade sem material parcial', async () => {
  await assert.rejects(createBootIdentity({ now: new Date(NaN) }), { message: 'BROKER_CLOCK_INVALID' });
});

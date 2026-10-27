import 'reflect-metadata';
import { createHash, webcrypto, X509Certificate } from 'node:crypto';
import {
  BasicConstraintsExtension, ExtendedKeyUsage, ExtendedKeyUsageExtension,
  KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension,
  X509CertificateGenerator
} from '@peculiar/x509';

const SERVERNAME = 'lume.local';
const DAY = 86400000;

function pemPrivate(der) {
  const encoded = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----\n`;
}

export async function createBootIdentity({ now = () => new Date() } = {}) {
  const current = typeof now === 'function' ? now() : now;
  const at = current instanceof Date ? current.getTime() : NaN;
  if (!Number.isFinite(at)) throw new TypeError('BROKER_CLOCK_INVALID');

  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: `CN=${SERVERNAME}`,
    notBefore: new Date(at - 5 * 60000),
    notAfter: new Date(at + 365 * DAY),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth], true),
      new SubjectAlternativeNameExtension([{ type: 'dns', value: SERVERNAME }], true)
    ]
  }, webcrypto);
  const certPem = certificate.toString('pem');
  const cert = new X509Certificate(certPem);
  if (cert.ca || cert.checkHost(SERVERNAME) !== SERVERNAME) throw new Error('BROKER_CERT_INVALID');
  const privateKey = pemPrivate(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const pin = createHash('sha256').update(cert.raw).digest('hex');
  return { certPem, privateKey, pin, servername: SERVERNAME };
}

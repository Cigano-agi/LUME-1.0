import test from 'node:test';
import assert from 'node:assert/strict';
import { createBootIdentity } from '../src/mcp/broker-identity.js';
import { validateBrokerDescriptor } from '../src/mcp/broker-bootstrap.js';

const selection = { tipo: 'legado', id: 'legado', geracao: null };
const boot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function descriptor(identity) {
  return { schema: 1, boot, perfil: selection, port: 41234, certPem: identity.certPem, pin: identity.pin };
}

test('descriptor não aceita certificado fora da janela de validade nem revela material no erro', async () => {
  for (const now of [new Date('2020-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z')]) {
    const identity = await createBootIdentity({ now });
    assert.throws(() => validateBrokerDescriptor(descriptor(identity), selection), error => {
      assert.equal(error.code, 'BROKER_BOOTSTRAP_UNTRUSTED');
      assert.equal(error.message, 'BROKER_BOOTSTRAP_UNTRUSTED');
      assert.equal(error.message.includes(identity.certPem), false);
      return true;
    });
  }
});

test('descriptor público recusa campos de autoridade e schema aberto', async () => {
  const identity = await createBootIdentity();
  const value = descriptor(identity);
  for (const extra of [
    { credential: 'synthetic-test-credential' },
    { privateKey: identity.privateKey },
    { grant: { revision: boot } },
    { dataDir: 'synthetic-data-dir' }
  ]) {
    assert.throws(() => validateBrokerDescriptor({ ...value, ...extra }, selection), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
  }
});

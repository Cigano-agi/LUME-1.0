import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBootIdentity } from '../src/mcp/broker-identity.js';
import { createProfileBroker } from '../src/mcp/profile-broker.js';
import { connectProfileBroker } from '../src/mcp/profile-broker-client.js';

const selection = { tipo: 'legado', id: 'legado', geracao: null };
const credential = 'synthetic-review-credential-00000000';

test('stopAdmission recusa BEGIN novo na sessão já admitida', async () => {
  const identity = await createBootIdentity();
  const boot = randomUUID(), revision = randomUUID();
  const broker = createProfileBroker({ selection, boot, identity,
    authorizeHello: () => ({ revision }), authorizeBegin: () => ({ revision }) });
  const { port } = await broker.start();
  broker.admit();
  const descriptor = { schema: 1, boot, perfil: selection, port, certPem: identity.certPem, pin: identity.pin };
  const client = await connectProfileBroker({ descriptor, selection, clientId: 'claude-desktop', credential });
  broker.stopAdmission();
  let outcome;
  try {
    const receipt = await client.begin();
    outcome = 'granted';
    await client.end(receipt);
  } catch {
    outcome = 'denied';
  }
  try { await client.closeAfterDb(); } catch { /* recusa pode encerrar o canal */ }
  try { await broker.close(); } catch { /* sessão recusada permanece incerta */ }
  assert.equal(outcome, 'denied', 'corte de admissão deve bloquear novos BEGIN');
});

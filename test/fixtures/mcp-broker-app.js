import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyClaudeActivation, authorizeClaudeBrokerHello, authorizeClaudeBrokerBegin } from '../../src/mcp/activation.js';
import { createBootIdentity } from '../../src/mcp/broker-identity.js';
import { createProfileBroker } from '../../src/mcp/profile-broker.js';
import { publishBrokerDescriptor } from '../../src/mcp/broker-bootstrap.js';

export const fixtureCredential = 'codigo-de-ativacao-local-com-mais-de-32-caracteres';
export const legacyProfile = { tipo: 'legado', id: 'legado', geracao: null };

export function brokerTestUserData(t) {
  const userData = mkdtempSync(join(homedir(), 'lume-mcp-broker-test-'));
  t.after(async () => {
    const { rmSync } = await import('node:fs');
    rmSync(userData, { recursive: true, force: true });
  });
  return userData;
}

export async function startBrokerApp(t, { userData, credential = fixtureCredential, scope = { kind: 'all' }, activate = true, onHello, publishDescriptor = publishBrokerDescriptor } = {}) {
  if (!userData) userData = brokerTestUserData(t);
  const dataDir = join(userData, 'data');
  mkdirSync(dataDir, { recursive: true });
  const activationPath = join(dataDir, 'mcp', 'claude-desktop.json');
  if (activate) applyClaudeActivation({ activationPath, scope, credential });
  const identity = await createBootIdentity({}), boot = randomUUID();
  const broker = createProfileBroker({
    selection: legacyProfile, boot, identity,
    authorizeHello: request => { onHello?.(request); return authorizeClaudeBrokerHello({ activationPath, ...request }); },
    authorizeBegin: request => authorizeClaudeBrokerBegin({ activationPath, ...request })
  });
  const { port } = await broker.start();
  let published;
  try {
    published = await publishDescriptor({ userData, selection: legacyProfile, boot, port, identity });
    broker.admit();
  } catch (error) {
    try { await broker.close(); } catch { /* preserve the publication failure */ }
    try { await published?.release(); } catch { /* preserve the publication failure */ }
    throw error;
  }
  t.after(async () => {
    try { await broker.close(); } catch {}
    try { await published.release(); } catch {}
  });
  return { userData, dataDir, activationPath, broker, ...published };
}

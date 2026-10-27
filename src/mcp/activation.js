import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CLAUDE_DESKTOP_CLIENT_ID = 'claude-desktop';
const CLIENTS = Object.freeze([
  Object.freeze({ id: CLAUDE_DESKTOP_CLIENT_ID, name: 'Claude Desktop', available: true, transport: 'stdio' }),
  Object.freeze({ id: 'chatgpt', name: 'ChatGPT', available: false, reason: 'Integração local ainda não disponível pelo caminho oficial.' })
]);

const hashCredential = value => createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cleanIds = value => [...new Set(value)].sort();
const equal = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('Escolha o que o assistente pode consultar.');
  if (scope.kind === 'all') return { kind: 'all' };
  if (scope.kind === 'today' && typeof scope.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(scope.date)) return { kind: 'today', date: scope.date };
  if (['projects', 'conversations'].includes(scope.kind) && Array.isArray(scope.ids) && scope.ids.length > 0 && scope.ids.length <= 100 && scope.ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)) return { kind: scope.kind, ids: cleanIds(scope.ids) };
  throw new TypeError('Esse recorte de consulta não é válido.');
}

function readDescriptor(path) {
  if (!existsSync(path)) return null;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('A configuração anterior do assistente está danificada.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.client_id !== CLAUDE_DESKTOP_CLIENT_ID || typeof value.credential_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.credential_hash) || !UUID.test(value.revision) || typeof value.enabled !== 'boolean' || typeof value.token_secret !== 'string' || Buffer.from(value.token_secret, 'base64url').length < 32) throw new Error('A configuração anterior do assistente é incompatível.');
  return { ...value, scope: normalizeScope(value.scope) };
}

function sameScope(a, b) { return JSON.stringify(normalizeScope(a)) === JSON.stringify(normalizeScope(b)); }

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function backup(path) {
  if (!existsSync(path)) return false;
  copyFileSync(path, `${path}.bak`);
  return true;
}

export function listMcpClients() { return CLIENTS.map(client => ({ ...client })); }

// These synchronous checks run inside the broker's HELLO/BEGIN callbacks.
// They deliberately disclose only the current revision to the broker.
export function authorizeClaudeBrokerHello({ activationPath, clientId, credential } = {}) {
  if (clientId !== CLAUDE_DESKTOP_CLIENT_ID || typeof credential !== 'string' || !credential) return null;
  try {
    const current = readDescriptor(activationPath);
    return current?.enabled && equal(current.credential_hash, hashCredential(credential)) ? { revision: current.revision } : null;
  } catch { return null; }
}

export function authorizeClaudeBrokerBegin({ activationPath, clientId, revision } = {}) {
  if (clientId !== CLAUDE_DESKTOP_CLIENT_ID || !UUID.test(revision)) return null;
  try {
    const current = readDescriptor(activationPath);
    return current?.enabled && equal(current.revision, revision) ? { revision: current.revision } : null;
  } catch { return null; }
}

export function readClaudeActivationForClient({ activationPath, clientId, credential, revision } = {}) {
  if (clientId !== CLAUDE_DESKTOP_CLIENT_ID || typeof credential !== 'string' || !credential) return null;
  try {
    const current = readDescriptor(activationPath);
    if (!current?.enabled || !equal(current.credential_hash, hashCredential(credential)) ||
        (revision !== undefined && !equal(current.revision, revision))) return null;
    return { revision: current.revision, scope: current.scope, credentialHash: current.credential_hash, secret: Buffer.from(current.token_secret, 'base64url') };
  } catch { return null; }
}

// Internal task-grant binding only; never returns the activation code or secret.
export function getClaudeActivationRevision({activationPath}={}) {
  try {const current=readDescriptor(activationPath);return current?.enabled?current.revision:null;}
  catch {return null;}
}

export function getClaudeActivationState({ activationPath } = {}) {
  if (typeof activationPath !== 'string' || !activationPath) throw new TypeError('Destino da ativação obrigatório.');
  try {
    const current = readDescriptor(activationPath);
    if (!current) return { client: CLAUDE_DESKTOP_CLIENT_ID, configured: false, enabled: false, scope: null, problem: null };
    return {
      client: CLAUDE_DESKTOP_CLIENT_ID,
      configured: true,
      enabled: current.enabled,
      scope: current.enabled ? current.scope : null,
      problem: null
    };
  } catch {
    return { client: CLAUDE_DESKTOP_CLIENT_ID, configured: true, enabled: false, scope: null, problem: 'A ativação precisa ser refeita.' };
  }
}

export function previewClaudeActivation({ activationPath, scope, rotate = false } = {}) {
  if (typeof activationPath !== 'string' || !activationPath) throw new TypeError('Destino da ativação obrigatório.');
  const nextScope = normalizeScope(scope), current = readDescriptor(activationPath);
  const unchanged = Boolean(current?.enabled && !rotate && sameScope(current.scope, nextScope));
  return {
    client: CLAUDE_DESKTOP_CLIENT_ID,
    action: unchanged ? 'none' : current ? current.enabled ? rotate ? 'rotate' : 'update-scope' : 'enable' : 'enable',
    will_backup: Boolean(current && !unchanged),
    requires_new_code: !current || rotate || !current.enabled,
    scope: nextScope,
    disclosure: 'Os trechos consultados serão processados pelo Claude conforme a conta escolhida. O assistente pode consultar fontes e registrar progresso e resultado apenas nas execuções autorizadas por você no Lume. O acesso pode ser desligado a qualquer momento.'
  };
}

export function applyClaudeActivation({ activationPath, scope, rotate = false, credential } = {}) {
  const preview = previewClaudeActivation({ activationPath, scope, rotate });
  const current = readDescriptor(activationPath);
  if (preview.action === 'none') return { ...preview, enabled: true, changed: false, activation_code: null, backup_created: false };
  const generated = typeof credential === 'string' && credential.length >= 32 ? credential : randomBytes(32).toString('base64url');
  const credentialHash = current && !preview.requires_new_code ? current.credential_hash : hashCredential(generated);
  const descriptor = {
    client_id: CLAUDE_DESKTOP_CLIENT_ID,
    credential_hash: credentialHash,
    revision: randomUUID(),
    enabled: true,
    scope: preview.scope,
    token_secret: current?.token_secret || randomBytes(32).toString('base64url')
  };
  const backupCreated = backup(activationPath);
  atomicJson(activationPath, descriptor);
  return { ...preview, enabled: true, changed: true, activation_code: preview.requires_new_code ? generated : null, backup_created: backupCreated };
}

export function revokeClaudeActivation({ activationPath } = {}) {
  if (typeof activationPath !== 'string' || !activationPath) throw new TypeError('Destino da ativação obrigatório.');
  const current = readDescriptor(activationPath);
  if (!current || !current.enabled) return { client: CLAUDE_DESKTOP_CLIENT_ID, enabled: false, changed: false, backup_created: false };
  const backupCreated = backup(activationPath);
  atomicJson(activationPath, { ...current, enabled: false, revision: randomUUID() });
  return { client: CLAUDE_DESKTOP_CLIENT_ID, enabled: false, changed: true, backup_created: backupCreated };
}

export function verifyClaudeActivationCode({ activationPath, credential } = {}) {
  if (typeof credential !== 'string' || !credential) return false;
  try {
    const current = readDescriptor(activationPath);
    return Boolean(current?.enabled && equal(current.credential_hash, hashCredential(credential)));
  } catch { return false; }
}

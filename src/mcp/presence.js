import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const LUME_PRESENCE_INTERVAL_MS = 2000;
export const LUME_PRESENCE_STALE_MS = 8000;
export const lumePresencePath = dataDir => join(dataDir, 'mcp', 'app-presence.json');

function closed() {
  const error = new Error('LUME_CLOSED');
  error.code = 'LUME_CLOSED';
  return error;
}

function atomicPresence(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function processRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export function assertLumeAppPresence({ presencePath, now = () => Date.now(), isProcessRunning = processRunning, staleMs = LUME_PRESENCE_STALE_MS } = {}) {
  if (typeof presencePath !== 'string' || !presencePath || !existsSync(presencePath)) throw closed();
  let value;
  try { value = JSON.parse(readFileSync(presencePath, 'utf8')); } catch { throw closed(); }
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  if (keys !== 'instance_id,pid,schema,started_at,updated_at' || value.schema !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.instance_id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.instance_id) || !Number.isSafeInteger(value.started_at) || !Number.isSafeInteger(value.updated_at)) throw closed();
  const current = now();
  if (!Number.isFinite(current) || value.started_at > value.updated_at || value.updated_at > current + staleMs || current - value.updated_at > staleMs || !isProcessRunning(value.pid)) throw closed();
  return true;
}

export function startLumeAppPresence({ dataDir, now = () => Date.now(), pid = process.pid, intervalMs = LUME_PRESENCE_INTERVAL_MS, schedule = setInterval, cancel = clearInterval } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Diretório de dados obrigatório.');
  const path = lumePresencePath(dataDir), instanceId = randomUUID(), startedAt = now();
  const beat = () => atomicPresence(path, { schema: 1, instance_id: instanceId, pid, started_at: startedAt, updated_at: now() });
  try { beat(); } catch { return { active: false, stop() {} }; }
  const timer = schedule(() => { try { beat(); } catch {} }, intervalMs);
  timer?.unref?.();
  return {
    active: true,
    stop() {
      cancel(timer);
      try {
        const current = JSON.parse(readFileSync(path, 'utf8'));
        if (current?.instance_id === instanceId && current?.pid === pid) rmSync(path, { force: true });
      } catch {}
    }
  };
}

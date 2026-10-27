import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLumeAppPresence, lumePresencePath, startLumeAppPresence } from '../src/mcp/presence.js';

const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'lume-presence-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const closed = fn => assert.throws(fn, error => error?.code === 'LUME_CLOSED' && error.message === 'LUME_CLOSED');

test('presença local nasce ativa e some assim que o Lume fecha', t => {
  const dataDir = temp(t), path = lumePresencePath(dataDir);
  const presence = startLumeAppPresence({ dataDir });
  assert.equal(presence.active, true);
  assert.equal(assertLumeAppPresence({ presencePath: path }), true);
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(disk).sort(), ['instance_id', 'pid', 'schema', 'started_at', 'updated_at']);
  assert.equal(JSON.stringify(disk).includes(dataDir), false);
  presence.stop();
  assert.equal(existsSync(path), false);
  closed(() => assertLumeAppPresence({ presencePath: path }));
});

test('arquivo velho, processo morto, futuro e conteúdo adulterado falham fechados', t => {
  const dataDir = temp(t), path = lumePresencePath(dataDir), now = 10_000;
  const base = { schema: 1, instance_id: '12345678-1234-4234-8234-123456789012', pid: 123, started_at: 1000, updated_at: 1000 };
  const save = value => { writeFileSync(path, JSON.stringify(value)); };
  startLumeAppPresence({ dataDir }).stop();
  save(base); closed(() => assertLumeAppPresence({ presencePath: path, now: () => now, isProcessRunning: () => true, staleMs: 1000 }));
  save({ ...base, updated_at: now }); closed(() => assertLumeAppPresence({ presencePath: path, now: () => now, isProcessRunning: () => false }));
  save({ ...base, updated_at: now + 9000 }); closed(() => assertLumeAppPresence({ presencePath: path, now: () => now, isProcessRunning: () => true }));
  save({ ...base, updated_at: now, segredo: 'não' }); closed(() => assertLumeAppPresence({ presencePath: path, now: () => now, isProcessRunning: () => true }));
});

test('falha ao criar presença não derruba o Lume e mantém MCP fechado', t => {
  const file = join(temp(t), 'arquivo'); writeFileSync(file, 'x');
  const presence = startLumeAppPresence({ dataDir: file });
  assert.equal(presence.active, false);
  closed(() => assertLumeAppPresence({ presencePath: lumePresencePath(file) }));
});

test('gate usa arquivo e PID local, sem servidor ou porta', () => {
  const source = readFileSync(new URL('../src/mcp/presence.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:(?:http|https|net)|createServer\s*\(|\.listen\s*\(/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import fallback from '../desktop/sac-fallback.cjs';
const { brokerBlockedByLocalPolicy } = fallback;

test('MCP only pauses for a local marker tied to the blocked helper hash', () => {
  const resources = mkdtempSync(join(tmpdir(), 'lume-sac-fallback-'));
  assert.equal(brokerBlockedByLocalPolicy(resources, 'win32'), false);
  const helperDir = join(resources, 'app.asar.unpacked', 'native', 'win-acl', 'bin');
  mkdirSync(helperDir, { recursive: true });
  const helper = join(helperDir, 'lume-acl.exe');
  writeFileSync(helper, 'helper under test');
  const marker = join(resources, 'lume-sac-no-mcp.json');
  const value = { schema:1, policyGuid:'{0283ac0f-fff1-49ae-ada1-8a933130cad6}',
    helperSha256:createHash('sha256').update('helper under test').digest('hex') };
  writeFileSync(marker, JSON.stringify(value));
  assert.equal(brokerBlockedByLocalPolicy(resources, 'win32'), true);
  assert.equal(brokerBlockedByLocalPolicy(resources, 'darwin'), false);
  writeFileSync(helper, 'replaced helper');
  assert.throws(() => brokerBlockedByLocalPolicy(resources, 'win32'), { code:'SAC_FALLBACK_INVALIDO' });
  writeFileSync(marker, JSON.stringify({ ...value, policyGuid:'other' }));
  assert.throws(() => brokerBlockedByLocalPolicy(resources, 'win32'), { code:'SAC_FALLBACK_INVALIDO' });
});

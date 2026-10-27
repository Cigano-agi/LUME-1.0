import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const child = fileURLToPath(new URL('./fixtures/mcp-broker-failed-publish-child.mjs', import.meta.url));

test('fixture fecha listener se publicar o broker falhar depois do listen', () => {
  const temp = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(temp, 'lume-broker-cleanup-')));
  const guard = randomUUID();
  writeFileSync(join(root, '.lume-broker-cleanup-test'), guard, { flag: 'wx' });
  try {
    const result = spawnSync(process.execPath, [child, root], {
      encoding: 'utf8', timeout: 7000, windowsHide: true
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PUBLISH_REJECTED_CLEANLY/);
  } finally {
    const actual = realpathSync(root);
    assert.equal(dirname(actual), temp);
    assert.match(basename(actual), /^lume-broker-cleanup-/);
    assert.equal(readFileSync(join(actual, '.lume-broker-cleanup-test'), 'utf8'), guard);
    rmSync(actual, { recursive: true, force: false });
  }
});

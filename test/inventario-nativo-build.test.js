import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('build does not trust an editable exe plus matching local manifest', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'lume-inventory-build-'));
  const temp = path.resolve(os.tmpdir());
  assert.equal(path.dirname(base).toLowerCase(), temp.toLowerCase());
  assert.ok(base.toLowerCase().startsWith(`${temp}${path.sep}lume-inventory-build-`.toLowerCase()));
  t.after(() => rm(base, { recursive: true, force: true }));

  const scriptDir = path.join(base, 'scripts');
  const sourceDir = path.join(base, 'native', 'project-inventory');
  const binDir = path.join(sourceDir, 'bin');
  await mkdir(scriptDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await copyFile(path.join(project, 'scripts', 'build-project-inventory.mjs'), path.join(scriptDir, 'build-project-inventory.mjs'));
  const source = await readFile(path.join(project, 'native', 'project-inventory', 'WindowsInventory.cs'));
  await writeFile(path.join(sourceDir, 'WindowsInventory.cs'), source);

  const fake = Buffer.from('forged-local-executable');
  await writeFile(path.join(binDir, 'lume-project-inventory.exe'), fake);
  await writeFile(path.join(binDir, 'manifest.json'), JSON.stringify({
    schema: 1, platform: 'win32', arch: 'x64', file: 'lume-project-inventory.exe',
    flavor: 'release', sha256: hash(fake), sourceSha256: hash(source)
  }) + '\n');

  const proc = spawnSync(process.execPath, [path.join(scriptDir, 'build-project-inventory.mjs')], {
    cwd: base, encoding: 'utf8', timeout: 30000, windowsHide: true, shell: false
  });
  assert.equal(proc.error, undefined);
  assert.equal(proc.status, 0, proc.stderr);
  const current = await readFile(path.join(binDir, 'lume-project-inventory.exe'));
  assert.notDeepEqual(current, fake, 'cached forged exe was accepted without a fresh compiler run');
});

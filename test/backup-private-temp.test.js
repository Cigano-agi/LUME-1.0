import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { criarTempBackupPrivado } from '../src/backup-private-temp.js';

test('temporario de backup tem acesso exclusivo do dono antes de receber dados', async () => {
  const dir = await criarTempBackupPrivado('lume-priv-test-');
  try {
    assert.equal((await stat(dir)).isDirectory(), true);
    if (process.platform === 'win32') {
      const code = `$a=Get-Acl -LiteralPath $env:LUME_BACKUP_TEST_PATH; $e=@($a.Access); [pscustomobject]@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;entries=$e.Count;sid=$e[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;type=$e[0].AccessControlType.ToString()} | ConvertTo-Json -Compress`;
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, LUME_BACKUP_TEST_PATH: dir } });
      assert.equal(result.status, 0);
      const acl = JSON.parse(result.stdout);
      assert.equal(acl.protected, true);
      assert.equal(acl.entries, 1);
      assert.equal(acl.owner, acl.sid);
      assert.equal(acl.type, 'Allow');
    } else assert.equal((await stat(dir)).mode & 0o077, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

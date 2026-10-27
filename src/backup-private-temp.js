import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fail = () => Object.assign(new Error('Diretorio temporario privado indisponivel.'), { code: 'BACKUP_ACL_FALHOU' });

// A ACL fica fechada antes de qualquer snapshot SQLite ou staging claro.
export async function criarTempBackupPrivado(prefixo) {
  if (typeof prefixo !== 'string' || !/^[a-z0-9-]{1,40}$/.test(prefixo)) throw new TypeError('Prefixo invalido');
  const dir = await mkdtemp(path.join(tmpdir(), prefixo));
  try {
    await chmod(dir, 0o700);
    if (process.platform === 'win32') {
      const owner = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const sid = owner.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (owner.status !== 0 || !sid) throw fail();
      const acl = spawnSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      if (acl.status !== 0) throw fail();
      const script = `$a=Get-Acl -LiteralPath $env:LUME_BACKUP_ACL_PATH; $e=@($a.Access | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;rights=[int]$_.FileSystemRights;type=$_.AccessControlType.ToString();inherited=$_.IsInherited} }); [pscustomobject]@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;entries=$e} | ConvertTo-Json -Compress -Depth 4`;
      const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, LUME_BACKUP_ACL_PATH: dir } });
      let effective;
      try { effective = JSON.parse(check.stdout); } catch { throw fail(); }
      const entries = effective.entries;
      if (check.status !== 0 || effective.owner !== sid || effective.protected !== true ||
          !Array.isArray(entries) || entries.length !== 1 || entries[0].sid !== sid ||
          entries[0].type !== 'Allow' || entries[0].inherited !== false ||
          (entries[0].rights & 0x1f01ff) !== 0x1f01ff) throw fail();
    }
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error?.code === 'BACKUP_ACL_FALHOU' ? error : fail();
  }
}

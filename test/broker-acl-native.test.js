import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const binary = join(import.meta.dirname, '..', 'native', 'win-acl', 'bin', 'lume-acl.exe');
const chain = path => {
  const root = parse(path).root;
  return relative(root, path).split(sep).filter(Boolean).reduce((paths, piece) => [...paths, join(paths.at(-1), piece)], [root]);
};
const clean = path => {
  if (![resolve(tmpdir()), resolve(homedir())].includes(dirname(resolve(path))) ||
      !basename(path).startsWith('lume-acl-native-')) throw Error('unsafe cleanup');
  rmSync(path, { recursive: true });
};
async function harness() {
  const stage = mkdtempSync(join(tmpdir(), 'lume-acl-native-harness-'));
  const out = join(stage, 'acl-tests.exe');
  try {
    await run('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
      ['/nologo', '/target:exe', '/platform:x64', '/langversion:5', '/main:LumeAclTests', `/out:${out}`,
        join(import.meta.dirname, '..', 'native', 'win-acl', 'LumeAcl.cs'),
        join(import.meta.dirname, 'fixtures', 'broker-acl-tests.cs')],
      { windowsHide: true, timeout: 30000, maxBuffer: 4096 });
    return { stage, out };
  } catch { clean(stage); throw Error('HARNESS_COMPILE_FAILED'); }
}
async function check(args) {
  try {
    const result = await run(binary, args, { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    assert.equal(result.stderr, '');
    return { exit: 0, stdout: result.stdout };
  } catch (error) {
    assert.equal(error.stderr, '');
    return { exit: error.code, stdout: error.stdout };
  }
}

test('contrato novo: fonte e executável ACL nativo estão disponíveis', () => {
  assert.equal(existsSync(join(import.meta.dirname, '..', 'native', 'win-acl', 'LumeAcl.cs')), true);
  assert.equal(existsSync(join(import.meta.dirname, '..', 'native', 'win-acl', 'bin', 'lume-acl.exe')), true);
});

test('ACL Windows real em perfil temporário: cadeia completa passa; omissão e índice falso recusam', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  const userData = mkdtempSync(join(homedir(), 'lume-acl-native-'));
  const fixture = await harness();
  try {
    const paths = chain(userData), strictFrom = paths.length - 1;
    const good = await check(['--check', userData, String(strictFrom), ...paths]);
    if (good.exit !== 0) {
      try { await run(fixture.out, ['--probe', userData], { windowsHide: true, timeout: 5000, maxBuffer: 4096 }); }
      catch (error) { t.diagnostic(`ACL_PROBE=${error.stdout ?? ''};CLASS=${error.code ?? 'unknown'}`); }
    }
    assert.deepEqual(good, { exit: 0, stdout: '{"ok":true,"code":"OK"}' });
    const omitted = await check(['--check', userData, String(strictFrom - 1), ...paths.slice(1)]);
    assert.deepEqual(omitted, { exit: 1, stdout: '{"ok":false,"code":"INVALID_INPUT"}' });
    const shifted = await check(['--check', userData, '0', ...paths]);
    assert.deepEqual(shifted, { exit: 1, stdout: '{"ok":false,"code":"INVALID_INPUT"}' });
    const ads = await check(['--check', userData, String(strictFrom), ...paths.slice(0, -1), `${userData}:stream`]);
    assert.deepEqual(ads, { exit: 1, stdout: '{"ok":false,"code":"INVALID_INPUT"}' });
  } finally { clean(userData); clean(fixture.stage); }
});

test('componente reparse real é recusado', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  const userData = mkdtempSync(join(homedir(), 'lume-acl-native-'));
  const outside = mkdtempSync(join(homedir(), 'lume-acl-native-outside-'));
  const link = join(userData, 'junction');
  try {
    try { symlinkSync(outside, link, 'junction'); }
    catch (error) { if (error.code === 'EPERM') return t.skip('junction indisponível neste usuário'); throw error; }
    const paths = chain(link);
    const result = await check(['--check', userData, String(paths.indexOf(userData)), ...paths]);
    assert.deepEqual(result, { exit: 1, stdout: '{"ok":false,"code":"ACL_UNTRUSTED"}' });
  } finally {
    if (existsSync(link)) unlinkSync(link);
    clean(userData); clean(outside);
  }
});

test('classificador usa o mesmo código do executável em casos sintéticos', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  const fixture = await harness();
  try {
    let before;
    try { before = statSync(fixture.out, { bigint: true }); }
    catch { assert.fail('HARNESS_FILE_UNREADABLE'); }
    assert.equal(before.isFile() && before.size > 0n, true, 'HARNESS_FILE_NOT_READY');
    let result;
    try { result = await run(fixture.out, ['--synthetic'], { windowsHide: true, timeout: 5000, maxBuffer: 4096 }); }
    catch (error) {
      let after;
      try { after = statSync(fixture.out, { bigint: true }); } catch { /* diagnostic only */ }
      const sameFile = Boolean(after && before.dev === after.dev && before.ino === after.ino &&
        before.size === after.size && before.mtimeNs === after.mtimeNs);
      const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code :
        Number.isInteger(error.code) ? error.code : 'OTHER';
      const errno = Number.isInteger(error.errno) ? error.errno : 'NONE';
      const signal = typeof error.signal === 'string' && /^[A-Z0-9]+$/.test(error.signal) ? error.signal : 'NONE';
      const marker = typeof error.stdout === 'string' && /^SYNTHETIC:\d+\/15$/.test(error.stdout) ? error.stdout : 'NONE';
      assert.fail(`HARNESS_EXECUTION_FAILED code=${code} errno=${errno} signal=${signal} killed=${error.killed === true} sameFile=${sameFile} marker=${marker}`);
    }
    assert.equal(result.stdout, 'SYNTHETIC:15/15');
    assert.equal(result.stderr, '');
  } finally { clean(fixture.stage); }
});

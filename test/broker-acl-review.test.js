import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createBootIdentity } from '../src/mcp/broker-identity.js';
import { publishBrokerDescriptor } from '../src/mcp/broker-bootstrap.js';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const source = join(root, 'native', 'win-acl', 'LumeAcl.cs');
const binary = join(root, 'native', 'win-acl', 'bin', 'lume-acl.exe');

function cleanup(path) {
  if (dirname(resolve(path)) !== resolve(tmpdir()) || !basename(path).startsWith('lume-acl-review-')) throw Error('unsafe cleanup');
  rmSync(path, { recursive: true });
}

const reviewHarness = String.raw`
using System;
using System.Security.AccessControl;
using System.Security.Principal;
internal static class ReviewAcl {
  static SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
  static SecurityIdentifier other = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
  static SecurityIdentifier installer;
  static RawSecurityDescriptor Sd(SecurityIdentifier owner, GenericAce ace, bool dacl = true, bool protectedAcl = false) {
    RawAcl acl = dacl ? new RawAcl(2, ace == null ? 0 : 1) : null;
    if (ace != null) acl.InsertAce(0, ace);
    ControlFlags flags = dacl ? ControlFlags.DiscretionaryAclPresent : ControlFlags.None;
    if (protectedAcl) flags |= ControlFlags.DiscretionaryAclProtected;
    return new RawSecurityDescriptor(flags, owner, null, null, acl);
  }
  static CommonAce Allow(uint mask, AceFlags flags = AceFlags.None) {
    return new CommonAce(flags, AceQualifier.AccessAllowed, unchecked((int)mask), other, false, null);
  }
  static bool Check(bool accept, RawSecurityDescriptor descriptor, bool strict, bool root = false) {
    try { LumeAclPolicy.Check(descriptor, user, strict, root); return accept; }
    catch (AclUntrustedException) { return !accept; }
  }
  public static int Main() {
    try { installer = (SecurityIdentifier)new NTAccount("NT SERVICE", "TrustedInstaller").Translate(typeof(SecurityIdentifier)); }
    catch { Console.Out.Write("REVIEW:RESOLVE_FAILED"); return 1; }
    bool[] result = new bool[] {
      Check(true, Sd(user, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, unchecked((int)0x10000000U), user, false, null)), true),
      Check(false, Sd(user, Allow(0x00000040U)), false), // DELETE_CHILD, mesmo no ancestral
      Check(false, Sd(user, Allow(0x10000000U)), false), // GENERIC_ALL no ancestral
      Check(false, Sd(user, Allow(0x00040000U)), false), // WRITE_DAC no ancestral
      Check(false, Sd(user, Allow(0x00080000U)), false), // WRITE_OWNER no ancestral
      Check(false, Sd(user, Allow(0x00010000U)), false), // DELETE no objeto
      Check(true, Sd(user, Allow(0x40000000U)), false), // criar irmão no ancestral
      Check(false, Sd(user, Allow(0x40000000U)), true), // GENERIC_WRITE desde userData
      Check(true, Sd(user, Allow(0x10000000U, AceFlags.InheritOnly)), true),
      Check(false, Sd(user, Allow(0x10000000U, AceFlags.Inherited)), true),
      Check(false, Sd(user, null, false), true),
      Check(false, Sd(other, null), true),
      Check(false, Sd(user, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0, other, true, new byte[] {1, 2, 3, 4})), true),
      Check(true, Sd(installer, null, true, true), false, true),
      Check(false, Sd(installer, null, true, true), false, false),
      Check(false, Sd(installer, null, true, false), false, true),
      Check(false, Sd(installer, null, true, true), true, true),
      Check(false, Sd(installer, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, unchecked((int)0x00010000U), installer, false, null), true, true), false, true)
    };
    int passed = 0;
    foreach (bool value in result) if (value) passed++;
    Console.Out.Write("REVIEW:" + passed + "/" + result.Length);
    return passed == result.Length ? 0 : 1;
  }
}`;

test('classificador real recusa substituição e escrita por terceiros; respeita InheritOnly', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  const stage = mkdtempSync(join(tmpdir(), 'lume-acl-review-'));
  try {
    const fixture = join(stage, 'review.cs'), out = join(stage, 'review.exe');
    writeFileSync(fixture, reviewHarness, { flag: 'wx' });
    try {
      await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/langversion:5', '/main:ReviewAcl', `/out:${out}`, source, fixture],
        { windowsHide: true, timeout: 30000, maxBuffer: 4096 });
    } catch { assert.fail('compilação do harness falhou sem expor detalhes privados'); }
    let result;
    try { result = await run(out, [], { windowsHide: true, timeout: 5000, maxBuffer: 4096 }); }
    catch (error) {
      const marker = typeof error.stdout === 'string' && /^REVIEW:(\d+\/18|RESOLVE_FAILED)$/.test(error.stdout)
        ? error.stdout : 'none';
      const code = Number.isInteger(error.code) ? error.code : 'other';
      const signal = typeof error.signal === 'string' && /^[A-Z0-9]+$/.test(error.signal) ? error.signal : 'none';
      assert.fail(`harness exit=${code}; signal=${signal}; killed=${error.killed === true}; marker=${marker}`);
    }
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, 'REVIEW:18/18');
  } finally { cleanup(stage); }
});

test('CLI real recusa cadeia omitida, índice deslocado, duplicação, ADS e device antes da ACL', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  const userData = 'C:\\Users\\Review\\Lume';
  const paths = ['C:\\', 'C:\\Users', 'C:\\Users\\Review', userData];
  const variants = [
    ['--check', userData, '2', ...paths.slice(1)],
    ['--check', userData, '0', ...paths],
    ['--check', userData, '4', ...paths, userData],
    ['--check', userData, '3', paths[0], paths[2], paths[1], paths[3]],
    ['--check', userData, '3', ...paths.slice(0, -1), `${userData}:stream`],
    ['--check', userData, '3', ...paths.slice(0, -1), `\\\\?\\${userData}`]
  ];
  for (const args of variants) {
    let error;
    try { await run(binary, args, { windowsHide: true, timeout: 5000, maxBuffer: 4096 }); }
    catch (failure) { error = failure; }
    assert.equal(error?.code, 1);
    assert.equal(error?.stdout, '{"ok":false,"code":"INVALID_INPUT"}');
    assert.equal(error?.stderr, '');
  }
});

test('RED: userData precisa ser diretório, inclusive quando é o alvo final', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  const stage = mkdtempSync(join(tmpdir(), 'lume-acl-review-'));
  try {
    const currentBinary = join(stage, 'current-acl.exe');
    try {
      await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/langversion:5', `/out:${currentBinary}`, source],
        { windowsHide: true, timeout: 30000, maxBuffer: 4096 });
    } catch { assert.fail('compilação da fonte atual falhou sem expor detalhes privados'); }
    const userData = join(stage, 'profile-file');
    writeFileSync(userData, 'fixture', { flag: 'wx' });
    const rootPath = parse(userData).root;
    const paths = relative(rootPath, userData).split(sep).filter(Boolean)
      .reduce((chain, piece) => [...chain, join(chain.at(-1), piece)], [rootPath]);
    let output;
    try { output = await run(currentBinary, ['--check', userData, String(paths.length - 1), ...paths],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096 }); }
    catch (error) { output = { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
    assert.equal(output.stderr, '');
    assert.equal(output.stdout, '{"ok":false,"code":"INVALID_INPUT"}');
  } finally { cleanup(stage); }
});

test('RED unitário: criar irmão durante inspeção não troca identidade do diretório', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  const userData = mkdtempSync(join(tmpdir(), 'lume-acl-review-'));
  let created = false;
  mock.method(childProcess, 'execFile', (_exe, _args, _options, callback) => {
    if (!created) { created = true; writeFileSync(join(userData, 'sibling.txt'), 'fixture', { flag: 'wx' }); }
    callback(null, '{"ok":true,"code":"OK"}', '');
  });
  try {
    const result = await publishBrokerDescriptor({
      userData, selection: { tipo: 'legado', id: 'legado', geracao: null },
      boot: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', port: 41234,
      identity: await createBootIdentity()
    });
    assert.equal(created, true);
    await result.release();
  } finally { mock.restoreAll(); cleanup(userData); }
});

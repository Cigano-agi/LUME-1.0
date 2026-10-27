import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, parse, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
// Bind the previously verified Microsoft-signed Framework compiler to its current bytes.
const compilerSha256 = '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00';
const source = join(root, 'native', 'win-acl', 'LumeAcl.cs');
const bin = join(root, 'native', 'win-acl', 'bin');
const target = join(bin, 'lume-acl.exe');
const manifestPath = join(bin, 'manifest.json');
const hex64 = /^[0-9a-f]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ownKeys = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const snapshot = path => existsSync(path) ? lstatSync(path, { bigint: true }) : null;
const same = (a, b) => a === null ? b === null : b !== null &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
const sameObject = (a, b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
const fingerprint = path => ({ stat: snapshot(path), digest: existsSync(path) ? hash(readFileSync(path)) : null });
const sameFingerprint = (before, path) => same(before.stat, snapshot(path)) &&
  before.digest === (existsSync(path) ? hash(readFileSync(path)) : null);

function noLinks(path, requireFile = false, requireSingleLink = false) {
  const first = parse(path).root;
  let current = first;
  const pieces = relative(first, path).split(sep).filter(Boolean);
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i]);
    const st = lstatSync(current);
    if (st.isSymbolicLink() || (i < pieces.length - 1 && !st.isDirectory())) throw Error('BROKER_ACL_BUILD_FAILED');
    if (i === pieces.length - 1 && requireFile && (!st.isFile() || (requireSingleLink && st.nlink !== 1))) throw Error('BROKER_ACL_BUILD_FAILED');
  }
}

function previousIsOurs() {
  if (!existsSync(target) && !existsSync(manifestPath)) return;
  if (!existsSync(target) || !existsSync(manifestPath)) throw Error('BROKER_ACL_BUILD_FAILED');
  noLinks(target, true, true); noLinks(manifestPath, true, true);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { throw Error('BROKER_ACL_BUILD_FAILED'); }
  if (!ownKeys(manifest, ['schema', 'platform', 'arch', 'file', 'sha256', 'sourceSha256']) ||
      manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.file !== 'lume-acl.exe' || !hex64.test(manifest.sha256) || !hex64.test(manifest.sourceSha256) ||
      hash(readFileSync(target)) !== manifest.sha256) throw Error('BROKER_ACL_BUILD_FAILED');
}

export async function buildBrokerAcl({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32' || arch !== 'x64' || process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('BROKER_ACL_BUILD_UNSUPPORTED');
  noLinks(compiler, true);
  if (hash(readFileSync(compiler)) !== compilerSha256) throw Error('BROKER_ACL_BUILD_FAILED');
  noLinks(source, true);
  noLinks(dirname(bin));
  if (!existsSync(bin)) mkdirSync(bin);
  noLinks(bin);
  previousIsOurs();
  const compilerBefore = snapshot(compiler);
  const sourceBefore = snapshot(source);
  const targetBefore = fingerprint(target);
  const manifestBefore = fingerprint(manifestPath);
  const sourceSha256 = hash(readFileSync(source));
  const stage = mkdtempSync(join(bin, '.build-'));
  const stageBefore = snapshot(stage);
  const stagedExe = join(stage, 'lume-acl.exe');
  const stagedManifest = join(stage, 'manifest.json');
  try {
    await run(compiler, ['/nologo', '/target:exe', '/platform:x64', '/langversion:5', '/optimize+', `/out:${stagedExe}`, source],
      { windowsHide: true, timeout: 30000, maxBuffer: 4096 });
    noLinks(stagedExe, true, true);
    const sha256 = hash(readFileSync(stagedExe));
    const manifest = { schema: 1, platform: 'win32', arch: 'x64', file: 'lume-acl.exe', sha256, sourceSha256 };
    writeFileSync(stagedManifest, JSON.stringify(manifest) + '\n', { flag: 'wx' });
    // Recheck existing artifacts after the compiler returns; uncertain replacements are preserved.
    noLinks(compiler, true); noLinks(source, true);
    if (!same(compilerBefore, snapshot(compiler)) || hash(readFileSync(compiler)) !== compilerSha256 ||
        !same(sourceBefore, snapshot(source)) || hash(readFileSync(source)) !== sourceSha256)
      throw Error('BROKER_ACL_BUILD_FAILED');
    previousIsOurs();
    if (!sameFingerprint(targetBefore, target) || !sameFingerprint(manifestBefore, manifestPath))
      throw Error('BROKER_ACL_BUILD_FAILED');
    noLinks(bin);
    renameSync(stagedExe, target);
    renameSync(stagedManifest, manifestPath);
    if (hash(readFileSync(target)) !== sha256) throw Error('BROKER_ACL_BUILD_FAILED');
    return manifest;
  } catch {
    throw Error('BROKER_ACL_BUILD_FAILED');
  } finally {
    // Only remove the unique staging directory created by this invocation after child exit.
    try {
      if (resolve(stage).startsWith(resolve(bin) + sep) && sameObject(stageBefore, snapshot(stage)) &&
          readdirSync(stage).every(name => name === 'lume-acl.exe' || name === 'manifest.json')) {
        noLinks(stage);
        for (const name of readdirSync(stage)) noLinks(join(stage, name), true, true);
        rmSync(stage, { recursive: true });
      }
    } catch { /* uncertain staging output is preserved */ }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildBrokerAcl().then(() => process.stdout.write('BROKER_ACL_BUILD_OK\n'))
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}

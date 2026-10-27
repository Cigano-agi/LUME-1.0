import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const compilerSha256 = '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00';
const source = join(root, 'native', 'project-inventory', 'WindowsInventory.cs');
const bin = join(root, 'native', 'project-inventory', 'bin');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = file => existsSync(file) ? lstatSync(file, { bigint: true }) : null;
const same = (a, b) => a === null ? b === null : b !== null &&
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
const fingerprint = file => ({ stat: snapshot(file), digest: existsSync(file) ? hash(readFileSync(file)) : null });
const sameFingerprint = (before, file) => same(before.stat, snapshot(file)) &&
  before.digest === (existsSync(file) ? hash(readFileSync(file)) : null);

function noLinks(file, requireFile = false, requireSingleLink = false) {
  const first = parse(file).root;
  let current = first;
  for (const part of relative(first, file).split(sep).filter(Boolean)) {
    current = join(current, part);
    const st = lstatSync(current);
    if (st.isSymbolicLink()) throw Error('PROJECT_INVENTORY_BUILD_FAILED');
  }
  if (requireFile) {
    const st = lstatSync(file);
    if (!st.isFile() || requireSingleLink && st.nlink !== 1) throw Error('PROJECT_INVENTORY_BUILD_FAILED');
  }
}

function previousIsOurs(target, manifestPath, flavor) {
  if (!existsSync(target) && !existsSync(manifestPath)) return null;
  if (!existsSync(target) || !existsSync(manifestPath)) throw Error('PROJECT_INVENTORY_BUILD_FAILED');
  noLinks(target, true, true); noLinks(manifestPath, true, true);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
  catch { throw Error('PROJECT_INVENTORY_BUILD_FAILED'); }
  const fields = ['schema', 'platform', 'arch', 'file', 'flavor', 'sha256', 'sourceSha256'];
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype ||
      Object.keys(manifest).sort().join(',') !== fields.sort().join(',') ||
      manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.file !== 'lume-project-inventory.exe' || manifest.flavor !== flavor ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256) || !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) ||
      hash(readFileSync(target)) !== manifest.sha256) throw Error('PROJECT_INVENTORY_BUILD_FAILED');
  return manifest;
}

export async function buildProjectInventory({ testHooks = false } = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('PROJECT_INVENTORY_BUILD_UNSUPPORTED');
  noLinks(compiler, true);
  if (hash(readFileSync(compiler)) !== compilerSha256) throw Error('PROJECT_INVENTORY_BUILD_FAILED');
  noLinks(source, true, true);
  noLinks(dirname(bin));
  if (!existsSync(bin)) mkdirSync(bin);
  noLinks(bin);
  const targetDir = testHooks ? join(bin, 'test') : bin;
  if (!existsSync(targetDir)) mkdirSync(targetDir);
  noLinks(targetDir);
  const target = join(targetDir, 'lume-project-inventory.exe');
  const manifestPath = join(targetDir, 'manifest.json');
  const flavor = testHooks ? 'test' : 'release';
  previousIsOurs(target, manifestPath, flavor);
  const sourceSha256 = hash(readFileSync(source));
  const compilerBefore = snapshot(compiler);
  const sourceBefore = snapshot(source);
  const targetBefore = fingerprint(target);
  const manifestBefore = fingerprint(manifestPath);
  const stage = mkdtempSync(join(targetDir, '.build-'));
  const stageBefore = snapshot(stage);
  const stagedExe = join(stage, 'lume-project-inventory.exe');
  const stagedManifest = join(stage, 'manifest.json');
  try {
    const args = ['/nologo', '/target:exe', '/platform:x64', '/langversion:5', '/optimize+', '/warnaserror+',
      '/reference:System.Web.Extensions.dll', `/out:${stagedExe}`];
    if (testHooks) args.push('/define:TEST_HOOKS');
    args.push(source);
    await run(compiler, args, { windowsHide: true, timeout: 30000, maxBuffer: 8192 });
    noLinks(stagedExe, true, true);
    const sha256 = hash(readFileSync(stagedExe));
    const manifest = { schema: 1, platform: 'win32', arch: 'x64', file: 'lume-project-inventory.exe',
      flavor, sha256, sourceSha256 };
    writeFileSync(stagedManifest, JSON.stringify(manifest) + '\n', { flag: 'wx' });
    noLinks(compiler, true); noLinks(source, true, true);
    if (!same(compilerBefore, snapshot(compiler)) || hash(readFileSync(compiler)) !== compilerSha256 ||
        !same(sourceBefore, snapshot(source)) || hash(readFileSync(source)) !== sourceSha256)
      throw Error('PROJECT_INVENTORY_BUILD_FAILED');
    previousIsOurs(target, manifestPath, flavor);
    if (!sameFingerprint(targetBefore, target) || !sameFingerprint(manifestBefore, manifestPath))
      throw Error('PROJECT_INVENTORY_BUILD_FAILED');
    renameSync(stagedExe, target);
    renameSync(stagedManifest, manifestPath);
    if (hash(readFileSync(target)) !== sha256) throw Error('PROJECT_INVENTORY_BUILD_FAILED');
    return manifest;
  } catch {
    throw Error('PROJECT_INVENTORY_BUILD_FAILED');
  } finally {
    try {
      const stageResolved = resolve(stage), targetResolved = resolve(targetDir);
      if (stageResolved.startsWith(targetResolved + sep) && same(stageBefore, snapshot(stage)) &&
          readdirSync(stage).every(name => name === 'lume-project-inventory.exe' || name === 'manifest.json')) {
        noLinks(stage);
        for (const name of readdirSync(stage)) {
          const file = join(stage, name);
          noLinks(file, true, true);
          unlinkSync(file);
        }
        rmdirSync(stage);
      }
    } catch { /* preserve uncertain staging output */ }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 3 || process.argv.length === 3 && process.argv[2] !== '--test-hooks') {
    process.stderr.write('PROJECT_INVENTORY_BUILD_FAILED\n'); process.exitCode = 1;
  } else {
    buildProjectInventory({ testHooks: process.argv[2] === '--test-hooks' })
      .then(() => process.stdout.write('PROJECT_INVENTORY_BUILD_OK\n'))
      .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  }
}

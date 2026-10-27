import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const nofollow = constants.O_NOFOLLOW || 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Shared by the archive variant; the same path, identity and process guards apply.
export { canonical, safeChain, outsideGit, overlaps, privateDirectory, inventory,
  stableInventory, stopped, exists, fileHash, durableJson, identity, same, validRelative };

// Bounded independent filesystem operations. A failure drains in-flight work
// before returning, so callers never observe an unfinished successful snapshot.
async function bounded(items, operation, concurrency = 16) {
  const results = new Array(items.length); let next = 0, failure;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(!failure){const index=next++;if(index>=items.length)return;
      try{results[index]=await operation(items[index],index);}catch(error){failure??=error;}
    }
  }));
  if(failure)throw failure;
  return results;
}

async function exists(name) {
  try { await lstat(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function safeChain(name) {
  const root = path.parse(name).root;
  let current = root;
  for (const segment of ['', ...path.relative(root, name).split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const st = await lstat(current, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) fail('SNAPSHOT_UNSAFE_PATH');
  }
}
async function outsideGit(name) {
  let current = path.dirname(name);
  while (true) {
    if (await exists(path.join(current, '.git'))) fail('SNAPSHOT_DESTINATION_IN_GIT');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function canonical(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) fail('SNAPSHOT_UNSAFE_PATH');
  return value;
}
function overlaps(a, b) {
  const relative = path.relative(key(a), key(b));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function privateDirectory(name) {
  await mkdir(name, { mode: 0o700 });
  if (process.platform === 'win32') {
    const owner = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = owner.stdout?.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (owner.status !== 0 || !sid) fail('SNAPSHOT_ACL_FAILED');
    const acl = spawnSync('icacls.exe', [name, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true });
    if (acl.status !== 0) fail('SNAPSHOT_ACL_FAILED');
  }
}

/** Fails closed when the OS process list cannot be read. No CLI bypass. */
export async function lumeIsRunning() {
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference='Stop'; $p = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Lume|Assessor)(\\.exe)?$' -or ($_.Name -match '^electron(\\.exe)?$' -and $_.CommandLine -match '(?i)lume|assessor') -or ($_.Name -match '^node(\\.exe)?$' -and ($_.CommandLine.Replace([char]92,[char]47) -match '(?i)/Lume/app/bin/(assessor|app)[.]js' -or $_.CommandLine.Replace([char]92,[char]47) -match '(?i)(?<![A-Za-z0-9._/-])(?:[.]/)?bin/(assessor|app)[.]js')) }); if ($p.Count -gt 0) { 'running' } else { 'stopped' }";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (result.status !== 0 || !['running', 'stopped'].includes(result.stdout.trim())) fail('LUME_NOT_STOPPED');
    return result.stdout.trim() === 'running';
  }
  const result = spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) fail('LUME_NOT_STOPPED');
  return result.stdout.split('\n').some(name => /(?:^|\/)(?:Lume|Assessor)(?: Helper[^/]*)?$/i.test(name.trim()));
}
async function stopped(probe) {
  try { if (await probe() !== false) fail('LUME_NOT_STOPPED'); }
  catch { fail('LUME_NOT_STOPPED'); }
}

async function inventory(root) {
  await safeChain(root);
  const files = [], directories = [];
  async function visit(relative) {
    const current = path.join(root, relative);
    const before = await lstat(current, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) fail('SNAPSHOT_UNSAFE_PATH');
    directories.push({ path: relative, stat: before });
    const names=(await readdir(current)).sort();
    const stats=await bounded(names,name=>lstat(path.join(current,name),{bigint:true}));
    for (let index=0;index<names.length;index++) {
      const name=names[index];
      const entry = relative ? relative + '/' + name : name;
      const stat = stats[index];
      if (stat.isSymbolicLink()) fail('SNAPSHOT_UNSAFE_PATH');
      if (stat.isDirectory()) await visit(entry);
      else if (stat.isFile() && stat.nlink === 1n && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)) files.push({ path: entry, stat });
      else fail('SNAPSHOT_UNSAFE_PATH');
    }
    if (!same(before, await lstat(current, { bigint: true }))) fail('SNAPSHOT_SOURCE_CHANGED');
  }
  await visit('');
  return { files, directories };
}

async function fileHash(name, expected, destination) {
  await safeChain(path.dirname(name));
  const before = await lstat(name, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (expected && !same(before, expected))) fail('SNAPSHOT_SOURCE_CHANGED');
  let source, target;
  try {
    source = await open(name, constants.O_RDONLY | nofollow);
    if (!same(before, await source.stat({ bigint: true }))) fail('SNAPSHOT_SOURCE_CHANGED');
    if (destination) target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o600);
    const hash = createHash('sha256');
    let size = 0;
    for await (const bytes of source.createReadStream({ highWaterMark: 1024 * 1024, autoClose: false })) {
      hash.update(bytes); size += bytes.length;
      if (target) await target.writeFile(bytes);
    }
    if (target) await target.sync();
    if (!same(before, await source.stat({ bigint: true })) || !same(before, await lstat(name, { bigint: true })) || BigInt(size) !== before.size) fail('SNAPSHOT_SOURCE_CHANGED');
    return { path: '', bytes: size, sha256: hash.digest('hex') };
  } finally { await source?.close(); await target?.close(); }
}
async function copyTree(source, target, entries) {
  await mkdir(target, { mode: 0o700 });
  for (const entry of entries.directories) if (entry.path) await mkdir(path.join(target, entry.path), { mode: 0o700 });
  const files = await bounded(entries.files,async entry=>{
    await safeChain(path.dirname(path.join(target, entry.path)));
    return { ...await fileHash(path.join(source, entry.path), entry.stat, path.join(target, entry.path)), path: entry.path };
  });
  return files;
}
async function stableInventory(root, before) {
  const after = await inventory(root);
  for (const kind of ['files', 'directories']) {
    if (before[kind].length !== after[kind].length) fail('SNAPSHOT_SOURCE_CHANGED');
    for (let i = 0; i < before[kind].length; i++) {
      const a = before[kind][i], b = after[kind][i];
      if (a.path !== b.path || !same(a.stat, b.stat)) fail('SNAPSHOT_SOURCE_CHANGED');
    }
  }
}
function validRelative(value, empty = false) {
  return typeof value === 'string' && ((empty && value === '') || (value.length > 0 && !value.includes('\\') && !value.includes(':') && !value.includes('\0') && value.split('/').every(x => x && x !== '.' && x !== '..')));
}
async function verifyTree(root, manifest) {
  const entries = await inventory(root);
  if (entries.files.length !== manifest.files.length || JSON.stringify(entries.directories.map(x => x.path)) !== JSON.stringify(manifest.directories)) fail('SNAPSHOT_HASH_MISMATCH');
  await bounded(entries.files,async(entry,i)=>{
    const expected = manifest.files[i];
    if (entry.path !== expected.path || Number(entry.stat.size) !== expected.bytes) fail('SNAPSHOT_HASH_MISMATCH');
    const actual = await fileHash(path.join(root, entry.path), entry.stat);
    if (actual.sha256 !== expected.sha256) fail('SNAPSHOT_HASH_MISMATCH');
  });
  await stableInventory(root, entries);
  return entries;
}
async function durableJson(name, data) {
  const handle = await open(name, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
export async function verifySnapshot(destination) {
  canonical(destination);
  await safeChain(destination);
  const name = path.join(destination, 'manifest.json');
  const stat = await lstat(name, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 128n * 1024n * 1024n) fail('SNAPSHOT_INVALID_MANIFEST');
  const handle = await open(name, constants.O_RDONLY | nofollow);
  let raw;
  try {
    if (!same(stat, await handle.stat({ bigint: true }))) fail('SNAPSHOT_INVALID_MANIFEST');
    raw = await handle.readFile('utf8');
    if (!same(stat, await handle.stat({ bigint: true })) || !same(stat, await lstat(name, { bigint: true }))) fail('SNAPSHOT_INVALID_MANIFEST');
  } finally { await handle.close(); }
  let manifest;
  try { manifest = JSON.parse(raw); } catch { fail('SNAPSHOT_INVALID_MANIFEST'); }
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories) ||
      manifest.directories.some(x => !validRelative(x, true)) ||
      manifest.files.some(x => !validRelative(x.path) || !Number.isSafeInteger(x.bytes) || x.bytes < 0 || !/^[a-f0-9]{64}$/.test(x.sha256))) fail('SNAPSHOT_INVALID_MANIFEST');
  await verifyTree(path.join(destination, 'profile'), manifest);
  return { manifest, manifestSha256: digest(raw), verified: true };
}

/** Copies only; never closes processes, replaces profiles, deletes originals or starts Lume. */
export async function snapshotLumeProfile({ source, destination, rehearsal, processProbe = lumeIsRunning } = {}) {
  const paths = [source, destination, rehearsal].map(canonical);
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++)
    if (overlaps(paths[i], paths[j]) || overlaps(paths[j], paths[i])) fail('SNAPSHOT_PATH_CONFLICT');
  await stopped(processProbe);
  await safeChain(source);
  for (const target of [destination, rehearsal]) {
    if (await exists(target)) fail('SNAPSHOT_DESTINATION_EXISTS');
    await safeChain(path.dirname(target));
    await outsideGit(target);
  }
  const before = await inventory(source);
  if (!before.files.some(x => x.path === 'data/assessor.db')) fail('SNAPSHOT_DATABASE_MISSING');
  await stopped(processProbe);
  await privateDirectory(destination);
  const destinationIdentity = await lstat(destination, { bigint: true });
  const files = await copyTree(source, path.join(destination, 'profile'), before);
  await stopped(processProbe);
  await stableInventory(source, before);
  const manifest = { version: 1, createdAt: new Date().toISOString(), directories: before.directories.map(x => x.path), files };
  await durableJson(path.join(destination, 'manifest.json'), manifest);
  const verified = await verifySnapshot(destination);
  await privateDirectory(rehearsal);
  const rehearsalIdentity = await lstat(rehearsal, { bigint: true });
  const copied = await inventory(path.join(destination, 'profile'));
  // copyTree creates its root; this root already has the private ACL applied.
  for (const entry of copied.directories) if (entry.path) await mkdir(path.join(rehearsal, entry.path), { mode: 0o700 });
  await bounded(copied.files,async entry=>{
    await safeChain(path.dirname(path.join(rehearsal, entry.path)));
    await fileHash(path.join(destination, 'profile', entry.path), entry.stat, path.join(rehearsal, entry.path));
  });
  await verifyTree(rehearsal, manifest);
  await stopped(processProbe);
  await stableInventory(source, before);
  if (!identity(destinationIdentity, await lstat(destination, { bigint: true })) || !identity(rehearsalIdentity, await lstat(rehearsal, { bigint: true }))) fail('SNAPSHOT_SOURCE_CHANGED');
  const receipt = { version: 1, files: files.length, bytes: files.reduce((sum, x) => sum + x.bytes, 0), manifestSha256: verified.manifestSha256, verified: true, rehearsed: true };
  await durableJson(path.join(destination, 'receipt.json'), receipt);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--source', '--destination', '--rehearsal'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i].slice(2))) fail('SNAPSHOT_ARGUMENTS');
      options[args[i].slice(2)] = args[i + 1];
    }
    console.log(JSON.stringify(await snapshotLumeProfile(options)));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, code: /^SNAPSHOT_|^LUME_NOT_STOPPED$/.test(error?.code || '') ? error.code : 'SNAPSHOT_FAILED' }));
    process.exitCode = 1;
  }
}

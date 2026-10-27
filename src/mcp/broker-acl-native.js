import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const fail = () => Object.assign(new Error('BROKER_BOOTSTRAP_UNTRUSTED'), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
const HEX = /^[0-9a-f]{64}$/;
const names = ['arch', 'file', 'platform', 'schema', 'sha256', 'sourceSha256'];

function artifactPath(name) {
  // electron-builder places the PE outside app.asar. No caller-controlled path exists.
  return fileURLToPath(new URL(`../../native/win-acl/bin/${name}`, import.meta.url))
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function regular(path, maxBytes) {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) throw fail();
  return stat;
}

function unchanged(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

function checkedArtifact() {
  const exe = artifactPath('lume-acl.exe');
  const manifestPath = artifactPath('manifest.json');
  const exeStat = regular(exe, 4 * 1024 * 1024);
  const manifestStat = regular(manifestPath, 1024);
  const rawManifest = fs.readFileSync(manifestPath);
  if (rawManifest.length !== manifestStat.size) throw fail();
  let manifest;
  try { manifest = JSON.parse(rawManifest.toString('utf8')); } catch { throw fail(); }
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype ||
    Object.keys(manifest).sort().join(',') !== names.join(',') ||
    manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
    manifest.file !== 'lume-acl.exe' || !HEX.test(manifest.sha256) || !HEX.test(manifest.sourceSha256)) throw fail();
  const contents = fs.readFileSync(exe);
  if (contents.length !== exeStat.size || createHash('sha256').update(contents).digest('hex') !== manifest.sha256) throw fail();
  if (!unchanged(exeStat, regular(exe, 4 * 1024 * 1024)) || !unchanged(manifestStat, regular(manifestPath, 1024))) throw fail();
  return { exe, manifestPath, exeStat, manifestStat, sha256: manifest.sha256 };
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(exe, args, { windowsHide: true, timeout: 5000, maxBuffer: 4096 }, (error, stdout, stderr) => {
      if (error) reject(fail()); else resolve({ stdout, stderr });
    });
  });
}

export async function verifyBrokerAcl({ userData, paths, strictFrom } = {}) {
  try {
    if (typeof userData !== 'string' || !userData || userData.includes('\0') ||
      !Array.isArray(paths) || paths.length < 1 || paths.length > 32 ||
      !Number.isInteger(strictFrom) || strictFrom < 0 || strictFrom >= paths.length ||
      paths[strictFrom] !== userData ||
      paths.some(path => typeof path !== 'string' || !path || path.includes('\0')) ||
      Buffer.byteLength(['--check', userData, String(strictFrom), ...paths].join('\0'), 'utf8') > 16 * 1024) throw fail();
    const artifact = checkedArtifact();
    const { stdout, stderr } = await run(artifact.exe, ['--check', userData, String(strictFrom), ...paths]);
    if (stderr || typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > 4096) throw fail();
    let answer;
    try { answer = JSON.parse(stdout); } catch { throw fail(); }
    if (!answer || Object.getPrototypeOf(answer) !== Object.prototype ||
      Object.keys(answer).sort().join(',') !== 'code,ok' || answer.ok !== true || answer.code !== 'OK') throw fail();
    if (!unchanged(artifact.exeStat, regular(artifact.exe, 4 * 1024 * 1024)) ||
      !unchanged(artifact.manifestStat, regular(artifact.manifestPath, 1024)) ||
      createHash('sha256').update(fs.readFileSync(artifact.exe)).digest('hex') !== artifact.sha256) throw fail();
  } catch { throw fail(); }
}

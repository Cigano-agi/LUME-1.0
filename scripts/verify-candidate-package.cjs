const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const candidate = process.argv[2];
if (!candidate) {
  console.error('Uso: node scripts/verify-candidate-package.cjs <diretorio-win-unpacked>');
  process.exit(2);
}

const root = path.resolve(candidate);
const resources = path.join(root, 'resources');
const archive = path.join(resources, 'app.asar');
const entries = asar.listPackage(archive).map((entry) => entry.replaceAll('\\', '/'));
const read = (name) => JSON.parse(asar.extractFile(archive, name).toString('utf8'));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const packed = (name) => entries.includes(`/${name}`);

const source = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
const metadata = read('package.json');
const policy = read('desktop/release-policy.json');
assert.equal(metadata.version, source.version);
assert.deepEqual(policy, { schema: 'lume-release-v1', enabled: false, channel: 'beta', feedUrl: null });
assert.ok(packed('native/win-acl/bin/lume-acl.exe'));
assert.ok(packed('native/win-acl/bin/manifest.json'));
assert.ok(!entries.some((entry) => /^\/docs\//i.test(entry)));
assert.ok(!entries.some((entry) => /^\/work\//i.test(entry)));
assert.ok(!entries.some((entry) => /^\/(?:AGENTS|DONE|PARKING)\.md$/i.test(entry)));
assert.ok(!entries.some((entry) => /(?:^|\/)(?:darwin|linux)(?:\/|$)/i.test(entry)));
assert.ok(!entries.some((entry) => /(?:^|\/)@img\/[^/]*(?:darwin|linux)/i.test(entry)));

const aclDir = path.join(resources, 'app.asar.unpacked/native/win-acl/bin');
const acl = JSON.parse(fs.readFileSync(path.join(aclDir, 'manifest.json'), 'utf8'));
assert.equal(acl.sha256, hash(path.join(aclDir, acl.file)));
const audioDir = path.join(resources, 'audio-local');
const audio = JSON.parse(fs.readFileSync(path.join(audioDir, 'manifest.json'), 'utf8'));
assert.equal(audio.arquivos.length, 14);
for (const item of audio.arquivos) {
  const file = path.join(audioDir, item.nome);
  assert.equal(fs.statSync(file).size, item.bytes, item.nome);
  assert.equal(hash(file), item.sha256, item.nome);
}
const actualAudio = fs.readdirSync(audioDir).sort();
const expectedAudio = ['manifest.json', ...audio.arquivos.map((item) => item.nome)].sort();
assert.deepEqual(actualAudio, expectedAudio);

console.log(JSON.stringify({
  result: 'CANDIDATE_CONTENT_OK',
  version: metadata.version,
  archiveEntries: entries.length,
  archiveBytes: fs.statSync(archive).size,
  aclSha256: acl.sha256,
  audioFilesVerified: audio.arquivos.length,
  updatesEnabled: policy.enabled,
  foreignPlatformFiles: 0,
  extraneousDocsOrWorkFiles: 0,
}, null, 2));

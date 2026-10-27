import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const require = createRequire(import.meta.url);
const hook = require('../scripts/broker-acl-before-pack.cjs').default;
const nativeFiles = ['native/win-acl/bin/lume-acl.exe', 'native/win-acl/bin/manifest.json'];
const excludedForeignBinaries = [
  '!**/onnxruntime-node/bin/napi-v6/darwin/**', '!**/onnxruntime-node/bin/napi-v6/linux/**',
  '!**/@img/*darwin*/**', '!**/@img/*linux*/**'
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('hook comum inclui binário e manifesto só em Windows, fora do ASAR', async () => {
  assert.equal(pkg.build.beforePack, 'scripts/broker-acl-before-pack.cjs');
  assert.deepEqual(pkg.build.win.files, [...nativeFiles, ...excludedForeignBinaries]);
  assert.deepEqual(pkg.build.asarUnpack, nativeFiles);
  assert.equal(pkg.build.files.includes('src/mcp/broker-acl-win.ps1'), false);
  assert.equal(pkg.build.files.some(file => file.includes('native/win-acl/bin')), false);
  await hook({ electronPlatformName: 'darwin', arch: 3 });
  await assert.rejects(hook({ electronPlatformName: 'win32', arch: 3 }), /BROKER_ACL_BUILD_UNSUPPORTED/);
});

test('desktop build, pack, candidato e Laya preservam o mesmo hook', () => {
  assert.match(pkg.scripts['desktop:build'], /electron-builder --win nsis --x64/);
  assert.match(pkg.scripts['desktop:pack'], /electron-builder --dir --win --x64/);
  const candidate = read('scripts/construir-candidato.mjs');
  assert.match(candidate, /electron-builder\/out\/cli\/cli\.js/);
  assert.doesNotMatch(candidate, /'--config',/);
  const laya = read('scripts/build-laya-bundled.mjs');
  assert.match(laya, /config=\{\.\.\.pkg\.build,/);
  assert.match(laya, /'--config',prepared\.configPath/);
});

test('beforePack Windows x64 produz manifesto coerente com fonte e PE', async t => {
  if (process.platform !== 'win32') return t.skip('Windows requerido');
  await hook({ electronPlatformName: 'win32', arch: 1 });
  const manifest = JSON.parse(read('native/win-acl/bin/manifest.json'));
  assert.deepEqual(Object.keys(manifest), ['schema', 'platform', 'arch', 'file', 'sha256', 'sourceSha256']);
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.platform, 'win32');
  assert.equal(manifest.arch, 'x64');
  assert.equal(manifest.file, 'lume-acl.exe');
  assert.equal(manifest.sha256, sha(readFileSync(join(root, nativeFiles[0]))));
  assert.equal(manifest.sourceSha256, sha(readFileSync(join(root, 'native/win-acl/LumeAcl.cs'))));
});

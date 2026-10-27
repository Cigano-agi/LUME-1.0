import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { minimatch } from 'minimatch';

const workflow = name => {
  const text = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  return { text, value: load(text) };
};

test('smoke macOS executa builds nativos arm64 e x64 em runners distintos', () => {
  const { text, value } = workflow('macos.yml');
  const matrix = value.jobs.smoke.strategy.matrix.include;
  assert.deepEqual(matrix.map(item => [item.arch, item.runner, item.uname_arch]), [
    ['arm64', 'macos-15', 'arm64'],
    ['x64', 'macos-15-intel', 'x86_64']
  ]);
  assert.match(text, /electron-builder --dir --mac --\$\{\{ matrix\.arch \}\}/);
  assert.match(text, /ASSESSOR_TEST_EXECUTABLE: dist\/desktop\/\$\{\{ matrix\.bundle_dir \}\}/);
});

test('candidato macOS universal só fecha depois de assinatura e execução Intel', () => {
  const { text, value } = workflow('macos.yml');
  assert.equal(value.jobs['signed-universal']['runs-on'], 'macos-15');
  assert.equal(value.jobs['signed-intel-verification']['runs-on'], 'macos-15-intel');
  assert.equal(value.jobs['signed-universal'].needs, 'universal-unsigned-intel');
  assert.equal(value.jobs['signed-intel-verification'].needs, 'signed-universal');
  assert.match(text, /desktop:build:mac -- --universal/);
  assert.match(text, /lipo -archs/);
  for (const command of ['codesign --verify', 'spctl --assess', 'xcrun stapler validate']) assert.match(text, new RegExp(command));
  assert.match(text, /Lume-\*-mac-universal\.dmg/);
  const signedJobs = JSON.stringify([value.jobs['signed-universal'], value.jobs['signed-intel-verification']]);
  assert.equal((signedJobs.match(/macos-universal-native\.mjs/g) || []).length, 2);
});

test('CI comum monta o universal no arm64 e transfere o mesmo app para Intel', () => {
  const {text, value} = workflow('macos.yml');
  const build = value.jobs['universal-unsigned'];
  const intel = value.jobs['universal-unsigned-intel'];
  assert.equal(value.on.push.paths, undefined);
  assert.equal(build['runs-on'], 'macos-15');
  assert.equal(build.needs, 'smoke');
  assert.equal(intel['runs-on'], 'macos-15-intel');
  assert.equal(intel.needs, 'universal-unsigned');
  assert.doesNotMatch(JSON.stringify(build) + JSON.stringify(intel), /secrets\.|macos-signing/);
  const prepareAt = text.indexOf('npm run desktop:deps:mac:universal');
  const universalAt = text.indexOf('electron-builder --dir --mac --universal');
  assert.ok(prepareAt >= 0 && prepareAt < universalAt);
  assert.match(text, /lume-macos-universal-unsigned-candidate/);
  assert.match(text, /cd work\/macos-universal-transfer && shasum -a 512 Lume\.app\.zip/);
  assert.match(text, /ditto -x -k/);
  assert.match(text, /shasum -a 512 -c Lume\.app\.zip\.sha512/);
  assert.equal((JSON.stringify(build).match(/macos-universal-native\.mjs/g) || []).length, 1);
  assert.equal((JSON.stringify(intel).match(/macos-universal-native\.mjs/g) || []).length, 1);
});

test('release publica um único pacote universal após duas provas nativas', () => {
  const { text, value } = workflow('release.yml');
  assert.equal(value.jobs['macos-build']['runs-on'], 'macos-15');
  assert.equal(value.jobs['macos-intel']['runs-on'], 'macos-15-intel');
  assert.equal(value.jobs['macos-intel'].needs, 'macos-build');
  assert.equal(value.jobs['macos-intel'].environment, undefined);
  assert.doesNotMatch(JSON.stringify(value.jobs['macos-intel']), /secrets\.|CSC_LINK|APPLE_API_KEY|MAC_NOTARIZATION/);
  const finalUpload = value.jobs['macos-intel'].steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(finalUpload.with.name, 'release-macos');
  assert.match(text, /--platform macos --architecture arm64/);
  assert.match(text, /--platform macos --architecture x64/);
  assert.match(text, /--architecture x64 --public-verification/);
  assert.match(text, /--merge-macos/);
  assert.match(text, /release-proof-macos\.json/);
  assert.equal((text.match(/macos-universal-native\.mjs/g) || []).length, 2);
  assert.doesNotMatch(text, /-mac-(?:arm64|x64)\.(?:dmg|zip)/);
});

test('prova de atualização cobre o mesmo DMG universal em arm64 e x64', () => {
  const { text, value } = workflow('update-proof.yml');
  const matrix = value.jobs.macos.strategy.matrix.include;
  assert.deepEqual(matrix.map(item => [item.architecture, item.runner]), [
    ['arm64', 'macos-15'],
    ['x64', 'macos-15-intel']
  ]);
  assert.match(text, /Lume-\$\{BASELINE_VERSION\}-mac-universal\.dmg/);
  assert.match(text, /lume-update-proof-macos-\$\{\{ matrix\.architecture \}\}/);
  assert.match(text, /macos-universal-native\.mjs/);
  assert.doesNotMatch(text, /mac-arm64\.dmg/);
});

test('dependências nativas do pacote universal preservam Intel e Apple Silicon', () => {
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(metadata.overrides['@huggingface/transformers']['onnxruntime-node'], '1.23.2');
  assert.equal(metadata.overrides['adm-zip'], '0.6.1');
  assert.equal(metadata.dependencies['onnxruntime-node'], '1.23.2');
  const runtimes=Object.entries(lock.packages).filter(([path])=>path.endsWith('/onnxruntime-node'));
  assert.ok(runtimes.length>0);
  for(const [,runtime] of runtimes)assert.equal(runtime.version,'1.23.2');
  assert.deepEqual(lock.packages[''].optionalDependencies, metadata.optionalDependencies);
  assert.match(metadata.build.mac.singleArchFiles, /sharp-libvips/);
  assert.match(metadata.build.mac.singleArchFiles, /onnxruntime-node/);
  const allowIdenticalNativeBinary = metadata.build.mac.x64ArchFiles;
  for (const path of [
    'Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.4.node',
    'Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64-0.35.4.node',
    'Contents/Resources/app.asar.unpacked/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.dylib',
    'Contents/Resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.dylib',
    'Contents/Resources/app.asar.unpacked/node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/libonnxruntime.dylib'
  ]) assert.equal(minimatch(path, allowIdenticalNativeBinary, { matchBase: true }), true, path);
  assert.equal(minimatch('Contents/MacOS/Lume', allowIdenticalNativeBinary, { matchBase: true }), false);
  assert.equal(minimatch('Contents/Resources/app.asar.unpacked/node_modules/outro/addon.node', allowIdenticalNativeBinary, { matchBase: true }), false);
});

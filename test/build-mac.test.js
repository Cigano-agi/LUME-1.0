import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepararBuildMac } from '../desktop/build-mac.mjs';
import { caminhosPacote } from '../desktop/package-layout.mjs';
import { readFileSync } from 'node:fs';
import { normalize } from 'node:path';

test('build Mac: recusa plataforma, argumentos e configuração incompleta antes de iniciar ferramentas', () => {
  for (const platform of ['win32', 'linux']) assert.throws(() => prepararBuildMac({ platform, args: [], env: {} }), /Mac autorizado/);
  for (const args of [['--publish', 'always'], ['--config.mac.notarize=false'], ['--check', '--check']]) assert.throws(() => prepararBuildMac({ platform: 'darwin', args, env: {} }), /argumentos/);
  for (const env of [{}, { APPLE_API_KEY: 'synthetic' }, { APPLE_KEYCHAIN: 'local' }, { APPLE_ID: 'synthetic', APPLE_APP_SPECIFIC_PASSWORD: 'synthetic' }])
    assert.throws(() => prepararBuildMac({ platform: 'darwin', arch: 'arm64', args: [], env }), /conjunto completo/);
});

test('build Mac: cada arquitetura nativa exige assinatura, notarização e ausência de publicação', () => {
  for (const arch of ['arm64', 'x64']) {
    const env = { APPLE_KEYCHAIN: 'synthetic-keychain', APPLE_KEYCHAIN_PROFILE: 'synthetic-profile' };
    const plan = prepararBuildMac({ platform: 'darwin', arch, args: [], env });
    assert.deepEqual(plan.args, ['--mac', 'dmg', 'zip', `--${arch}`, '--publish', 'never', '--config.forceCodeSigning=true', '--config.mac.notarize=true']);
    assert.equal(plan.check, false);
    assert.equal(prepararBuildMac({ platform: 'darwin', arch, args: ['--check'], env }).check, true);
    for (const extra of [{ CSC_NAME: '-' }, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }]) assert.throws(() => prepararBuildMac({ platform: 'darwin', arch, args: [], env: { ...env, ...extra } }), /Developer ID/);
    assert.ok(!JSON.stringify(plan).includes('synthetic'));
  }
});

test('build Mac: universal mantem assinatura e notarizacao obrigatorias', () => {
  const env = { APPLE_KEYCHAIN_PROFILE: 'synthetic-profile' };
  for (const hostArch of ['arm64', 'x64']) {
    const plan = prepararBuildMac({ platform: 'darwin', arch: hostArch, args: ['--universal'], env });
    assert.equal(plan.arch, 'universal');
    assert.equal(plan.hostArch, hostArch);
    assert.deepEqual(plan.args, ['--mac', 'dmg', 'zip', '--universal', '--publish', 'never', '--config.forceCodeSigning=true', '--config.mac.notarize=true']);
    assert.equal(prepararBuildMac({ platform: 'darwin', arch: hostArch, args: ['--check', '--universal'], env }).check, true);
  }
});

test('release Mac exige config do Laya e a entrega ao empacotador',()=>{
  const env={APPLE_KEYCHAIN_PROFILE:'synthetic-profile',GITHUB_ACTIONS:'true',LUME_RELEASE_APPROVED:'PUBLICAR'};
  assert.throws(()=>prepararBuildMac({platform:'darwin',arch:'arm64',args:['--universal'],env}),/modelo Laya verificado/);
  const plan=prepararBuildMac({platform:'darwin',arch:'arm64',args:['--universal'],env:{...env,LUME_LAYA_BUILD_CONFIG:'work/laya-bundled-electron-builder.json'}});
  assert.deepEqual(plan.args.slice(-2),['--config','work/laya-bundled-electron-builder.json']);
});

test('pacote: seleciona bundle e artefato da mesma plataforma/arquitetura e rejeita destino desconhecido', () => {
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  for (const [platform, arch, relative] of [['darwin','arm64','mac-arm64/Lume.app/Contents/Resources/app.asar'],['darwin','x64','mac/Lume.app/Contents/Resources/app.asar'],['darwin','universal','mac-universal/Lume.app/Contents/Resources/app.asar'],['win32','x64','win-unpacked/resources/app.asar']]) {
    const paths = caminhosPacote({ output: 'dist/test', platform, arch, metadata });
    assert.equal(paths.archive, normalize('dist/test/'+relative));
    assert.ok(paths.artifact.includes(metadata.version));
    assert.ok(paths.artifact.includes(arch));
    assert.ok(paths.artifact.endsWith(platform==='darwin'?'.dmg':'.exe'));
  }
  for (const [platform, arch] of [['linux','x64'],['darwin','../x'],['win32','arm64']]) assert.throws(() => caminhosPacote({ output: 'dist/test', platform, arch, metadata }));
});

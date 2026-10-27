import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {configureWindowsArchive}=require('../scripts/broker-acl-before-pack.cjs');
const {compute7zCompressArgs}=require('app-builder-lib/out/targets/archive');

test('NSIS Windows usa filtro decodificável nos argumentos reais do electron-builder',()=>{
  const previous=process.env.ELECTRON_BUILDER_7Z_FILTER;
  try {
    process.env.ELECTRON_BUILDER_7Z_FILTER='BCJ2';
    configureWindowsArchive();
    const args=compute7zCompressArgs('7z',{compression:'maximum'});
    assert.ok(args.includes('-mf=BCJ'));
    assert.equal(args.some(x=>x==='-mf=ARM64'||x==='-mf=BCJ2'),false);
  } finally {
    if(previous===undefined)delete process.env.ELECTRON_BUILDER_7Z_FILTER;
    else process.env.ELECTRON_BUILDER_7Z_FILTER=previous;
  }
});

test('configuração do filtro preserva demais opções e é idempotente',()=>{
  const env={ELECTRON_BUILDER_COMPRESSION_LEVEL:'9',OTHER_BUILD_OPTION:'preserved'};
  configureWindowsArchive(env);configureWindowsArchive(env);
  assert.deepEqual(env,{ELECTRON_BUILDER_COMPRESSION_LEVEL:'9',OTHER_BUILD_OPTION:'preserved',ELECTRON_BUILDER_7Z_FILTER:'BCJ'});
});

test('hook restringe filtro ao build Windows suportado sem trocar dependências',()=>{
  const source=readFileSync(new URL('../scripts/broker-acl-before-pack.cjs',import.meta.url),'utf8');
  const platform=source.indexOf("if (context.electronPlatformName !== 'win32') return;");
  const arch=source.indexOf("if (context.arch !== Arch.x64) throw");
  const configure=source.indexOf('exports.configureWindowsArchive();');
  assert.ok(platform>=0&&arch>platform&&configure>arch);
});

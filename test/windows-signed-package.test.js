import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {copyFile,mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {prepareNativeStaging} from '../scripts/windows-signed-staging.mjs';
import {verifySignedPackage} from '../scripts/verify-windows-signed-package.mjs';
import {deriveWindowsSignedConfig,WINDOWS_NATIVE_EXCLUDES} from '../scripts/prepare-windows-signed-build.mjs';

const require=createRequire(import.meta.url);
const {createPackage}=require('@electron/asar');
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'lume-signed-package-'));
  t.after(async()=>{
    const actual=await realpath(root),parent=await realpath(tmpdir());
    if(actual.startsWith(parent+sep)&&resolve(actual)===resolve(root))await rm(root,{recursive:true,force:true});
  });
  const aclDir=join(root,'source-acl'),audioDir=join(root,'source-audio');
  const stageDir=join(root,'stage'),packageDir=join(root,'win-unpacked');
  const policyPath=join(root,'policy.json');
  await mkdir(aclDir);await mkdir(audioDir);
  const acl=Buffer.from('MZacl'),exe=Buffer.from('MZwhisper'),dll=Buffer.from('MZdll'),model=Buffer.from('model');
  await writeFile(join(aclDir,'lume-acl.exe'),acl);
  await writeFile(join(aclDir,'manifest.json'),JSON.stringify({schema:1,platform:'win32',arch:'x64',file:'lume-acl.exe',sha256:hash(acl),sourceSha256:hash('source')})+'\n');
  const files=[['modelo.bin',model],['whisper-cli.exe',exe],['whisper.dll',dll]].map(([nome,bytes])=>({nome,bytes:bytes.length,sha256:hash(bytes)}));
  for(const [name,bytes] of [['modelo.bin',model],['whisper-cli.exe',exe],['whisper.dll',dll]])await writeFile(join(audioDir,name),bytes);
  const audioManifest=Buffer.from(JSON.stringify({versao:2,plataforma:'win32',arquitetura:'x64',arquivos:files})+'\n');
  await writeFile(join(audioDir,'manifest.json'),audioManifest);
  await writeFile(policyPath,JSON.stringify({versao:1,pacotes:{'win32-x64':{manifestoSha256:hash(audioManifest)}}}));
  await prepareNativeStaging({aclDir,audioDir,policyPath,outputDir:stageDir,
    signFile:async path=>writeFile(path,Buffer.concat([await readFile(path),Buffer.from('-signed')])),
    verifySignature:async path=>(await readFile(path)).toString().endsWith('-signed')});
  const appSource=join(root,'app-source');
  await mkdir(join(appSource,'desktop'),{recursive:true});
  await mkdir(join(appSource,'native','win-acl','bin'),{recursive:true});
  await copyFile(join(stageDir,'desktop','audio-local-policy.json'),join(appSource,'desktop','audio-local-policy.json'));
  await copyFile(join(stageDir,'native','win-acl','bin','manifest.json'),join(appSource,'native','win-acl','bin','manifest.json'));
  const resources=join(packageDir,'resources');
  await mkdir(join(resources,'app.asar.unpacked','native','win-acl','bin'),{recursive:true});
  await mkdir(join(resources,'audio-local'),{recursive:true});
  await createPackage(appSource,join(resources,'app.asar'));
  await copyFile(join(stageDir,'native','win-acl','bin','lume-acl.exe'),join(resources,'app.asar.unpacked','native','win-acl','bin','lume-acl.exe'));
  for(const name of ['modelo.bin','whisper-cli.exe','whisper.dll','manifest.json'])
    await copyFile(join(stageDir,'audio-local',name),join(resources,'audio-local',name));
  return{root,stageDir,packageDir,resources};
}

test('recibo, política no ASAR e auxiliares no pacote conservam os mesmos bytes',async t=>{
  const f=await fixture(t);
  const result=await verifySignedPackage({stageDir:f.stageDir,packageDir:f.packageDir,signatureValid:async()=>true});
  assert.equal(result.ok,true);
  assert.equal(result.nativeFiles,3);
  await writeFile(join(f.resources,'audio-local','whisper.dll'),'MZtampered');
  await assert.rejects(verifySignedPackage({stageDir:f.stageDir,packageDir:f.packageDir,signatureValid:async()=>true}),
    /WINDOWS_SIGNED_PACKAGE_INVALID/);
});

test('config assinada troca fontes nativas, preserva Laya e exclui binários de outras plataformas',()=>{
  const config={files:['desktop/main.cjs','desktop/audio-local-policy.json'],
    extraResources:[{from:'work/laya',to:'laya',filter:['encoder.onnx']}],
    win:{files:['native/win-acl/bin/lume-acl.exe','native/win-acl/bin/manifest.json',...WINDOWS_NATIVE_EXCLUDES],
      extraResources:[{from:'native/audio-local/bin',to:'audio-local'}]}};
  const signed=deriveWindowsSignedConfig(config,'C:\\stage','Synthetic Publisher');
  assert.equal(config.files[1],'desktop/audio-local-policy.json');
  assert.equal(signed.files[1].to,'desktop');
  assert.equal(signed.win.files[0].to,'native/win-acl/bin');
  assert.equal(signed.win.forceCodeSigning,true);
  assert.equal(signed.win.signtoolOptions.publisherName,'Synthetic Publisher');
  assert.deepEqual(signed.win.signExts,['.dll','.node']);
  assert.equal(signed.extraResources[0].to,'laya');
  assert.equal(signed.extraResources[1].to,'audio-local');
  assert.deepEqual(signed.win.files.slice(1),WINDOWS_NATIVE_EXCLUDES);
  assert.equal(signed.beforePack,'scripts/windows-signed-before-pack.cjs');
});

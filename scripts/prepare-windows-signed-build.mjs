// Build-only staging. It never changes the unsigned source binaries or the installed app.
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareNativeStaging} from './windows-signed-staging.mjs';
import {certificateIdentity,validSignature,signAuthenticode} from './windows-signing-authenticode.mjs';

const root=resolve(import.meta.dirname,'..');
export const WINDOWS_NATIVE_EXCLUDES=Object.freeze([
  '!**/onnxruntime-node/bin/napi-v6/darwin/**',
  '!**/onnxruntime-node/bin/napi-v6/linux/**',
  '!**/@img/*darwin*/**',
  '!**/@img/*linux*/**'
]);
export function deriveWindowsSignedConfig(config,stageRoot,commonName){
  const oldPolicy='desktop/audio-local-policy.json';
  if(!commonName||!Array.isArray(config.files)||!config.files.includes(oldPolicy)||!config.win||
     !Array.isArray(config.extraResources)||!config.extraResources.some(x=>x.to==='laya')||
     !Array.isArray(config.win.files)||WINDOWS_NATIVE_EXCLUDES.some(x=>!config.win.files.includes(x)))
    throw Error('WINDOWS_BUILD_CONFIG_INVALID');
  const result=structuredClone(config);
  result.files=result.files.map(x=>x===oldPolicy?{
    from:join(stageRoot,'desktop'),to:'desktop',filter:['audio-local-policy.json']
  }:x);
  result.beforePack='scripts/windows-signed-before-pack.cjs';
  result.win={...result.win,forceCodeSigning:true,signExts:['.dll','.node'],
    files:[{from:join(stageRoot,'native','win-acl','bin'),to:'native/win-acl/bin',filter:['lume-acl.exe','manifest.json']},
      ...WINDOWS_NATIVE_EXCLUDES],
    signtoolOptions:{...result.win.signtoolOptions,publisherName:commonName,
      signingHashAlgorithms:['sha256'],sign:'scripts/windows-signed-hook.cjs'}};
  result.extraResources.push({from:join(stageRoot,'audio-local'),to:'audio-local',filter:['**/*']});
  delete result.win.extraResources;
  return result;
}
export async function prepare({env=process.env,outputDir=join(root,'work','windows-signed-stage')}={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('WINDOWS_SIGNING_REQUIRES_X64_HOST');
  const certificate=env.CSC_LINK, password=env.CSC_KEY_PASSWORD;
  const {thumbprint,commonName}=certificateIdentity(certificate,password);
  const signFile=async file=>signAuthenticode(file,{certificate,password,thumbprint});
  const stage=await prepareNativeStaging({
    aclDir:join(root,'native','win-acl','bin'),audioDir:join(root,'native','audio-local','bin'),
    policyPath:join(root,'desktop','audio-local-policy.json'),outputDir,signFile,
    verifySignature:file=>validSignature(file,thumbprint)
  });
  const sourceConfig=env.LUME_LAYA_BUILD_CONFIG||join(root,'work','laya-bundled-electron-builder.json');
  const config=JSON.parse(await readFile(sourceConfig,'utf8'));
  const signedConfig=deriveWindowsSignedConfig(config,stage.root,commonName);
  const configPath=join(root,'work','windows-signed-electron-builder.json');
  await writeFile(configPath,JSON.stringify(signedConfig,null,2)+'\n');
  if(env.GITHUB_ENV)await writeFile(env.GITHUB_ENV,
    `LUME_WINDOWS_SIGNER_THUMBPRINT=${thumbprint}\nLUME_WINDOWS_SIGN_CERTIFICATE=${resolve(certificate)}\n`,{flag:'a'});
  return{configPath,stage:stage.root,thumbprint};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  prepare().then(x=>console.log('WINDOWS_SIGNED_BUILD_PREPARED',JSON.stringify(x)))
    .catch(e=>{console.error(e.message);process.exitCode=1;});

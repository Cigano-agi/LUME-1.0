// Verify staged signed bytes survived packaging without changing the runtime policies.
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {digest} from './windows-signed-staging.mjs';
import {validSignature} from './windows-signing-authenticode.mjs';

const require=createRequire(import.meta.url);
const {extractFile,listPackage}=require('@electron/asar');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw Error('WINDOWS_SIGNED_PACKAGE_INVALID');};
async function checked(file,expected){
  const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||await digest(file)!==expected)fail();
}
export async function verifySignedPackage({stageDir,packageDir,signatureValid=()=>false}){
  const stage=resolve(stageDir),pkg=resolve(packageDir);
  const receipt=JSON.parse(await readFile(join(stage,'receipt.json'),'utf8'));
  if(receipt.schema!=='lume-windows-signed-staging-v1'||!Array.isArray(receipt.nativeFiles)||
     !/^[a-f0-9]{64}$/.test(receipt.aclManifestSha256)||
     !/^[a-f0-9]{64}$/.test(receipt.audioManifestSha256)||
     !/^[a-f0-9]{64}$/.test(receipt.policySha256))fail();
  const archive=join(pkg,'resources','app.asar');
  const files=listPackage(archive).map(x=>x.replaceAll('\\','/'));
  if(files.filter(x=>x==='/desktop/audio-local-policy.json').length!==1||
     files.filter(x=>x==='/native/win-acl/bin/manifest.json').length!==1)fail();
  const policyBytes=extractFile(archive,join('desktop','audio-local-policy.json'));
  const aclBytes=extractFile(archive,join('native','win-acl','bin','manifest.json'));
  const audioBytes=await readFile(join(pkg,'resources','audio-local','manifest.json'));
  if(sha(policyBytes)!==receipt.policySha256||sha(aclBytes)!==receipt.aclManifestSha256||
     sha(audioBytes)!==receipt.audioManifestSha256)fail();
  const policy=JSON.parse(policyBytes),acl=JSON.parse(aclBytes),audio=JSON.parse(audioBytes);
  if(policy.pacotes?.['win32-x64']?.manifestoSha256!==sha(audioBytes)||
     !Array.isArray(audio.arquivos)||!audio.arquivos.length)fail();
  const expected=new Set();
  for(const item of receipt.nativeFiles){
    if(!/^(native\/win-acl\/bin|audio-local)\/[a-zA-Z0-9._-]+\.(exe|dll)$/.test(item.path)||
       expected.has(item.path)||!Number.isSafeInteger(item.bytes)||item.bytes<1||
       !/^[a-f0-9]{64}$/.test(item.sha256))fail();
    expected.add(item.path);
    const packed=item.path.startsWith('audio-local/')
      ?join(pkg,'resources',item.path)
      :join(pkg,'resources','app.asar.unpacked',item.path);
    await checked(join(stage,item.path),item.sha256);
    await checked(packed,item.sha256);
    if(await signatureValid(packed)!==true)fail();
  }
  const aclEntry=receipt.nativeFiles.find(x=>x.path==='native/win-acl/bin/lume-acl.exe');
  if(!aclEntry||acl.sha256!==aclEntry.sha256)fail();
  for(const item of audio.arquivos){
    if(!/^[a-zA-Z0-9._-]+$/.test(item.nome)||!Number.isSafeInteger(item.bytes)||
       !/^[a-f0-9]{64}$/.test(item.sha256))fail();
    const file=join(pkg,'resources','audio-local',item.nome);
    await checked(file,item.sha256);
    if(/\.(exe|dll)$/i.test(item.nome)&&!expected.has(`audio-local/${item.nome}`))fail();
  }
  return{ok:true,nativeFiles:expected.size,aclManifestSha256:receipt.aclManifestSha256,
    audioManifestSha256:receipt.audioManifestSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const thumbprint=process.env.LUME_WINDOWS_SIGNER_THUMBPRINT;
  if(!/^[a-f0-9]{40}$/i.test(thumbprint??''))throw Error('WINDOWS_SIGNER_IDENTITY_MISSING');
  verifySignedPackage({stageDir:join(import.meta.dirname,'..','work','windows-signed-stage'),
    packageDir:process.argv[2]||join(import.meta.dirname,'..','dist','desktop','win-unpacked'),
    signatureValid:path=>validSignature(path,thumbprint)})
    .then(x=>console.log('WINDOWS_SIGNED_PACKAGE_OK',JSON.stringify(x)))
    .catch(e=>{console.error(e.message);process.exitCode=1;});
}

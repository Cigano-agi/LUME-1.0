// Prepare signed native bytes before electron-builder seals app.asar and resources.
// No certificate or signing key is stored in this module or its receipt.
import {createHash} from 'node:crypto';
import {createReadStream,constants} from 'node:fs';
import {copyFile,lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const hex=/^[a-f0-9]{64}$/;
const name=/^[a-zA-Z0-9._-]{1,80}$/;
const fail=()=>{throw Error('WINDOWS_SIGNED_STAGING_INVALID');};
export async function digest(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
async function regular(path){
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail();
  return stat;
}
async function exactFiles(dir,expected){
  const entries=await readdir(dir,{withFileTypes:true});
  if(entries.length!==expected.length||entries.some(x=>!expected.includes(x.name)||!x.isFile()||x.isSymbolicLink()))fail();
}
async function copyChecked(source,target,expected){
  const stat=await regular(source);
  if(!Number.isSafeInteger(expected.bytes)||expected.bytes<1||!hex.test(expected.sha256)||
     stat.size!==expected.bytes||await digest(source)!==expected.sha256)fail();
  await copyFile(source,target,constants.COPYFILE_EXCL);
  const copied=await regular(target);
  if(copied.size!==expected.bytes||await digest(target)!==expected.sha256)fail();
}
async function measure(path){const stat=await regular(path);return{bytes:stat.size,sha256:await digest(path)};}
function parseJson(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{fail();}}

export async function prepareNativeStaging({aclDir,audioDir,policyPath,outputDir,signFile,verifySignature}){
  if(typeof signFile!=='function'||typeof verifySignature!=='function')fail();
  const aclManifestPath=join(aclDir,'manifest.json'),audioManifestPath=join(audioDir,'manifest.json');
  const [aclBytes,audioBytes,policyBytes]=await Promise.all([
    readFile(aclManifestPath),readFile(audioManifestPath),readFile(policyPath)
  ]);
  const acl=parseJson(aclBytes),audio=parseJson(audioBytes),policy=parseJson(policyBytes);
  if(acl.schema!==1||acl.platform!=='win32'||acl.arch!=='x64'||acl.file!=='lume-acl.exe'||
     !hex.test(acl.sha256)||!hex.test(acl.sourceSha256))fail();
  if(audio.versao!==2||audio.plataforma!=='win32'||audio.arquitetura!=='x64'||
     !Array.isArray(audio.arquivos)||audio.arquivos.length<2||audio.arquivos.length>32||
     !audio.arquivos.some(x=>x.nome==='modelo.bin')||!audio.arquivos.some(x=>x.nome==='whisper-cli.exe')||
     !audio.arquivos.some(x=>x.nome==='whisper.dll')||
     audio.arquivos.some(x=>!x||!name.test(x.nome)||!Number.isSafeInteger(x.bytes)||x.bytes<1||!hex.test(x.sha256))||
     new Set(audio.arquivos.map(x=>x.nome)).size!==audio.arquivos.length)fail();
  if(policy.versao!==1||policy.pacotes?.['win32-x64']?.manifestoSha256!==createHash('sha256').update(audioBytes).digest('hex'))fail();
  await exactFiles(aclDir,['lume-acl.exe','manifest.json']);
  await exactFiles(audioDir,['manifest.json',...audio.arquivos.map(x=>x.nome)]);
  await regular(aclManifestPath);await regular(audioManifestPath);await regular(policyPath);
  const out=resolve(outputDir),aclOut=join(out,'native','win-acl','bin'),audioOut=join(out,'audio-local'),desktopOut=join(out,'desktop');
  await mkdir(out);await mkdir(join(out,'native'));await mkdir(join(out,'native','win-acl'));
  await mkdir(aclOut);await mkdir(audioOut);await mkdir(desktopOut);
  await copyChecked(join(aclDir,acl.file),join(aclOut,acl.file),{bytes:(await regular(join(aclDir,acl.file))).size,sha256:acl.sha256});
  for(const item of audio.arquivos)await copyChecked(join(audioDir,item.nome),join(audioOut,item.nome),item);
  const nativeFiles=[join(aclOut,acl.file),...audio.arquivos.filter(x=>/\.(exe|dll)$/i.test(x.nome)).map(x=>join(audioOut,x.nome))];
  for(const file of nativeFiles){
    await signFile(file);
    await regular(file);
    if(await verifySignature(file)!==true)fail();
  }
  const signedAcl={...acl,sha256:(await measure(join(aclOut,acl.file))).sha256};
  const signedAudio={...audio,arquivos:await Promise.all(audio.arquivos.map(async item=>({nome:item.nome,...await measure(join(audioOut,item.nome))})))};
  const finalAclBytes=Buffer.from(JSON.stringify(signedAcl)+'\n');
  const finalAudioBytes=Buffer.from(JSON.stringify(signedAudio)+'\n');
  const finalPolicy={...policy,pacotes:{...policy.pacotes,'win32-x64':{
    ...policy.pacotes['win32-x64'],manifestoSha256:createHash('sha256').update(finalAudioBytes).digest('hex')
  }}};
  const finalPolicyBytes=Buffer.from(JSON.stringify(finalPolicy,null,2)+'\n');
  await writeFile(join(aclOut,'manifest.json'),finalAclBytes,{flag:'wx'});
  await writeFile(join(audioOut,'manifest.json'),finalAudioBytes,{flag:'wx'});
  await writeFile(join(desktopOut,'audio-local-policy.json'),finalPolicyBytes,{flag:'wx'});
  const receipt={schema:'lume-windows-signed-staging-v1',nativeFiles:await Promise.all(nativeFiles.map(async file=>({
    path:file.slice(out.length+1).replaceAll('\\','/'),...await measure(file)
  }))),aclManifestSha256:createHash('sha256').update(finalAclBytes).digest('hex'),
    audioManifestSha256:finalPolicy.pacotes['win32-x64'].manifestoSha256,
    policySha256:createHash('sha256').update(finalPolicyBytes).digest('hex')};
  await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  return{root:out,receipt};
}

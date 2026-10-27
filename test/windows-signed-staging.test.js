import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {prepareNativeStaging,digest} from '../scripts/windows-signed-staging.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'lume-sign-test-'));
  t.after(async()=>{
    const actual=await realpath(root),parent=await realpath(tmpdir());
    if(actual.startsWith(parent+sep)&&resolve(actual)===resolve(root))await rm(root,{recursive:true,force:true});
  });
  const aclDir=join(root,'acl'),audioDir=join(root,'audio'),policyPath=join(root,'policy.json'),outputDir=join(root,'stage');
  await mkdir(aclDir);await mkdir(audioDir);
  const aclBytes=Buffer.from('MZacl-unsigned'),audioExe=Buffer.from('MZwhisper-unsigned');
  const audioDll=Buffer.from('MZdll-unsigned'),model=Buffer.from('synthetic-model');
  await writeFile(join(aclDir,'lume-acl.exe'),aclBytes);
  await writeFile(join(audioDir,'whisper-cli.exe'),audioExe);
  await writeFile(join(audioDir,'whisper.dll'),audioDll);
  await writeFile(join(audioDir,'modelo.bin'),model);
  const acl={schema:1,platform:'win32',arch:'x64',file:'lume-acl.exe',sha256:hash(aclBytes),sourceSha256:hash('source')};
  const audio={versao:2,motor:'whisper.cpp',versaoMotor:'test',plataforma:'win32',arquitetura:'x64',modeloNome:'synthetic',
    arquivos:[['modelo.bin',model],['whisper-cli.exe',audioExe],['whisper.dll',audioDll]].map(([nome,bytes])=>({nome,bytes:bytes.length,sha256:hash(bytes)}))};
  const audioManifest=Buffer.from(JSON.stringify(audio)+'\n');
  await writeFile(join(aclDir,'manifest.json'),JSON.stringify(acl)+'\n');
  await writeFile(join(audioDir,'manifest.json'),audioManifest);
  await writeFile(policyPath,JSON.stringify({versao:1,pacotes:{'win32-x64':{manifestoSha256:hash(audioManifest)}}}));
  const signFile=async path=>writeFile(path,Buffer.concat([await readFile(path),Buffer.from('-signed')]));
  const verifySignature=async path=>(await readFile(path)).toString().endsWith('-signed');
  return{root,aclDir,audioDir,policyPath,outputDir,signFile,verifySignature};
}

test('assinatura antecede manifesto e política; modelo e fontes originais ficam intactos',async t=>{
  const f=await fixture(t);
  const sourceHash=await digest(join(f.audioDir,'modelo.bin'));
  const {receipt}=await prepareNativeStaging(f);
  const acl=JSON.parse(await readFile(join(f.outputDir,'native','win-acl','bin','manifest.json')));
  const audioBytes=await readFile(join(f.outputDir,'audio-local','manifest.json'));
  const audio=JSON.parse(audioBytes);
  const policy=JSON.parse(await readFile(join(f.outputDir,'desktop','audio-local-policy.json')));
  assert.equal(acl.sha256,await digest(join(f.outputDir,'native','win-acl','bin','lume-acl.exe')));
  assert.equal(audio.arquivos.find(x=>x.nome==='whisper-cli.exe').sha256,await digest(join(f.outputDir,'audio-local','whisper-cli.exe')));
  assert.equal(audio.arquivos.find(x=>x.nome==='whisper.dll').sha256,await digest(join(f.outputDir,'audio-local','whisper.dll')));
  assert.equal(audio.arquivos.find(x=>x.nome==='modelo.bin').sha256,sourceHash);
  assert.equal(policy.pacotes['win32-x64'].manifestoSha256,hash(audioBytes));
  assert.equal(receipt.audioManifestSha256,hash(audioBytes));
  assert.equal((await readFile(join(f.aclDir,'lume-acl.exe'))).toString(),'MZacl-unsigned');
  assert.equal((await readFile(join(f.audioDir,'whisper-cli.exe'))).toString(),'MZwhisper-unsigned');
});

test('assinatura rejeitada impede recibo final',async t=>{
  const f=await fixture(t);
  f.verifySignature=async()=>false;
  await assert.rejects(prepareNativeStaging(f),/WINDOWS_SIGNED_STAGING_INVALID/);
  await assert.rejects(readFile(join(f.outputDir,'receipt.json')),{code:'ENOENT'});
});

test('fonte adulterada não chega à assinatura',async t=>{
  const f=await fixture(t);let signed=0;
  f.signFile=async()=>{signed++;};
  await writeFile(join(f.audioDir,'whisper.dll'),'MZtampered');
  await assert.rejects(prepareNativeStaging(f),/WINDOWS_SIGNED_STAGING_INVALID/);
  assert.equal(signed,0);
});

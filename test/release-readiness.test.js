import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {candidateBuildArgs} from '../scripts/construir-candidato.mjs';
import {inspectReleaseReadiness,mergeMacNativeProofs,recordNativeProof,ReleaseReadinessError} from '../scripts/release-readiness.mjs';
import {inspectVersionContract,assertVersionContract,VersionContractError} from '../scripts/version-contract.mjs';

const VERSION='3.2.0-beta.6';
const BETA06_REQUIREMENTS=['L06-ORG','L06-ACOES','L06-ONB','L06-DIST','L06-FEED','L06-TRUST','L06-UI','L06-AUDIO','L06-OPS','L06-PILOTO'];
const ci={LUME_RELEASE_APPROVED:'PUBLICAR',GITHUB_ACTIONS:'true',GITHUB_REF_TYPE:'tag',GITHUB_REF_NAME:'v'+VERSION,GITHUB_RUN_ID:'123'};
const publishCi={LUME_RELEASE_APPROVED:'PUBLICAR',LUME_RELEASE_CONFIRMATION:'PUBLICAR',LUME_RELEASE_TAG:'v'+VERSION,LUME_RELEASE_SOURCE_RUN_ID:'123',GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'999'};
const win={...ci,WINDOWS_CERTIFICATE_P12_BASE64:'base64',CSC_KEY_PASSWORD:'senha'};
const mac={...ci,CSC_LINK:'certificado',CSC_KEY_PASSWORD:'senha',APPLE_API_KEY:'/tmp/key',APPLE_API_KEY_ID:'key',APPLE_API_ISSUER:'issuer'};
const macPublic={...ci,LUME_NATIVE_VERIFICATION:'VERIFICADO',LUME_PUBLIC_SIGNATURE_VERIFICATION:'VERIFICADO'};
const workflow=`on:\n  push:\n    tags:\n      - "v3.*"\njobs:\n  windows:\n    runs-on: windows-2025\n    environment: windows-signing\n    path: release-proof-windows.json\n  macos-build:\n    runs-on: macos-15\n    environment: macos-signing\n    run: node scripts/release-readiness.mjs --platform macos --architecture arm64\n  macos-intel:\n    runs-on: macos-15-intel\n    run: node scripts/release-readiness.mjs --platform macos --architecture x64 --public-verification && node scripts/release-readiness.mjs --merge-macos\n`;
const layaWorkflow=`  - run: node scripts/laya-release-assets.mjs prepare\n  - run: node scripts/prepare-windows-signed-build.mjs\n  - run: npm run desktop:build -- --config work/windows-signed-electron-builder.json\n  - run: node scripts/verify-windows-signatures.mjs\n  - run: node scripts/verify-windows-signed-package.mjs\n  - run: node scripts/laya-release-assets.mjs verify windows\n  - run: node scripts/laya-release-assets.mjs verify macos\n`;
const publishWorkflow=`on:\n  workflow_dispatch:\n    inputs:\n      confirmation:\n      build_run_id:\njobs:\n  publish:\n    environment: release-beta\n    env:\n      LUME_RELEASE_CONFIRMATION: x\n      LUME_RELEASE_SOURCE_RUN_ID: x\n    run: |\n      if(run.event!=='push'||run.conclusion!=='success'||run.head_sha!==head)throw Error()\n      node scripts/release-readiness.mjs --mode publish\n      node scripts/publicar-release.mjs release-files\n`;

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'lume-release-')),artifacts=join(root,'artifacts');
 t?.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const dir of ['desktop','mcpb/lume','.github/workflows','artifacts','docs/beta-06'])mkdirSync(join(root,dir),{recursive:true});
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'assessor-2.0',version:VERSION,build:{extraMetadata:{version:VERSION}}}));
 writeFileSync(join(root,'package-lock.json'),JSON.stringify({name:'assessor-2.0',version:VERSION,lockfileVersion:3,packages:{'':{name:'assessor-2.0',version:VERSION}}}));
 writeFileSync(join(root,'mcpb/lume/manifest.json'),JSON.stringify({manifest_version:'0.3',name:'com.readyworks.lume.local-memory',version:VERSION}));
 writeFileSync(join(root,'desktop/release-policy.json'),JSON.stringify({schema:'lume-release-v1',enabled:false,channel:'beta',feedUrl:null}));
 writeFileSync(join(root,'.github/workflows/release.yml'),workflow+layaWorkflow);
 writeFileSync(join(root,'.github/workflows/release-publish.yml'),publishWorkflow);
 writeFileSync(join(root,'docs/beta-06/release-acceptance.json'),JSON.stringify({schema:'lume-beta06-acceptance-v1',version:VERSION,requirements:Object.fromEntries(BETA06_REQUIREMENTS.map(id=>[id,{status:'aprovado',evidence:['teste-fixture']}]))}));
 return{root,artifacts};
}
function artifacts(dir){
 const names=['Lume-'+VERSION+'-win-x64-Setup.exe','Lume-'+VERSION+'-win-x64-Setup.exe.blockmap','Lume-'+VERSION+'-mac-universal.dmg','Lume-'+VERSION+'-mac-universal.zip','Lume-'+VERSION+'-mac-universal.zip.blockmap'];
 for(const name of names)writeFileSync(join(dir,name),'arquivo '+name);
 const hash=name=>createHash('sha512').update(readFileSync(join(dir,name))).digest('base64');
 writeFileSync(join(dir,'beta.yml'),`version: ${VERSION}\nfiles:\n  - url: ${names[0]}\n    sha512: ${hash(names[0])}\npath: ${names[0]}\nsha512: ${hash(names[0])}\n`);
 writeFileSync(join(dir,'beta-mac.yml'),`version: ${VERSION}\nfiles:\n  - url: ${names[2]}\n    sha512: ${hash(names[2])}\n  - url: ${names[3]}\n    sha512: ${hash(names[3])}\npath: ${names[3]}\nsha512: ${hash(names[3])}\n`);
}

test('contrato checkout exige as cinco representacoes e blockers especificos',t=>{
 const cases=[
  ['package.json','missing','PACKAGE_MISSING'],['package.json','{','PACKAGE_MALFORMED'],['package.json',JSON.stringify({version:'3.2.0-alpha.1',build:{extraMetadata:{version:VERSION}}}),'PACKAGE_VERSION'],
  ['package.json',JSON.stringify({version:VERSION,build:{}}),'ELECTRON_METADATA_MISSING'],['package.json',JSON.stringify({version:VERSION,build:{extraMetadata:{version:'3.2.0-beta.4'}}}),'ELECTRON_METADATA_VERSION'],
  ['package-lock.json','missing','PACKAGE_LOCK_MISSING'],['package-lock.json','{','PACKAGE_LOCK_MALFORMED'],['package-lock.json',JSON.stringify({version:'3.2.0-beta.4',packages:{'':{version:VERSION}}}),'PACKAGE_LOCK_VERSION'],
  ['package-lock.json',JSON.stringify({version:VERSION,packages:{}}),'PACKAGE_LOCK_ROOT_MISSING'],['package-lock.json',JSON.stringify({version:VERSION,packages:{'':{version:'3.2.0-beta.4'}}}),'PACKAGE_LOCK_ROOT_VERSION'],
  ['mcpb/lume/manifest.json','missing','MCP_MANIFEST_MISSING'],['mcpb/lume/manifest.json','{','MCP_MANIFEST_MALFORMED'],
  ['mcpb/lume/manifest.json',JSON.stringify({name:'com.readyworks.lume.local-memory',manifest_version:'0.2',version:VERSION}),'MCP_MANIFEST_FORMAT'],
  ['mcpb/lume/manifest.json',JSON.stringify({name:'outro',manifest_version:'0.3',version:VERSION}),'MCP_MANIFEST_NAME'],
  ['mcpb/lume/manifest.json',JSON.stringify({name:'com.readyworks.lume.local-memory',manifest_version:'0.3',version:'3.2.0-beta.4'}),'MCP_MANIFEST_VERSION']
 ];
 for(const [relative,value,id] of cases){
  const f=fixture(t),path=join(f.root,relative);
  if(value==='missing')rmSync(path);else writeFileSync(path,value);
  assert.ok(inspectVersionContract({root:f.root,shape:'checkout'}).blockers.some(item=>item.id===id),id);
  assert.throws(()=>assertVersionContract({root:f.root,shape:'checkout'}),VersionContractError);
 }
});

test('contrato packaged aceita ausencia esperada de build e lock apenas quando solicitado',t=>{
 const f=fixture(t),pkg=JSON.parse(readFileSync(join(f.root,'package.json')));delete pkg.build;writeFileSync(join(f.root,'package.json'),JSON.stringify(pkg));rmSync(join(f.root,'package-lock.json'));
 assert.equal(assertVersionContract({root:f.root,shape:'packaged'}).version,VERSION);
 const strict=inspectVersionContract({root:f.root});
 assert.ok(strict.blockers.some(item=>item.id==='ELECTRON_METADATA_MISSING'));assert.ok(strict.blockers.some(item=>item.id==='PACKAGE_LOCK_MISSING'));
});

test('checkout real esta alinhado e manifest_version permanece 0.3',()=>{
 const root=resolve('.'),expected=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
 const result=assertVersionContract({root,shape:'checkout'});assert.equal(result.version,expected);assert.equal(result.manifest.manifest_version,'0.3');
});

test('candidato interno deriva package.version e mantem atualizacao desligada',t=>{
 const f=fixture(t),result=inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}});
 assert.equal(result.version,VERSION);assert.equal(result.candidateBuildAllowed,true);assert.equal(result.publicationAllowed,false);assert.ok(result.publicationBlockers.some(item=>item.id==='WINDOWS_SIGNING'));
 const policy=join(f.root,'desktop/release-policy.json');writeFileSync(policy,JSON.stringify({schema:'lume-release-v1',enabled:true,channel:'beta',feedUrl:'https://example.test'}));
 assert.equal(inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}}).candidateBuildAllowed,false);
});

test('canal e workflow incoerentes bloqueiam sem alegar prova externa',t=>{
 const f=fixture(t);writeFileSync(join(f.root,'desktop/release-policy.json'),JSON.stringify({schema:'lume-release-v1',enabled:false,channel:'estavel',feedUrl:null}));writeFileSync(join(f.root,'.github/workflows/release.yml'),'jobs: {}');
 const result=inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}});for(const id of ['RELEASE_CHANNEL','RELEASE_WORKFLOW'])assert.ok(result.blockers.some(item=>item.id===id),id);
});

test('workflow exige cada ambiente nomeado sem trata-lo como aprovacao real',t=>{
 for(const name of ['windows-signing','macos-signing']){const f=fixture(t),path=join(f.root,'.github/workflows/release.yml');writeFileSync(path,(workflow+layaWorkflow).replaceAll(name,'ambiente-ausente'));const result=inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}});assert.ok(result.blockers.some(item=>item.id==='RELEASE_WORKFLOW'),name);}
 {const f=fixture(t),path=join(f.root,'.github/workflows/release-publish.yml');writeFileSync(path,publishWorkflow.replace('release-beta','ambiente-ausente'));assert.ok(inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}}).blockers.some(item=>item.id==='RELEASE_WORKFLOW'));}
});

test('workflow exige prova macOS em cada arquitetura sem depender do nome interno do arquivo',t=>{
 const f=fixture(t),path=join(f.root,'.github/workflows/release.yml');
 writeFileSync(path,(workflow+layaWorkflow).replace('--platform macos --architecture x64 --public-verification','--platform macos --public-verification'));
 assert.ok(inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}}).blockers.some(item=>item.id==='RELEASE_WORKFLOW'));
});

test('preflight de plataforma falha fechado por gate tecnico individual',t=>{
 const f=fixture(t),windows=inspectReleaseReadiness({mode:'windows',root:f.root,env:ci}),macos=inspectReleaseReadiness({mode:'macos',root:f.root,env:ci});
 assert.ok(windows.blockers.some(item=>item.id==='WINDOWS_SIGNING'));assert.ok(macos.blockers.some(item=>item.id==='APPLE_DEVELOPER_ID'));assert.ok(macos.blockers.some(item=>item.id==='APPLE_NOTARIZATION'));
 for(const [key,id] of [['LUME_RELEASE_APPROVED','RELEASE_APPROVAL'],['GITHUB_ACTIONS','RELEASE_CI'],['GITHUB_RUN_ID','RELEASE_RUN'],['GITHUB_REF_NAME','RELEASE_TAG']]){const env={...win};delete env[key];assert.ok(inspectReleaseReadiness({mode:'windows',root:f.root,env}).blockers.some(item=>item.id===id),id);}
});

test('publicacao exige aprovacao manual, run assinada, token, manifestos e provas nativas',t=>{
 const f=fixture(t),empty=inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env:ci});for(const id of ['RELEASE_APPROVAL','RELEASE_SOURCE_RUN','PUBLISH_TOKEN','UPDATE_MANIFEST','NATIVE_PROOF'])assert.ok(empty.blockers.some(item=>item.id===id),id);
 writeFileSync(join(f.artifacts,'beta.yml'),`version: ${VERSION}\n`);writeFileSync(join(f.artifacts,'beta-mac.yml'),`version: ${VERSION}\n`);
 assert.ok(inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env:ci}).blockers.some(item=>item.id==='RELEASE_ARTIFACT'));
});

test('workflow da 0.6 bloqueia build assinado sem preparo e conferência do Laya',t=>{
  for(const phrase of ['laya-release-assets.mjs prepare','laya-release-assets.mjs verify windows','laya-release-assets.mjs verify macos',
    'prepare-windows-signed-build.mjs','--config work/windows-signed-electron-builder.json',
    'verify-windows-signatures.mjs','verify-windows-signed-package.mjs']){
    const f=fixture(t),path=join(f.root,'.github/workflows/release.yml');
    writeFileSync(path,(workflow+layaWorkflow).replace(phrase,'etapa-removida'));
    assert.ok(inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}}).blockers.some(item=>item.id==='RELEASE_WORKFLOW'),phrase);
  }
});

test('publicação da Beta 0.6 exige aceite registrado para cada requisito',t=>{
 const f=fixture(t),path=join(f.root,'docs/beta-06/release-acceptance.json');
 const record=JSON.parse(readFileSync(path,'utf8'));record.requirements['L06-ORG']={status:'pendente',evidence:[]};writeFileSync(path,JSON.stringify(record));
 const result=inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env:publishCi});
 assert.ok(result.blockers.some(item=>item.id==='PRODUCT_ACCEPTANCE'&&item.message.includes('L06-ORG')));
 assert.ok(inspectReleaseReadiness({mode:'candidate',root:f.root,env:{}}).candidateBuildAllowed);
 rmSync(path);assert.ok(inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env:publishCi}).blockers.some(item=>item.id==='PRODUCT_ACCEPTANCE'));
});

test('provas nativas ligam hashes aos artefatos e liberam somente conjunto completo',t=>{
 const f=fixture(t);artifacts(f.artifacts);recordNativeProof({platform:'windows',root:f.root,artifactsDir:f.artifacts,env:{...win,LUME_NATIVE_VERIFICATION:'VERIFICADO'}});recordNativeProof({platform:'macos',architecture:'arm64',root:f.root,artifactsDir:f.artifacts,env:{...mac,LUME_NATIVE_VERIFICATION:'VERIFICADO'}});recordNativeProof({platform:'macos',architecture:'x64',publicVerification:true,root:f.root,artifactsDir:f.artifacts,env:macPublic});mergeMacNativeProofs({root:f.root,artifactsDir:f.artifacts,env:macPublic});for(const architecture of ['arm64','x64'])rmSync(join(f.artifacts,`release-proof-macos-${architecture}.json`));
 const env={...publishCi,BLOB_READ_WRITE_TOKEN:'token'};assert.equal(inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env}).publicationAllowed,true);
 writeFileSync(join(f.artifacts,'Lume-'+VERSION+'-mac-universal.zip'),'alterado');assert.ok(inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env}).blockers.some(item=>item.id==='NATIVE_PROOF_HASH'));
});

test('manifesto de atualização exige checksum real e caminho local exato',t=>{
 const f=fixture(t);artifacts(f.artifacts);
 const winPath=join(f.artifacts,'beta.yml'),macPath=join(f.artifacts,'beta-mac.yml');
 const originalWin=readFileSync(winPath,'utf8'),originalMac=readFileSync(macPath,'utf8');
 const inspect=()=>inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env:{...publishCi,BLOB_READ_WRITE_TOKEN:'token'}}).blockers;
 assert.equal(inspect().some(item=>item.id==='UPDATE_MANIFEST_HASH'||item.id==='UPDATE_MANIFEST_PATH'),false);
 for(const [path,original] of [[winPath,originalWin],[macPath,originalMac]]){
   writeFileSync(path,original.replace(/^    sha512: .*\n/m,''));
   assert.ok(inspect().some(item=>item.id==='UPDATE_MANIFEST_HASH'),path+' sem hash de files');
   writeFileSync(path,original.replace(/^sha512: .*\n/m,''));
   assert.ok(inspect().some(item=>item.id==='UPDATE_MANIFEST_HASH'),path+' sem hash principal');
   writeFileSync(path,original.replace(/^(    sha512: ).*$/m,'$1'+Buffer.alloc(64).toString('base64')));
   assert.ok(inspect().some(item=>item.id==='UPDATE_MANIFEST_HASH'),path+' com hash falso');
   writeFileSync(path,original.replace(/^(  - url: ).*$/m,'$1https://outro.exemplo/arquivo.exe'));
   assert.ok(inspect().some(item=>item.id==='UPDATE_MANIFEST_PATH'),path+' com URL externa');
   writeFileSync(path,original);
 }
});

test('provas antigas e artefatos de outra versao nao entram na publicacao',t=>{
 const f=fixture(t);artifacts(f.artifacts);recordNativeProof({platform:'windows',root:f.root,artifactsDir:f.artifacts,env:{...win,LUME_NATIVE_VERIFICATION:'VERIFICADO'}});recordNativeProof({platform:'macos',architecture:'arm64',root:f.root,artifactsDir:f.artifacts,env:{...mac,LUME_NATIVE_VERIFICATION:'VERIFICADO'}});recordNativeProof({platform:'macos',architecture:'x64',publicVerification:true,root:f.root,artifactsDir:f.artifacts,env:macPublic});mergeMacNativeProofs({root:f.root,artifactsDir:f.artifacts,env:macPublic});for(const architecture of ['arm64','x64'])rmSync(join(f.artifacts,`release-proof-macos-${architecture}.json`));
 writeFileSync(join(f.artifacts,'Lume-3.2.0-beta.0-win-x64-Setup.exe'),'antigo');const result=inspectReleaseReadiness({mode:'publish',root:f.root,artifactsDir:f.artifacts,env:{...publishCi,LUME_RELEASE_SOURCE_RUN_ID:'124',BLOB_READ_WRITE_TOKEN:'token'}});
 assert.ok(result.blockers.some(item=>item.id==='RELEASE_ARTIFACT_VERSION'));assert.ok(result.blockers.some(item=>item.id==='NATIVE_PROOF_RUN'));
});

test('prova exige verificacao nativa e candidato escolhe alvo local',t=>{
 const f=fixture(t);artifacts(f.artifacts);assert.throws(()=>recordNativeProof({platform:'windows',root:f.root,artifactsDir:f.artifacts,env:win}),ReleaseReadinessError);assert.deepEqual(candidateBuildArgs({platform:'win32',arch:'x64'}),['--dir','--win','--x64','--publish','never']);assert.throws(()=>candidateBuildArgs({platform:'linux',arch:'x64'}));
});

test('prova universal macOS não fecha sem as duas execuções nativas', t => {
 const f=fixture(t);artifacts(f.artifacts);const env={...mac,LUME_NATIVE_VERIFICATION:'VERIFICADO'};
 recordNativeProof({platform:'macos',architecture:'arm64',root:f.root,artifactsDir:f.artifacts,env});
 assert.throws(()=>mergeMacNativeProofs({root:f.root,artifactsDir:f.artifacts,env:macPublic}),/x64/);
 assert.throws(()=>recordNativeProof({platform:'macos',architecture:'universal',root:f.root,artifactsDir:f.artifacts,env}),/Arquitetura/);
});

test('prova Intel usa somente verificação pública e rejeita segredo como requisito', t => {
 const f=fixture(t);artifacts(f.artifacts);
 assert.doesNotThrow(()=>recordNativeProof({platform:'macos',architecture:'x64',publicVerification:true,root:f.root,artifactsDir:f.artifacts,env:macPublic}));
 const intelPath=join(f.artifacts,'release-proof-macos-x64.json'),intelProof=JSON.parse(readFileSync(intelPath,'utf8'));
 assert.equal(intelProof.verificationKind,'public-verification');
 assert.throws(()=>recordNativeProof({platform:'macos',architecture:'x64',publicVerification:true,root:f.root,artifactsDir:f.artifacts,env:{...macPublic,LUME_PUBLIC_SIGNATURE_VERIFICATION:'NAO'}}),/pública/);
 recordNativeProof({platform:'macos',architecture:'arm64',root:f.root,artifactsDir:f.artifacts,env:{...mac,LUME_NATIVE_VERIFICATION:'VERIFICADO'}});
 writeFileSync(intelPath,JSON.stringify({...intelProof,verificationKind:'signed-build'},null,2));
 assert.throws(()=>mergeMacNativeProofs({root:f.root,artifactsDir:f.artifacts,env:macPublic}),/caminho exigido/);
});

test('readiness e produto nao importam nem empacotam evidencia 07-06',()=>{
 for(const relative of ['package.json','scripts/build-lume-mcpb.mjs','scripts/release-readiness.mjs','.github/workflows/release.yml'])assert.doesNotMatch(readFileSync(resolve(relative),'utf8'),/provar-whatsapp-labels|LUME-3\.2-LABELS-PROVA|whatsapp-labels-prova/i,relative);
});

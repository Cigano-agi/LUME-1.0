import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,link,symlink} from 'node:fs/promises';
import {writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {snapshotLumeArchive,parseHashes,validateArchiveListing} from '../scripts/snapshot-lume-archive.mjs';

const sevenZip=path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/7zip@1.0.0/7zip-win-x64-a34pt/bin/7za.exe');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'lume-archive-review-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source');await mkdir(path.join(source,'data'),{recursive:true});await mkdir(path.join(source,'empty dir'));
  await writeFile(path.join(source,'data/assessor.db'),'synthetic database');
  await writeFile(path.join(source,'data/assessor.db-wal'),'synthetic wal');
  return{root,source,destination:path.join(root,'snapshot'),rehearsal:path.join(root,'rehearsal'),sevenZip,processProbe:async()=>false};
}
const noReceipt=f=>assert.rejects(access(path.join(f.destination,'receipt.json')),{code:'ENOENT'});

test('archive review: roundtrip preserva Unicode, espaços, ocultos, vazios e hashes independentes',async t=>{
  const f=await fixture(t);
  for(const name of ['ação 東京.txt',' leading space.txt','.hidden','windows-hidden.bin','zero.bin'])await writeFile(path.join(f.source,name),name==='zero.bin'?'':'synthetic '+name);
  assert.equal(spawnSync('attrib.exe',['+h',path.join(f.source,'windows-hidden.bin')],{windowsHide:true}).status,0);
  const result=await snapshotLumeArchive(f);assert.equal(result.verified,true);assert.equal(result.rehearsed,true);assert.equal(result.files,7);
  const raw=await readFile(path.join(f.destination,'manifest.json')),manifest=JSON.parse(raw);
  assert.equal(sha(raw),result.manifestSha256);assert.equal(manifest.format,'7z-store');
  assert.equal(sha(await readFile(path.join(f.destination,'profile.7z'))),result.archiveSha256);
  assert.ok(manifest.directories.includes('empty dir'));
  for(const entry of manifest.files){const original=await readFile(path.join(f.source,entry.path)),restored=await readFile(path.join(f.rehearsal,entry.path));assert.deepEqual(restored,original);assert.equal(sha(original),entry.sha256);assert.equal(restored.length,entry.bytes);}
});

test('archive review: processo ativo ou consulta incerta não cria destino',async t=>{
  for(const probe of [async()=>true,async()=>{throw Error('synthetic process probe');}]){const f=await fixture(t);await assert.rejects(snapshotLumeArchive({...f,processProbe:probe}),{code:'LUME_NOT_STOPPED'});await assert.rejects(access(f.destination),{code:'ENOENT'});}
});

test('archive review: destinos existentes, sobrepostos e Git nunca são sobrescritos',async t=>{
  const f=await fixture(t);
  for(const changes of [{destination:f.source},{rehearsal:f.source},{rehearsal:f.destination},{destination:path.join(f.source,'inside')}])await assert.rejects(snapshotLumeArchive({...f,...changes}),{code:'SNAPSHOT_PATH_CONFLICT'});
  await mkdir(f.destination);await writeFile(path.join(f.destination,'sentinel'),'keep');await assert.rejects(snapshotLumeArchive(f),{code:'SNAPSHOT_DESTINATION_EXISTS'});assert.equal(await readFile(path.join(f.destination,'sentinel'),'utf8'),'keep');
  const g=await fixture(t);await mkdir(path.join(g.root,'.git'));await assert.rejects(snapshotLumeArchive(g),{code:'SNAPSHOT_DESTINATION_IN_GIT'});
});

test('archive review: ferramenta sem pin falha antes de executar ou criar destino',async t=>{
  const f=await fixture(t),fake=path.join(f.root,'fake.exe');await writeFile(fake,'synthetic non executable');
  await assert.rejects(snapshotLumeArchive({...f,sevenZip:fake}),{code:'SNAPSHOT_ARCHIVER_UNTRUSTED'});await assert.rejects(access(f.destination),{code:'ENOENT'});
});

test('archive review: hardlink, junction interna e raiz ligada são recusados',async t=>{
  const hard=await fixture(t);await link(path.join(hard.source,'data/assessor.db'),path.join(hard.source,'alias'));await assert.rejects(snapshotLumeArchive(hard),{code:'SNAPSHOT_UNSAFE_PATH'});
  const f=await fixture(t);await symlink(path.join(f.source,'data'),path.join(f.source,'linked'),'junction');await assert.rejects(snapshotLumeArchive(f),{code:'SNAPSHOT_UNSAFE_PATH'});
  const g=await fixture(t),linked=path.join(g.root,'linked-root');await symlink(g.source,linked,'junction');await assert.rejects(snapshotLumeArchive({...g,source:linked}),{code:'SNAPSHOT_UNSAFE_PATH'});
});

test('archive review: fonte alterada antes ou após hashes não produz recibo',async t=>{
  for(const phase of ['source-hashes','archive']){const f=await fixture(t);await assert.rejects(snapshotLumeArchive({...f,onProgress:p=>{if(p.phase===phase){const file=path.join(f.source,'data/assessor.db'),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);}}}),e=>['SNAPSHOT_HASH_MISMATCH','SNAPSHOT_SOURCE_CHANGED'].includes(e.code));await noReceipt(f);}
});

test('archive review: fonte alterada e restaurada não ressuscita inventário anterior',async t=>{
  const f=await fixture(t),file=path.join(f.source,'data/assessor.db'),original=await readFile(file);
  await assert.rejects(snapshotLumeArchive({...f,onProgress:p=>{if(p.phase==='archive'){writeFileSync(file,'changed');writeFileSync(file,original);}}}),{code:'SNAPSHOT_SOURCE_CHANGED'});await noReceipt(f);
});

test('archive review: arquivo compactado alterado antes da restauração é recusado',async t=>{
  const f=await fixture(t);await assert.rejects(snapshotLumeArchive({...f,onProgress:p=>{if(p.phase==='restore'){const file=path.join(f.destination,'profile.7z'),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);}}}),e=>['SNAPSHOT_ARCHIVER_FAILED','SNAPSHOT_ARCHIVE_CHANGED','SNAPSHOT_SOURCE_CHANGED'].includes(e.code));await noReceipt(f);
});

test('archive review: restauração alterada depois do hash não produz recibo',async t=>{
  const f=await fixture(t);await assert.rejects(snapshotLumeArchive({...f,onProgress:p=>{if(p.phase==='source-stability')writeFileSync(path.join(f.rehearsal,'data/assessor.db'),'changed restored database');}}),{code:'SNAPSHOT_SOURCE_CHANGED'});await noReceipt(f);
});

test('archive review: processo reiniciado antes de extrair mantém ensaio ausente',async t=>{
  const f=await fixture(t);let calls=0;await assert.rejects(snapshotLumeArchive({...f,processProbe:async()=>++calls===3}),{code:'LUME_NOT_STOPPED'});await noReceipt(f);await assert.rejects(access(f.rehearsal),{code:'ENOENT'});
});

test('archive review: alteração durante última consulta de processos ainda invalida fonte',async t=>{
  const f=await fixture(t);let calls=0;
  await assert.rejects(snapshotLumeArchive({...f,processProbe:async()=>{if(++calls===4)await writeFile(path.join(f.source,'data/assessor.db'),'late synthetic source change');return false;}}),{code:'SNAPSHOT_SOURCE_CHANGED'});await noReceipt(f);
});

test('archive review: parsers rejeitam traversal, duplicatas, contagens e links sem relaxar hashes',()=>{
  const entries={files:[{path:'ação.txt',stat:{size:2n}}],directories:[{path:''},{path:'empty'}]};
  const line='a'.repeat(64)+'             2  ação.txt',dir=' '.repeat(80)+'empty\\';
  assert.equal(parseHashes(line+'\n'+dir,entries)[0].path,'ação.txt');
  for(const raw of [line+'\n'+line+'\n'+dir,line,line.replace('ação.txt','../ação.txt')+'\n'+dir,line.replace('             2','             3')+'\n'+dir,line+'\n'+dir+'\n'+dir])assert.throws(()=>parseHashes(raw,entries));
  const file='Path = ação.txt\nSize = 2\nEncrypted = -\nAttributes = A\n',folder='Path = empty\nSize = 0\nEncrypted = -\nAttributes = D\n';
  assert.doesNotThrow(()=>validateArchiveListing(file+'\n'+folder,entries));
  for(const raw of [file,file+'\n'+file+'\n'+folder,file.replace('ação.txt','../ação.txt')+'\n'+folder,file+'Symbolic Link = target\n\n'+folder,file.replace('Encrypted = -','Encrypted = +')+'\n'+folder])assert.throws(()=>validateArchiveListing(raw,entries));
});

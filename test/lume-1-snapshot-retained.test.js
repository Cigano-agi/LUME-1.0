import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access,symlink,link} from 'node:fs/promises';
import {writeFileSync,readFileSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {snapshotLumeArchive} from '../scripts/snapshot-lume-archive.mjs';

const sevenZip=path.join(process.env.LOCALAPPDATA,'electron-builder/Cache/7zip@1.0.0/7zip-win-x64-a34pt/bin/7za.exe');
const historical=Array.from({length:9},(_,i)=>`data/wa-auth-invalid-179018026180${i}-65705cec-f8ad-4dbc-8974-e39fe86f661a`);
historical.push('data/wa-auth-before-repair-20260923-133822');
const unlisted='data/wa-auth-invalid-1790180261819-65705cec-f8ad-4dbc-8974-e39fe86f661a';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function put(root,name,bytes){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),bytes);}
async function fixture(t){
  const tempRoot=path.resolve(tmpdir()),root=await mkdtemp(path.join(tempRoot,'lume-retained-review-'));
  assert(root.startsWith(tempRoot+path.sep));
  t.after(async()=>{assert(root.startsWith(tempRoot+path.sep));await rm(root,{recursive:true,force:true});});
  const source=path.join(root,'source');
  for(const [name,bytes] of [['data/assessor.db','synthetic-db'],['data/assessor.db-wal','synthetic-wal'],['data/assessor.db-shm','synthetic-shm'],['data/wa-auth/creds.json','synthetic-active'],['credenciais/key.bin','synthetic-key'],['perfil-ativo.json','synthetic-marker'],['.maintenance','synthetic-maintenance']])await put(source,name,bytes);
  await put(source,historical[0]+'/nested/old.json','synthetic-old');
  return{root,source,destination:path.join(root,'snapshot'),rehearsal:path.join(root,'rehearsal'),sevenZip,retainedSessions:[historical[0]],processProbe:async()=>false};
}
const absent=name=>assert.rejects(access(name),{code:'ENOENT'});
const noReceipt=f=>absent(path.join(f.destination,'receipt.json'));

test('retained review: 7z real exclui somente dez nomes exatos e restaura todo o restante',async t=>{
  const f=await fixture(t);
  for(const [i,dir] of historical.entries())await put(f.source,dir+'/nested/old.json','synthetic retained '+i);
  const kept=[unlisted+'/creds.json',historical[0]+'-extra/keep.txt','other/'+historical[0]+'/same-name.txt'];
  for(const name of kept)await put(f.source,name,'synthetic included '+name);
  const result=await snapshotLumeArchive({...f,retainedSessions:historical});
  assert.equal(result.scope,'operational-profile');assert.equal(result.verified,true);assert.equal(result.rehearsed,true);
  const raw=await readFile(path.join(f.destination,'manifest.json')),manifest=JSON.parse(raw);
  assert.equal(sha(raw),result.manifestSha256);assert.deepEqual(manifest.retainedAtSource,result.retainedAtSource);
  assert.equal(result.retainedAtSource.length,10);
  for(const record of result.retainedAtSource){
    assert.deepEqual(Object.keys(record).sort(),['bytes','contentVerified','copied','files','path','preservedAtSource'].sort());
    assert.equal(record.files,1);assert.equal(record.copied,false);assert.equal(record.contentVerified,false);assert.equal(record.preservedAtSource,true);
    assert.equal(record.bytes,(await readFile(path.join(f.source,record.path,'nested/old.json'))).length);
    await absent(path.join(f.rehearsal,record.path));
    assert(!manifest.files.some(entry=>entry.path===record.path||entry.path.startsWith(record.path+'/')));
  }
  const required=['data/assessor.db','data/assessor.db-wal','data/assessor.db-shm','data/wa-auth/creds.json','credenciais/key.bin','perfil-ativo.json','.maintenance',...kept];
  assert.deepEqual(manifest.files.map(x=>x.path).sort(),required.sort());
  for(const entry of manifest.files){const original=await readFile(path.join(f.source,entry.path));assert.equal(sha(original),entry.sha256);assert.deepEqual(await readFile(path.join(f.rehearsal,entry.path)),original);}
  const listing=spawnSync(sevenZip,['l','-slt','-ba',path.join(f.destination,'profile.7z')],{encoding:'utf8',windowsHide:true});
  assert.equal(listing.status,0);const names=listing.stdout.split(/\r?\n/).filter(x=>x.startsWith('Path = ')).map(x=>x.slice(7).replaceAll('\\','/'));
  assert(names.includes('data/wa-auth/creds.json'));assert(names.includes(unlisted+'/creds.json'));
  for(const dir of historical)assert(!names.some(name=>name===dir||name.startsWith(dir+'/')));
});

test('retained review: rejeita ativo, outras pastas, traversal, wildcard, duplicatas, case e ausência',async t=>{
  const f=await fixture(t);
  const bad=[null,'not-array',['data/wa-auth'],['credenciais'],['data'],['../'+historical[0]],['data/wa-auth-invalid-*'],[path.join(f.source,historical[0])],[historical[0],historical[0]],[historical[0].toUpperCase()],['data\\'+historical[0].slice(5)],[unlisted],['data/wa-auth-before-repair-20260923-133822/child']];
  for(const retainedSessions of bad){await assert.rejects(snapshotLumeArchive({...f,retainedSessions}),{code:'SNAPSHOT_INVALID_RETENTION'});await absent(f.destination);}
  const fileOnly='data/wa-auth-before-repair-20260923-133822';await put(f.source,fileOnly,'not-directory');
  await assert.rejects(snapshotLumeArchive({...f,retainedSessions:[fileOnly]}),{code:'SNAPSHOT_INVALID_RETENTION'});
});

test('retained review: retenção exige diretório ativo wa-auth',async t=>{
  const f=await fixture(t);await renameSync(path.join(f.source,'data/wa-auth'),path.join(f.source,'data/active-moved'));
  await assert.rejects(snapshotLumeArchive(f),{code:'SNAPSHOT_ACTIVE_SESSION_MISSING'});await absent(f.destination);
});

test('retained review: junction e hardlink em conteúdo retido continuam proibidos',async t=>{
  const f=await fixture(t),target=path.join(f.root,'external');await mkdir(target);await put(target,'sentinel','outside');
  const linked=historical[1];await symlink(target,path.join(f.source,linked),'junction');
  await assert.rejects(snapshotLumeArchive({...f,retainedSessions:[linked]}),{code:'SNAPSHOT_UNSAFE_PATH'});await absent(f.destination);
  const g=await fixture(t);await link(path.join(g.source,'data/assessor.db'),path.join(g.source,historical[0],'alias'));
  await assert.rejects(snapshotLumeArchive(g),{code:'SNAPSHOT_UNSAFE_PATH'});await absent(g.destination);
});

test('retained review: mutação de bytes retidos mesmo tamanho invalida inventário final',async t=>{
  const f=await fixture(t);await assert.rejects(snapshotLumeArchive({...f,onProgress:event=>{
    if(event.phase==='source-stability'){const file=path.join(f.source,historical[0],'nested/old.json'),bytes=readFileSync(file);bytes[0]^=1;writeFileSync(file,bytes);}
  }}),{code:'SNAPSHOT_SOURCE_CHANGED'});await noReceipt(f);
});

test('retained review: novo arquivo dentro de pasta retida invalida inventário final',async t=>{
  const f=await fixture(t);await assert.rejects(snapshotLumeArchive({...f,onProgress:event=>{
    if(event.phase==='source-stability')writeFileSync(path.join(f.source,historical[0],'new-file'),'synthetic late');
  }}),{code:'SNAPSHOT_SOURCE_CHANGED'});await noReceipt(f);
});

test('retained review: mutar array chamador não amplia exclusão após início',async t=>{
  const f=await fixture(t),requested=[historical[0]];await put(f.source,unlisted+'/old','must-copy');
  const result=await snapshotLumeArchive({...f,retainedSessions:requested,onProgress:event=>{if(event.phase==='inventory')requested.push(unlisted);}});
  assert.deepEqual(result.retainedAtSource.map(x=>x.path),[historical[0]]);assert.equal(await readFile(path.join(f.rehearsal,unlisted,'old'),'utf8'),'must-copy');
});

test('retained review: CLI rejeita lista vinculada a outra source antes de copiar',async t=>{
  const f=await fixture(t),list=path.join(f.root,'retention.json');await writeFile(list,JSON.stringify({source:path.join(f.root,'other'),directories:[historical[0]]}));
  const run=spawnSync(process.execPath,['scripts/snapshot-lume-archive.mjs','--source',f.source,'--destination',f.destination,'--rehearsal',f.rehearsal,'--seven-zip',sevenZip,'--retained-sessions',list],{encoding:'utf8',windowsHide:true});
  assert.equal(run.status,1);assert.match(run.stderr,/SNAPSHOT_INVALID_RETENTION/);await absent(f.destination);
});

test('retained review: sem lista mantém escopo integral e cópia das pastas históricas',async t=>{
  const f=await fixture(t),result=await snapshotLumeArchive({...f,retainedSessions:[]});
  assert.equal(result.scope,'full-profile');assert.deepEqual(result.retainedAtSource,[]);
  assert.deepEqual(await readFile(path.join(f.source,historical[0],'nested/old.json')),await readFile(path.join(f.rehearsal,historical[0],'nested/old.json')));
});

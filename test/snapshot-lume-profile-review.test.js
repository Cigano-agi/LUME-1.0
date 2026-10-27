import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {snapshotLumeProfile,verifySnapshot} from '../scripts/snapshot-lume-profile.mjs';

const source=await readFile(new URL('../scripts/snapshot-lume-profile.mjs',import.meta.url),'utf8');
// Isolate the unmodified private scheduler to control completions deterministically.
// Filesystem/security integration is exercised through the exported API below.
const start=source.indexOf('async function bounded('),end=source.indexOf('\nasync function exists(',start);
assert(start>=0&&end>start);
const bounded=vm.runInNewContext(source.slice(start,end)+';bounded');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('review: concorrência fica em16 e resultados preservam ordem apesar de término invertido',async()=>{
  let active=0,peak=0,started=0;const gates=[];
  const run=bounded(Array.from({length:65},(_,i)=>i),async i=>{
    started++;peak=Math.max(peak,++active);
    await new Promise(resolve=>gates.push(resolve));active--;return i*3;
  });
  assert.equal(started,16);assert.equal(active,16);
  while(started<65||active){for(const resolve of gates.splice(0).reverse())resolve();await tick();}
  assert.deepEqual(Array.from(await run),Array.from({length:65},(_,i)=>i*3));
  assert.equal(peak,16);assert.equal(active,0);
});

test('review: primeira falha interrompe novas operações e só retorna após drenar as iniciadas',async()=>{
  const expected=new Error('synthetic failure'),gates=[];let started=0,active=0,settled=false;
  const run=bounded(Array.from({length:64},(_,i)=>i),async i=>{
    started++;active++;
    try{await new Promise((resolve,reject)=>gates.push({i,resolve,reject}));return i;}finally{active--;}
  });
  const observed=run.then(()=>{settled=true;throw Error('unexpected success');},error=>{settled=true;return error;});
  assert.equal(started,16);gates.find(g=>g.i===0).reject(expected);await tick();
  assert.equal(settled,false);assert.equal(started,16);assert.equal(active,15);
  for(const gate of gates.filter(g=>g.i!==0).reverse())gate.resolve();
  assert.equal(await observed,expected);assert.equal(active,0);assert.equal(started,16);
});

test('review: snapshot paralelo de81arquivos conserva hash, ordem, restauração e rejeita adulteração',async t=>{
  const tempRoot=path.resolve(tmpdir());
  const root=await mkdtemp(path.join(tempRoot,'lume-snapshot-concurrency-review-'));
  assert(root.startsWith(tempRoot+path.sep));
  t.after(async()=>{assert(root.startsWith(tempRoot+path.sep));await rm(root,{recursive:true,force:true});});
  const profile=path.join(root,'source'),destination=path.join(root,'backup'),rehearsal=path.join(root,'rehearsal');
  await mkdir(path.join(profile,'data'),{recursive:true});await mkdir(path.join(profile,'nested'));
  const entries=[['data/assessor.db',Buffer.from('synthetic DB')],...Array.from({length:80},(_,i)=>['nested/'+String(i).padStart(3,'0')+'.bin',Buffer.alloc(1+(i*8191)%65536,i)])];
  for(const [name,bytes] of entries)await writeFile(path.join(profile,name),bytes);
  const result=await snapshotLumeProfile({source:profile,destination,rehearsal,processProbe:async()=>false});
  assert.equal(result.files,81);assert.equal(result.verified,true);assert.equal(result.rehearsed,true);
  const {manifest}=await verifySnapshot(destination);
  assert.deepEqual(manifest.files.map(x=>x.path),entries.map(x=>x[0]));
  for(const [index,[name,bytes]] of entries.entries()){
    assert.equal(manifest.files[index].sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(path.join(rehearsal,name)),bytes);
    assert.deepEqual(await readFile(path.join(profile,name)),bytes);
  }
  await writeFile(path.join(destination,'profile','nested','079.bin'),Buffer.alloc(entries.at(-1)[1].length,250));
  await assert.rejects(verifySnapshot(destination),{code:'SNAPSHOT_HASH_MISMATCH'});
});

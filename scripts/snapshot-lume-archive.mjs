import { lstat, open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, safeChain, outsideGit, overlaps, privateDirectory, inventory,
  stableInventory, stopped, exists, fileHash, durableJson, identity, same,
  validRelative, lumeIsRunning } from './snapshot-lume-profile.mjs';

const TOOL_SHA256 = '223b873c50380fe9a39f1a22b6abf8d46db506e1c08d08312902f6f3cd1f7ac3';
const fail = code => { throw Object.assign(new Error(code), {code}); };
const relative = value => {
  let name=value.replaceAll('\\','/');
  if(name.startsWith('./'))name=name.slice(2);
  if(!validRelative(name)||/[\r\n]/.test(name))fail('SNAPSHOT_UNSAFE_PATH');
  return name;
};
function run(executable,args,cwd){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const chunks=[];let length=0,overflow=false;
    child.stdout.on('data',bytes=>{length+=bytes.length;if(length>160*1024*1024){overflow=true;child.kill();}else chunks.push(bytes);});
    child.stderr.resume();
    child.once('error',()=>reject(Object.assign(new Error('SNAPSHOT_ARCHIVER_FAILED'),{code:'SNAPSHOT_ARCHIVER_FAILED'})));
    child.once('close',code=>code===0&&!overflow?resolve(Buffer.concat(chunks).toString('utf8')):
      reject(Object.assign(new Error('SNAPSHOT_ARCHIVER_FAILED'),{code:'SNAPSHOT_ARCHIVER_FAILED'})));
  });
}
export function parseHashes(raw,entries){
  const found=new Map(),dirs=new Set(['']);
  for(const line of raw.split(/\r?\n/)){
    if(!line.trim())continue;
    const match=/^([a-fA-F0-9]{64}) +([0-9]+)  (.*)$/.exec(line);
    if(!match){
      if(!/^ {80}.+\\$/.test(line))fail('SNAPSHOT_HASH_FORMAT');
      const name=relative(line.slice(80,-1));if(dirs.has(name))fail('SNAPSHOT_HASH_MISMATCH');dirs.add(name);continue;
    }
    const name=relative(match[3]),bytes=Number(match[2]);
    if(found.has(name)||!Number.isSafeInteger(bytes))fail('SNAPSHOT_HASH_MISMATCH');
    found.set(name,{path:name,bytes,sha256:match[1].toLowerCase()});
  }
  if(found.size!==entries.files.length||dirs.size!==entries.directories.length||entries.directories.some(x=>!dirs.has(x.path)))fail('SNAPSHOT_HASH_MISMATCH');
  return entries.files.map(entry=>{
    const actual=found.get(entry.path);if(!actual||actual.bytes!==Number(entry.stat.size))fail('SNAPSHOT_HASH_MISMATCH');return actual;
  });
}
export function validateArchiveListing(raw,entries){
  const files=new Map(entries.files.map(x=>[x.path,Number(x.stat.size)]));
  const dirs=new Set(entries.directories.map(x=>x.path).filter(Boolean));
  const seen=new Set();
  for(const block of raw.split(/\r?\n\r?\n/)){
    if(!block.trim())continue;
    const fields={};
    for(const line of block.split(/\r?\n/)){
      if(!line)continue;const match=/^([^=]+) = (.*)$/.exec(line);
      if(!match||Object.hasOwn(fields,match[1]))fail('SNAPSHOT_ARCHIVE_UNSAFE');fields[match[1]]=match[2];
    }
    const name=relative(fields.Path||'');
    if(seen.has(name)||fields.Encrypted!=='-'||!/^\d+$/.test(fields.Size||'')||
       !/^[DASHRINOTC ]*$/.test(fields.Attributes||'')||Object.keys(fields).some(k=>/link/i.test(k)))fail('SNAPSHOT_ARCHIVE_UNSAFE');
    seen.add(name);
    if(fields.Attributes.includes('D')){if(!dirs.delete(name)||Number(fields.Size)!==0)fail('SNAPSHOT_ARCHIVE_UNSAFE');}
    else {if(!files.has(name)||files.get(name)!==Number(fields.Size))fail('SNAPSHOT_ARCHIVE_UNSAFE');files.delete(name);}
  }
  if(files.size||dirs.size)fail('SNAPSHOT_ARCHIVE_UNSAFE');
}

/** Full local recovery archive. Never changes the source or overwrites a destination. */
export async function snapshotLumeArchive({source,destination,rehearsal,sevenZip,retainedSessions=[],processProbe=lumeIsRunning,onProgress=()=>{}}={}){
  if(!Array.isArray(retainedSessions))fail('SNAPSHOT_INVALID_RETENTION');retainedSessions=[...retainedSessions];
  const paths=[source,destination,rehearsal].map(canonical);canonical(sevenZip);
  for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)
    if(overlaps(paths[i],paths[j])||overlaps(paths[j],paths[i]))fail('SNAPSHOT_PATH_CONFLICT');
  await stopped(processProbe);await safeChain(source);
  for(const target of [destination,rehearsal]){
    if(await exists(target))fail('SNAPSHOT_DESTINATION_EXISTS');await safeChain(path.dirname(target));await outsideGit(target);
  }
  if((await fileHash(sevenZip)).sha256!==TOOL_SHA256)fail('SNAPSHOT_ARCHIVER_UNTRUSTED');
  const toolIdentity=await lstat(sevenZip,{bigint:true});
  const exec=async(args,cwd=destination)=>{
    if(!same(toolIdentity,await lstat(sevenZip,{bigint:true})))fail('SNAPSHOT_ARCHIVER_CHANGED');
    return run(sevenZip,args,cwd);
  };
  onProgress({phase:'inventory'});
  const before=await inventory(source);
  if(!before.files.some(x=>x.path==='data/assessor.db'))fail('SNAPSHOT_DATABASE_MISSING');
  if(!Array.isArray(retainedSessions)||retainedSessions.length>100||new Set(retainedSessions).size!==retainedSessions.length||retainedSessions.some(name=>
    typeof name!=='string'||!/^data\/wa-auth-(?:invalid-[0-9]{13}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|before-repair-[0-9]{8}-[0-9]{6})$/.test(name)||!before.directories.some(x=>x.path===name)))fail('SNAPSHOT_INVALID_RETENTION');
  if(retainedSessions.length&&!before.directories.some(x=>x.path==='data/wa-auth'))fail('SNAPSHOT_ACTIVE_SESSION_MISSING');
  const retained=name=>retainedSessions.some(dir=>name===dir||name.startsWith(dir+'/'));
  const included={files:before.files.filter(x=>!retained(x.path)),directories:before.directories.filter(x=>!retained(x.path))};
  // Exact directory names only; never derive a broad exclusion from age or wildcard.
  const exclusions=retainedSessions.map(name=>'-x!'+name.replaceAll('/',path.sep));
  const retainedRecords=retainedSessions.map(dir=>{const entries=before.files.filter(x=>x.path.startsWith(dir+'/'));return{path:dir,files:entries.length,bytes:entries.reduce((n,x)=>n+Number(x.stat.size),0),copied:false,contentVerified:false,preservedAtSource:true};});
  // Native hashes avoid hundreds of thousands of separate Node stream objects.
  onProgress({phase:'source-hashes',files:included.files.length,retainedHistoricalDirectories:retainedRecords.length});
  const files=parseHashes(await exec(['h','-r','-scrcSHA256','-ba','-sccUTF-8',...exclusions,'.'],source),included);
  await stopped(processProbe);
  await privateDirectory(destination);const destinationIdentity=await lstat(destination,{bigint:true});
  const archive=path.join(destination,'profile.7z');
  onProgress({phase:'archive',files:files.length});
  await exec(['a','-t7z','-mx=0','-ms=off','-mmt=2','-bd','-y',...exclusions,archive,'.'],source);
  const handle=await open(archive,'r+');try{await handle.sync();}finally{await handle.close();}
  const archiveIdentity=await lstat(archive,{bigint:true});
  const archiveHash=await fileHash(archive,archiveIdentity);
  await exec(['t','-bd',archive]);
  validateArchiveListing(await exec(['l','-slt','-ba','-sccUTF-8',archive]),included);
  await stopped(processProbe);
  if(!same(archiveIdentity,await lstat(archive,{bigint:true})))fail('SNAPSHOT_ARCHIVE_CHANGED');
  onProgress({phase:'restore',files:files.length});
  await privateDirectory(rehearsal);const rehearsalIdentity=await lstat(rehearsal,{bigint:true});
  await exec(['x','-bd','-y','-o'+rehearsal,archive]);
  onProgress({phase:'restore-hashes',files:files.length});
  const restored=await inventory(rehearsal);
  if(JSON.stringify(restored.directories.map(x=>x.path))!==JSON.stringify(included.directories.map(x=>x.path)))fail('SNAPSHOT_HASH_MISMATCH');
  const actual=parseHashes(await exec(['h','-r','-scrcSHA256','-ba','-sccUTF-8','.'],rehearsal),restored);
  if(JSON.stringify(actual)!==JSON.stringify(files))fail('SNAPSHOT_HASH_MISMATCH');
  onProgress({phase:'source-stability',files:files.length});
  await stopped(processProbe);await stableInventory(source,before);await stableInventory(rehearsal,restored);
  if(!identity(destinationIdentity,await lstat(destination,{bigint:true}))||!identity(rehearsalIdentity,await lstat(rehearsal,{bigint:true}))||
    !same(archiveIdentity,await lstat(archive,{bigint:true})))fail('SNAPSHOT_SOURCE_CHANGED');
  const manifest={version:2,createdAt:new Date().toISOString(),format:'7z-store',scope:retainedRecords.length?'operational-profile':'full-profile',retainedAtSource:retainedRecords,
    archive:{path:'profile.7z',bytes:archiveHash.bytes,sha256:archiveHash.sha256},directories:included.directories.map(x=>x.path),files};
  await durableJson(path.join(destination,'manifest.json'),manifest);
  const receipt={version:2,scope:manifest.scope,retainedAtSource:retainedRecords,files:files.length,bytes:files.reduce((sum,x)=>sum+x.bytes,0),archiveSha256:archiveHash.sha256,
    manifestSha256:createHash('sha256').update(JSON.stringify(manifest)+'\n').digest('hex'),verified:true,rehearsed:true};
  await durableJson(path.join(destination,'receipt.json'),receipt);onProgress({phase:'complete',...receipt});return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2),options={};
    for(let i=0;i<args.length;i+=2){
      const names={'--source':'source','--destination':'destination','--rehearsal':'rehearsal','--seven-zip':'sevenZip','--retained-sessions':'retentionManifest'};
      if(!names[args[i]]||!args[i+1]||Object.hasOwn(options,names[args[i]]))fail('SNAPSHOT_ARGUMENTS');options[names[args[i]]]=args[i+1];
    }
    if(options.retentionManifest){
      canonical(options.retentionManifest);await fileHash(options.retentionManifest);
      const retained=JSON.parse(await readFile(options.retentionManifest,'utf8'));
      if(retained?.source!==options.source||!Array.isArray(retained.directories))fail('SNAPSHOT_INVALID_RETENTION');
      options.retainedSessions=retained.directories;delete options.retentionManifest;
    }
    options.onProgress=value=>console.log(JSON.stringify({...value,at:new Date().toISOString()}));
    await snapshotLumeArchive(options);
  }catch(error){console.error(JSON.stringify({ok:false,code:/^SNAPSHOT_|^LUME_NOT_STOPPED$/.test(error?.code||'')?error.code:'SNAPSHOT_FAILED'}));process.exitCode=1;}
}

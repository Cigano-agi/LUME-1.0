import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPILER = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const COMPILER_SHA256 = '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00';
const FILE = 'lume-activity.exe';
const fail = () => { throw Error('APP_ACTIVITY_BUILD_FAILED'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshot = file => { try { return lstatSync(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const sameObject = (a,b) => a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
const same = (a,b) => a === null ? b === null : sameObject(a,b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
const fingerprint = file => ({stat:snapshot(file),digest:snapshot(file) ? hash(readFileSync(file)) : null});
const unchanged = (before,file) => same(before.stat,snapshot(file)) && before.digest === (snapshot(file) ? hash(readFileSync(file)) : null);

function noLinks(file, requireFile = false, requireSingleLink = true) {
  if (!isAbsolute(file)) fail();
  let current = parse(file).root;
  const parts = relative(current,file).split(sep).filter(Boolean);
  for (let i=0;i<parts.length;i++) {
    current=join(current,parts[i]);
    const st=lstatSync(current);
    if (st.isSymbolicLink() || i<parts.length-1 && !st.isDirectory() ||
        i===parts.length-1 && requireFile && (!st.isFile() || requireSingleLink && st.nlink!==1)) fail();
  }
}
function paths(root) {
  if (typeof root!=='string' || !isAbsolute(root)) fail();
  const native=join(root,'native','app-activity'),bin=join(native,'bin');
  return {native,bin,source:join(native,'LumeActivity.cs'),target:join(bin,FILE),manifest:join(bin,'manifest.json')};
}

// Verification never loads or executes the helper. verifySource=false is for a
// packaged layout without C# source, not a relaxation of binary/manifest checks.
export function verifyAppActivity({root=ROOT,verifySource=true}={}) {
  try {
    if (typeof verifySource!=='boolean') fail();
    const p=paths(root);noLinks(p.target,true);noLinks(p.manifest,true);
    const manifest=JSON.parse(readFileSync(p.manifest,'utf8'));
    const fields=['schema','platform','arch','file','sha256','sourceSha256'];
    if (!manifest || Object.getPrototypeOf(manifest)!==Object.prototype ||
        Object.keys(manifest).sort().join(',')!==fields.sort().join(',') ||
        manifest.schema!==1 || manifest.platform!=='win32' || manifest.arch!=='x64' || manifest.file!==FILE ||
        !/^[0-9a-f]{64}$/.test(manifest.sha256) || !/^[0-9a-f]{64}$/.test(manifest.sourceSha256) ||
        hash(readFileSync(p.target))!==manifest.sha256) fail();
    if (verifySource) {noLinks(p.source,true);if(hash(readFileSync(p.source))!==manifest.sourceSha256)fail();}
    return manifest;
  } catch { fail(); }
}

export async function buildAppActivity({platform=process.platform,arch=process.arch}={}) {
  if(platform!=='win32'||arch!=='x64'||process.platform!=='win32'||process.arch!=='x64')
    throw Error('APP_ACTIVITY_BUILD_UNSUPPORTED');
  const p=paths(ROOT);let stage,stageBefore;
  try {
    // Windows servicing owns compiler hardlinks; its exact bytes are pinned.
    noLinks(COMPILER,true,false);if(hash(readFileSync(COMPILER))!==COMPILER_SHA256)fail();
    noLinks(p.source,true);noLinks(p.native);
    if(!existsSync(p.bin))mkdirSync(p.bin);
    noLinks(p.bin);const binBefore=snapshot(p.bin);
    if(!binBefore.isDirectory())fail();
    if(snapshot(p.target)||snapshot(p.manifest))verifyAppActivity({verifySource:false});
    const compilerBefore=snapshot(COMPILER),sourceBefore=snapshot(p.source);
    const sourceSha256=hash(readFileSync(p.source));
    const targetBefore=fingerprint(p.target),manifestBefore=fingerprint(p.manifest);
    stage=mkdtempSync(join(p.bin,'.build-'));stageBefore=snapshot(stage);
    const stagedExe=join(stage,FILE),stagedManifest=join(stage,'manifest.json');
    await run(COMPILER,['/nologo','/target:exe','/platform:x64','/langversion:5','/optimize+','/warnaserror+',
      '/reference:System.Web.Extensions.dll',`/out:${stagedExe}`,p.source],
    {windowsHide:true,timeout:30000,maxBuffer:8192});
    noLinks(stagedExe,true);
    const manifest={schema:1,platform:'win32',arch:'x64',file:FILE,sha256:hash(readFileSync(stagedExe)),sourceSha256};
    writeFileSync(stagedManifest,JSON.stringify(manifest)+'\n',{flag:'wx'});
    noLinks(COMPILER,true,false);noLinks(p.source,true);noLinks(p.bin);
    if(!same(compilerBefore,snapshot(COMPILER))||hash(readFileSync(COMPILER))!==COMPILER_SHA256||
       !same(sourceBefore,snapshot(p.source))||hash(readFileSync(p.source))!==sourceSha256||
       !sameObject(binBefore,snapshot(p.bin)))fail();
    if(snapshot(p.target)||snapshot(p.manifest))verifyAppActivity({verifySource:false});
    if(!unchanged(targetBefore,p.target)||!unchanged(manifestBefore,p.manifest))fail();
    noLinks(stage);if(!sameObject(stageBefore,snapshot(stage)))fail();
    noLinks(stagedExe,true);noLinks(stagedManifest,true);
    if(hash(readFileSync(stagedExe))!==manifest.sha256||readFileSync(stagedManifest,'utf8')!==JSON.stringify(manifest)+'\n')fail();
    renameSync(stagedExe,p.target);renameSync(stagedManifest,p.manifest);
    return verifyAppActivity();
  } catch (cause) { throw Error('APP_ACTIVITY_BUILD_FAILED',{cause}); }
  finally {
    // Delete only this invocation's checked staging files, never uncertain output.
    try {
      if(stage&&resolve(stage).startsWith(resolve(p.bin)+sep)&&sameObject(stageBefore,snapshot(stage))&&
         readdirSync(stage).every(name=>name===FILE||name==='manifest.json')) {
        noLinks(stage);
        const files=readdirSync(stage).map(name=>join(stage,name));
        for(const file of files)noLinks(file,true);
        for(const file of files)unlinkSync(file);
        rmdirSync(stage);
      }
    } catch { /* preserve uncertain staging output */ }
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  if(process.argv.length!==2){process.stderr.write('APP_ACTIVITY_BUILD_FAILED\n');process.exitCode=1;}
  else buildAppActivity().then(()=>process.stdout.write('APP_ACTIVITY_BUILD_OK\n'))
    .catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
}

// Windows packaging input for the ASAR watcher/rename defect. Uses the normal
// builder hooks (including dependency preparation), preserving installed apps,
// existing builds, policies and signatures.
import {createReadStream,constants,readFileSync} from 'node:fs';
import {access,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,isAbsolute,join,normalize,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReleaseReady} from './release-readiness.mjs';
const require=createRequire(import.meta.url);
const unzipper=require('unzipper');
const asar=require('@electron/asar');
const {deepAssign}=require('builder-util-runtime');
const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const hash=async stream=>{const digest=createHash('sha256');for await(const chunk of stream)digest.update(chunk);return digest.digest('hex');};
const exists=async path=>{try{await access(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
export function safeArchivePath(name){
  if(typeof name!=='string'||!name||name.includes('\\')||name.includes(':')||name.includes('\0')||isAbsolute(name)||name.split('/').includes('..'))throw Error('ELECTRON_ARCHIVE_PATH_INVALID');
  return name;
}
export function includeOfficialInput(name){return !['resources/default_app.asar','version'].includes(name);}
// Same metadata cleanup as the installed app-builder-lib/fileTransformer. Runtime
// entrypoints, exports and dependency graphs are still compared exactly.
function expectedPackage(source,{main=false,configuration={}}={}){
  const data=JSON.parse(JSON.stringify(source));
  if(main&&source.build?.extraMetadata)deepAssign(data,source.build.extraMetadata);
  const ignored=new Set(['dist','gitHead','build','jspm','ava','xo','nyc','eslintConfig','contributors','bundleDependencies','tags']);
  const removeBabel=data.dependencies&&typeof data.dependencies==='object'&&!Object.keys(data.dependencies).some(k=>k.startsWith('babel'));
  for(const key of Object.keys(data))if(key.startsWith('_')||ignored.has(key)||
    configuration.removePackageScripts!==false&&key==='scripts'||configuration.removePackageKeywords!==false&&key==='keywords'||
    main&&key==='devDependencies'||!main&&key==='bugs'||removeBabel&&key==='babel')delete data[key];
  return data;
}
export function verifyCandidateArchive(archive,{sourceRoot}={}){
  const files=asar.listPackage(archive).map(name=>name.replaceAll('\\','/').slice(1));
  const appFiles=files.filter(name=>!name.startsWith('node_modules/'));
  const forbidden=appFiles.filter(name=>/^(test|tests|data|docs|work|backups|\.planning|wa-auth)(\/|$)|(^|\/)\.env($|\.)|\.(db|sqlite|pem|key)$|creds\.json$|(^|\/)(fixtures?|mocks?)(\/|$)/i.test(name));
  if(forbidden.length)throw Error(`PACKAGE_FORBIDDEN_PATHS:${forbidden.join(',')}`);
  const failures=[];
  for(const name of files){
    const info=asar.statFile(archive,normalize(name),false);
    if(info.files)continue;
    if(info.link)throw Error('PACKAGE_LINK_UNEXPECTED:'+name);
    const bytes=asar.extractFile(archive,normalize(name));
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(info.integrity?.algorithm!=='SHA256'||digest!==info.integrity.hash)failures.push(name+':integrity');
    if(sourceRoot){
      const path=resolve(sourceRoot,safeArchivePath(name)),rel=relative(sourceRoot,path);
      if(rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('PACKAGE_SOURCE_ESCAPES_ROOT');
      if(name==='package.json'||name.startsWith('node_modules/')&&name.endsWith('/package.json')){
        const source=JSON.parse(readFileSync(path,'utf8'));
        let configuration={};try{configuration=JSON.parse(readFileSync(join(sourceRoot,'package.json'),'utf8')).build||{};}catch(error){if(error.code!=='ENOENT')throw error;}
        const expected=expectedPackage(source,{main:name==='package.json',configuration});
        const actual=JSON.parse(bytes.toString('utf8'));
        const keys=Object.keys(expected).sort();
        if(JSON.stringify(Object.keys(actual).sort())!==JSON.stringify(keys)||keys.some(key=>JSON.stringify(actual[key])!==JSON.stringify(expected[key])))failures.push(name+':metadata');
      }else if(digest!==createHash('sha256').update(readFileSync(path)).digest('hex'))failures.push(name+':source-changed');
    }
  }
  if(failures.length)throw Error(`PACKAGE_CHANGED_DURING_BUILD:${failures.join(',')}`);
  return{fileCount:files.length,appFiles:appFiles.length,forbidden:[],integrityVerified:true,sourceVerified:Boolean(sourceRoot),scope:'All ASAR entries including dependencies and unpacked files; extra resources require separate verification.'};
}
export async function verifyExtraResources(source,destination){
  const entries=async root=>{const result=[];async function visit(dir=''){
    for(const name of (await readdir(join(root,dir))).sort()){
      const relativeName=dir?dir+'/'+name:name,path=join(root,relativeName),stat=await lstat(path);
      if(stat.isSymbolicLink())throw Error('PACKAGE_RESOURCE_LINK_UNEXPECTED');
      if(stat.isDirectory())await visit(relativeName);
      else if(stat.isFile())result.push({name:relativeName,bytes:stat.size,sha256:await hash(createReadStream(path))});
      else throw Error('PACKAGE_RESOURCE_INVALID');
    }
  }await visit();return result;};
  const originals=await entries(source),copies=await entries(destination);
  if(JSON.stringify(originals)!==JSON.stringify(copies))throw Error('PACKAGE_RESOURCE_MISMATCH');
  return{files:copies.length,bytes:copies.reduce((n,f)=>n+f.bytes,0),verified:true,manifestSha256:createHash('sha256').update(JSON.stringify(copies)).digest('hex')};
}
export async function prepareOfficialElectron({root=ROOT,cache=join(process.env.LOCALAPPDATA||'','electron','Cache')}={}){
  if(process.platform!=='win32'||process.arch!=='x64')throw Error('BUILD_REQUIRES_WINDOWS_X64');
  const packageJson=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const electronRoot=join(root,'node_modules','electron'),dist=join(electronRoot,'dist');
  const installed=JSON.parse(await readFile(join(electronRoot,'package.json'),'utf8')).version;
  if(!/^\d+\.\d+\.\d+$/.test(installed)||packageJson.devDependencies.electron!==installed||(await readFile(join(dist,'version'),'utf8')).trim()!==installed)throw Error('ELECTRON_VERSION_MISMATCH');
  const archiveName=`electron-v${installed}-win32-x64.zip`;
  const expected=JSON.parse(await readFile(join(electronRoot,'checksums.json'),'utf8'))[archiveName];
  if(!/^[0-9a-f]{64}$/.test(expected||''))throw Error('ELECTRON_CHECKSUM_MISSING');
  let archive;
  for(const entry of await readdir(cache,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const candidate=join(cache,entry.name,archiveName);
    if(await exists(candidate)&&await hash(createReadStream(candidate))===expected){archive=candidate;break;}
  }
  if(!archive)throw Error('VERIFIED_ELECTRON_CACHE_MISSING');
  const zip=await unzipper.Open.file(archive),entries=[];
  for(const entry of zip.files){
    const name=safeArchivePath(entry.path);
    if(entry.type==='Directory')continue;
    if(((entry.externalFileAttributes>>>16)&0o170000)===0o120000)throw Error('ELECTRON_SYMLINK_UNEXPECTED');
    const source=resolve(dist,name),rel=relative(dist,source);
    if(rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('ELECTRON_INPUT_ESCAPES_ROOT');
    const info=await lstat(source);
    if(!info.isFile()||info.isSymbolicLink())throw Error('ELECTRON_INPUT_NOT_FILE');
    const originalHash=await hash(entry.stream()),actualHash=await hash(createReadStream(source));
    if(originalHash!==actualHash)throw Error(`ELECTRON_INPUT_MISMATCH:${name}`);
    entries.push({name,sha256:actualHash,bytes:info.size});
  }
  if(!entries.some(x=>x.name==='electron.exe')||!entries.some(x=>x.name==='resources/default_app.asar'))throw Error('ELECTRON_ARCHIVE_INCOMPLETE');
  const base=join(root,'work','lume-1-20261026');await mkdir(base,{recursive:true});
  const stage=await mkdtemp(join(base,'electron-official-input-'));
  for(const entry of entries.filter(x=>includeOfficialInput(x.name))){
    const target=join(stage,entry.name);await mkdir(dirname(target),{recursive:true});
    await copyFile(join(dist,entry.name),target,constants.COPYFILE_EXCL);
    if(await hash(createReadStream(target))!==entry.sha256)throw Error('ELECTRON_INPUT_COPY_MISMATCH');
  }
  const evidence={date:new Date().toISOString(),electronVersion:installed,archive,archiveSha256:expected,source:dist,stage,entries,omitted:['resources/default_app.asar','version'],reason:'Same default-app cleanup as normal electron-builder unpack; avoids watched ASAR directory rename.',installedApplicationTouched:false};
  await writeFile(join(base,`electron-input-${stage.split(sep).at(-1)}.json`),JSON.stringify(evidence,null,2));
  return evidence;
}
export async function buildLumeCandidate(){
  assertReleaseReady({mode:'candidate',root:ROOT,env:process.env});
  const evidence=await prepareOfficialElectron();
  const output=await mkdtemp(join(ROOT,'work','lume-1-20261026','candidate-official-'));
  const args=[require.resolve('electron-builder/out/cli/cli.js'),'--dir','--win','--x64','--publish','never',`--config.electronDist=${evidence.stage}`,`--config.directories.output=${output}`];
  console.log(JSON.stringify({event:'verified-official-input',version:evidence.electronVersion,archiveSha256:evidence.archiveSha256,files:evidence.entries.length,output}));
  const code=await new Promise((resolveCode,reject)=>{const child=spawn(process.execPath,args,{cwd:ROOT,env:process.env,stdio:'inherit',shell:false,windowsHide:true});child.once('error',reject);child.once('exit',code=>resolveCode(code??1));});
  await writeFile(join(output,'build-receipt.json'),JSON.stringify({date:new Date().toISOString(),code,output,electronInput:evidence.stage,applicationLaunched:false,installed:false},null,2));
  if(code!==0)throw Error(`LUME_CANDIDATE_BUILD_FAILED:${code}`);
  try{
    const inspection=verifyCandidateArchive(join(output,'win-unpacked','resources','app.asar'),{sourceRoot:ROOT});
    inspection.audioLocal=await verifyExtraResources(join(ROOT,'native/audio-local/bin'),join(output,'win-unpacked/resources/audio-local'));
    await writeFile(join(output,'package-inspection.json'),JSON.stringify(inspection,null,2));
  }catch(error){
    await writeFile(join(output,'package-rejected.json'),JSON.stringify({valid:false,error:error.message,applicationLaunched:false},null,2));
    throw error;
  }
  return output;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify({event:'candidate-built',output:await buildLumeCandidate()}));}catch(error){console.error(error.message);process.exitCode=1;}
}

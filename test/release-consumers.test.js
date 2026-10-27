import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepararRelease} from '../scripts/preparar-release.mjs';
import {publicarRelease} from '../scripts/publicar-release.mjs';

const VERSION='3.2.0-beta.3';
const fixture=t=>{const root=mkdtempSync(join(tmpdir(),'lume-consumers-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'desktop'));writeFileSync(join(root,'package.json'),JSON.stringify({version:'9.9.9'}));return root;};

test('preparacao usa uma unica readiness.version e nao rele package depois do gate',t=>{
 const root=fixture(t),writes=[];let calls=0;
 const result=prepararRelease({platform:'win32',root,env:{},readiness:()=>{calls++;writeFileSync(join(root,'package.json'),JSON.stringify({version:'8.8.8'}));return{version:VERSION};},write:(path,body)=>writes.push({path,body})});
 assert.equal(calls,1);assert.equal(result.version,VERSION);assert.equal(result.channel,'beta');assert.equal(writes.length,1);assert.match(writes[0].body,/beta/);assert.doesNotMatch(writes[0].body,/8\.8\.8|9\.9\.9/);
});

test('preparacao nao grava quando readiness falha',t=>{
 const root=fixture(t);let writes=0;assert.throws(()=>prepararRelease({platform:'darwin',root,readiness:()=>{throw new Error('gate');},write:()=>writes++}),/gate/);assert.equal(writes,0);
});

test('publicacao usa readiness.version uma vez, sem rede real nem releitura do package',async t=>{
 const root=fixture(t),dir=join(root,'release-files');mkdirSync(dir);
 const names=[`Lume-${VERSION}-win-x64-Setup.exe`,`Lume-${VERSION}-mac-universal.dmg`,`Lume-${VERSION}-mac-universal.zip`,'beta.yml','beta-mac.yml'];
 for(const name of names)writeFileSync(join(dir,name),name.endsWith('.yml')?`version: ${VERSION}\npath: Lume-${VERSION}-${name==='beta.yml'?'win-x64-Setup.exe':'mac-universal.zip'}\n`:'bytes');
 let readyCalls=0;const puts=[],fetches=[];
 const result=await publicarRelease({root,dir,env:{BLOB_READ_WRITE_TOKEN:'token'},readiness:()=>{readyCalls++;writeFileSync(join(root,'package.json'),JSON.stringify({version:'8.8.8'}));return{version:VERSION};},putFile:async(path)=>{puts.push(path);return{url:'https://blob.test/'+path};},fetchUrl:async(url,options)=>{fetches.push([String(url),options]);return String(url).includes('?check=')?{ok:false,status:404}:{ok:true,status:200};},log:()=>{}});
 assert.equal(readyCalls,1);assert.equal(result.version,VERSION);assert.equal(puts.length,7);assert.ok(puts.every(path=>path.startsWith('releases/beta/')));assert.ok(fetches.length>=8);
 assert.match(fetches[0][0],/^https:\/\/lume\.gypsiventures\.com\/releases\/beta\/beta\.yml\?check=/);
 assert.deepEqual(puts.slice(-4),[
  `releases/beta/manifests/${VERSION}/beta.yml`,
  `releases/beta/manifests/${VERSION}/beta-mac.yml`,
  'releases/beta/beta.yml',
  'releases/beta/beta-mac.yml'
 ]);
});

test('publicacao nao consulta rede nem grava quando readiness falha',async t=>{
 const root=fixture(t);let puts=0,fetches=0;
 await assert.rejects(publicarRelease({root,dir:root,readiness:()=>{throw new Error('gate');},putFile:async()=>puts++,fetchUrl:async()=>{fetches++;return{ok:true};}}),/gate/);
 assert.equal(puts,0);assert.equal(fetches,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,linkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildAppActivity,verifyAppActivity} from '../scripts/build-app-activity.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'lume-activity-build-')),native=join(root,'native/app-activity'),bin=join(native,'bin');mkdirSync(bin,{recursive:true});
  const source=join(native,'LumeActivity.cs'),target=join(bin,'lume-activity.exe'),manifest=join(bin,'manifest.json');
  writeFileSync(source,'// synthetic integrity source; never compiled');writeFileSync(target,'synthetic non-executable integrity bytes');
  const data={schema:1,platform:'win32',arch:'x64',file:'lume-activity.exe',sha256:hash(readFileSync(target)),sourceSha256:hash(readFileSync(source))};
  const save=()=>writeFileSync(manifest,JSON.stringify(data));save();return{root,native,bin,source,target,manifest,data,save};
}
test('verificador confere fonte e bytes sem executar o arquivo',()=>{
  const f=fixture();assert.deepEqual(verifyAppActivity({root:f.root}),f.data);
  writeFileSync(f.target,'altered');assert.throws(()=>verifyAppActivity({root:f.root}),/APP_ACTIVITY_BUILD_FAILED/);
});
test('fonte modificada reprova checkout; pacote sem fonte exige opção explícita',()=>{
  const f=fixture();writeFileSync(f.source,'changed source');assert.throws(()=>verifyAppActivity({root:f.root}));
  unlinkSync(f.source);assert.throws(()=>verifyAppActivity({root:f.root}));
  assert.deepEqual(verifyAppActivity({root:f.root,verifySource:false}),f.data);
  writeFileSync(f.target,'corrupted');assert.throws(()=>verifyAppActivity({root:f.root,verifySource:false}));
});
test('manifesto rejeita campos extras, plataforma, arquitetura, hashes e traversal',()=>{
  const f=fixture(),original={...f.data};
  for(const delta of [{extra:true},{schema:2},{platform:'darwin'},{arch:'arm64'},{file:'../other.exe'},{file:'C:/other.exe'},{sha256:'bad'},{sourceSha256:'A'.repeat(64)}]){
    writeFileSync(f.manifest,JSON.stringify({...original,...delta}));assert.throws(()=>verifyAppActivity({root:f.root}));
  }
  for(const bad of ['{','[]','null']){writeFileSync(f.manifest,bad);assert.throws(()=>verifyAppActivity({root:f.root}));}
});
test('par incompleto e caminho não regular não são adotados',()=>{
  const f=fixture();unlinkSync(f.manifest);assert.throws(()=>verifyAppActivity({root:f.root}));f.save();
  unlinkSync(f.target);assert.throws(()=>verifyAppActivity({root:f.root}));mkdirSync(f.target);assert.throws(()=>verifyAppActivity({root:f.root}));
  assert.throws(()=>verifyAppActivity({root:'relative'}));assert.throws(()=>verifyAppActivity({root:f.root,verifySource:'false'}));
});
test('hardlinks de fonte, executável e manifesto são rejeitados',()=>{
  for(const name of ['source','target','manifest']){const f=fixture();linkSync(f[name],join(f.root,'hardlink'));assert.throws(()=>verifyAppActivity({root:f.root}));}
});
test('junction no caminho de fonte/binário é rejeitada',()=>{
  const f=fixture(),other=mkdtempSync(join(tmpdir(),'lume-activity-link-'));mkdirSync(join(other,'native'));
  symlinkSync(f.native,join(other,'native/app-activity'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>verifyAppActivity({root:other}));
});
test('build recusa plataforma e arquitetura incompatíveis antes do compilador',async()=>{
  await assert.rejects(buildAppActivity({platform:'darwin'}),/APP_ACTIVITY_BUILD_UNSUPPORTED/);
  await assert.rejects(buildAppActivity({arch:'arm64'}),/APP_ACTIVITY_BUILD_UNSUPPORTED/);
});

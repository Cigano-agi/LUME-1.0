import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {createPackageWithOptions,createPackageFromStreams} from '@electron/asar';
import {verifyCandidateArchive,verifyExtraResources} from '../scripts/lume-1-build.mjs';

async function fixture(name,options={}) {
  const root=await mkdtemp(join(tmpdir(),'lume-build-independent-'));
  const source=join(root,'source'),archive=join(root,'app.asar');
  await mkdir(dirname(join(source,name)),{recursive:true});
  await writeFile(join(source,name),'synthetic reviewed bytes');
  await createPackageWithOptions(source,archive,options);
  return {source,archive};
}

test('revisao build: binario ACL unpacked alterado reprova integridade e fonte',async()=>{
  const name='native/win-acl/bin/lume-acl.exe';
  const {source,archive}=await fixture(name,{unpack:'*.exe'});
  assert.equal(verifyCandidateArchive(archive,{sourceRoot:source}).sourceVerified,true);
  await writeFile(join(archive+'.unpacked',name),'synthetic altered bytes');
  assert.throws(()=>verifyCandidateArchive(archive,{sourceRoot:source}),/PACKAGE_CHANGED_DURING_BUILD/);
});

test('revisao build: dependencia executavel diferente da fonte reprova candidata',async()=>{
  const name='node_modules/synthetic-dependency/index.js';
  const {source,archive}=await fixture(name);
  assert.equal(verifyCandidateArchive(archive,{sourceRoot:source}).sourceVerified,true);
  await writeFile(join(source,name),'synthetic newer reviewed bytes');
  assert.throws(()=>verifyCandidateArchive(archive,{sourceRoot:source}),/PACKAGE_CHANGED_DURING_BUILD/);
});

test('revisao build: metadata permite transformacao normal e rejeita troca do entrypoint',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-build-metadata-'));
  const source=join(root,'source'),pack=join(root,'pack');await mkdir(source);await mkdir(pack);
  const original={name:'synthetic',version:'1.0.0',main:'desktop/main.cjs',scripts:{test:'synthetic'},devDependencies:{synthetic:'1.0.0'},build:{extraMetadata:{version:'1.0.1'}}};
  await writeFile(join(source,'package.json'),JSON.stringify(original));
  const expected={name:'synthetic',version:'1.0.1',main:'desktop/main.cjs'};
  await writeFile(join(pack,'package.json'),JSON.stringify(expected));
  const good=join(root,'good.asar');await createPackageWithOptions(pack,good,{});
  assert.equal(verifyCandidateArchive(good,{sourceRoot:source}).sourceVerified,true);
  await writeFile(join(pack,'package.json'),JSON.stringify({...expected,main:'unreviewed.cjs'}));
  const bad=join(root,'bad.asar');await createPackageWithOptions(pack,bad,{});
  assert.throws(()=>verifyCandidateArchive(bad,{sourceRoot:source}),/PACKAGE_CHANGED_DURING_BUILD.*metadata/);
});

test('revisao build: recursos externos exigem conteudo e conjunto exatos',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-build-resources-'));
  const source=join(root,'source'),copy=join(root,'copy');await mkdir(source);await mkdir(copy);
  for(const dir of [source,copy])await writeFile(join(dir,'audio.bin'),'synthetic reviewed audio');
  assert.equal((await verifyExtraResources(source,copy)).verified,true);
  await writeFile(join(copy,'audio.bin'),'synthetic modified audio');
  await assert.rejects(verifyExtraResources(source,copy),/PACKAGE_RESOURCE_MISMATCH/);
  await writeFile(join(copy,'audio.bin'),'synthetic reviewed audio');
  await writeFile(join(copy,'extra.bin'),'synthetic extra');
  await assert.rejects(verifyExtraResources(source,copy),/PACKAGE_RESOURCE_MISMATCH/);
});

test('revisao build: link ASAR nao pode passar como arquivo regular',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-build-link-')),archive=join(root,'link.asar');
  const file=join(root,'target.js'),content='synthetic reviewed target';await writeFile(file,content);
  const metadata=await stat(file),streamGenerator=()=>Readable.from([Buffer.from(content)]);
  await createPackageFromStreams(archive,[
    {path:'target.js',type:'file',unpacked:false,stat:metadata,streamGenerator},
    {path:'alias.js',type:'link',symlink:'target.js',unpacked:false,stat:metadata,streamGenerator}
  ]);
  assert.throws(()=>verifyCandidateArchive(archive),/PACKAGE_LINK_UNEXPECTED/);
});

test('revisao build: aceita metadata de dependencia transformada pelo builder instalado',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-build-dependency-metadata-'));
  const source=join(root,'source'),pack=join(root,'pack'),name='node_modules/synthetic-dependency/package.json';
  for(const base of [source,pack])await mkdir(dirname(join(base,name)),{recursive:true});
  const original={name:'synthetic-dependency',version:'1.0.0',main:'index.js',scripts:{test:'synthetic'},keywords:['synthetic'],bugs:{url:'https://example.invalid'},devDependencies:{fixture:'1.0.0'}};
  await writeFile(join(source,name),JSON.stringify(original));
  const require=createRequire(import.meta.url),{createTransformer}=require('app-builder-lib/out/fileTransformer.js');
  const transformed=await createTransformer(source,{},{})(join(source,name));
  assert.ok(transformed);await writeFile(join(pack,name),transformed);
  const archive=join(root,'app.asar');await createPackageWithOptions(pack,archive,{});
  assert.equal(verifyCandidateArchive(archive,{sourceRoot:source}).sourceVerified,true);
  await writeFile(join(source,name),JSON.stringify({...original,main:'different-reviewed-entry.js'}));
  assert.throws(()=>verifyCandidateArchive(archive,{sourceRoot:source}),/PACKAGE_CHANGED_DURING_BUILD/);
});

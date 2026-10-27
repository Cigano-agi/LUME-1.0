import test from 'node:test';
import assert from 'node:assert/strict';
import {safeArchivePath,includeOfficialInput,verifyCandidateArchive} from '../scripts/lume-1-build.mjs';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPackage} from '@electron/asar';
test('input oficial impede traversal e não retém aplicativo padrão de demonstração Electron',()=>{
 for(const path of ['../electron.exe','a/../../app.asar','C:/private','\\server\\share','a\0b','/absolute','a\\..\\b'])assert.throws(()=>safeArchivePath(path));
 assert.equal(safeArchivePath('resources/default_app.asar'),'resources/default_app.asar');
 assert.equal(includeOfficialInput('resources/default_app.asar'),false);assert.equal(includeOfficialInput('version'),false);
 assert.equal(includeOfficialInput('electron.exe'),true);assert.equal(includeOfficialInput('resources.pak'),true);
});
test('empacotamento rejeita ASAR alterado em vez de anunciar candidata válida',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lume-build-integrity-'));
 const source=join(root,'source'),archive=join(root,'sample.asar');await mkdir(source);
 await writeFile(join(source,'proof.txt'),'synthetic integrity example');await createPackage(source,archive);
 assert.equal(verifyCandidateArchive(archive).integrityVerified,true);
 const bytes=await readFile(archive);bytes[bytes.length-1]^=1;await writeFile(archive,bytes);
 assert.throws(()=>verifyCandidateArchive(archive),/PACKAGE_CHANGED_DURING_BUILD/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MODEL_FILES} from '../src/laya/integrity.js';
import {MODEL_REVISION} from '../src/laya/policy.js';
import {lerTrava,validarFonte,prepararReleaseBundle} from '../scripts/laya-release-assets.mjs';

test('trava da release descreve exatamente os nove arquivos obrigatórios',async()=>{
  const lock=await lerTrava();
  assert.equal(lock.revision,MODEL_REVISION);
  assert.deepEqual([...lock.assets].sort(),[...MODEL_FILES,'lume-laya-manifest.json'].sort());
  assert.equal(lock.approvedForActions,false);
  await assert.rejects(prepararReleaseBundle({source:'nao-existe',env:{GITHUB_ACTIONS:'true',LUME_RELEASE_APPROVED:'PUBLICAR'}}),/QUALIDADE_NAO_APROVADA/);
});

test('modelo da release exige manifesto fixado e todos os arquivos íntegros',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lume-laya-release-'));
  try{
    const sha256={};
    for(const name of MODEL_FILES){const bytes=Buffer.from(`conteudo:${name}`);await writeFile(join(dir,name),bytes);sha256[name]=createHash('sha256').update(bytes).digest('hex');}
    const manifest={revision:MODEL_REVISION,parityVerified:true,sha256},bytes=Buffer.from(JSON.stringify(manifest));
    await writeFile(join(dir,'lume-laya-manifest.json'),bytes);
    const lock={revision:MODEL_REVISION,manifestSha256:createHash('sha256').update(bytes).digest('hex')};
    assert.equal((await validarFonte(dir,lock)).manifestSha256,lock.manifestSha256);
    await assert.rejects(validarFonte(dir,{...lock,manifestSha256:'0'.repeat(64)}),/MANIFEST_DIVERGENTE/);
    await writeFile(join(dir,'LICENSE'),'alterada');
    await assert.rejects(validarFonte(dir,lock),/INTEGRIDADE_FALHOU/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

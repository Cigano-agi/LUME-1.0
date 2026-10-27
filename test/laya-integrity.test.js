import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MODEL_FILES,verificarModelo} from '../src/laya/integrity.js';
import {MODEL_REVISION} from '../src/laya/policy.js';

test('modelo exige hashes da licença e ficha além dos pesos',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lume-laya-integrity-'));
  try{
    const sha256={};
    for(const name of MODEL_FILES){
      const bytes=Buffer.from(`fixture:${name}`);
      await writeFile(join(dir,name),bytes);
      sha256[name]=createHash('sha256').update(bytes).digest('hex');
    }
    const manifest={revision:MODEL_REVISION,parityVerified:true,sha256};
    await writeFile(join(dir,'lume-laya-manifest.json'),JSON.stringify(manifest));
    assert.equal((await verificarModelo(dir)).revision,MODEL_REVISION);
    await writeFile(join(dir,'LICENSE'),'alterada');
    await assert.rejects(verificarModelo(dir),/LAYA_INTEGRIDADE_FALHOU/);
    await writeFile(join(dir,'LICENSE'),'fixture:LICENSE');
    await writeFile(join(dir,'MODEL-CARD.md'),'alterada');
    await assert.rejects(verificarModelo(dir),/LAYA_INTEGRIDADE_FALHOU/);
    delete manifest.sha256['MODEL-CARD.md'];
    await writeFile(join(dir,'lume-laya-manifest.json'),JSON.stringify(manifest));
    await assert.rejects(verificarModelo(dir),/LAYA_INTEGRIDADE_FALHOU/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

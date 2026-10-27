import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('lease A e C0 no perfil sintético: mesmo DB exclusivo, idempotente, sem mutar', t => {
  const home=realpathSync(homedir());
  const root=realpathSync(mkdtempSync(join(home,'lume-03a36-maintenance-plan-')));
  const guard=randomUUID();
  writeFileSync(join(root,'.lume-03a36-harness'),guard,{flag:'wx'});
  let child=null,confirmedClosed=false;
  try{
    const childEnv={...process.env,TEMP:root,TMP:root,TMPDIR:root};
    child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/03A36-maintenance-plan-child.mjs',import.meta.url)),root],
      {cwd:process.cwd(),env:childEnv,encoding:'utf8',timeout:30000,windowsHide:true});
    confirmedClosed=child.status!==null&&child.signal===null;
    assert.equal(child.error,undefined,`subprocess de fixture falhou ao iniciar/terminar: ${child.error?.message}`);
    assert.equal(confirmedClosed,true,`subprocess não confirmou saída: signal=${child.signal} status=${child.status}`);
    assert.equal(child.status,0,`fixture filha falhou: ${child.stderr}`);
    const result=JSON.parse(child.stdout);
    assert.equal(result.state,'ok');
    assert.equal(result.secondConnection,'refused');
    assert.equal(result.markerRetained,true);
    assert.equal(result.filesUnchanged,true);
    assert.ok(result.parts>0);
    t.diagnostic(`A+C0=${result.c0.state}; FK antes=${result.fkBeforeClose}, após lease=${result.fkAfterAcquire}, antes de C0=${result.fkBeforeC0}; conexao concorrente=${result.secondConnection}; arquivos invariantes=${result.filesUnchanged}`);
    assert.equal(result.c0.state,'compatible',`C0 deve funcionar na lease A; causa observada: ${result.c0.cause??'sem recusa reportada'}`);
    assert.deepEqual([result.fkBeforeClose,result.fkAfterAcquire,result.fkBeforeC0],[1,1,1]);
    assert.match(result.c0.signature,/^[a-f0-9]{64}$/);
    assert.ok(result.c0.files>0);
  }finally{
    if(confirmedClosed){
      const again=realpathSync(root);
      assert.equal(dirname(again),home);
      assert.equal(again,root);
      assert.match(basename(again),/^lume-03a36-maintenance-plan-/);
      assert.equal(readFileSync(join(again,'.lume-03a36-harness'),'utf8'),guard);
      rmSync(again,{recursive:true,force:false});
    }
  }
});

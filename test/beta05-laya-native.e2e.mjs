// Real local model through the packaged Electron service, with an isolated profile.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const modelDir=process.env.LUME_LAYA_MODEL_DIR;
if(!modelDir)throw Error('LUME_LAYA_MODEL_DIR deve apontar para o modelo local verificado.');
const profile=mkdtempSync(join(tmpdir(),'lume-beta05-laya-'));
execFileSync(process.execPath,['scripts/laya-install.mjs',modelDir,join(profile,'data','modelos','laya')],{timeout:120000});
const output=resolve('work/beta05-native-laya');mkdirSync(output,{recursive:true});
const options={env:{...process.env,ASSESSOR_DESKTOP_TEST_PROFILE:profile},timeout:30000};
if(process.env.ASSESSOR_TEST_EXECUTABLE)options.executablePath=process.env.ASSESSOR_TEST_EXECUTABLE;
else options.args=[resolve('.')];
const app=await electron.launch(options),errors=[];
try{
  const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#owner').fill('Teste local · demonstração');
  await page.locator('#consent').check();await page.locator('#accept-form button[type=submit]').click();
  await page.locator('#skip').click();await page.locator('#today:not([hidden])').waitFor();
  const proof=await page.evaluate(async()=>{
    const {token}=await(await fetch('/api/sessao')).json(),headers={'x-assessor-token':token,'content-type':'application/json'};
    const before=await(await fetch('/api/v3/laya',{headers})).json();
    const start=performance.now();
    const response=await fetch('/api/v3/laya/classificar',{method:'POST',headers,body:JSON.stringify({texto:'Você pode enviar os documentos para eu revisar?'})});
    const result=await response.json(),coldMs=performance.now()-start;
    const second=await fetch('/api/v3/laya/classificar',{method:'POST',headers,body:JSON.stringify({texto:'O pagamento está confirmado e o prazo do recurso termina amanhã.'})});
    const sensitive=await second.json(),after=await(await fetch('/api/v3/laya',{headers})).json();
    return{before,status:response.status,result,coldMs,secondStatus:second.status,sensitive,after};
  });
  assert.equal(proof.before.instalado,true);assert.equal(proof.status,200,JSON.stringify(proof));
  assert.equal(proof.result.local,true);assert.equal(proof.result.experimental,true);
  assert.equal(proof.before.aprovado,false);assert.equal(proof.result.motivo,'validacao_pendente');assert.equal(proof.result.categoria,null);
  assert.equal(proof.result.sugestao,false);
  assert.equal(proof.secondStatus,200);assert.equal(proof.sensitive.abstencao,true);assert.equal(proof.sensitive.categoria,null);
  assert.deepEqual(errors,[]);
  writeFileSync(join(output,'evidence.json'),JSON.stringify({date:new Date().toISOString(),native:true,synthetic:true,executable:options.executablePath||'source',profile,proof,errors},null,2));
  console.log('BETA05_LAYA_NATIVE_OK',JSON.stringify(proof));
}finally{await app.close();}

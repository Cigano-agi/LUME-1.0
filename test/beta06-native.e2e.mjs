// Real Electron/OS vault, isolated synthetic profile. No WhatsApp or provider call.
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,relative} from 'node:path';
import pacote from '../package.json' with {type:'json'};

const profile=mkdtempSync(join(tmpdir(),'lume-beta06-native-'));
const packaged=process.env.LUME_TEST_PACKAGED==='1';
const output=resolve(packaged?'work/beta06-packaged':'work/beta06-native');mkdirSync(output,{recursive:true});
const options={args:packaged?[]:[resolve('.')],env:{...process.env,ASSESSOR_DESKTOP_TEST_PROFILE:profile},timeout:30000};
if(process.env.LUME_TEST_ELECTRON)options.executablePath=process.env.LUME_TEST_ELECTRON;
let application,stage='launch';const errors=[];
// A fatal launcher error may happen outside the awaited Playwright promise.
// Never leave a previous run's successful receipt as the current result.
const receipt=join(output,'evidence.json');
if(existsSync(receipt)){
  const previous=JSON.parse(readFileSync(receipt,'utf8'));
  if(previous.data)writeFileSync(join(output,'evidence-'+previous.data.replace(/[^0-9TZ]/g,'')+'.json'),JSON.stringify(previous,null,2));
}
writeFileSync(receipt,JSON.stringify({data:new Date().toISOString(),status:'running',stage,synthetic:true,packaged},null,2));
process.on('uncaughtExceptionMonitor',error=>{
  writeFileSync(receipt,JSON.stringify({data:new Date().toISOString(),status:'failed',stage,synthetic:true,packaged,error:String(error.message).slice(0,1500)},null,2));
});
const call=(page,path,data)=>page.evaluate(async({path,data})=>{
  const {token}=await (await fetch('/api/sessao')).json();
  const response=await fetch(path,{method:data===undefined?'GET':'POST',headers:{'content-type':'application/json','x-assessor-token':token},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {status:response.status,data:await response.json()};
},{path,data});

try{
  const inicio=performance.now();application=await electron.launch(options);
  let page=await application.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.locator('#owner').waitFor();stage='onboarding';
  await page.locator('#owner').fill('Teste isolado da 0.6');
  await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();
  await page.getByRole('button',{name:'Explorar meu espaço primeiro'}).click();
  await page.locator('#clarity-content:not([hidden])').waitFor();
  const startupMs=Math.round(performance.now()-inicio);
  stage='os-vault';
  let estado=await call(page,'/api/v3/vendas/jev');assert.equal(estado.status,200);assert.equal(estado.data.disponivel,true);assert.equal(estado.data.configurada,false);
  const syntheticKey=`sk-or-v1-${'b'.repeat(64)}`;
  const guardado=await call(page,'/api/v3/vendas/jev/configurar',{chave:syntheticKey});
  assert.equal(guardado.status,200);assert.equal(guardado.data.configurada,true);
  assert.equal(readFileSync(join(profile,'credenciais','openrouter.seguro')).includes(Buffer.from(syntheticKey)),false);
  assert.doesNotMatch(JSON.stringify(guardado),/sk-or-v1/);
  const browserSecurity=await page.evaluate(()=>({require:typeof window.require,process:typeof window.process}));
  assert.deepEqual(browserSecurity,{require:'undefined',process:'undefined'});
  const runtime=await application.evaluate(({app,safeStorage})=>({
    version:app.getVersion(),electron:process.versions.electron,node:process.versions.node,
    packaged:app.isPackaged,profile:app.getPath('userData'),encryptionAvailable:safeStorage.isEncryptionAvailable(),
    processes:app.getAppMetrics().map(p=>({type:p.type,workingSetKB:p.memory.workingSetSize}))
  }));
  assert.equal(runtime.version,pacote.version);assert.equal(runtime.profile,profile);
  assert.equal(runtime.packaged,packaged);
  const audio=await call(page,'/api/v3/audio');assert.equal(audio.status,200);assert.equal(audio.data.padrao,'local');
  assert.equal(audio.data.motores.local.disponivel,false);assert.equal(audio.data.motores.gemini.disponivel,false);
  await page.screenshot({path:join(output,'native-empty.png')});
  await application.close();application=null;stage='restart';
  application=await electron.launch(options);page=await application.firstWindow();
  await page.locator('#workspace').waitFor();
  estado=await call(page,'/api/v3/vendas/jev');assert.equal(estado.data.configurada,true);
  const removido=await call(page,'/api/v3/vendas/jev/remover',{});assert.equal(removido.data.configurada,false);
  assert.equal(existsSync(join(profile,'credenciais','openrouter.seguro')),false);
  assert.deepEqual(errors,[]);
  const evidence={data:new Date().toISOString(),status:'passed',synthetic:true,scope:packaged?'packaged candidate, not signed installer':'development Electron, not signed installer',runtime:{...runtime,profile:undefined,isolatedProfile:true},startupMs,browserSecurity,checks:['onboarding without pairing','real OS vault ciphertext','no key returned','restart persistence','credential removal','audio state without bundled model or fallback'],externalModelCalls:0,errors};
  writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){
  const evidence={data:new Date().toISOString(),status:'failed',stage,synthetic:true,error:String(error.message).slice(0,1500)};
  writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2));console.error(JSON.stringify(evidence));process.exitCode=1;
}finally{
  if(application)await application.close().catch(()=>{});
  // Only this freshly allocated test profile; never a user's existing app data.
  const rel=relative(tmpdir(),profile);
  if(rel.startsWith('lume-beta06-native-')&&!rel.includes('..'))rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}

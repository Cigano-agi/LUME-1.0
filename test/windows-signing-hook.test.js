import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../scripts/windows-signed-hook.cjs',import.meta.url),'utf8');
const signer='A'.repeat(40);
const file=resolve('work/windows-signed-stage/native/win-acl/bin/lume-acl.exe');
const bytes=Buffer.from('MZ signed native fixture');
const digest=createHash('sha256').update(bytes).digest('hex');

function load({contents=bytes,signatureValid=true,identity=signer}={}){
  const receipt={nativeFiles:[{path:'native/win-acl/bin/lume-acl.exe',sha256:digest}]};
  const calls=[];
  const fs={readFileSync:path=>String(path).endsWith('receipt.json')?JSON.stringify(receipt):contents};
  const child={execFileSync:(_exe,_args,options)=>{
    calls.push(JSON.parse(options.input));
    if(!signatureValid)throw Error('bad signature');
  }};
  const context={Buffer,__dirname:resolve('scripts'),module:{exports:{}},
    process:{env:{LUME_WINDOWS_SIGNER_THUMBPRINT:identity}},
    require:id=>id==='node:fs'?fs:id==='node:child_process'?child:requireBuiltIn(id)};
  runInNewContext(source,context,{filename:'windows-signed-hook.cjs'});
  return{hook:context.module.exports,calls};
}

function requireBuiltIn(id){
  if(id==='node:crypto')return{createHash};
  if(id==='node:path')return{resolve,sep:resolve('a/b').includes('\\')?'\\':'/',join:(...parts)=>parts.join('/')};
  throw Error(`Unexpected module ${id}`);
}

test('hook carrega e conserva bytes nativos previamente assinados',async()=>{
  const {hook,calls}=load();
  await hook({path:file});
  assert.equal(calls.length,1);
  assert.equal(calls[0].signer,signer);
});

test('hook falha fechado para bytes alterados, assinatura inválida e identidade ausente',async()=>{
  await assert.rejects(load({contents:Buffer.from('MZ changed')}).hook({path:file}),/WINDOWS_PRESIGNED_NATIVE_CHANGED/);
  await assert.rejects(load({signatureValid:false}).hook({path:file}),/WINDOWS_PRESIGNED_NATIVE_CHANGED/);
  assert.throws(()=>load({identity:''}),/WINDOWS_SIGNER_IDENTITY_MISSING/);
});

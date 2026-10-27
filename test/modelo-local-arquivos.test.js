import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ArquivosModeloLocal} from '../src/modelo-local-arquivos.js';
const bytes=Buffer.from('Pesos sintéticos para conferir integridade.');
const file={name:'onnx/model_q4.onnx',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const manifesto={model:'test/model',revision:'a'.repeat(40),files:[file]};
async function env(t,fetch=async()=>new Response(bytes)){
  const dir=await mkdtemp(join(tmpdir(),'lume-model-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new ArquivosModeloLocal({diretorio:dir,manifesto,fetch});
}
test('modelo: exige consentimento antes de qualquer rede ou arquivo',async t=>{
  let calls=0;const m=await env(t,async()=>{calls++;return new Response(bytes);});
  for(const confirmar of [undefined,false,1,'true'])await assert.rejects(m.instalar({confirmar}),/Confirme/);
  assert.equal(calls,0);assert.deepEqual(await readdir(m.raiz),[]);
});
test('modelo: verifica tamanho/hash, usa revisão fixa e reutiliza cache sem rede',async t=>{
  let calls=0;const m=await env(t,async url=>{calls++;assert.equal(url,`https://huggingface.co/test/model/resolve/${manifesto.revision}/${file.name}`);return new Response(bytes);});
  const ready=await m.instalar({confirmar:true});assert.equal(ready.etapa,'pronto');assert.equal(ready.ocupado,false);assert.equal(ready.bytes,bytes.length);
  assert.deepEqual(await readFile(join(m.diretorio,file.name)),bytes);await m.verificar();await m.instalar({confirmar:true});assert.equal(calls,1);
});
test('modelo: cache ausente ou corrompido falha offline, reparo só com consentimento',async t=>{
  let calls=0;const m=await env(t,async()=>{calls++;return new Response(bytes);});await assert.rejects(m.verificar(),/ausente/);assert.equal(calls,0);
  await m.instalar({confirmar:true});await writeFile(join(m.diretorio,file.name),Buffer.alloc(bytes.length));
  await assert.rejects(m.verificar(),/alterado/);assert.equal(calls,1);await m.instalar({confirmar:true});assert.equal(calls,2);
});
for(const mode of ['hash','curto','longo','http'])test('modelo: rejeita '+mode+' e não deixa parcial como arquivo pronto',async t=>{
  const m=await env(t,async()=>mode==='http'?new Response('erro',{status:503}):new Response(Buffer.alloc(mode==='curto'?1:mode==='longo'?bytes.length+1:bytes.length)));
  await assert.rejects(m.instalar({confirmar:true}));assert.equal(m.estado().etapa,'falha');assert.equal(m.estado().ocupado,false);
  assert.deepEqual(await readdir(join(m.diretorio,'onnx')),[]);
});
test('modelo: cancelamento interrompe download e concorrência não inicia outra rede',async t=>{
  let entered;const enteredPromise=new Promise(r=>entered=r);const m=await env(t,async(url,{signal})=>{entered();await new Promise((r,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});});
  const pending=m.instalar({confirmar:true});await enteredPromise;await assert.rejects(m.instalar({confirmar:true}),/andamento/);m.cancelar();await assert.rejects(pending,/cancelada/);assert.equal(m.estado().etapa,'cancelado');assert.equal(m.estado().ocupado,false);
  assert.deepEqual(await readdir(join(m.diretorio,'onnx')),[]);
});
test('modelo: manifesto não aceita escape de caminho, URL, revisão móvel ou digest inválido',()=>{
  for(const change of [{revision:'main'},{model:'https://evil.test/x'},{files:[{...file,name:'../fora.onnx'}]},{files:[{...file,name:'a/../../b.onnx'}]},{files:[{...file,sha256:'abc'}]},{files:[file,file]}])assert.throws(()=>new ArquivosModeloLocal({diretorio:'work',manifesto:{...manifesto,...change}}));
});
test('modelo: múltiplos arquivos na mesma pasta são preparados e totalizados',async t=>{
  const m=await env(t);m.manifesto={...m.manifesto,files:[file,{...file,name:'onnx/segundo.onnx'}],bytes:bytes.length*2};
  const state=await m.instalar({confirmar:true});assert.equal(state.bytes,bytes.length*2);assert.equal(state.total,bytes.length*2);
  assert.equal((await readdir(join(m.diretorio,'onnx'))).length,2);
});
test('modelo: cancelar durante bytes remove o parcial e preserva arquivo completo',async t=>{
  let calls=0,cancelled=false;const m=await env(t,async()=>{
    if(++calls===1)return new Response(bytes);
    return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,5));setTimeout(()=>m.cancelar(),30);},cancel(){cancelled=true;}}));
  });
  m.manifesto={...m.manifesto,files:[file,{...file,name:'onnx/segundo.onnx'}],bytes:bytes.length*2};
  await assert.rejects(m.instalar({confirmar:true}),/cancelada/);assert.ok(cancelled);
  assert.deepEqual(await readFile(join(m.diretorio,file.name)),bytes);assert.deepEqual(await readdir(join(m.diretorio,'onnx')),['model_q4.onnx']);
});

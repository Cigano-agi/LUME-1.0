import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {abrirBanco} from '../src/banco.js';
import {Politica} from '../src/autorizacao.js';
import {Saidas} from '../src/saidas.js';

const DM='551100000001@s.whatsapp.net',OTHER='551100000002@s.whatsapp.net';
function environment(db,Class=Saidas){const p=new Politica(db);p.definir(DM,'atender',{decididoPor:'local:owner'});return new Class(db,p);}
function prepare(s){return s.preparar({conversaId:DM,corpo:'Resposta sintética',idempotencia:'same-key'});}

test('claim durável é incerta antes do transporte e concorrentes de dois handles não repetem',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-saidas-race-')),path=join(dir,'test.sqlite');
  const a=abrirBanco(path),b=abrirBanco(path);t.after(()=>{a.close();b.close();rmSync(dir,{recursive:true,force:true});});
  const first=environment(a),second=environment(b);prepare(first);
  let calls=0,release;
  const pending=first.enviar('same-key',async(jid,body,waId)=>{
    calls++;assert.equal(jid,DM);assert.equal(body,'Resposta sintética');assert.equal(waId,'known-wa-id');
    assert.equal(second.buscar('same-key').estado,'incerta');
    assert.equal(second.buscar('same-key').motivo,'known-wa-id');
    await new Promise(resolve=>release=resolve);return waId;
  },new Date(),{externoId:'known-wa-id'});
  const duplicate=await second.enviar('same-key',async()=>{calls++;return 'unexpected';});
  assert.equal(duplicate.enviada,false);release();assert.equal((await pending).enviada,true);
  await second.enviar('same-key',async()=>{calls++;return 'unexpected';});assert.equal(calls,1);
});

test('crash real do processo após despacho mantém incerta ao reabrir e impede reenvio',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-saidas-crash-')),path=join(dir,'test.sqlite'),script=join(dir,'child.mjs');
  let after;t.after(()=>{after?.close();rmSync(dir,{recursive:true,force:true});});
  const before=abrirBanco(path);prepare(environment(before));before.close();
  writeFileSync(script,`import {abrirBanco} from ${JSON.stringify(new URL('../src/banco.js',import.meta.url).href)};
    import {Politica} from ${JSON.stringify(new URL('../src/autorizacao.js',import.meta.url).href)};
    import {Saidas} from ${JSON.stringify(new URL('../src/saidas.js',import.meta.url).href)};
    const db=abrirBanco(${JSON.stringify(path)}),s=new Saidas(db,new Politica(db));
    await s.enviar('same-key',async()=>{process.stdout.write('DISPATCHED\\n');await new Promise(()=>{setInterval(()=>{},1000);});});`);
  const child=spawn(process.execPath,[script],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stderr='';child.stderr.on('data',value=>stderr+=value);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('Processo de prova não despachou: '+stderr));},10000);
    let dispatched=false;child.stdout.on('data',value=>{if(String(value).includes('DISPATCHED')){dispatched=true;child.kill('SIGKILL');}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);dispatched?resolve():reject(Error('Processo terminou antes do despacho: '+stderr));});
  });
  after=abrirBanco(path);const s=environment(after);
  assert.equal(s.buscar('same-key').estado,'incerta');let calls=0;
  const result=await s.enviar('same-key',async()=>{calls++;return 'unexpected';});
  assert.equal(result.enviada,false);assert.equal(calls,0);
});

test('erro de transporte não persiste credenciais e ausência de recibo permanece incerta',async t=>{
  for(const transport of [async()=>{throw Error('token=private-secret cookie=session-secret');},async()=>null]){
    const db=abrirBanco();t.after(()=>db.close());const s=environment(db);prepare(s);
    const result=await s.enviar('same-key',transport);assert.equal(result.incerta,true);
    assert.equal(s.buscar('same-key').estado,'incerta');
    assert.doesNotMatch(JSON.stringify({result,row:s.buscar('same-key')}),/private-secret|session-secret/);
  }
});

test('idempotência não pode ser reutilizada para outro destinatário ou conteúdo',t=>{
  const db=abrirBanco();t.after(()=>db.close());const s=environment(db),first=prepare(s);
  assert.equal(prepare(s).id,first.id);
  assert.throws(()=>s.preparar({conversaId:OTHER,corpo:'Resposta sintética',idempotencia:'same-key'}));
  assert.throws(()=>s.preparar({conversaId:DM,corpo:'Conteúdo substituído',idempotencia:'same-key'}));
  assert.equal(s.buscar('same-key').corpo,'Resposta sintética');assert.equal(s.buscar('same-key').conversa_id,DM);
});

test('validação de fonte/autorização rejeitada impede qualquer chamada de transporte',async t=>{
  const db=abrirBanco();t.after(()=>db.close());const s=environment(db);prepare(s);let calls=0;
  const result=await s.enviar('same-key',async()=>{calls++;return 'unexpected';},new Date(),{validar:()=>false});
  assert.equal(result.enviada,false);assert.equal(calls,0);assert.equal(s.buscar('same-key').estado,'cancelada');
});

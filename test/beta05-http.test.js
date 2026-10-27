import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';

test('Beta 0.5 exige aceite e sessão; Laya é local e só recebe o trecho explícito',async t=>{
  const db=abrirBanco(), desktop=new Desktop(db), chamadas=[];
  const laya={status:()=>({instalado:true,local:true,experimental:true}),classificar:async input=>{chamadas.push(input);return{categoria:null,abstencao:true};}};
  const server=criarServidor(db,{desktop:true,laya,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await(await fetch(base+'/api/sessao')).json();
  const headers={'x-assessor-token':token,'content-type':'application/json'};
  const post=(data,extra={})=>fetch(base+'/api/v3/laya/classificar',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  assert.equal((await fetch(base+'/api/v3/clareza',{headers})).status,403);
  assert.equal((await post({texto:'Pode revisar este documento?'})).status,403);
  desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});
  for(const endpoint of ['/api/v3/clareza','/api/v3/laya']){
    assert.equal((await fetch(base+endpoint)).status,403);
    assert.equal((await fetch(base+endpoint,{headers})).status,200);
  }
  assert.equal((await fetch(base+'/api/v3/clareza?cliente=outro',{headers})).status,400);
  assert.equal((await post({texto:'Pedido'}, {'x-assessor-token':'invalido'})).status,403);
  for(const body of [null,[],{}, {texto:' '},{texto:'a'.repeat(2001)},{texto:'Pedido',executar:true}])assert.equal((await post(body)).status,400);
  const antes=db.prepare('SELECT COUNT(*) n FROM eventos').get().n;
  assert.deepEqual(await(await post({texto:'Pode revisar este documento?'})).json(),{categoria:null,abstencao:true});
  assert.deepEqual(chamadas,[{texto:'Pode revisar este documento?'}]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n,antes);
  laya.classificar=async()=>{throw Error('caminho-interno-secreto');};
  const erro=await post({texto:'Pedido'});assert.equal(erro.status,503);assert.ok(!(await erro.text()).includes('caminho-interno-secreto'));
  laya.classificar=async()=>{throw Error('LAYA_CONTEXTO_EXTENSO');};
  const extenso=await post({texto:'Texto com muitos tokens'});assert.equal(extenso.status,400);assert.match((await extenso.json()).erro,/Reduza o texto/);
  for(const asset of ['/beta05.css','/beta05.js'])assert.equal((await fetch(base+asset)).status,200);
});

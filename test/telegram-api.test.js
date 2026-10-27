import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
import {TelegramHojeIntegracao} from '../src/telegram-integracao.js';

test('API do Telegram exige sessão, ativa só por gesto e nunca devolve o token',async t=>{
  const db=abrirBanco();t.after(()=>db.close());
  const desktop=new Desktop(db);
  let secret=null,requests=0;
  const telegram=new TelegramHojeIntegracao(db,{desktop,
    clareza:{resumo:()=>({dia:'2026-09-28',prioridades:{total:0},revisao:{total:0},oportunidades:{total:0}})},
    segredos:{estado:async()=>({disponivel:true,configurada:Boolean(secret)}),ler:async()=>secret,
      gravar:async value=>{secret=value},remover:async()=>{secret=null}},
    fetchImpl:async(_url,{signal})=>{requests++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}))}
  });
  t.after(()=>telegram.encerrar());
  const server=criarServidor(db,{desktop:true,telegram,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await(await fetch(base+'/api/sessao')).json();
  const path='/api/v3/telegram-hoje',headers={'x-assessor-token':token,'content-type':'application/json'};
  const post=(route,data,auth=true)=>fetch(base+route,{method:'POST',headers:auth?headers:{'content-type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await fetch(base+path,{headers:{'x-assessor-token':token}})).status,403);
  desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});
  assert.equal((await fetch(base+path)).status,403);
  assert.equal((await post(path,{enabled:true,chatId:'123',token:'123456:abcdefghijklmnopqrstuvwxyz123456'},false)).status,403);
  assert.equal(requests,0);
  const configured=await post(path,{enabled:true,chatId:'123',token:'123456:abcdefghijklmnopqrstuvwxyz123456'});
  assert.equal(configured.status,200);
  const body=await configured.text();assert.doesNotMatch(body,/123456:|abcdefghijklmnopqrstuvwxyz/);
  const state=await(await fetch(base+path,{headers})).json();assert.equal(state.enabled,true);
  const disabled=await post(path+'/desativar',{});assert.equal(disabled.status,200);
  assert.equal((await disabled.json()).enabled,false);assert.equal(secret,null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {request} from 'node:http';
import {abrirBanco} from '../src/banco.js';
import {ChatGPTPessoal,validarIdToken} from '../src/pessoal/chatgpt.js';

const NOW=Date.parse('2026-10-26T12:00:00Z'),AUTH='https://auth.openai.com',API='https://api.openai.com/v1';
const CLIENT='oaiapp_lume_test',SUBJECT='subject-synthetic';
const SECRET_ACCESS='access-secret-synthetic',SECRET_REFRESH='refresh-secret-synthetic';
const SCOPE='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwks={keys:[{...publicKey.export({format:'jwk'}),kid:'synthetic-key',use:'sig',alg:'RS256'}]};
const catalog={models:[{visibility:'list',slug:'gpt-6-astra',display_name:'Astra sintético'},
  {visibility:'hidden',slug:'secret-model',display_name:'Oculto'},{visibility:'list',slug:'bad/model'}]};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function token(claims={},header={}) {
  const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'synthetic-key',...header})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:AUTH,aud:CLIENT,sub:SUBJECT,exp:NOW/1000+3600,email:'test@example.invalid',...claims})).toString('base64url');
  const input=head+'.'+body;return input+'.'+sign('RSA-SHA256',Buffer.from(input),privateKey).toString('base64url');
}
function account(extra={}) {return {client_id:CLIENT,subject:SUBJECT,email:'test@example.invalid',
  access_token:SECRET_ACCESS,refresh_token:SECRET_REFRESH,id_token:'id-secret-synthetic',
  scopes:SCOPE.split(' '),expires_at:NOW+3600000,...extra};}
function fixture(t,{saved=null,handler}={}) {
  const db=abrirBanco();let raw=saved?JSON.stringify({version:1,active:saved.client_id,accounts:[saved]}):null;
  const writes=[],requests=[];
  const cofre={estado:async()=>({disponivel:true,configurada:raw!==null}),ler:async()=>raw,
    gravar:async value=>{assert.equal(typeof value,'string');raw=value;writes.push(value);},remover:async()=>{raw=null;}};
  const client=new ChatGPTPessoal(db,{cofre,agora:()=>NOW,fetchImpl:async(url,options={})=>{
    requests.push({url,options});
    assert.ok(url.startsWith(AUTH+'/')||url.startsWith(API+'/'),'nenhuma rede externa real');
    assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    if(handler)return handler(url,options);
    if(url===API+'/models')return json(catalog);
    throw Error('Rota simulada não configurada');
  }});
  t.after(()=>{client.encerrar();db.close();});
  const model=()=>db.prepare('INSERT OR REPLACE INTO desktop_config(chave,valor) VALUES(?,?)').run('pessoal-chatgpt-model','gpt-6-astra');
  return {db,client,requests,writes,model,stored:()=>raw?JSON.parse(raw):null};
}
function loopback(url,{method='GET',headers={}}={}) {
  const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');
  return new Promise((resolve,reject)=>{
    const req=request(parsed,{method,headers},res=>{let body='';res.setEncoding('utf8');res.on('data',v=>body+=v);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});
    req.on('error',reject);req.end();
  });
}
async function start(client,options) {
  const login=await client.iniciarLogin(options),url=new URL(login.url),callback=new URL(url.searchParams.get('redirect_uri'));
  callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','synthetic-code');callback.searchParams.set('client_id',CLIENT);
  return {url,callback};
}
function sse(events,{cut=false}={}) {
  const bytes=new TextEncoder().encode(events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));
  let cursor=0;
  return new Response(new ReadableStream({pull(controller){
    if(cursor<bytes.length){controller.enqueue(bytes.slice(cursor,cursor+7));cursor+=7;return;}
    if(cut)controller.error(Error('upstream-secret-synthetic'));else controller.close();
  }}),{headers:{'content-type':'text/event-stream','x-request-id':'req-synthetic'}});
}
const delta=text=>({type:'response.output_text.delta',delta:text});
const complete=text=>({type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text}]}]}});
const input={instructions:'Atenda apenas o pedido sintético.',input:[{role:'user',content:'Olá'}]};

for(const operation of ['logout','seleção de conta'])test(`cofre assíncrono: refresh em gravação não desfaz ${operation}`,{timeout:5000},async t=>{
  const f=fixture(t,{saved:account({expires_at:NOW-1}),handler:async url=>{
    if(url.endsWith('/token'))return json({access_token:'rotated-access-synthetic',refresh_token:'rotated-refresh-synthetic',token_type:'Bearer',expires_in:3600,scope:SCOPE});
    if(url.endsWith('/openid-configuration'))return json({issuer:AUTH,revocation_endpoint:AUTH+'/api/accounts/oauth/revoke'});
    if(url.endsWith('/revoke'))return json({});
    if(url.endsWith('/models'))return json(catalog);
    throw Error('Rota inesperada');
  }});
  const second=account({client_id:'oaiapp_second',subject:'second-subject'});
  let raw=JSON.stringify({version:1,active:CLIENT,accounts:[account({expires_at:NOW-1}),second]}),release,writing,held=false;
  const started=new Promise(resolve=>writing=resolve);
  f.client.cofre={estado:async()=>({disponivel:true,configurada:true}),ler:async()=>raw,gravar:async value=>{
    if(!held&&JSON.parse(value).accounts[0].access_token==='rotated-access-synthetic'){
      held=true;
      writing();await new Promise(resolve=>release=resolve);
    }
    raw=value;
  }};
  const refresh=f.client.modelos().catch(error=>error);await started;
  const changed=(operation==='logout'?f.client.sair():f.client.selecionarConta(second.client_id)).catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));release();const [,outcome]=await Promise.all([refresh,changed]);
  assert.equal(outcome instanceof Error,false,'a operação atual deve concluir');
  const state=await f.client.estado();
  if(operation==='logout'){
    assert.equal(state.connected,false,'gravação antiga não pode ressuscitar credenciais após logout');
    const stored=JSON.parse(raw).accounts.find(a=>a.client_id===CLIENT);
    assert.equal(stored.access_token,undefined);assert.equal(stored.refresh_token,undefined);
  }else assert.equal(state.account.id,second.client_id,'gravação antiga não pode restaurar conta anterior');
});

test('cofre assíncrono: seleção antiga aguardando leitura não desfaz escolha mais recente',{timeout:5000},async t=>{
  const f=fixture(t),second=account({client_id:'oaiapp_second',subject:'second-subject'});
  let raw=JSON.stringify({version:1,active:CLIENT,accounts:[account(),second]}),first=true,release;
  f.client.cofre={estado:async()=>({disponivel:true,configurada:true}),ler:async()=>{
    if(first){first=false;const snapshot=raw;await new Promise(resolve=>release=resolve);return snapshot;}
    return raw;
  },gravar:async value=>{raw=value;}};
  const old=f.client.selecionarConta(second.client_id).catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');
  const latest=f.client.selecionarConta(CLIENT).catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));release();
  const [,outcome]=await Promise.all([old,latest]);assert.equal(outcome instanceof Error,false);
  assert.equal((await f.client.estado()).account.id,CLIENT,'a última escolha deve prevalecer');
});

test('cofre assíncrono: leitura antiga de token não inicia refresh após troca da conta',{timeout:5000},async t=>{
  const f=fixture(t,{handler:async url=>{
    if(url.endsWith('/token'))return json({access_token:'rotated-access-synthetic',token_type:'Bearer',expires_in:3600,scope:SCOPE});
    if(url.endsWith('/models'))return json(catalog);
    throw Error('Rota inesperada');
  }}),second=account({client_id:'oaiapp_second',subject:'second-subject'});
  let raw=JSON.stringify({version:1,active:CLIENT,accounts:[account({expires_at:NOW-1}),second]}),first=true,release;
  f.client.cofre={estado:async()=>({disponivel:true,configurada:true}),ler:async()=>{
    if(first){first=false;const snapshot=raw;await new Promise(resolve=>release=resolve);return snapshot;}
    return raw;
  },gravar:async value=>{raw=value;}};
  const old=f.client.modelos().catch(error=>error);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');
  await f.client.selecionarConta(second.client_id);release();await old;
  assert.equal((await f.client.estado()).account.id,second.client_id,'leitura anterior não pode restaurar conta antiga');
  assert.equal(f.requests.length,0,'nenhum refresh deve começar com leitura revogada pela troca de conta');
});

test('OAuth HTTP local valida state, PKCE e nonce; tokens ficam somente no cofre JSON',async t=>{
  let authorization;const logs=[];for(const method of ['log','warn','error'])t.mock.method(console,method,(...args)=>logs.push(args));
  const f=fixture(t,{handler:async(url,options)=>{
    if(url.endsWith('/token')){
      const form=new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'),'authorization_code');assert.equal(form.get('client_id'),CLIENT);
      assert.equal(form.get('resource'),API);assert.equal(form.get('redirect_uri'),authorization.url.searchParams.get('redirect_uri'));
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),authorization.url.searchParams.get('code_challenge'));
      assert.match(form.get('code_verifier'),/^[\w-]{43}$/);
      return json({access_token:SECRET_ACCESS,refresh_token:SECRET_REFRESH,token_type:'Bearer',expires_in:3600,scope:SCOPE,
        id_token:token({nonce:authorization.url.searchParams.get('nonce')})});
    }
    if(url.endsWith('/jwks.json'))return json(jwks);
    throw Error('Rota inesperada');
  }});
  authorization=await start(f.client);
  assert.equal(authorization.url.origin,AUTH);assert.equal(authorization.url.searchParams.get('client_id'),'dynamic_agent_client');
  assert.equal(authorization.url.searchParams.get('scope'),SCOPE);assert.equal(authorization.url.searchParams.get('code_challenge_method'),'S256');
  assert.notEqual(authorization.url.searchParams.get('state'),authorization.url.searchParams.get('nonce'));
  const wrong=new URL(authorization.callback);wrong.searchParams.set('state','wrong');
  assert.equal((await loopback(wrong)).status,400);assert.equal(f.requests.length,0);
  const duplicate=new URL(authorization.callback);duplicate.searchParams.append('state',duplicate.searchParams.get('state'));
  assert.equal((await loopback(duplicate)).status,400);
  assert.equal((await loopback(authorization.callback,{method:'POST'})).status,400);
  assert.equal((await loopback(authorization.callback,{headers:{host:'evil.invalid'}})).status,400);
  const result=await loopback(authorization.callback);
  assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');
  assert.equal(f.stored().accounts[0].subject,SUBJECT);assert.equal(f.writes.length,1);
  const state=await f.client.estado();assert.equal(state.connected,true);assert.equal(state.planEnabled,true);assert.equal(state.pending,false);
  assert.doesNotMatch(JSON.stringify({state,logs,config:f.db.prepare('SELECT * FROM desktop_config').all(),result}),/access-secret|refresh-secret|eyJhbGci/);
});

test('ID token RSA rejeita issuer, audience, azp, nonce, expiração, assinatura e subject inválidos',()=>{
  const opts={clientId:CLIENT,nonce:'nonce-correct',subject:SUBJECT,agora:NOW};
  const valid=token({nonce:'nonce-correct'});assert.equal(validarIdToken(valid,jwks,opts).subject,SUBJECT);
  for(const claims of [{iss:'https://evil.invalid'},{aud:'oaiapp_other'},{aud:[CLIENT,'other'],azp:'other'},
    {nonce:'wrong'},{exp:NOW/1000},{nbf:NOW/1000+60},{sub:'wrong'}]){
    assert.throws(()=>validarIdToken(token({nonce:'nonce-correct',...claims}),jwks,opts),{code:'identidade_invalida'});
  }
  const parts=valid.split('.');parts[1]=Buffer.from(JSON.stringify({iss:AUTH,aud:CLIENT,sub:SUBJECT,exp:NOW/1000+3600,nonce:'nonce-correct',admin:true})).toString('base64url');
  assert.throws(()=>validarIdToken(parts.join('.'),jwks,opts),{code:'identidade_invalida'});
  assert.throws(()=>validarIdToken(token({nonce:'nonce-correct'},{alg:'HS256'}),jwks,opts),{code:'identidade_invalida'});
  assert.throws(()=>validarIdToken(valid,{keys:[]},opts),{code:'identidade_invalida'});
});

test('callback nonce errado não conecta nem grava tokens',async t=>{
  const f=fixture(t,{handler:async url=>url.endsWith('/token')?json({access_token:SECRET_ACCESS,token_type:'bearer',expires_in:3600,scope:SCOPE,id_token:token({nonce:'wrong'})}):json(jwks)});
  const {callback}=await start(f.client);assert.equal((await loopback(callback)).status,400);
  assert.equal(f.writes.length,0);assert.equal((await f.client.estado()).connected,false);
});

test('login de retorno rejeita client_id diferente antes de trocar código',async t=>{
  const f=fixture(t,{saved:account()});const {url,callback}=await start(f.client,{accountId:CLIENT});
  assert.equal(url.searchParams.get('client_id'),CLIENT);callback.searchParams.set('client_id','oaiapp_intruder');
  assert.equal((await loopback(callback)).status,400);assert.equal(f.requests.length,0);assert.equal(f.writes.length,0);
});

test('login de retorno rejeita subject diferente sem substituir a conta existente',async t=>{
  let authorization;const f=fixture(t,{saved:account(),handler:async url=>url.endsWith('/token')?json({access_token:'other-access-secret',
    token_type:'bearer',expires_in:3600,scope:SCOPE,id_token:token({nonce:authorization.url.searchParams.get('nonce'),sub:'other-subject'})}):json(jwks)});
  authorization=await start(f.client,{accountId:CLIENT});assert.equal((await loopback(authorization.callback)).status,400);
  assert.equal(f.writes.length,0);assert.equal(f.stored().accounts[0].access_token,SECRET_ACCESS);
});

test('catálogo da conta filtra invisíveis e seleção recusa modelo ausente sem fallback',async t=>{
  const f=fixture(t,{saved:account()});assert.deepEqual(await f.client.modelos(),[{id:'gpt-6-astra',name:'Astra sintético'}]);
  await assert.rejects(f.client.selecionarModelo('gpt-other'),{code:'modelo_indisponivel'});
  assert.equal((await f.client.estado()).model,null);
  assert.equal((await f.client.selecionarModelo('gpt-6-astra')).model,'gpt-6-astra');
  assert.ok(f.requests.every(r=>r.options.headers.Authorization==='Bearer '+SECRET_ACCESS));
});

test('catálogo com metadados extensos mantém só modelos visíveis e campos públicos',async t=>{
  const f=fixture(t,{saved:account(),handler:async()=>json({...catalog,metadata:'x'.repeat(300000)})});
  assert.deepEqual(await f.client.modelos(),[{id:'gpt-6-astra',name:'Astra sintético'}]);
});

test('erro HTTP não JSON mantém status e diagnóstico sem divulgar corpo ou credencial',async t=>{
  const f=fixture(t,{saved:account(),handler:async()=>new Response('<html>'+SECRET_ACCESS+'</html>',{status:403,headers:{'content-type':'text/html','x-request-id':'request-synthetic'}})});
  await assert.rejects(f.client.modelos(),e=>e.code==='http_403'&&e.status===403&&e.requestId==='request-synthetic'&&!JSON.stringify(e).includes(SECRET_ACCESS));
});

test('catálogo excessivo é interrompido com erro específico',async t=>{
  const f=fixture(t,{saved:account(),handler:async()=>json({models:[],metadata:'x'.repeat(2100000)})});
  await assert.rejects(f.client.modelos(),{code:'resposta_grande_demais'});
});

test('scope de uso direto ausente impede catálogo e inferência antes da rede',async t=>{
  const f=fixture(t,{saved:account({scopes:['openid','resource.invoke']})});f.model();
  await assert.rejects(f.client.modelos(),{code:'permissao_plano_ausente'});
  await assert.rejects(f.client.responder(input),{code:'permissao_plano_ausente'});assert.equal(f.requests.length,0);
});

test('Responses usa store:false e stream:true sem campos extras; só retorna após completed',async t=>{
  const f=fixture(t,{saved:account(),handler:async(url,options)=>{
    assert.equal(url,API+'/responses');assert.equal(options.method,'POST');
    assert.deepEqual(JSON.parse(options.body),{model:'gpt-6-astra',...input,store:false,stream:true});
    return sse([delta('parcial'),complete('Resposta final com acentuação: ação.')]);
  }});f.model();
  const result=await f.client.responder({...input,temperature:1,tools:[{}],store:true});
  assert.equal(result.text,'Resposta final com acentuação: ação.');assert.equal(result.completed,true);
  assert.equal((await f.client.estado()).verifiedAt,new Date(NOW).toISOString());
});

test('Responses preserva identificador do evento concluído quando cabeçalho request-id está ausente',async t=>{
 const f=fixture(t,{saved:account(),handler:async()=>new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'resp_synthetic_unique',status:'completed',output:[{content:[{type:'output_text',text:'Concluído.'}]}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}})});f.model();
 const result=await f.client.responder(input);assert.equal(result.requestId,null);assert.equal(result.responseId,'resp_synthetic_unique');
});

test('stream sem completed, cortado e incomplete nunca entrega os deltas como resposta',async t=>{
  for(const [events,options,code] of [[[delta('não entregar')],{},'stream_interrompido'],
    [[delta('não entregar')],{cut:true},'stream_interrompido'],
    [[delta('não entregar'),{type:'response.incomplete'}],{},'resposta_incompleta']]){
    const f=fixture(t,{saved:account(),handler:async()=>sse(events,options)});f.model();
    await assert.rejects(f.client.responder(input),error=>error.code===code&&!error.message.includes('não entregar')&&!error.message.includes('upstream-secret'));
    assert.equal((await f.client.estado()).verifiedAt,null);
  }
});

test('quota após deltas pausa a conta e bloqueia nova rede até retomada explícita',async t=>{
  const f=fixture(t,{saved:account(),handler:async()=>sse([delta('não enviar'),{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded',message:SECRET_ACCESS}}}])});f.model();
  await assert.rejects(f.client.responder(input),{code:'subscription_sharing_usage_limit_exceeded'});
  assert.equal((await f.client.estado()).paused,true);
  await assert.rejects(f.client.responder(input),{code:'subscription_sharing_usage_limit_exceeded'});assert.equal(f.requests.length,1);
  assert.doesNotMatch(JSON.stringify(await f.client.estado()),/access-secret|não enviar/);
  f.client.retomar();assert.equal((await f.client.estado()).paused,false);
});

test('refresh simultâneo é serializado e preserva rotação no cofre',async t=>{
  let release,refreshes=0;
  const f=fixture(t,{saved:account({expires_at:NOW-1000}),handler:async(url,options)=>{
    if(url.endsWith('/token')){
      refreshes++;const form=new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'),'refresh_token');assert.equal(form.get('refresh_token'),SECRET_REFRESH);assert.equal(form.get('client_id'),CLIENT);
      await new Promise(resolve=>release=resolve);
      return json({access_token:'rotated-access-secret',refresh_token:'rotated-refresh-secret',token_type:'bearer',expires_in:3600,scope:SCOPE});
    }
    assert.equal(options.headers.Authorization,'Bearer rotated-access-secret');return json(catalog);
  }});
  const first=f.client.modelos(),second=f.client.modelos();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(refreshes,1);release();await Promise.all([first,second]);
  assert.equal(f.stored().accounts[0].refresh_token,'rotated-refresh-secret');assert.equal(f.writes.length,1);
});

test('refresh terminal apaga credenciais e não tenta fallback',async t=>{
  const f=fixture(t,{saved:account({expires_at:NOW-1000}),handler:async()=>json({error:'invalid_grant',error_description:SECRET_REFRESH},400)});
  await assert.rejects(f.client.modelos(),{code:'invalid_grant'});
  assert.equal((await f.client.estado()).connected,false);assert.equal(f.requests.length,1);
  assert.equal(f.stored().accounts[0].refresh_token,undefined);
});

test('logout usa descoberta confiável e rota revocation exata; remove credenciais locais',async t=>{
  const f=fixture(t,{saved:account(),handler:async(url,options)=>{
    if(url.endsWith('/openid-configuration'))return json({issuer:AUTH,revocation_endpoint:AUTH+'/api/accounts/oauth/revoke'});
    assert.equal(url,AUTH+'/api/accounts/oauth/revoke');const form=new URLSearchParams(options.body);
    assert.equal(form.get('token'),SECRET_REFRESH);assert.equal(form.get('client_id'),CLIENT);assert.equal(form.get('token_type_hint'),'refresh_token');
    return new Response('',{status:200});
  }});
  const result=await f.client.sair();assert.equal(result.remoteRevocationConfirmed,true);assert.equal(result.connected,false);
  assert.doesNotMatch(JSON.stringify(f.stored()),/access-secret|refresh-secret|id-secret/);
});

test('logout com rota de revogação não confiável não envia token e informa falta de confirmação',async t=>{
  const f=fixture(t,{saved:account(),handler:async()=>json({issuer:AUTH,revocation_endpoint:'https://evil.invalid/revoke'})});
  const result=await f.client.sair();assert.equal(result.remoteRevocationConfirmed,false);assert.equal(result.connected,false);assert.equal(f.requests.length,1);
});

test('dois inícios de login simultâneos abrem apenas uma tentativa OAuth',async t=>{
  const f=fixture(t);
  const results=await Promise.allSettled([f.client.iniciarLogin(),f.client.iniciarLogin()]);
  const fulfilled=results.filter(r=>r.status==='fulfilled');
  // Uma implementação com corrida pode perder a referência do primeiro servidor.
  // Limpar somente os listeners loopback cujas portas foram devolvidas ao teste.
  const ports=new Set(fulfilled.map(r=>Number(new URL(new URL(r.value.url).searchParams.get('redirect_uri')).port)));
  t.after(()=>{for(const handle of process._getActiveHandles()){
    if(typeof handle.address!=='function'||typeof handle.close!=='function')continue;
    const address=handle.address();if(address?.address==='127.0.0.1'&&ports.has(address.port))handle.close();
  }});
  assert.equal(fulfilled.length,1,'uma única tentativa deve possuir o listener e o state');
  assert.equal(results.find(r=>r.status==='rejected')?.reason?.code,'login_em_andamento');
});

test('encerrar durante leitura do cofre não reabre login nem listener depois',async t=>{
  const f=fixture(t);let release,entered;
  const reading=new Promise(resolve=>entered=resolve);
  f.client.cofre.estado=()=>new Promise(resolve=>{release=()=>resolve({disponivel:true,configurada:false});entered();});
  const started=f.client.iniciarLogin();await reading;f.client.encerrar();release();
  await assert.rejects(started,{code:'operacao_cancelada'});
  assert.equal(f.client.pending,null);
});

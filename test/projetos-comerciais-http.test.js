import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';

test('Projetos HTTP: sem pasta, fonte restrita, linha do tempo e organização reversível',async t=>{
  const db=abrirBanco(),contexto=new ContextoApp(db),desktop=new Desktop(db);
  contexto.receber({type:'notify',messages:[
    {key:{id:'acordo',remoteJid:'5511@s.whatsapp.net',fromMe:false},messageTimestamp:1790326800,message:{conversation:'Vamos criar o Produto Sol. Outro assunto: o Produto Lua ainda está em estudo.'}},
    {key:{id:'restrita',remoteJid:'grupo@g.us',fromMe:false},messageTimestamp:1790326801,message:{conversation:'Conteúdo de grupo não autorizado.'}}
  ]});
  const server=criarServidor(db,{desktop:true,contexto,conexao:{estado:()=>({estado:'desconectada'}),parar:async()=>{}}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await (await fetch(base+'/api/sessao')).json();
  const headers={'x-assessor-token':token,'content-type':'application/json'},prefixo=base+'/api/v3/projetos-comerciais';
  const get=route=>fetch(prefixo+route,{headers});
  const post=(route,data,extra={})=>fetch(prefixo+'/'+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  const rascunho={nome:'Produto Sol',fontes:[{eventoId:1,trecho:'Vamos criar o Produto Sol.'}],natureza:'acordo_citado'};
  assert.equal((await post('rascunho',rascunho)).status,403);
  desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});
  assert.equal((await fetch(prefixo)).status,403);
  assert.equal((await post('rascunho',rascunho,{origin:'https://externo.invalid'})).status,403);
  for(const invalido of [null,[],{...rascunho,raiz:'C:/privado'}])assert.equal((await post('rascunho',invalido)).status,400);
  assert.equal((await post('rascunho',{nome:'Sem permissão',fontes:[{eventoId:2}]})).status,409);
  const {projeto}=await (await post('rascunho',rascunho)).json();
  assert.equal(projeto.estado,'rascunho');assert.equal(projeto.acordoVerificado,false);
  assert.equal(projeto.fontes[0].trecho,'Vamos criar o Produto Sol.');
  assert.equal(Object.hasOwn(projeto,'raiz'),false);
  const repetido=await (await post('rascunho',rascunho)).json();assert.equal(repetido.projeto.id,projeto.id);
  const confirmacao=await (await post('confirmar',{id:projeto.id,confirmar:true})).json();
  assert.equal(confirmacao.projeto.estado,'confirmado');assert.equal(confirmacao.projeto.acordoVerificado,false);
  const lista=await (await get('?estado=confirmado')).json();assert.equal(lista.projetos.length,1);
  const pagina=await (await get('/timeline?id='+projeto.id+'&limite=1')).json();
  assert.equal(pagina.timeline.length,1);assert.ok(Number.isSafeInteger(pagina.antes));
  assert.equal((await get('/item?id='+projeto.id+'&id=outro')).status,400);
  assert.equal((await post('arquivar',{id:projeto.id,confirmar:false})).status,400);
  await post('arquivar',{id:projeto.id,confirmar:true});
  const restauracao=await (await post('restaurar',{id:projeto.id,confirmar:true})).json();assert.equal(restauracao.projeto.estado,'rascunho');
  db.prepare('UPDATE eventos SET texto=? WHERE id=1').run('A mensagem foi corrigida.');
  assert.equal((await get('/item?id='+projeto.id)).status,404);
  assert.deepEqual((await (await get('')).json()).projetos,[]);
  assert.equal((await post('confirmar',{id:projeto.id,confirmar:true})).status,409);
});

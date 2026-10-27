import test from 'node:test';
import assert from 'node:assert/strict';
import {registrarRotasNotetaker} from '../src/notetaker/http.js';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {NotetakerServico} from '../src/notetaker/servico.js';
import {cabecalhoWav} from '../src/notetaker/contrato.js';
import {LumeMcpReadService} from '../src/mcp/read-service.js';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';

test('tracer HTTP tem rotas explícitas',()=>{
  assert.equal(typeof registrarRotasNotetaker,'function');
});

async function http(port,path,{method='GET',token,origin,host,body,headers={}}={}){
  return await new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path,method,headers:{...(host?{host}:{}),...(origin?{origin}:{}),...(token?{'x-assessor-token':token}:{}),...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks),json(){return JSON.parse(this.bytes.toString())}}));});req.on('error',reject);req.end(body);
  });
}
async function upload(port,id,token,duracao,{tamperHeader=false,truncate=false,mime='audio/wav',chunk=65536,nonzero=false}={}){
  const pcm=duracao*32000,header=cabecalhoWav(pcm);
  if(tamperHeader)header.write('LIST',36,'ascii');
  const expected=createHash('sha256').update(header),zero=Buffer.alloc(chunk);if(nonzero)zero.fill(1);
  const resposta=new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path:`/api/v3/notetaker/sessoes/${id}/importar`,method:'POST',headers:{'x-assessor-token':token,'content-type':mime}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});req.on('error',reject);
    (async()=>{req.write(header);let restante=truncate?pcm-2:pcm;while(restante){const n=Math.min(restante,chunk),b=zero.subarray(0,n);expected.update(b);if(!req.write(b))await once(req,'drain');restante-=n;}req.end();})().catch(reject);
  });
  const r=await resposta;return {...r,hash:expected.digest('hex')};
}

async function pacoteRuntime(root,runner){
  const raiz=join(root,'bundle'),hash=b=>createHash('sha256').update(b).digest('hex');await mkdir(raiz);
  const binary=Buffer.from('executavel-sintetico'),weights=Buffer.from('modelo-sintetico');
  const manifesto={versao:1,motor:'whisper.cpp',versaoMotor:'teste-1',plataforma:process.platform,arquitetura:process.arch,
    modeloNome:'modelo-teste',executavelBytes:binary.length,executavelSha256:hash(binary),modeloBytes:weights.length,modeloSha256:hash(weights)};
  await writeFile(join(raiz,process.platform==='win32'?'whisper-cli.exe':'whisper-cli'),binary);
  await writeFile(join(raiz,'modelo.bin'),weights);const bytes=Buffer.from(JSON.stringify(manifesto));await writeFile(join(raiz,'manifest.json'),bytes);
  return criarAudioLocalRuntime({raiz,manifestoSha256:hash(bytes),runner});
}

test('HTTP autenticado importa 61s, reinicia, busca fonte e reproduz hash',async()=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;
  let db,server;
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    db=abrirBanco(join(root,'db.sqlite'));new ContextoApp(db);new Desktop(db).aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
    let asrCalls=0,failRunner=false;
    const audioLocal=await pacoteRuntime(root,async(_binary,args)=>{
      assert.equal(db.prepare('SELECT importacao_estado FROM notetaker_sessoes').get().importacao_estado,'completa');
      asrCalls++;
      if(failRunner)throw new Error('falha sintética do motor');
      await writeFile(args[args.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'pt'},transcription:[{offsets:{from:0,to:900},text:'trecho sintético'}]}));
    });
    const opts={desktop:true,notetakerExperimento:true,testProfileRoot:root,testMarker:marker,audioLocal};
    server=criarServidor(db,opts);await new Promise(r=>server.listen(0,'127.0.0.1',r));let port=server.address().port;
    let token=(await http(port,'/api/sessao')).json().token;
    assert.equal((await http(port,'/api/v3/notetaker/sessoes',{method:'POST',headers:{'content-type':'application/json'},body:'{"origem":"importacao","entradas":["importacao"]}'})).status,403);
    assert.equal((await http(port,'/api/v3/notetaker/sessoes',{method:'POST',token,origin:'http://evil.invalid',headers:{'content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await http(port,'/api/v3/notetaker/sessoes',{method:'POST',token,host:'evil.invalid',headers:{'content-type':'application/json'},body:'{}'})).status,403);
    const created=await http(port,'/api/v3/notetaker/sessoes',{method:'POST',token,headers:{'content-type':'application/json'},body:'{"origem":"importacao","entradas":["importacao"]}'});
    assert.equal(created.status,201);const id=created.json().id;
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${id}/consentir`,{method:'POST',token,headers:{'content-type':'application/json'},body:'{"entradas":["importacao"],"confirmar":true}'})).status,200);
    const uploaded=await upload(port,id,token,61,{nonzero:true});assert.equal(uploaded.status,200);assert.equal(uploaded.data.partes.length,2);assert.equal(uploaded.data.sha256,uploaded.hash);assert.equal(uploaded.data.asr.estado,'concluida');assert.equal(asrCalls,2);
    const retry=await upload(port,id,token,61,{nonzero:true});assert.equal(retry.status,200);assert.equal(retry.data.partes.length,2);assert.ok(retry.data.partes.every(p=>p.repetida));assert.equal(asrCalls,2);
    const partIds=uploaded.data.partes.map(p=>p.id);
    const evento=db.prepare("SELECT id FROM eventos WHERE tipo='notetaker_trecho' ORDER BY id LIMIT 1").get().id;
    const found=new LumeMcpReadService(db).fonte(evento,{kind:'all'});assert.equal(found.author,'Autoria não identificada');assert.equal(found.source_time_ms,0);
    const orfao=db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('local:notetaker:orfao','trecho:orfao','entrada','notetaker_trecho','','órfão','2026-09-27T00:00:00Z','2026-09-27','minha') RETURNING id").get().id;
    assert.equal(new LumeMcpReadService(db).fonte(orfao,{kind:'all'}),null);
    await new Promise(r=>server.close(r));server=null;db.close();db=abrirBanco(join(root,'db.sqlite'));
    server=criarServidor(db,opts);await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;token=(await http(port,'/api/sessao')).json().token;
    const state=await http(port,`/api/v3/notetaker/sessoes/${id}`,{token});assert.equal(state.json().partes.length,2);assert.equal(state.json().coberturaMs,61000);assert.equal(state.json().asr,'concluida');
    const trechoId=db.prepare('SELECT trecho_id FROM notetaker_fontes WHERE evento_id=?').get(evento).trecho_id;
    const rota=`/api/v3/notetaker/trechos/${trechoId}`;
    assert.equal((await http(port,rota)).status,403);
    assert.equal((await http(port,rota,{method:'PATCH',headers:{'content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await http(port,rota,{token,origin:'http://evil.invalid',method:'PATCH',headers:{'content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await http(port,rota,{token})).json().textoGerado,'trecho sintético');
    assert.equal((await http(port,rota,{token,method:'PATCH',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
    const json={'content-type':'application/json; charset=utf-8'};
    const payload=texto=>JSON.stringify({texto,revisaoEsperada:0,confirmar:true});
    for(const bad of [Buffer.from([0xc3]),JSON.stringify({texto:'\ud800',revisaoEsperada:0,confirmar:true}),
      JSON.stringify({texto:'x',revisaoEsperada:0,confirmar:true,ator:'cliente'})])
      assert.equal((await http(port,rota,{token,method:'PATCH',headers:json,body:bad})).status,400);
    assert.equal((await http(port,rota,{token,method:'PATCH',headers:json,body:Buffer.alloc(65537,32)})).status,413);
    const alterado=await http(port,rota,{token,method:'PATCH',headers:json,body:payload('texto revisto 📝')});
    assert.equal(alterado.status,200);assert.equal(alterado.json().textoExibido,'texto revisto 📝');
    const conflito=await http(port,rota,{token,method:'PATCH',headers:json,body:payload('outra versão')});
    assert.equal(conflito.status,409);assert.equal(conflito.json().codigo,'CONFLITO');assert.equal(JSON.stringify(conflito.json()).includes('texto revisto'),false);
    const hist=`${rota}/correcoes`;
    assert.equal((await http(port,hist,{token})).json().correcoes.length,1);
    for(const q of ['?antes=1&antes=2','?antes=0','?antes=1e2','?limite=21','?limite=+1','?x=1'])
      assert.equal((await http(port,hist+q,{token})).status,400,q);
    assert.equal((await http(port,rota+'?limite=1',{token})).status,400);
    const source=await http(port,`/api/v3/notetaker/fontes/${evento}`,{token});assert.equal(source.json().autoria,'Autoria não identificada');
    const first=await http(port,`/api/v3/notetaker/partes/${partIds[0]}/audio`,{token});assert.equal(first.status,200);assert.equal(createHash('sha256').update(first.bytes).digest('hex'),uploaded.data.partes[0].sha256);
    const ranged=await http(port,`/api/v3/notetaker/partes/${partIds[0]}/audio`,{token,headers:{range:'bytes=0-43'}});assert.equal(ranged.status,206);assert.equal(ranged.bytes.length,44);
    assert.equal((await http(port,`/api/v3/notetaker/partes/${partIds[0]}/audio`,{token,headers:{range:'bytes=9000000-'}})).status,416);
    assert.equal((await http(port,`/api/v3/notetaker/partes/../../bad/audio`,{token})).status,404);
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${id}/partes`,{method:'POST',token,headers:{'content-type':'audio/wav','x-lume-entrada':'importacao','x-lume-posicao':'2'},body:first.bytes})).status,403);
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${id}/importar`,{method:'POST',token,headers:{'content-type':'application/octet-stream'},body:first.bytes})).status,415);
    failRunner=true;
    const erroAsr=await http(port,'/api/v3/notetaker/sessoes',{method:'POST',token,headers:{'content-type':'application/json'},body:'{"origem":"importacao","entradas":["importacao"]}'});
    const falhaId=erroAsr.json().id;
    await http(port,`/api/v3/notetaker/sessoes/${falhaId}/consentir`,{method:'POST',token,headers:{'content-type':'application/json'},body:'{"entradas":["importacao"],"confirmar":true}'});
    const falhaUpload=await upload(port,falhaId,token,1,{nonzero:true});assert.equal(falhaUpload.status,200);assert.equal(falhaUpload.data.asr.estado,'falha');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_fontes WHERE sessao_id=?').get(falhaId).n,0);
    assert.equal((await http(port,`/api/v3/notetaker/partes/${falhaUpload.data.partes[0].id}/audio`,{token})).status,200);
    const invalida=await http(port,'/api/v3/notetaker/sessoes',{method:'POST',token,headers:{'content-type':'application/json'},body:'{"origem":"importacao","entradas":["importacao"]}'});
    const iid=invalida.json().id;
    await http(port,`/api/v3/notetaker/sessoes/${iid}/consentir`,{method:'POST',token,headers:{'content-type':'application/json'},body:'{"entradas":["importacao"],"confirmar":true}'});
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${iid}/importar`,{method:'POST',token,headers:{'content-type':'audio/wav'},body:Buffer.concat([cabecalhoWav(32000),Buffer.alloc(2)])})).status,400);
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${iid}/importar`,{method:'POST',token,headers:{'content-type':'audio/wav'},body:Buffer.concat([cabecalhoWav(2),Buffer.alloc(4)])})).status,400);
    const extra=cabecalhoWav(2);extra.write('LIST',36,'ascii');
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${iid}/importar`,{method:'POST',token,headers:{'content-type':'audio/wav'},body:Buffer.concat([extra,Buffer.alloc(2)])})).status,400);
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${iid}`,{token})).json().importacao,'incompleta');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos WHERE conversa_id=?').get(`local:notetaker:${iid}`).n,0);
    await writeFile(join(root,'notetaker-audio',partIds[0]+'.wav'),Buffer.from('corrompido'));
    assert.equal((await http(port,`/api/v3/notetaker/partes/${partIds[0]}/audio`,{token})).status,503);
    assert.equal((await http(port,`/api/v3/notetaker/fontes/${evento}`,{token})).status,503);
    new NotetakerServico(db,opts);
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${id}`,{token})).json().coberturaMs,1000);
    db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run(new Date().toISOString(),id);
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${id}`,{token})).status,403);
    assert.equal(new LumeMcpReadService(db).fonte(evento,{kind:'all'}),null);
  }finally{if(server)await new Promise(r=>server.close(r));db?.close();if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;await rm(root,{recursive:true,force:true});}
});

test('PATCH preserva UTF-8 dividido entre chunks e mantém gates de termos e perfil',async()=>{
  const id=randomUUID(),body=Buffer.from(JSON.stringify({texto:'síntese 📝',revisaoEsperada:0,confirmar:true}));
  const corte=body.indexOf(Buffer.from('í'))+1;
  let chamado,saida;
  const req={method:'PATCH',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield body.subarray(0,corte);yield body.subarray(corte);}};
  await registrarRotasNotetaker(req,{},new URL(`http://localhost/api/v3/notetaker/trechos/${id}`),{
    servico:{corrigirTrecho(_id,input){chamado=input;return {textoExibido:input.texto};}},
    json(status,data){saida={status,data};}
  });
  assert.equal(saida.status,200);assert.equal(chamado.texto,'síntese 📝');
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;let db,server;
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    db=abrirBanco(join(root,'db.sqlite'));new ContextoApp(db);const desktop=new Desktop(db);
    server=criarServidor(db,{desktop:true,notetakerExperimento:true,testProfileRoot:root,testMarker:marker});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));let port=server.address().port;
    let token=(await http(port,'/api/sessao')).json().token;
    assert.equal((await http(port,`/api/v3/notetaker/trechos/${id}`,{token,method:'PATCH',
      headers:{'content-type':'application/json'},body:'{}'})).status,403);
    await new Promise(r=>server.close(r));server=null;
    desktop.aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
    server=criarServidor(db,{desktop:true,notetakerExperimento:true,testProfileRoot:root,testMarker:randomUUID()});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
    token=(await http(port,'/api/sessao')).json().token;
    assert.equal((await http(port,`/api/v3/notetaker/trechos/${id}`,{token,method:'PATCH',
      headers:{'content-type':'application/json'},body:'{}'})).status,404);
  }finally{if(server)await new Promise(r=>server.close(r));db?.close();
    if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;
    await rm(root,{recursive:true,force:true});}
});

test('upload HTTP de 2 h é fracionado sem materializar arquivo inteiro',async(t)=>{
  const root=await mkdtemp(join(tmpdir(),'lume-notetaker-')),marker=randomUUID(),old=process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE=root;let db,server;
  try{
    await writeFile(join(root,'.lume-notetaker-test'),marker);
    db=abrirBanco(join(root,'db.sqlite'));new ContextoApp(db);new Desktop(db).aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
    server=criarServidor(db,{desktop:true,notetakerExperimento:true,testProfileRoot:root,testMarker:marker});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port,token=(await http(port,'/api/sessao')).json().token;
    const created=await http(port,'/api/v3/notetaker/sessoes',{method:'POST',token,headers:{'content-type':'application/json'},body:'{"origem":"importacao","entradas":["importacao"]}'});
    const id=created.json().id;
    assert.equal((await http(port,`/api/v3/notetaker/sessoes/${id}/consentir`,{method:'POST',token,headers:{'content-type':'application/json'},body:'{"entradas":["importacao"],"confirmar":true}'})).status,200);
    let peak=process.memoryUsage().rss,baseline=peak;const timer=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10);
    let uploaded;try{uploaded=await upload(port,id,token,7200);}finally{clearInterval(timer);}
    assert.equal(uploaded.status,200);assert.equal(uploaded.data.bytes,230400044);assert.equal(uploaded.data.sha256,uploaded.hash);assert.equal(uploaded.data.partes.length,120);
    assert.equal(uploaded.data.asr.estado,'indisponivel');assert.equal(db.prepare('SELECT COUNT(*) n FROM notetaker_fontes').get().n,0);
    t.diagnostic(`RSS adicional observado: ${((peak-baseline)/1024/1024).toFixed(1)} MiB`);
    assert.ok(peak-baseline<160*1024*1024,`RSS adicional ${(peak-baseline)/1024/1024} MiB`);
    const state=await http(port,`/api/v3/notetaker/sessoes/${id}`,{token});assert.equal(state.json().coberturaMs,7200000);assert.equal(state.json().asr,'indisponivel');
    for(const i of [0,60,119]){
      const p=uploaded.data.partes[i],r=await http(port,`/api/v3/notetaker/partes/${p.id}/audio`,{token});
      assert.equal(r.status,200);assert.equal(createHash('sha256').update(r.bytes).digest('hex'),p.sha256);
    }
  }finally{if(server)await new Promise(r=>server.close(r));db?.close();if(old===undefined)delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;else process.env.ASSESSOR_DESKTOP_TEST_PROFILE=old;await rm(root,{recursive:true,force:true});}
});

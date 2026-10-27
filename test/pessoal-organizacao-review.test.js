// Independent reviewer: synthetic SQLite/streams and loopback only; no real transport/model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {ClassificadorPessoal} from '../src/pessoal/classificador.js';
import {FerramentasPessoais} from '../src/pessoal/ferramentas.js';
import {lerJsonLimitado} from '../src/pessoal/leitura-limitada.js';
import {criarServidor} from '../src/painel/servidor.js';

const DM='550000000071@s.whatsapp.net',OTHER='550000000072@s.whatsapp.net';
const TEXT='Pode preparar o projeto de implantação da loja?';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const items=view=>[...view.comercial,...view.tarefas,...view.projetos];
async function fixture(t,{accepted=true}={}){
  const db=abrirBanco(),contexto=new ContextoApp(db),desktop=new Desktop(db);
  if(accepted)desktop.aceitar({nome:'Revisão sintética',aceito:true,versao:VERSAO_TERMOS});
  let now=new Date('2026-10-26T23:00:00.000Z'),seq=0,modelCalls=0,classifierCalls=0;
  const pessoal=new LumePessoal(db,{desktop,agora:()=>now,fetchImpl:()=>assert.fail('No network'),credencial:()=>assert.fail('No real vault'),telegram:{estado:async()=>({}),agendar:()=>false},conexao:{estado:()=>({estado:'desconectada'}),enviarTexto:()=>assert.fail('No transport')},chatgpt:{estado:async()=>({}),encerrar(){},responder:async request=>{
    modelCalls++;const input=JSON.parse(request.input.at(-1).content),e=input.mensagemAtual;
    return {completed:true,text:JSON.stringify({decisao:'consultar_dono',resumo:'Preparar projeto da loja',trecho:e.texto,baloes:['Vou conferir o projeto e preparar o plano.'],fontes:[e.id],motivo:'Revisão sintética.'})};
  }}});
  const classifier=new ClassificadorPessoal(db,{pessoal,agora:()=>now,segredos:{estado:async()=>({configurada:true}),ler:async()=>'SYNTHETIC_ONLY'},avaliar:async()=>{classifierCalls++;return {modelo:'typesafe/jev-1.14',origem:'jev',temperatura:'insuficiente',etapa:'insuficiente',assunto:{valor:'projeto',confianca:.9},andamento:{valor:'planejado',confianca:.9},continuidade:{valor:'novo_assunto',confianca:.9}};}});
  pessoal.classificador=classifier;await pessoal.configurar({enabled:true});
  for(const id of [DM,OTHER]){db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,'Pessoa homônima');pessoal.configurarConversa({conversaId:id,categoria:'lead',modo:'rascunhar',remoto:true});}
  await classifier.configurar({enabled:true,confirmar:true,limiteMensalMicrousd:10000});
  t.after(async()=>{await classifier.encerrar();await pessoal.encerrar();db.close();});
  const f={db,contexto,desktop,pessoal,classifier,modelCalls:()=>modelCalls,classifierCalls:()=>classifierCalls};
  f.receive=({id=DM,text=TEXT,type='notify'}={})=>{
    now=new Date(+now+1000);const r=contexto.receber({type,messages:[{key:{id:'org-review-'+(++seq),remoteJid:id,fromMe:false},messageTimestamp:Math.floor(+now/1000),message:{conversation:text}}]});assert.equal(r.falhas,0);
    db.prepare("UPDATE etapas SET proxima_tentativa_em='2000-01-01T00:00:00.000Z'").run();return db.prepare('SELECT * FROM eventos ORDER BY id DESC LIMIT 1').get();
  };
  f.count=table=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  f.stage=(e,stage)=>db.prepare('SELECT * FROM etapas WHERE evento_id=? AND etapa=?').get(e.id,stage);
  return f;
}
async function localServer(t,f,{readOnly=false}={}){
  const server=criarServidor(f.db,{desktop:true,pessoal:f.pessoal,contexto:f.contexto,readOnly,conexao:{estado:()=>({estado:'desconectada'})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,{token}=await(await fetch(origin+'/api/sessao')).json();
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  return ({auth=true,headers={},suffix=''}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(origin+'/api/v3/pessoal/organizacao'+suffix,{headers:{...(auth?{'x-assessor-token':token}:{}),...headers}},res=>{let raw='';res.setEncoding('utf8');res.on('data',v=>{raw+=v;});res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw),raw}));res.on('error',reject);});req.on('error',reject);req.end();
  });
}

test('review organização: classificação e extração nas duas ordens produzem o mesmo rascunho único',async t=>{
  for(const order of ['classify-first','extract-first']){
    const f=await fixture(t),e=f.receive();
    if(order==='classify-first'){await f.classifier.tick();assert.equal(f.count('lume_projetos_comerciais'),0);await f.pessoal.tick();}
    else{await f.pessoal.tick();assert.equal(f.count('lume_projetos_comerciais'),0);await f.classifier.tick();}
    assert.equal(f.count('lume_projetos_comerciais'),1);assert.equal(f.count('pessoal_propostas'),1);assert.equal(f.count('desktop_negocios'),0);assert.equal(f.count('saidas'),0);
    const [project]=f.db.prepare('SELECT * FROM lume_projetos_comerciais').all();assert.equal(project.estado,'rascunho');assert.equal(project.natureza,'incerto');
    const [item]=items(f.pessoal.organizacao.listar());assert.equal(item.eventoId,e.id);assert.equal(item.fonte.trecho,TEXT);assert.equal(item.projeto.id,project.id);
    await Promise.all([f.classifier.tick(),f.pessoal.tick()]);for(let i=0;i<3;i++)f.pessoal.organizarDemanda(item.acaoId);
    assert.equal(f.count('lume_projetos_comerciais'),1);assert.equal(f.modelCalls(),1);assert.equal(f.classifierCalls(),1);
  }
});
test('review organização: avaliação antiga ilegível não transforma resposta válida em falha',async t=>{
  const f=await fixture(t),e=f.receive();f.db.prepare('INSERT INTO lume_vendas_avaliacoes VALUES(?,?,?,?,?)').run(randomUUID(),DM,'a'.repeat(64),'{','2026-10-26T22:00:00.000Z');
  await f.pessoal.tick();assert.equal(f.modelCalls(),1);assert.equal(f.count('lume_acoes'),1);assert.equal(f.stage(e,'assistencia').estado,'concluida');assert.equal(f.count('pessoal_propostas'),1);
});
test('review organização: falha de consulta auxiliar não desfaz conclusão durável do classificador',async t=>{
  const f=await fixture(t),e=f.receive();await f.pessoal.tick();
  f.pessoal.organizacao.vendas.obter=()=>{throw Error('SYNTHETIC_METADATA_FAILURE');};
  await f.classifier.tick();assert.equal(f.count('lume_vendas_avaliacoes'),1);assert.equal(f.stage(e,'classificacao_pessoal').estado,'concluida');assert.equal(f.count('pessoal_propostas'),1);assert.equal(f.classifierCalls(),1);
});
test('review organização: erro ao gravar projeto preserva resposta e permite organização posterior sem modelo',async t=>{
  const f=await fixture(t);f.receive();await f.classifier.tick();
  f.db.exec("CREATE TRIGGER review_project_failure BEFORE INSERT ON lume_projetos_fontes BEGIN SELECT RAISE(ABORT,'synthetic project failure'); END");
  await f.pessoal.tick();assert.equal(f.count('pessoal_propostas'),1);assert.equal(f.count('lume_projetos_comerciais'),0);
  f.db.exec('DROP TRIGGER review_project_failure');const action=f.db.prepare('SELECT id FROM lume_acoes').get();f.pessoal.organizarDemanda(action.id);
  assert.equal(f.count('lume_projetos_comerciais'),1);assert.equal(f.modelCalls(),1);assert.equal(f.classifierCalls(),1);
});
test('review organização: novo assunto e homônimos mantêm fontes exatas e revogação remove derivação',async t=>{
  const f=await fixture(t);const events=[];
  for(const [id,text]of [[DM,TEXT],[DM,'Outro assunto: pode planejar o projeto da clínica?'],[OTHER,TEXT]]){events.push(f.receive({id,text}));await f.pessoal.tick();await f.classifier.tick();}
  assert.equal(f.count('lume_projetos_comerciais'),3);const links=f.db.prepare('SELECT projeto_id,evento_id FROM lume_projetos_fontes').all();assert.equal(new Set(links.map(x=>x.projeto_id)).size,3);assert.deepEqual(new Set(links.map(x=>x.evento_id)),new Set(events.map(x=>x.id)));
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(events[1].id);const current=items(f.pessoal.organizacao.listar());assert.ok(!current.some(x=>x.eventoId===events[1].id));assert.ok(current.some(x=>x.eventoId===events[2].id));
});
test('review organização: HTTP exige sessão/origem/aceite, aceita readOnly sem efeitos',async t=>{
  const f=await fixture(t);f.receive();await f.pessoal.tick();await f.classifier.tick();
  f.db.prepare('UPDATE conversas_app SET nome=? WHERE id=?').run('Primeira pessoa sintética',DM);
  f.db.prepare('UPDATE conversas_app SET nome=? WHERE id=?').run('Segunda pessoa sintética',OTHER);
  f.receive({id:OTHER});await f.pessoal.tick();await f.classifier.tick();
  const request=await localServer(t,f,{readOnly:true});
  for(const opts of [{auth:false},{headers:{'x-assessor-token':'wrong'}},{headers:{origin:'https://evil.invalid'}},{headers:{host:'evil.invalid'}},{headers:{'sec-fetch-site':'cross-site'}}])assert.equal((await request(opts)).status,403);
  assert.equal((await request({suffix:'?limite=101'})).status,400);const before=f.db.prepare('SELECT total_changes() n').get().n,response=await request();assert.equal(response.status,200);assert.equal(items(response.data).length,2);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  assert.equal(items(response.data).find(x=>x.conversaId===DM).conversaNome,'Primeira pessoa sintética');
  assert.equal(items(response.data).find(x=>x.conversaId===OTHER).conversaNome,'Segunda pessoa sintética');
  f.pessoal.configurarAtendimento({conversaId:DM,acao:'excluir'});const remaining=items((await request()).data);assert.equal(remaining.length,1);assert.equal(remaining[0].conversaId,OTHER);assert.equal(remaining[0].conversaNome,'Segunda pessoa sintética');
  const fresh=await fixture(t,{accepted:false}),locked=await localServer(t,fresh);assert.equal((await locked()).status,403);
});
test('review ferramentas: 512 KiB exatos passam, limite acumulado em chunks cancela',async()=>{
  const payload=JSON.stringify({text:'á'.repeat(260000)}),bytes=new TextEncoder().encode(payload);const padded=new Uint8Array(524288);padded.fill(32);padded.set(bytes);
  assert.equal((await lerJsonLimitado(new Response(padded))).text.length,260000);
  let canceled=false;
  const response=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(262144));c.enqueue(new Uint8Array(262145));},cancel(){canceled=true;}}));
  await assert.rejects(lerJsonLimitado(response),/resposta_excessiva/);assert.equal(canceled,true);
});
test('review ferramentas: deadline total não renova entre cofre, fetch e corpo, nem inicia outro vínculo',async t=>{
  const f=await fixture(t);let requests=0,reads=0,canceled=false;
  const tools=new FerramentasPessoais(f.db,{permitida:()=>true,prazoMs:70,credencial:async()=>{reads++;await delay(20);return null;},fetchImpl:async()=>{requests++;await delay(20);return new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){canceled=true;}}));}});
  tools.vincular({conversaId:DM,tipo:'github',recurso:'synthetic/a'});tools.vincular({conversaId:DM,tipo:'github',recurso:'synthetic/b'});
  const result=await Promise.race([tools.consultar(DM),delay(400).then(()=>null)]);assert.ok(result);assert.ok(result.every(x=>!x.disponivel));assert.equal(canceled,true);assert.equal(reads,1);assert.equal(requests,1);
});
test('review ferramentas: cofre que termina após deadline não inicia fetch tardio',async t=>{
  const f=await fixture(t);let resolve,calls=0;const secret=new Promise(r=>{resolve=r;});
  const tools=new FerramentasPessoais(f.db,{permitida:()=>true,prazoMs:20,credencial:()=>secret,fetchImpl:()=>{calls++;assert.fail('Late fetch');}});tools.vincular({conversaId:DM,tipo:'github',recurso:'synthetic/a'});
  const result=await Promise.race([tools.consultar(DM),delay(200).then(()=>null)]);assert.ok(result);assert.equal(result[0].disponivel,false);resolve('SYNTHETIC_ONLY');await delay(5);assert.equal(calls,0);
});

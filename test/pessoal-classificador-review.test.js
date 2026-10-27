// Independent review: isolated SQLite and loopback HTTP; no real credentials or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop, VERSAO_TERMOS} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {LumePessoal} from '../src/pessoal/servico.js';
import {ClassificadorPessoal} from '../src/pessoal/classificador.js';
import {Backup} from '../src/backup.js';
import {criarServidor} from '../src/painel/servidor.js';
import {VendasJev} from '../src/vendas/servico.js';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {criarPerfilRealSintetico} from './fixtures/backup-schema-real.js';
import {abrirOraculoStagingV9} from './fixtures/backup-restore-oraculo.js';
import {criarOrigemV9} from '../src/backup-acervo-v9.js';
import {gravarPacote} from '../src/backup-stream.js';
import {validarAcervoV9,descartarPlanoV9} from '../src/backup-acervo-restore-v9.js';

const DM='550000000091@s.whatsapp.net', OTHER='550000000092@s.whatsapp.net';
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const reply={modelo:'typesafe/jev-1.14',origem:'jev',temperatura:'insuficiente',etapa:'insuficiente',assunto:{valor:'tarefa',confianca:.8},andamento:{valor:'planejado',confianca:.8},continuidade:{valor:'incerto',confianca:.8}};
async function fixture(t,{evaluate,active=true,accepted=true,read}={}){
  const db=abrirBanco(),contexto=new ContextoApp(db),desktop=new Desktop(db);
  if(accepted)desktop.aceitar({nome:'Revisão sintética',aceito:true,versao:VERSAO_TERMOS});
  let now=new Date('2026-10-26T22:00:00.000Z'),seq=0,calls=0,reads=0,configured=true;
  const pessoal=new LumePessoal(db,{desktop,agora:()=>now,chatgpt:{estado:async()=>({}),encerrar(){}},telegram:{estado:async()=>({})},conexao:{enviarTexto:()=>assert.fail('No replies')},fetchImpl:()=>assert.fail('No external network')});
  const f={db,contexto,desktop,pessoal,calls:()=>calls,reads:()=>reads,advance:ms=>{now=new Date(+now+ms);}};
  const segredos={estado:async()=>({configurada:configured}),ler:async()=>{reads++;return read?read(f):'SYNTHETIC_ONLY';},remover:async()=>{configured=false;},gravar:async()=>{configured=true;}};
  const c=new ClassificadorPessoal(db,{pessoal,segredos,agora:()=>now,avaliar:async args=>{calls++;return evaluate?evaluate(f,args):reply;}});
  pessoal.classificador=c;Object.assign(f,{c,segredos});
  if(active){await pessoal.configurar({enabled:true});for(const id of [DM,OTHER]){db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,'Pessoa sintética');pessoal.configurarConversa({conversaId:id,categoria:'lead',modo:'rascunhar',remoto:true});}}
  f.enable=(limit=10000)=>c.configurar({enabled:true,confirmar:true,limiteMensalMicrousd:limit});
  f.receive=({id=DM,type='notify',text='Pode preparar este documento?',sameTime=false}={})=>{
    if(!sameTime)f.advance(1000);
    const result=contexto.receber({type,messages:[{key:{id:'review-'+(++seq),remoteJid:id,fromMe:false},messageTimestamp:Math.floor(+now/1000),message:{conversation:text}}]});
    assert.equal(result.falhas,0);
    db.prepare("UPDATE etapas SET proxima_tentativa_em='2000-01-01T00:00:00.000Z' WHERE etapa='classificacao_pessoal'").run();
    return db.prepare('SELECT * FROM eventos ORDER BY id DESC LIMIT 1').get();
  };
  f.rows=()=>db.prepare('SELECT * FROM lume_vendas_avaliacoes').all();
  f.stage=id=>db.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='classificacao_pessoal'").get(id);
  t.after(async()=>{await c.encerrar();await pessoal.encerrar();db.close();});
  return f;
}
async function localServer(t,f,{readOnly=false}={}){
  const server=criarServidor(f.db,{desktop:true,readOnly,pessoal:f.pessoal,contexto:f.contexto,segredosJev:f.segredos,conexao:{estado:()=>({estado:'desconectada'})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const {token}=await(await fetch(origin+'/api/sessao')).json();
  const request=(path='/api/v3/pessoal/classificador',{body,auth=true,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(origin+path,{method:body===undefined?'GET':'POST',headers:{...(auth?{'x-assessor-token':token}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...headers}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',v=>{raw+=v;});res.on('end',()=>resolve({status:res.statusCode,raw,data:JSON.parse(raw)}));res.on('error',reject);
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return request;
}

test('review: reativar Lume durante leitura do cofre não recupera autorização em voo',async t=>{
  const f=await fixture(t,{read:async f=>{await f.pessoal.configurar({enabled:false});await f.pessoal.configurar({enabled:true});return 'SYNTHETIC_ONLY';}});
  await f.enable();f.receive();await f.c.tick();assert.equal(f.calls(),0);assert.equal(f.rows().length,0);
});
test('review: revogar e restaurar IA da conversa durante cofre invalida despacho',async t=>{
  const f=await fixture(t,{read:async f=>{const ia=new DesktopIA(f.db);ia.permitir({conversa:DM,permitida:false});ia.permitir({conversa:DM,permitida:true});return 'SYNTHETIC_ONLY';}});
  await f.enable();f.receive();await f.c.tick();assert.equal(f.calls(),0);
});
test('review: remoção da chave via HTTP cancela classificador em voo e descarta retorno',async t=>{
  const entered=defer(),finish=defer();let signal;
  const f=await fixture(t,{evaluate:async(_f,args)=>{signal=args.signal;entered.resolve();await finish.promise;return reply;}}),request=await localServer(t,f);
  await f.enable();f.receive();const running=f.c.tick();await entered.promise;
  try{const response=await request('/api/v3/vendas/jev/remover',{body:{}});assert.equal(response.status,200);}
  finally{finish.resolve();await running;}
  assert.equal(signal.aborted,true,'Removal must cancel the classifier using this same vault');assert.equal(f.rows().length,0);
});
test('review: notificações no mesmo segundo consolidam um único recorte',async t=>{
  const f=await fixture(t);await f.enable();f.receive();f.receive({sameTime:true,text:'Mais um detalhe do mesmo pedido.'});await f.c.tick();await f.c.tick();assert.equal(f.calls(),1);
});
test('review: histórico mais novo não suprime nova notify autorizada',async t=>{
  const f=await fixture(t);await f.enable();const e=f.receive();f.receive({type:'history',text:'Histórico sintético de ordenação posterior.'});await f.c.tick();assert.equal(f.calls(),1);assert.equal(f.stage(e.id).estado,'concluida');
});
test('review: notify atrasada anterior ao segundo da ativação não dispara',async t=>{
  const f=await fixture(t);await f.enable();f.advance(-1000);f.receive({sameTime:true});await f.c.tick();assert.equal(f.calls(),0);
});
test('review: reserva pertence ao mês do despacho após espera pelo cofre',async t=>{
  const f=await fixture(t,{read:async f=>{f.advance(2000);return 'SYNTHETIC_ONLY';}});f.advance(5*86400000+2*3600000-2000);await f.enable();f.receive();await f.c.tick();assert.equal(f.calls(),1);assert.ok((await f.c.estado()).reservadoMicrousd>0,'A dispatch in November must debit November, not October');
});
test('review: falha local na reserva reverte claim sem despacho e preserva reexecução segura',async t=>{
  const f=await fixture(t);await f.enable();const e=f.receive();
  f.db.exec("CREATE TRIGGER review_reservation_failure BEFORE INSERT ON desktop_config WHEN NEW.chave GLOB 'pessoal-classificador:reserva:*' BEGIN SELECT RAISE(ABORT,'synthetic reservation failure'); END");
  await f.c.tick();assert.equal(f.calls(),0);assert.equal(f.stage(e.id).estado,'pendente');assert.equal((await f.c.estado()).reservadoMicrousd,0);
  f.db.exec('DROP TRIGGER review_reservation_failure');await f.c.tick();assert.equal(f.calls(),1);assert.equal(f.stage(e.id).estado,'concluida');
});
test('review: troca de fontes ou exclusão enquanto cofre aguarda impede despacho',async t=>{
  for(const mutate of [f=>f.db.prepare('UPDATE eventos SET texto=? WHERE conversa_id=?').run('Texto alterado',DM),f=>f.pessoal.configurarAtendimento({conversaId:DM,acao:'excluir'}),f=>f.pessoal.configurarConversa({conversaId:DM,categoria:'lead',modo:'rascunhar',remoto:false})]){
    const f=await fixture(t,{read:async f=>{mutate(f);return 'SYNTHETIC_ONLY';}});await f.enable();f.receive();await f.c.tick();assert.equal(f.calls(),0);
  }
});
test('review: exclusão da fonte após despacho impede persistência sem repetir e conserva reserva',async t=>{
  const f=await fixture(t,{evaluate:f=>{f.db.prepare('DELETE FROM eventos WHERE conversa_id=?').run(DM);return reply;}});await f.enable();f.receive();await f.c.tick();await f.c.tick();assert.equal(f.calls(),1);assert.equal(f.rows().length,0);assert.ok((await f.c.estado()).reservadoMicrousd>0);
});
test('review: reserva mensal exata conta erro incerto e não reenvia no mês seguinte',async t=>{
  const f=await fixture(t,{evaluate:()=>{throw Object.assign(Error('SYNTHETIC_SECRET'),{code:'JEV_INDISPONIVEL'});}});await f.enable();f.receive();await f.c.tick();
  const reserved=(await f.c.estado()).reservadoMicrousd;assert.ok(reserved>0);await f.enable(reserved);f.receive({id:OTHER});await f.c.tick();assert.equal(f.calls(),1);
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM etapas').all()),/SYNTHETIC_SECRET/);
  f.advance(32*86400000);await f.c.tick();assert.equal(f.calls(),2,'A previously unclaimed event may run next month');await f.c.tick();assert.equal(f.calls(),2,'Dispatched failure is never retried');
});
test('review: duas instâncias concorrentes disputam claim e reserva uma vez',async t=>{
  const f=await fixture(t);await f.enable();f.receive();const second=new ClassificadorPessoal(f.db,{pessoal:f.pessoal,segredos:f.segredos,agora:()=>new Date('2026-10-26T22:01:00.000Z'),avaliar:()=>assert.fail('Duplicate dispatch')});
  try{await Promise.all([f.c.tick(),second.tick()]);assert.equal(f.calls(),1);}finally{await second.encerrar();}
});
test('review: encerrar interrompe avaliação, descarta retorno tardio e não reenvia',async t=>{
  const entered=defer(),finish=defer();let signal;
  const f=await fixture(t,{evaluate:async(_f,args)=>{signal=args.signal;entered.resolve();await finish.promise;return reply;}});await f.enable();f.receive();const running=f.c.tick();await entered.promise;
  const closed=f.c.encerrar();assert.equal(signal.aborted,true);finish.resolve();await Promise.all([running,closed]);await f.c.tick();assert.equal(f.rows().length,0);assert.equal(f.calls(),1);
});
test('review: backup recusa omitir conteúdo do classificador ativo',async t=>{
  const f=await fixture(t);await f.enable();f.receive();await f.c.tick();assert.throws(()=>new Backup(f.db).capturar(),{code:'PESSOAL_DADOS_NAO_MAPEADOS'});assert.equal(f.rows().length,1);
});
test('review: classificador nunca ativado não bloqueia backup de novas fontes locais',async t=>{
  const f=await fixture(t,{active:false});f.receive();await f.c.tick();assert.equal(f.calls(),0);
  assert.doesNotThrow(()=>new Backup(f.db,{perfil:()=>({nome:'Perfil sintético'})}).capturar());
});
test('review: correção manual HTTP vence avaliação em voo; extras parciais e enums inválidos falham',async t=>{
  const entered=defer(),finish=defer();let signal;
  const f=await fixture(t,{evaluate:async(_f,args)=>{signal=args.signal;entered.resolve();await finish.promise;return reply;}}),request=await localServer(t,f);
  await f.enable();f.receive();const run=f.c.tick();await entered.promise;
  const correction={conversa_id:DM,temperatura:'frio',etapa:'encerrado',confirmar:true,assunto:'pessoal',andamento:'insuficiente',continuidade:'novo_assunto'};
  try{assert.equal((await request('/api/v3/vendas/corrigir',{body:correction})).status,200);}finally{finish.resolve();await run;}
  assert.equal(signal.aborted,true);assert.equal(f.rows().length,1);const saved=JSON.parse(f.rows()[0].resultado);assert.equal(saved.origem,'manual');assert.equal(saved.assunto.valor,'pessoal');assert.equal(saved.assunto.confianca,null);
  for(const invalid of [{...correction,assunto:'invalid'},{...correction,andamento:undefined},{...correction,extra:true},{...correction,continuidade:null}])assert.equal((await request('/api/v3/vendas/corrigir',{body:invalid})).status,400);
  assert.equal(f.rows().length,1);assert.equal(f.calls(),1);
});
test('review: critérios manuais fora do Lume pessoal recusam backup v8/v9 explicitamente',async()=>{
  const f=await criarPerfilRealSintetico();let source;
  try{
    await salesRecord(f.db,'typesafe/jev-1.14');new VendasJev(f.db).corrigir({conversa_id:DM,temperatura:'morno',etapa:'interesse',confirmar:true,assunto:'projeto',andamento:'bloqueado',continuidade:'incerto'});
    assert.throws(()=>new Backup(f.db,{perfil:()=>({nome:'Perfil sintético'})}).capturar(),{code:'PESSOAL_DADOS_NAO_MAPEADOS'});f.db.close();
    await assert.rejects(async()=>{source=await criarOrigemV9({dbPath:f.dbPath,perfil:{dono:'Perfil sintético'}});},{code:'PESSOAL_DADOS_NAO_MAPEADOS'});
  }finally{await source?.fechar();await f.close();}
});
test('review: HTTP classificador protege sessão, origem, host, parâmetros e campos sem ler chave',async t=>{
  const f=await fixture(t),request=await localServer(t,f),body={enabled:true,confirmar:true,limiteMensalMicrousd:10000};
  for(const args of [{auth:false},{headers:{'x-assessor-token':'wrong'}},{headers:{origin:'https://evil.invalid'}},{headers:{host:'evil.invalid'}},{headers:{'sec-fetch-site':'cross-site'}}])for(const data of [undefined,body])assert.equal((await request(undefined,{...args,body:data})).status,403);
  for(const invalid of [{...body,extra:1},{...body,chave:'SYNTHETIC_ONLY'},{...body,confirmar:'true'},{...body,limiteMensalMicrousd:0},{...body,limiteMensalMicrousd:1000001},[],null])assert.equal((await request(undefined,{body:invalid})).status,400);
  for(const data of [undefined,body])assert.equal((await request('/api/v3/pessoal/classificador?extra=1',{body:data})).status,400);
  assert.equal((await request(undefined,{body})).status,200);const state=await request();assert.equal(state.status,200);assert.equal(state.data.enabled,true);assert.doesNotMatch(state.raw,/SYNTHETIC_ONLY/);assert.equal(f.reads(),0);assert.equal(f.calls(),0);
});
test('review: HTTP readOnly e primeiro acesso mantêm classificação fechada',async t=>{
  for(const opts of [{readOnly:true},{accepted:false}]){
    const f=await fixture(t,{accepted:opts.accepted!==false,active:false}),request=await localServer(t,f,opts);
    assert.equal((await request()).status,opts.accepted===false?403:200);assert.equal((await request(undefined,{body:{enabled:true,confirmar:true,limiteMensalMicrousd:10000}})).status,403);assert.equal(f.c.config().enabled,false);assert.equal(f.reads(),0);
  }
});
async function salesRecord(db,model){
  db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,'legacy-review','entrada','texto','{}','Pedido sintético','2026-10-26T20:00:00.000Z','2026-10-26','minha')").run(DM);
  const sales=new VendasJev(db,{segredos:{ler:async()=>'SYNTHETIC_ONLY'},avaliar:async()=>({modelo:model,origem:'jev',temperatura:'morno',etapa:'interesse',criterio:'Interesse sintético',criterio_etapa:'Etapa sintética',confianca:.8,criterios_versao:'vendas-1'})});
  const preview=sales.preparar({conversa_id:DM});const result=await sales.avaliar({previa_id:preview.id,confirmar:true});
  result.consentimento.modelo=model;
  db.prepare('UPDATE lume_vendas_avaliacoes SET resultado=? WHERE id=?').run(JSON.stringify(result),result.id);
  return result;
}
test('review: backup v8 aceita avaliações avulsas 1.13 e 1.14, mantendo versão histórica',async t=>{
  for(const model of ['typesafe/jev-1.13','typesafe/jev-1.14']){
    const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new Desktop(db);const backup=new Backup(db,{perfil:()=>({nome:'Perfil sintético'})});
    await salesRecord(db,model);const captured=backup.capturar();backup.validar(captured);
    const result=JSON.parse(captured.tabelas.lume_vendas_avaliacoes[0].resultado);assert.equal(result.modelo,model);assert.equal(result.consentimento.modelo,model);assert.doesNotMatch(JSON.stringify(captured),/SYNTHETIC_ONLY/);
  }
});
test('review: restore v9 aceita 1.13 e 1.14 e não transfere consentimento para uso remoto',async()=>{
  for(const model of ['typesafe/jev-1.13','typesafe/jev-1.14']){
    const f=await criarPerfilRealSintetico(),staging=join(f.dir,'review-staging'),pacote=join(f.dir,'review.lumebak'),senha='senha sintetica review';let plano;
    try{
      await salesRecord(f.db,model);f.db.close();await mkdir(staging);
      const source=await criarOrigemV9({dbPath:f.dbPath,perfil:{dono:'Perfil sintético'}});await gravarPacote({origem:source.origem,destino:pacote,senha});
      ({plano}=await validarAcervoV9({pacote,senha,raizStaging:staging}));
      const restored=await abrirOraculoStagingV9({raizStaging:staging,raizFixture:f.dir});
      try{const result=JSON.parse(restored.prepare('SELECT resultado FROM lume_vendas_avaliacoes').get().resultado);assert.equal(result.modelo,model);assert.equal(result.desatualizada,true);assert.equal(result.importacao.consentimento_transferido,false);assert.equal(result.consentimento.modelo,model);}finally{restored.close();}
    }finally{if(plano)await descartarPlanoV9(plano);await f.close();}
  }
});

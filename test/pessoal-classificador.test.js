import test from 'node:test';import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';import {LumePessoal} from '../src/pessoal/servico.js';
import {ClassificadorPessoal} from '../src/pessoal/classificador.js';import {VendasJev} from '../src/vendas/servico.js';
import {avaliarComJev,CRITERIOS_TEMPERATURA,CRITERIOS_ETAPA,CRITERIOS_ASSUNTO,CRITERIOS_ANDAMENTO,CRITERIOS_CONTINUIDADE} from '../src/vendas/jev.js';
const DM='550000000001@s.whatsapp.net';
async function fixture(t,{evaluate,configured=true}={}){
 const db=abrirBanco(),contexto=new ContextoApp(db),desktop=new Desktop(db);desktop.aceitar({nome:'Teste',aceito:true,versao:VERSAO_TERMOS});
 let now=new Date(),seq=0,calls=0,reads=0;
 const pessoal=new LumePessoal(db,{desktop,agora:()=>now,chatgpt:{estado:async()=>({}),encerrar(){}},conexao:{},telegram:{estado:async()=>({})}});
 await pessoal.configurar({enabled:true});db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(DM,'Pessoa');pessoal.configurarConversa({conversaId:DM,categoria:'lead',modo:'rascunhar',remoto:true});
 const segredos={estado:async()=>({configurada:configured}),ler:async()=>{reads++;return 'synthetic';}};
 const result={modelo:'typesafe/jev-1.14',temperatura:'quente',etapa:'conversa',assunto:{valor:'comercial',confianca:.9},andamento:{valor:'bloqueado',confianca:.9},continuidade:{valor:'incerto',confianca:.9}};
 const c=new ClassificadorPessoal(db,{pessoal,segredos,agora:()=>now,avaliar:async r=>{calls++;return evaluate?evaluate({r,pessoal,db,result}):result;}});
 t.after(async()=>{await c.encerrar();await pessoal.encerrar();db.close();});
 const receive=(type='notify',text='Pode mandar a proposta deste projeto?')=>{now=new Date(now.getTime()+1000);contexto.receber({type,messages:[{key:{id:String(++seq),remoteJid:DM,fromMe:false},messageTimestamp:Math.floor(now/1000),message:{conversation:text}}]});const e=db.prepare('SELECT * FROM eventos ORDER BY id DESC LIMIT 1').get();now=new Date(Date.now()+30000);return e;};
 return {c,pessoal,db,receive,config:()=>c.configurar({enabled:true,confirmar:true,limiteMensalMicrousd:10000}),calls:()=>calls,reads:()=>reads,segredos};
}
test('classificador não chama cofre/modelo por padrão, sem credencial ou sem teto suficiente',async t=>{
 const f=await fixture(t);f.receive();await f.c.tick();assert.equal(f.calls(),0);assert.equal(f.reads(),0);
 for(const data of [{enabled:true,confirmar:true,limiteMensalMicrousd:0},{enabled:true,confirmar:false,limiteMensalMicrousd:10000}])assert.throws(()=>f.c.configurar(data));
 await f.c.configurar({enabled:true,confirmar:true,limiteMensalMicrousd:1});f.receive();await f.c.tick();await f.c.tick();assert.equal(f.calls(),0);
 const no=await fixture(t,{configured:false});await no.config();no.receive();await no.c.tick();assert.equal(no.calls(),0);assert.equal(no.reads(),0);
});
test('classifica na etapa existente, persiste avaliação corrigível e não envia nem confirma negócio',async t=>{
 const f=await fixture(t);await f.config();const e=f.receive();await Promise.all([f.c.tick(),f.c.tick()]);assert.equal(f.calls(),1);
 assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE etapa='classificacao_pessoal' AND evento_id=?").get(e.id).estado,'concluida');
 const stored=new VendasJev(f.db).obter({conversa_id:DM});assert.equal(stored.assunto.valor,'comercial');assert.equal(stored.somenteSugestao,true);assert.equal(stored.continuidade.valor,'incerto');assert.equal(stored.desatualizada,false);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saidas').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM pessoal_propostas').get().n,0);
 assert.ok((await f.c.estado()).reservadoMicrousd>0);await f.c.tick();assert.equal(f.calls(),1);
 f.receive();assert.equal(new VendasJev(f.db).obter({conversa_id:DM}).desatualizada,true);
});
test('nova ativação não classifica backlog ou histórico, exclusão bloqueia antes do modelo',async t=>{
 const f=await fixture(t);const old=f.receive();await f.config();await f.c.tick();assert.equal(f.calls(),0);
 assert.equal(f.db.prepare("SELECT estado FROM etapas WHERE etapa='classificacao_pessoal' AND evento_id=?").get(old.id),undefined,'No opt-in means no queued classification');
 const h=f.receive('history');assert.equal(f.db.prepare("SELECT 1 FROM etapas WHERE etapa='classificacao_pessoal' AND evento_id=?").get(h.id),undefined);
 f.receive();f.pessoal.configurarAtendimento({conversaId:DM,acao:'excluir'});await f.c.tick();assert.equal(f.calls(),0);
});
test('revogação durante classificação descarta resultado sem alterar resposta do Lume',async t=>{
 const f=await fixture(t,{evaluate:({pessoal,result})=>{pessoal.configurarAtendimento({conversaId:DM,acao:'excluir'});return result;}});await f.config();f.receive();await f.c.tick();
 assert.equal(f.calls(),1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_vendas_avaliacoes').get().n,0);assert.ok((await f.c.estado()).reservadoMicrousd>0);
});
test('erro e reinício após despacho mantêm reserva e não repetem requisição',async t=>{
 const f=await fixture(t,{evaluate:()=>{throw Error('synthetic secret');}});await f.config();const e=f.receive();await f.c.tick();await f.c.tick();assert.equal(f.calls(),1);
 let stage=f.db.prepare("SELECT * FROM etapas WHERE etapa='classificacao_pessoal' AND evento_id=?").get(e.id);assert.equal(stage.estado,'falha');assert.doesNotMatch(JSON.stringify(stage),/synthetic secret/);
 f.db.prepare("UPDATE etapas SET estado='em_curso' WHERE etapa='classificacao_pessoal'").run();
 const next=new ClassificadorPessoal(f.db,{pessoal:f.pessoal,segredos:f.segredos,avaliar:()=>assert.fail('No retry')});await next.tick();await next.encerrar();
 stage=f.db.prepare("SELECT * FROM etapas WHERE etapa='classificacao_pessoal' AND evento_id=?").get(e.id);assert.equal(stage.estado,'falha');assert.ok((await f.c.estado()).reservadoMicrousd>0);
});
test('adaptador1.14 valida cinco decisões, inclui abstenção e rejeita modelo antigo',async()=>{
 const answer=(criteria,key)=>({type:'choice',choice:key,confidence:.9,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===key?1:0]))});
 const body={model:'typesafe/jev-1.14',answers:{temperatura:answer(CRITERIOS_TEMPERATURA,'insuficiente'),etapa:answer(CRITERIOS_ETAPA,'insuficiente'),assunto:answer(CRITERIOS_ASSUNTO,'pessoal'),andamento:answer(CRITERIOS_ANDAMENTO,'insuficiente'),continuidade:answer(CRITERIOS_CONTINUIDADE,'novo_assunto')}};
 const args={fontes:[{texto:'Novo assunto pessoal',recebido_em:new Date().toISOString(),autor_e_dono:0}],chave:'sk-or-v1-'+'a'.repeat(64),confirmar:true,classificar:true};let sent;
 const result=await avaliarComJev({...args,fetch:async(_u,r)=>{sent=JSON.parse(r.body);return Response.json(body);}});assert.equal(Object.keys(sent.questions).length,5);assert.equal(result.assunto.valor,'pessoal');
 await assert.rejects(avaliarComJev({...args,fetch:async()=>Response.json({...body,model:'typesafe/jev-1.13'})}),{code:'JEV_MODELO_DIVERGENTE'});
});

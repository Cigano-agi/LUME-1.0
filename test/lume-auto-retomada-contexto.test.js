// Synthetic independent scheduler review; no live profile or remote calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO,ETAPA_ORGANIZACAO} from '../src/pessoal/organizador.js';
const GROUP='550000007301@g.us',MODEL='synthetic-recapture-review';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
function fixture(t){
 const db=abrirBanco(),context=new ContextoApp(db);let seq=0,calls=0,handler=()=>blank();
 new Desktop(db).aceitar({nome:'Synthetic recapture',aceito:true,versao:VERSAO_TERMOS});
 const org=new OrganizadorConversas(db,{agora:()=>new Date('2026-10-28T12:00:00Z'),chatgpt:{estado:async()=>({connected:true,planEnabled:true,paused:false,model:MODEL,account:{id:'synthetic'}}),responder:async req=>({completed:true,model:MODEL,requestId:'synthetic-'+(++calls),text:JSON.stringify(handler(JSON.parse(req.input[0].content)))})}});
 org.configurarEscopo({escopo:'todas',confirmar:true});org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC ONLY',revisor:'independent scheduler fixture'});org.configurar({acao:'retomar'});
 t.after(async()=>{await org.encerrar();db.close();});
 const add=(text,group=GROUP)=>context._registrarEvento({conversaId:group,origemId:'synthetic-'+(++seq),autorId:'550000007399@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date(Date.UTC(2026,9,28,11,0,seq))},'dirigida').id;
 const project=(name,source,text)=>org.projetos.criarRascunho({nome:name,natureza:'incerto',fontes:[{eventoId:source,trecho:text}]});
 const state=id=>db.prepare('SELECT estado,resultado FROM etapas WHERE evento_id=? AND etapa=?').get(id,ETAPA_ORGANIZACAO);
 const sweep=(n=4)=>{for(let i=0;i<n;i++)org.capturar({limite:100});};
 const step=async id=>{org.capturar();db.prepare("UPDATE etapas SET proxima_tentativa_em='2099-01-01T00:00:00Z' WHERE etapa=? AND evento_id<>? AND estado IN('pendente','falha')").run(ETAPA_ORGANIZACAO,id);return org.passo();};
 return {db,org,add,project,state,sweep,step,calls:()=>calls,handler:fn=>handler=fn};
}
function nominal(f,{text='Vou enviar as páginas.',prior=true}={}){
 const earlierText='Preparar páginas do projeto Boreal.',earlier=prior?f.add(earlierText):null;
 const sourceText='O da Aurora é a Nara.',source=f.add(sourceText),p=f.project('Aurora',source,sourceText),target=f.add(text);
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',projetoId:p.id,trecho:'Vou enviar as páginas.',confianca:.98,evidencias:[{eventoId:source,trecho:sourceText}]}]}));
 return {earlier,earlierText,p,target,text};
}
test('recapture: nominal abstention is revisited once when an older eligible candidate is discovered later',async t=>{
 const f=fixture(t),n=nominal(f);assert.equal(await f.step(n.target),true);assert.ok(JSON.parse(f.state(n.target).resultado).abstencoesAtribuicao.length);
 const p=f.project('Boreal',n.earlier,n.earlierText);f.sweep();assert.equal(f.state(n.target).estado,'pendente');
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:'Boreal',projetoId:p.id,trecho:n.text,confianca:.98,evidencias:[{eventoId:n.earlier,trecho:n.earlierText}]}]}));
 assert.equal(await f.step(n.target),true);f.sweep(10);assert.equal(f.state(n.target).estado,'concluida');assert.equal(f.calls(),4);
});
test('recapture: bounded candidate result is revisited when an older relevant project becomes selectable',async t=>{
 const f=fixture(t),earlierText='Preparar páginas do projeto Boreal.',earlier=f.add(earlierText);
 for(let i=0;i<9;i++){const text='Preparar material Ficticio'+i+'.',id=f.add(text);f.project('Ficticio'+i,id,text);}
 const target=f.add('Vou enviar as páginas do projeto Boreal.');assert.equal(await f.step(target),true);assert.ok(JSON.parse(f.state(target).resultado).limitesContexto.length);
 f.project('Boreal',earlier,earlierText);f.sweep();assert.equal(f.state(target).estado,'pendente');
});
test('recapture: unchanged incomplete context remains complete through ten sweeps',async t=>{
 const f=fixture(t),n=nominal(f);assert.equal(await f.step(n.target),true);const before=f.state(n.target).resultado;
 f.sweep(10);assert.equal(f.state(n.target).estado,'concluida');assert.equal(f.state(n.target).resultado,before);assert.equal(f.calls(),2);
});
test('recapture: observed post-apply fingerprint does not requeue its own new project effects',async t=>{
 const f=fixture(t),n=nominal(f,{text:'Projeto Boreal vai começar. Vou enviar as páginas.',prior:false});
 const source=f.org.projetos.obter(n.p.id).fontes[0];
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:'Boreal',trecho:'Projeto Boreal vai começar.',confianca:.98},{tipo:'projeto',nome:'Aurora',projetoId:n.p.id,trecho:'Vou enviar as páginas.',confianca:.98,evidencias:[{eventoId:source.eventoId,trecho:source.trecho}]}]}));
 assert.equal(await f.step(n.target),true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,2);
 const result=JSON.parse(f.state(n.target).resultado);assert.ok(result.abstencoesAtribuicao.length);assert.match(result.contextoObservadoDigest,/^[a-f0-9]{64}$/);
 f.sweep(10);assert.equal(f.state(n.target).estado,'concluida');assert.equal(f.calls(),2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,2);
});
test('recapture: legacy incomplete result without observed fingerprint gets one migration evaluation',async t=>{
 const f=fixture(t),n=nominal(f);assert.equal(await f.step(n.target),true);
 const old=JSON.parse(f.state(n.target).resultado);delete old.contextoObservadoDigest;f.db.prepare('UPDATE etapas SET resultado=? WHERE evento_id=? AND etapa=?').run(JSON.stringify(old),n.target,ETAPA_ORGANIZACAO);
 f.sweep();assert.equal(f.state(n.target).estado,'pendente');assert.equal(await f.step(n.target),true);f.sweep(10);assert.equal(f.state(n.target).estado,'concluida');assert.equal(f.calls(),4);
});
test('recapture: future and other-conversation projects are not new eligible context',async t=>{
 const f=fixture(t),n=nominal(f);assert.equal(await f.step(n.target),true);const before=f.state(n.target).resultado;
 const futureText='Preparar catálogo Futuro.',future=f.add(futureText);f.project('Futuro',future,futureText);
 const otherText='Preparar catálogo Outra.',other=f.add(otherText,'550000007302@g.us');f.project('Outra',other,otherText);
 f.sweep(10);assert.equal(f.state(n.target).estado,'concluida');assert.equal(f.state(n.target).resultado,before);assert.equal(f.calls(),2);
});
test('recapture: complete result without incompleteness flags is not globally invalidated by catalog growth',async t=>{
 const f=fixture(t),oldText='Preparar catálogo Aurora.',old=f.add(oldText),target=f.add('A mensagem não contém tarefa nova.');assert.equal(await f.step(target),true);
 const before=f.state(target).resultado;f.project('Aurora',old,oldText);f.sweep(10);assert.equal(f.state(target).estado,'concluida');assert.equal(f.state(target).resultado,before);assert.equal(f.calls(),2);
});
test('recapture: real sweep preserves independently proven own project identity across reprocessing',async t=>{
 const f=fixture(t),lateText='Preparar catálogo do projeto Celeste.',lateSource=f.add(lateText),n=nominal(f,{text:'Projeto Boreal vai começar. Vou enviar as páginas.',prior:false});
 const source=f.org.projetos.obter(n.p.id).fontes[0];
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:'Boreal',trecho:'Projeto Boreal vai começar.',confianca:.98},{tipo:'projeto',nome:'Aurora',projetoId:n.p.id,trecho:'Vou enviar as páginas.',confianca:.98,evidencias:[{eventoId:source.eventoId,trecho:source.trecho}]}]}));
 assert.equal(await f.step(n.target),true);const own=f.db.prepare("SELECT id FROM lume_projetos_comerciais WHERE nome='Boreal'").get();assert.ok(own);assert.ok(f.org.projetos.obter(own.id));
 f.project('Celeste',lateSource,lateText);
 f.sweep();assert.equal(f.state(n.target).estado,'pendente');assert.equal(f.state(n.target).resultado,null);
 assert.ok(f.org.projetos.obter(own.id),'complete marker proof must remain valid even while its producing stage is pending');
 assert.equal(await f.step(n.target),true);const rows=f.db.prepare("SELECT id FROM lume_projetos_comerciais WHERE nome='Boreal'").all();assert.deepEqual(rows.map(r=>r.id),[own.id]);assert.ok(f.org.projetos.obter(own.id));
 const after=f.state(n.target).resultado;assert.equal(JSON.parse(after).contextoObservadoDigest,f.org.contextoObservado(f.org.fonte(n.target,{remoto:true})));
 f.sweep(10);assert.equal(f.state(n.target).estado,'concluida');assert.equal(f.state(n.target).resultado,after);assert.equal(f.calls(),4);
});

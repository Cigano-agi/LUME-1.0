// Independent identity-evidence propagation and read boundaries. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO} from '../src/pessoal/organizador.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {assinaturaFonte} from '../src/tarefas-esquema.js';
import {evidenciaIdentidadeAfirmativa} from '../src/pessoal/organizacao-identidade.js';
const GROUP='550000009501@g.us',MODEL='synthetic-identity-review';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(t){
 const db=abrirBanco(),context=new ContextoApp(db);let seq=0,request=0,handler=()=>blank();const calls=[];
 new Desktop(db).aceitar({nome:'Synthetic identity review',aceito:true,versao:VERSAO_TERMOS});
 const org=new OrganizadorConversas(db,{agora:()=>new Date('2026-10-28T12:00:00Z'),chatgpt:{estado:async()=>({connected:true,planEnabled:true,paused:false,model:MODEL,account:{id:'synthetic'}}),responder:async r=>{const input=JSON.parse(r.input[0].content);calls.push(input);return {completed:true,model:MODEL,requestId:'synthetic-'+(++request),text:JSON.stringify(await handler(input,r))};}}});
 org.configurarEscopo({escopo:'todas',confirmar:true});org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC TEST ONLY',revisor:'independent fixture'});org.configurar({acao:'retomar'});
 t.after(async()=>{await org.encerrar();db.close();});
 const add=texto=>context._registrarEvento({conversaId:GROUP,origemId:'synthetic-'+(++seq),autorId:'550000009599@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto,recebidoEm:new Date('2026-10-28T11:00:00Z')},'dirigida').id;
 const proof=id=>{const e=org.fonte(id,{remoto:true});return {eventoId:id,assinatura:assinaturaFonte(e),autorizacao:digest(org.autorizacao(e.conversa_id)),contexto:org.contextual.montar(e).prova,contrato:CONTRATO_ORGANIZACAO};};
 const mark=(kind,id,value)=>{org.config(kind+'-inferido:'+id,value);db.prepare("INSERT INTO etapas(evento_id,etapa,estado,resultado,atualizado_em) VALUES(?,'organizacao_chatgpt','concluida',?,'2026-10-28T12:00:00Z') ON CONFLICT(evento_id,etapa) DO UPDATE SET estado='concluida',resultado=excluded.resultado").run(value.eventoId,JSON.stringify({...blank(),...value}));};
 const step=async id=>{org.capturar();db.prepare("UPDATE etapas SET proxima_tentativa_em='2099-01-01T00:00:00Z' WHERE etapa='organizacao_chatgpt' AND evento_id<>? AND estado IN('pendente','falha')").run(id);return org.passo();};
 return {db,org,calls,add,proof,mark,step,handler:fn=>handler=fn};
}
const question='O da Lia é o CRM, ou esse é o da Nara?';

for(const text of ['O projeto é Aurora ou Boreal?','O cliente é Lia ou Nara?','O da Lia e o CRM, ou e o da Nara?'])test('identity review: explicit identity alternatives cannot become assertions — '+text,async t=>{
 const f=fixture(t),id=f.add(text),name=text.includes('Boreal')?'Boreal':'Nara';
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:name,trecho:text,confianca:.99}]}));
 assert.equal(await f.step(id),true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,0);
});

for(const text of [
 'O cliente e a equipe podem revisar ou enviar o catalogo do projeto Aurora?',
 'O trabalho é revisar o catalogo do projeto Aurora ou enviar a proposta?',
 'Podemos criar o projeto Aurora ou revisar o projeto Boreal?',
 'A equipe e o cliente precisam escolher React ou Vue para o projeto Aurora?',
])test('identity review: operational alternative or conjunction is not an identity assertion — '+text,t=>{
 const f=fixture(t),id=f.add(text),e=f.org.fonte(id,{remoto:true});
 assert.equal(evidenciaIdentidadeAfirmativa(text,0,text.length).elegivel,true);
 const output=f.org.validarResultado({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:text,confianca:.98}]},e,f.org.contextual.montar(e));assert.equal(output.vinculos.length,1);
});

test('identity review: legacy automatic project based on question is hidden in local and external reads and candidates',t=>{
 const f=fixture(t),source=f.add(question),proof=f.proof(source),p=f.org.projetos.criarRascunho({nome:'Nara',natureza:'incerto',fontes:[{eventoId:source,trecho:'ou esse é o da Nara?'}]});f.mark('projeto',p.id,proof);
 const later=f.add('O CRM pertence a outro trabalho declarado depois.');
 assert.equal(f.org.projetos.obter(p.id),null);assert.equal(new ProjetosComerciais(f.db).obter(p.id),null);
 assert.equal(f.org.contextual.montar(f.org.fonte(later,{remoto:true})).candidatos.some(c=>c.id===p.id),false);
 assert.equal(f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(source).texto,question);
});

test('identity review: a questioned automatic extra link does not invalidate the legitimate project base',t=>{
 const f=fixture(t),base='Projeto Aurora: preparar catalogo de pecas.',source=f.add(base),p=f.org.projetos.criarRascunho({nome:'Aurora',natureza:'incerto',fontes:[{eventoId:source,trecho:base}]}),q=f.add('O projeto Aurora é o CRM, ou esse é o da Nara?'),proof=f.proof(q);
 const link=f.org.projetos.vincularFonte({id:p.id,eventoId:q,trecho:'O projeto Aurora é o CRM'});f.mark('vinculo',link.fonteId,proof);
 const current=f.org.projetos.obter(p.id);assert.ok(current);assert.deepEqual(current.fontes.map(x=>x.eventoId),[source]);
 const timeline=f.org.timeline({conversa:GROUP});assert.deepEqual(timeline.itens.find(x=>x.fonte.eventoId===q).projetos,[]);
 const later=f.add('Vamos preparar o catalogo combinado.');const candidate=f.org.contextual.montar(f.org.fonte(later,{remoto:true})).candidatos.find(c=>c.id===p.id);
 assert.ok(candidate);assert.equal(candidate.fontes.some(x=>x.eventoId===q),false);
});

test('identity review: explicit manual correction preserves a questioned link but still obeys source revocation',t=>{
 const f=fixture(t),base='Projeto Aurora: preparar catalogo de pecas.',source=f.add(base),p=f.org.projetos.criarRascunho({nome:'Aurora',natureza:'incerto',fontes:[{eventoId:source,trecho:base}]}),q=f.add(question);
 f.org.corrigirVinculo({eventoId:q,trecho:question,projetoId:p.id});
 assert.ok(f.org.projetos.obter(p.id).fontes.some(x=>x.eventoId===q));assert.ok(f.org.timeline({conversa:GROUP}).itens.find(x=>x.fonte.eventoId===q).projetos.some(x=>x.id===p.id));
 f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(q);assert.equal(f.org.projetos.obter(p.id).fontes.some(x=>x.eventoId===q),false);
});

test('identity review: legacy affirmative action sourced from identity question is hidden without deleting original source',t=>{
 const f=fixture(t),source=f.add(question),proof=f.proof(source);
 f.org.contexto.acoes.registrar({eventoId:source,candidatas:[{fonte:'E'+source,tipo:'pendencia',resumo:'Preparar CRM do projeto Nara',trecho:question,prazo_citado:''}]});
 const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(source);assert.ok(action);f.mark('acao',action.id,proof);
 assert.equal(f.org.contexto.acoes.obter(action.id),null);assert.deepEqual(f.org.timeline({conversa:GROUP}).itens.find(x=>x.fonte.eventoId===source).compromissos,[]);
 assert.equal(f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(source).texto,question);
});

test('identity review: question to later identity correction cannot create and propagate a guessed project',async t=>{
 const f=fixture(t),q=f.add(question);
 f.handler(i=>({...blank(),vinculos:[{tipo:'projeto',nome:'Lia',trecho:'O da Lia é o CRM',confianca:.99},{tipo:'projeto',nome:'Nara',trecho:'ou esse é o da Nara?',confianca:.99}]}));
 assert.equal(await f.step(q),true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,0);
 const correction='O CRM é da Dora.',next=f.add(correction);
 f.handler(i=>{assert.equal(i.projetos.some(p=>p.nome==='Nara'||p.nome==='Lia'),false);return {...blank(),vinculos:[{tipo:'projeto',nome:'Nara',trecho:correction,confianca:.99,origemNome:{eventoId:q,trecho:'ou esse é o da Nara?'}}]};});
 assert.equal(await f.step(next),true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,0);
 const last=f.add('Dora, o nome correto da pessoa.');f.handler(i=>{assert.equal(i.projetos.length,0);return blank();});assert.equal(await f.step(last),true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,0);
});

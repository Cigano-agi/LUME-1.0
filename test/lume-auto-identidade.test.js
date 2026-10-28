// Identity evidence eligibility tests. Synthetic SQLite, account and model only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ContextoApp} from '../src/contexto-app.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO,ETAPA_ORGANIZACAO} from '../src/pessoal/organizador.js';
const GROUP='550000007701@g.us',MODEL='synthetic-two-pass',ACCOUNT='synthetic-account';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function fixture(t){
 const db=abrirBanco(),context=new ContextoApp(db);new Desktop(db).aceitar({nome:'Conciliação sintética',aceito:true,versao:VERSAO_TERMOS});
 const calls=[],state={connected:true,planEnabled:true,paused:false,model:MODEL,account:{id:ACCOUNT}};let sequence=0,handler=async()=>blank();
 const org=new OrganizadorConversas(db,{chatgpt:{estado:async()=>structuredClone(state),responder:async request=>{const input=JSON.parse(request.input[0].content),index=calls.length;calls.push({request,input});assert.equal(request.validar(),true);const answer=await handler({request,input,index});return answer?.__receipt?answer.value:{completed:true,model:MODEL,requestId:'synthetic-pass-'+(index+1),text:typeof answer==='string'?answer:JSON.stringify(answer)};}}});
 db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(GROUP,'Grupo fictício de revisão');org.configurarEscopo({escopo:'todas',confirmar:true});
 const f={db,org,calls,state,handle(fn){handler=fn;},add(text){return context._registrarEvento({conversaId:GROUP,origemId:'synthetic-conciliation-'+(++sequence),autorId:'550000007799@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date(Date.UTC(2026,9,28,12,0,sequence))},'terceiro').id;},
  project(name,text){const event=this.add(text);const p=org.projetos.criarRascunho({nome:name,natureza:'incerto',chave:'synthetic-project-'+name,fontes:[{eventoId:event,trecho:text}]}).id;return{id:p,event,text,name};},
  start(){org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC TEST ONLY',revisor:'synthetic independent test'});org.configurar({acao:'retomar'});},
  async step(target){this.start();org.capturar();db.prepare("UPDATE etapas SET proxima_tentativa_em='2099-01-01T00:00:00Z' WHERE etapa=? AND evento_id<>?").run(ETAPA_ORGANIZACAO,target);return org.passo();},
  noTargetEffects(target){assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_acoes WHERE evento_id=?').get(target).n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_projetos_fontes WHERE evento_id=?').get(target).n,0);assert.equal(org.sugestoes(target),null);}
 };
 t.after(async()=>{await org.encerrar();for(const table of ['saidas','pessoal_propostas','telegram_saidas'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);db.close();});return f;
}
const guard=async()=> (await import('../src/pessoal/organizacao-identidade.js')).evidenciaIdentidadeAfirmativa;
const ambiguous='Projeto Aurora é o mesmo projeto da Alfa, ou é o Projeto Boreal da Beta?';
const blocked=[
 ['comparação completa',ambiguous,ambiguous],
 ['primeira alternativa sem pontuação',ambiguous,'Projeto Aurora é o mesmo projeto da Alfa'],
 ['segunda alternativa sem pontuação',ambiguous,'Projeto Boreal da Beta'],
 ['recorte mínimo do nome',ambiguous,'Aurora'],
 ['quebra de linha','Projeto Aurora é o mesmo projeto da Alfa,\nou é o Projeto Boreal da Beta?','Projeto Boreal da Beta'],
 ['confirmação é','O projeto Aurora é da Alfa?','projeto Aurora'],
 ['confirmação não é','O projeto Aurora não é da Alfa?','projeto Aurora'],
 ['confirmação né','O projeto Aurora é da Alfa, né','projeto Aurora'],
 ['confirmação com né e pontuação','O projeto Aurora é da Alfa, né?','projeto Aurora'],
 ['identidade alternativa','Este é o projeto Aurora ou o projeto Boreal?','projeto Boreal'],
];
for(const [name,text,excerpt] of blocked)test('identidade detector: bloqueia '+name,async()=>{
 const check=await guard();assert.deepEqual(check(text,text.indexOf(excerpt),excerpt.length),{elegivel:false,motivo:'identidade_interrogativa'});
});
for(const text of [
 'Pode criar o projeto Aurora?',
 'Quer React ou Vue para projeto Aurora?',
 'Aurora é da Alfa, não da Beta.',
 'O projeto Aurora não é da Beta.',
 'Projeto Aurora: criar um catálogo.',
 'Vamos iniciar o projeto da Alfa.',
 'A entrega do projeto Aurora será amanhã?',
 'Pode revisar o catálogo do projeto Aurora ou enviar a proposta?',
])test('identidade detector: preserva declaração/pedido '+text,async()=>{
 assert.deepEqual((await guard())(text,0,text.length),{elegivel:true,motivo:null});
});
test('identidade detector: frase declarativa independente não herda interrogação anterior',async()=>{
 const declaration='Projeto Boreal: criar um catálogo.',text=ambiguous+' '+declaration;
 assert.deepEqual((await guard())(text,text.indexOf(declaration),declaration.length),{elegivel:true,motivo:null});
});
for(const [start,size] of [[-1,8],[0,0],[1.5,8],[0,Infinity],[0,999],[NaN,8]])test(`identidade detector: intervalo inválido ${start}/${size}`,async()=>{
 assert.deepEqual((await guard())('Projeto Aurora: catálogo.',start,size),{elegivel:false,motivo:'intervalo_invalido'});
});
const newLink=(text,name='Aurora')=>({tipo:'projeto',nome:name,trecho:text,confianca:.98});
const validate=(f,id,raw)=>{const e=f.org.fonte(id,{remoto:true});return f.org.validarResultado({...blank(),...raw},e,f.org.contextual.montar(e));};
for(const [name,text,excerpt] of blocked.slice(0,5).filter(([, ,excerpt])=>excerpt.length>=8))test('identidade integração: alvo '+name+' não gera vínculo',t=>{
 const f=fixture(t),id=f.add(text),r=validate(f,id,{vinculos:[newLink(excerpt,excerpt.includes('Boreal')?'Boreal':'Aurora')]});assert.equal(r.vinculos.length,0);
});
test('identidade integração: origemNome posterior não converte pergunta anterior em identidade',t=>{
 const f=fixture(t),prior=f.add(ambiguous),text='Vamos começar a produzir esse catálogo amanhã.',target=f.add(text);
 const r=validate(f,target,{vinculos:[{...newLink(text,'Boreal'),origemNome:{eventoId:prior,trecho:'Projeto Boreal da Beta'}}]});assert.equal(r.vinculos.length,0);
});
test('identidade integração: uma evidência interrogativa invalida mistura com evidência afirmativa',t=>{
 const f=fixture(t),valid=f.project('Aurora','Projeto Aurora: catálogo da Alfa.'),question=f.add('O projeto Aurora é o mesmo da Beta?');
 f.org.projetos.vincularFonte({id:valid.id,eventoId:question,trecho:'O projeto Aurora é o mesmo da Beta?'});
 const text='Vamos revisar o catálogo para a próxima entrega.',target=f.add(text),r=validate(f,target,{vinculos:[{...newLink(text),projetoId:valid.id,evidencias:[{eventoId:valid.event,trecho:valid.text},{eventoId:question,trecho:'O projeto Aurora'}]}]});
 assert.equal(r.vinculos.length,0);
});
test('identidade integração: duas passagens concordantes não persistem as alternativas como projetos',async t=>{
 const f=fixture(t),id=f.add(ambiguous);f.handle(()=>({...blank(),vinculos:[newLink('Projeto Aurora é o mesmo projeto da Alfa'),newLink('Projeto Boreal da Beta','Boreal')]}));
 assert.equal(await f.step(id),true);assert.equal(f.calls.length,2);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,0);assert.equal(f.org.sugestoes(id)?.vinculos.length,0);
});
test('identidade integração: vínculo bloqueado não deixa resumo de identidade como fato sugerido',async t=>{
 const f=fixture(t),id=f.add(ambiguous);f.handle(()=>({...blank(),vinculos:[newLink('Projeto Aurora é o mesmo projeto da Alfa')],acontecimentos:[{tipo:'mudanca',resumo:'O projeto Aurora passou a ser da Alfa.',trecho:'Projeto Aurora é o mesmo projeto da Alfa',confianca:.98}],compromissos:[{tipo:'pendencia',resumo:'Tratar o projeto Aurora como projeto da Alfa.',trecho:'Projeto Aurora é o mesmo projeto da Alfa',confianca:.98}]}));
 assert.equal(await f.step(id),true);const r=f.org.sugestoes(id);assert.equal(r.vinculos.length,0);assert.equal(r.acontecimentos.length,0);assert.equal(r.compromissos.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes WHERE evento_id=?').get(id).n,0);
});
test('identidade integração: declaração independente sobrevive às duas passagens na mesma mensagem',async t=>{
 const f=fixture(t),declaration='Projeto Boreal: criar um catálogo.',text=ambiguous+' '+declaration,id=f.add(text);f.handle(()=>({...blank(),vinculos:[newLink('Projeto Aurora é o mesmo projeto da Alfa'),newLink(declaration,'Boreal')]}));
 assert.equal(await f.step(id),true);const links=f.org.sugestoes(id).vinculos;assert.equal(links.length,1);assert.equal(links[0].nome,'Boreal');
});
for(const text of ['Pode criar o projeto Aurora?','Aurora é da Alfa, não da Beta.'])test('identidade integração: positivo materializa '+text,async t=>{
 const f=fixture(t),id=f.add(text);f.handle(()=>({...blank(),vinculos:[newLink(text)]}));assert.equal(await f.step(id),true);assert.equal(f.calls.length,2);assert.equal(f.org.sugestoes(id).vinculos.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,1);
});
test('identidade integração: projeto provisório conserva início explícito e referência anterior afirmativa',async t=>{
 const f=fixture(t),identity='Este trabalho é para a cliente Alfa.',prior=f.add(identity),text='Vamos começar o projeto combinado amanhã.',id=f.add(text);f.handle(()=>({...blank(),vinculos:[{...newLink(text,'Alfa'),origemNome:{eventoId:prior,trecho:identity}}]}));
 assert.equal(await f.step(id),true);const link=f.org.sugestoes(id).vinculos[0];assert.ok(link);assert.equal(link.nome,'Alfa');assert.equal(link.origemNome.eventoId,prior);
});
test('identidade projeção: assunto interrogativo fica neutro na timeline e conserva a fonte',async t=>{
 const f=fixture(t),id=f.add(ambiguous),falseIdentity='Aurora é o mesmo projeto da Alfa';
 f.handle(()=>({...blank(),assuntos:[{nome:falseIdentity,trecho:'Projeto Aurora é o mesmo projeto da Alfa',confianca:.98}]}));
 assert.equal(await f.step(id),true);
 const projected=f.org.timeline({conversa:GROUP}).itens.find(x=>x.fonte.eventoId===id);
 assert.ok(projected);assert.equal(projected.texto,ambiguous,'original question is not removed or rewritten');
 assert.deepEqual(projected.assuntos,['Dúvida sobre o projeto']);assert.deepEqual(projected.projetos,[]);assert.deepEqual(projected.acontecimentos,[]);assert.deepEqual(projected.compromissos,[]);
 assert.equal(projected.assuntos.includes(falseIdentity),false);
});

// Independent two-pass behavior tests. Synthetic SQLite, account and model only.
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
function candidates(f){return[f.project('Aurora','Projeto Aurora: preparar o catálogo da equipe.'),f.project('Boreal','Projeto Boreal: organizar a apresentação da equipe.')];}
const link=(candidate,text,evidencias=[{eventoId:candidate.event,trecho:candidate.text}])=>({tipo:'projeto',nome:candidate.name,projetoId:candidate.id,trecho:text,evidencias,confianca:.98});
const question=(projects,text)=>({pergunta:'Este assunto é de qual projeto?',trecho:text,projetoIds:projects.map(p=>p.id),confianca:.98});

for(const questionPass of [0,1])test('conciliação: pergunta na passagem '+(questionPass+1)+' impede vínculo sobreposto',async t=>{
 const f=fixture(t),projects=candidates(f),text='Vamos revisar o material da equipe amanhã.',id=f.add(text);
 f.handle(({index})=>({...blank(),vinculos:index===questionPass?[]:[link(projects[0],text)],perguntas:index===questionPass?[question(projects,text)]:[]}));
 const r=await f.org.avaliarFonte(id);assert.equal(f.calls.length,2);assert.equal(r.vinculos.length,0);assert.equal(r.perguntas.length,1);assert.deepEqual(new Set(r.perguntas[0].opcoes.map(p=>p.projetoId)),new Set(projects.map(p=>p.id)));
});
test('conciliação: pergunta em subintervalo bloqueia vínculo que contém esse intervalo',async t=>{
 const f=fixture(t),projects=candidates(f),text='Vamos revisar o material da equipe amanhã e fechar o arquivo.',id=f.add(text);
 f.handle(({index})=>({...blank(),vinculos:[link(projects[0],text)],perguntas:index?[question(projects,'revisar o material da equipe amanhã')]:[]}));
 const r=await f.org.avaliarFonte(id);assert.equal(r.vinculos.length,0);assert.equal(r.perguntas.length,1);
});
test('conciliação: A na proposta e B na revisão vira pergunta entre candidatos reais',async t=>{
 const f=fixture(t),projects=candidates(f),text='Vamos revisar aquele material da equipe amanhã.',id=f.add(text);
 f.handle(({index})=>({...blank(),vinculos:[link(projects[index],text)]}));
 const r=await f.org.avaliarFonte(id);assert.equal(f.calls.length,2);assert.equal(r.vinculos.length,0);assert.equal(r.perguntas.length,1);assert.deepEqual(new Set(r.perguntas[0].opcoes.map(p=>p.projetoId)),new Set(projects.map(p=>p.id)));
});
test('conciliação: revisão recebe original e proposta bruta e acrescenta omissão fundamentada',async t=>{
 const f=fixture(t),text='Projeto Aurora: revisar o catálogo amanhã.',id=f.add(text),proposal=blank();
 f.handle(({input,index})=>{if(!index)return proposal;const {proposta,...original}=input;assert.deepEqual(original,f.calls[0].input);assert.deepEqual(proposta,proposal);return{...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:text,confianca:.98}],compromissos:[{tipo:'pendencia',resumo:'Revisar o catálogo',trecho:text,prazo_citado:'amanhã',confianca:.98}]};});
 const r=await f.org.avaliarFonte(id);assert.equal(f.calls.length,2);assert.equal(r.vinculos.length,1);assert.equal(r.compromissos.length,1);f.noTargetEffects(id);
});
test('conciliação: proposta bruta não perde item sintático antes da revisão semântica',async t=>{
 const f=fixture(t),text='Projeto Aurora: revisar o catálogo amanhã.',id=f.add(text),proposal={...blank(),assuntos:[{nome:'Aurora',trecho:text,confianca:.5}]};
 f.handle(({input,index})=>{if(!index)return proposal;assert.deepEqual(input.proposta,proposal);return blank();});
 await f.org.avaliarFonte(id);assert.equal(f.calls.length,2);
});
for(const mode of ['invalid-json','throw','quota','incomplete','wrong-model','missing-receipt','duplicate-receipt','account-change','plan-revoked'])test('conciliação: segunda '+mode+' não aplica primeira',async t=>{
 const f=fixture(t),text='Projeto Aurora: revisar o catálogo amanhã.',id=f.add(text);
 f.handle(({index})=>{if(!index)return{...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:text,confianca:.98}],compromissos:[{tipo:'pendencia',resumo:'Revisar catálogo',trecho:text,confianca:.98}]};
  if(mode==='invalid-json')return '{invalid';if(mode==='throw')throw Error('synthetic second failure');if(mode==='quota')throw Object.assign(Error('synthetic quota'),{code:'subscription_sharing_usage_limit_exceeded'});
  if(mode==='account-change')f.state.account.id='other-synthetic';if(mode==='plan-revoked')f.state.planEnabled=false;
  return{__receipt:true,value:{completed:mode!=='incomplete',model:mode==='wrong-model'?'different-model':MODEL,requestId:mode==='missing-receipt'?'':mode==='duplicate-receipt'?'synthetic-pass-1':'synthetic-pass-2',text:JSON.stringify(blank())}};
 });
 assert.equal(await f.step(id),false);assert.equal(f.calls.length,2);f.noTargetEffects(id);assert.notEqual(f.db.prepare('SELECT estado FROM etapas WHERE evento_id=? AND etapa=?').get(id,ETAPA_ORGANIZACAO).estado,'concluida');
});
for(const pass of [0,1])for(const mutation of ['scope','source','context'])test(`conciliação: ${mutation} revogada/alterada na passagem ${pass+1} invalida tudo`,async t=>{
 const f=fixture(t),prior=f.add('Projeto Aurora: contexto anterior autorizado.'),text='Projeto Aurora: revisar o catálogo amanhã.',id=f.add(text);
 f.handle(({request,index})=>{if(index===pass){if(mutation==='scope')f.org.configurarEscopo({escopo:'autorizadas',confirmar:true});else f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Conteúdo sintético corrigido pelo dono.',mutation==='source'?id:prior);assert.equal(request.validar(),false);}return{...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:text,confianca:.98}]};});
 await assert.rejects(f.org.avaliarFonte(id));assert.equal(f.calls.length,pass+1);f.noTargetEffects(id);
});
test('conciliação: passo só grava após completar a revisão e conserva os dois recibos',async t=>{
 const f=fixture(t),text='Projeto Aurora: revisar o catálogo amanhã.',id=f.add(text),entered=deferred(),release=deferred();
 f.handle(async({index})=>{if(index===1){entered.resolve('review');await release.promise;}return{...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:text,confianca:.98}]};});
 const pending=f.step(id);const stage=await Promise.race([entered.promise,pending.then(()=> 'finished')]);
 try{assert.equal(stage,'review','must request review before committing');f.noTargetEffects(id);assert.equal(f.db.prepare('SELECT estado FROM etapas WHERE evento_id=? AND etapa=?').get(id,ETAPA_ORGANIZACAO).estado,'em_curso');}finally{release.resolve();}
 assert.equal(await pending,true);const result=f.org.sugestoes(id);assert.equal(result.recibos.length,2);assert.deepEqual(result.recibos.map(r=>r.requestId),['synthetic-pass-1','synthetic-pass-2']);assert(result.recibos.every(r=>r.modelo===MODEL&&r.contaId===ACCOUNT));
});
for(const mode of ['outside-candidate','target','future'])test('conciliação: todas evidências devem ser anteriores e do intervalo candidato — '+mode,async t=>{
 const f=fixture(t),projects=candidates(f),extra=f.add('Outra mensagem antiga sem vínculo com o candidato.'),text='Vamos revisar o catálogo citado pela equipe.',id=f.add(text),future=f.add('Uma mensagem futura não sustenta o passado.');
 const wrong=mode==='outside-candidate'?{eventoId:extra,trecho:'Outra mensagem antiga sem vínculo com o candidato.'}:mode==='target'?{eventoId:id,trecho:text}:{eventoId:future,trecho:'Uma mensagem futura não sustenta o passado.'};
 f.handle(()=>({...blank(),vinculos:[link(projects[0],text,[{eventoId:projects[0].event,trecho:projects[0].text},wrong])]}));
 const r=await f.org.avaliarFonte(id);assert.equal(r.vinculos.length,0,'one good evidence cannot launder another invalid evidence');f.noTargetEffects(id);
});
test('conciliação: prazo de120s é compartilhado, sem novo orçamento na revisão',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,28,12)});const f=fixture(t),id=f.add('Projeto Aurora: revisar o catálogo amanhã.');
 f.handle(({index,request})=>{assert(request.signal,'both passes must receive the shared deadline signal');assert(Number.isFinite(request.timeoutMs)&&request.timeoutMs>0&&request.timeoutMs<=120000);if(!index)t.mock.timers.tick(70000);else{assert.strictEqual(request.signal,f.calls[0].request.signal,'review must retain the same overall abort signal');assert(request.timeoutMs<=50000,'review receives only the remaining overall budget');}return blank();});
 await f.org.avaliarFonte(id);assert.equal(f.calls.length,2);
});
test('conciliação: orçamento esgotado na primeira não inicia revisão nem aplica resultado',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,28,12)});const f=fixture(t),id=f.add('Projeto Aurora: revisar o catálogo amanhã.');
 f.handle(()=>{t.mock.timers.tick(120001);return blank();});await assert.rejects(f.org.avaliarFonte(id));assert.equal(f.calls.length,1);f.noTargetEffects(id);
});
test('conciliação: tempo consumido nas duas respostas soma ao mesmo deadline',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,9,28,12)});const f=fixture(t),id=f.add('Projeto Aurora: revisar o catálogo amanhã.');
 f.handle(({index})=>{t.mock.timers.tick(index?50001:70000);return blank();});await assert.rejects(f.org.avaliarFonte(id));assert.equal(f.calls.length,2);f.noTargetEffects(id);
});
test('conciliação: abort externo durante a revisão rejeita resposta tardia',async t=>{
 const f=fixture(t),id=f.add('Projeto Aurora: revisar o catálogo amanhã.'),controller=new AbortController(),entered=deferred(),release=deferred();
 f.handle(async({index,request})=>{if(index===1){entered.resolve(request);await release.promise;}return blank();});
 const pending=f.org.avaliarFonte(id,{signal:controller.signal}),observed=Promise.race([entered.promise,pending.then(()=>null)]);const request=await observed;
 try{assert(request,'review must be pending');controller.abort();assert.equal(request.signal.aborted,true);assert.equal(request.validar(),false);}finally{release.resolve();}
 await assert.rejects(pending);f.noTargetEffects(id);
});
test('conciliação: dúvida não elimina vínculo de outro intervalo da mensagem',async t=>{
 const f=fixture(t),projects=candidates(f),first='Revisar o catálogo do projeto Aurora.',second='Também precisamos revisar aquele outro material.',id=f.add(first+' '+second);
 f.handle(()=>({...blank(),vinculos:[link(projects[0],first)],perguntas:[question(projects,second)]}));
 const r=await f.org.avaliarFonte(id);assert.equal(r.vinculos.length,1);assert.equal(r.vinculos[0].trecho,first);assert.equal(r.perguntas.length,1);
});
test('conciliação: evidência fora do intervalo cadastrado no mesmo evento é rejeitada',async t=>{
 const f=fixture(t),base='Projeto Aurora: preparar catálogo.',outside='Outro trabalho não faz parte deste vínculo.',event=f.add(base+' '+outside),projectId=f.org.projetos.criarRascunho({nome:'Aurora',natureza:'incerto',chave:'synthetic-narrow',fontes:[{eventoId:event,trecho:base}]}).id;
 const candidate={id:projectId,event,text:base,name:'Aurora'},text='Vamos revisar o catálogo daquele projeto.',id=f.add(text);
 f.handle(()=>({...blank(),vinculos:[link(candidate,text,[{eventoId:event,trecho:base},{eventoId:event,trecho:outside}])]}));
 assert.equal((await f.org.avaliarFonte(id)).vinculos.length,0);
});
test('conciliação: próprio alvo não vira evidência mesmo cadastrado no candidato',async t=>{
 const f=fixture(t),[candidate]=candidates(f),text='Projeto Aurora: revisão atual do catálogo.',id=f.add(text);f.org.projetos.vincularFonte({id:candidate.id,eventoId:id,trecho:text});
 f.handle(()=>({...blank(),vinculos:[link(candidate,text,[{eventoId:id,trecho:text}])]}));
 assert.equal((await f.org.avaliarFonte(id)).vinculos.length,0);
});
test('conciliação: desacordo em um de dois trechos conserva vínculo do trecho concordante',async t=>{
 const f=fixture(t),[a,b]=candidates(f),c=f.project('Cedro','Projeto Cedro: preparar o material de lançamento.');
 const first='Revisar aquele catálogo combinado.',second='Organizar a apresentação do projeto Boreal.',id=f.add(first+' '+second);
 f.handle(({index})=>({...blank(),vinculos:[link(index?c:a,first),link(b,second)]}));
 const r=await f.org.avaliarFonte(id);assert.equal(r.perguntas.length,1);assert.deepEqual(new Set(r.perguntas[0].opcoes.map(p=>p.projetoId)),new Set([a.id,c.id]));assert.equal(r.vinculos.length,1);assert.equal(r.vinculos[0].projetoId,b.id);assert.equal(r.vinculos[0].trecho,second);
});
test('conciliação: revisão pode acrescentar segundo trabalho literal sem remover o primeiro',async t=>{
 const f=fixture(t),[a,b]=candidates(f),first='Projeto Aurora: revisar o catálogo.',second='Projeto Boreal: organizar a apresentação.',id=f.add(first+' '+second);
 f.handle(({index})=>({...blank(),vinculos:[link(a,first),...(index?[link(b,second)]:[])]}));
 const r=await f.org.avaliarFonte(id);assert.equal(r.perguntas.length,0);assert.deepEqual(r.vinculos.map(v=>v.projetoId),[a.id,b.id]);
});
test('conciliação: dois trabalhos concordantes no mesmo trecho conservam ambos os vínculos',async t=>{
 const f=fixture(t),[a,b]=candidates(f),text='Revisar os materiais dos projetos Aurora e Boreal juntos.',id=f.add(text);
 f.handle(()=>({...blank(),vinculos:[link(a,text),link(b,text)]}));
 const r=await f.org.avaliarFonte(id);assert.equal(r.perguntas.length,0);assert.deepEqual(new Set(r.vinculos.map(v=>v.projetoId)),new Set([a.id,b.id]));
});
test('conciliação: A+B para B+C no mesmo trecho pergunta A/C e bloqueia vínculos sobrepostos',async t=>{
 const f=fixture(t),[a,b]=candidates(f),c=f.project('Cedro','Projeto Cedro: preparar material sintético.'),text='Revisar os dois materiais combinados pela equipe.',id=f.add(text);
 f.handle(({index})=>({...blank(),vinculos:(index?[b,c]:[a,b]).map(p=>link(p,text))}));
 const r=await f.org.avaliarFonte(id);assert.equal(r.perguntas.length,1);assert.deepEqual(new Set(r.perguntas[0].opcoes.map(p=>p.projetoId)),new Set([a.id,c.id]));assert.equal(r.vinculos.length,0);
});

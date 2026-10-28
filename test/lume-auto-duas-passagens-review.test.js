// Independent boundary tests; synthetic in-memory sources, no account/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO,INSTRUCOES_ORGANIZACAO,INSTRUCOES_REVISAO_ORGANIZACAO} from '../src/pessoal/organizador.js';
const MODEL='synthetic-two-pass',GROUP='550000009001@g.us';
const blank=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
function fixture(t){
 const db=abrirBanco(),context=new ContextoApp(db),calls=[];let seq=0,handler=()=>blank(),stateHook=()=>{};
 const account={connected:true,planEnabled:true,paused:false,model:MODEL,account:{id:'synthetic-account'}};
 new Desktop(db).aceitar({nome:'Synthetic boundary review',aceito:true,versao:VERSAO_TERMOS});
 const org=new OrganizadorConversas(db,{agora:()=>new Date('2026-10-28T12:00:00Z'),chatgpt:{estado:async()=>{await stateHook();return structuredClone(account);},responder:async r=>{calls.push(r);const value=await handler(r,calls.length);return value?.response??{completed:true,model:MODEL,requestId:'synthetic-request-'+calls.length,text:JSON.stringify(value)};}}});
 org.configurarEscopo({escopo:'todas',confirmar:true});org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC TEST ONLY',revisor:'independent fixture'});org.configurar({acao:'retomar'});
 t.after(async()=>{await org.encerrar();db.close();});
 const add=text=>context._registrarEvento({conversaId:GROUP,origemId:'synthetic-'+(++seq),autorId:'550000009099@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:new Date('2026-10-28T11:00:00Z')},'dirigida').id;
 return {db,org,calls,account,add,handler:fn=>handler=fn,stateHook:fn=>stateHook=fn};
}
const targetText='Projeto Aurora: preparar o catalogo solicitado.';
const proposal=()=>({...blank(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:targetText,confianca:.98}]});
const noDerivation=f=>{assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);};

test('two-pass: identical original input plus untrusted raw proposal; two receipts and no interim persistence',async t=>{
 const f=fixture(t),id=f.add(targetText);
 f.handler((r,n)=>{noDerivation(f);assert.equal(r.validar(),true);if(n===2){const first=JSON.parse(f.calls[0].input[0].content),second=JSON.parse(r.input[0].content);assert.deepEqual(second.proposta,proposal());delete second.proposta;assert.deepEqual(second,first);assert.equal(r.signal,f.calls[0].signal);assert.ok(r.timeoutMs<=f.calls[0].timeoutMs);}return proposal();});
 assert.equal(await f.org.passo(),true);assert.equal(f.calls.length,2);assert.equal(f.calls[0].instructions,INSTRUCOES_ORGANIZACAO);assert.equal(f.calls[1].instructions,INSTRUCOES_REVISAO_ORGANIZACAO);
 const result=f.org.sugestoes(id);assert.deepEqual(result.recibos.map(r=>r.fase),['extracao','revisao']);assert.equal(new Set(result.recibos.map(r=>r.requestId)).size,2);assert.equal(result.vinculos.length,1);
});

for(const phase of [1,2])for(const mutation of ['source','permission','pause','account','model','plan'])test(`two-pass: ${mutation} changed in phase ${phase} cannot persist or advance`,async t=>{
 const f=fixture(t),id=f.add(targetText);
 f.handler((r,n)=>{if(n===phase){if(mutation==='source')f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(targetText+' changed',id);if(mutation==='permission')f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);if(mutation==='pause')f.org.configurar({acao:'pausar'});if(mutation==='account')f.account.account.id='another-account';if(mutation==='model')f.account.model='another-model';if(mutation==='plan')f.account.planEnabled=false;}return proposal();});
 assert.equal(await f.org.passo(),false);assert.equal(f.calls.length,phase);noDerivation(f);assert.equal(f.org.sugestoes(id),null);
});

for(const invalid of ['duplicate','incomplete','wrong-model','missing-id','malformed','throw'])test('two-pass: invalid second receipt/output '+invalid+' has no first-pass fallback',async t=>{
 const f=fixture(t),id=f.add(targetText);
 f.handler((r,n)=>{if(n===1)return proposal();if(invalid==='throw')throw Object.assign(new Error('synthetic failure'),{code:'SYNTHETIC_FAILURE'});const response={completed:true,model:MODEL,requestId:'synthetic-request-2',text:JSON.stringify(proposal())};if(invalid==='duplicate')response.requestId='synthetic-request-1';if(invalid==='incomplete')response.completed=false;if(invalid==='wrong-model')response.model='wrong';if(invalid==='missing-id')delete response.requestId;if(invalid==='malformed')response.text='not json';return {response};});
 assert.equal(await f.org.passo(),false);assert.equal(f.calls.length,2);noDerivation(f);assert.equal(f.org.sugestoes(id),null);
});

test('two-pass: deadline is shared, not renewed after first response',async t=>{
 const f=fixture(t),id=f.add(targetText),original=Date.now;let offset=0;Date.now=()=>original()+offset;t.after(()=>{Date.now=original;});
 f.handler(()=>{offset=120001;return proposal();});await assert.rejects(f.org.avaliarFonte(id),e=>e.code==='ORGANIZACAO_INTERROMPIDA');assert.equal(f.calls.length,1);noDerivation(f);
});

test('two-pass: external abort during review rejects a late completed response',async t=>{
 const f=fixture(t),id=f.add(targetText),controller=new AbortController();
 f.handler((r,n)=>{if(n===2){controller.abort();assert.equal(r.validar(),false);}return proposal();});
 await assert.rejects(f.org.avaliarFonte(id,{signal:controller.signal}),e=>e.code==='ORGANIZACAO_INTERROMPIDA');assert.equal(f.calls.length,2);noDerivation(f);
});

test('two-pass: lost queue lease prevents transmission of second request',async t=>{
 const f=fixture(t),id=f.add(targetText);
 f.handler((r,n)=>{if(n===1)f.db.prepare("UPDATE etapas SET lease_token='another-owner' WHERE evento_id=? AND etapa='organizacao_chatgpt'").run(id);return proposal();});
 assert.equal(await f.org.passo(),false);noDerivation(f);assert.equal(f.calls.length,1,'obsolete worker must not send review after losing ownership');
});

for(const phase of [1,2])test('two-pass: expired queue lease in phase '+phase+' prevents later calls and persistence',async t=>{
 const f=fixture(t),id=f.add(targetText);
 f.handler((r,n)=>{if(n===phase)f.db.prepare("UPDATE etapas SET lease_ate='2026-10-28T11:59:59Z' WHERE evento_id=? AND etapa='organizacao_chatgpt'").run(id);return proposal();});
 assert.equal(await f.org.passo(),false);assert.equal(f.calls.length,phase);noDerivation(f);
});

test('two-pass: manual target correction during review invalidates both proposals',async t=>{
 const f=fixture(t),id=f.add(targetText);
 f.handler((r,n)=>{if(n===2)f.org.corrigirVinculo({eventoId:id,trecho:targetText,projetoId:null});return proposal();});
 assert.equal(await f.org.passo(),false);noDerivation(f);assert.equal(f.org.sugestoes(id),null);
});

test('two-pass: context revoked during review invalidates both proposals',async t=>{
 const f=fixture(t),prior=f.add('O catalogo sintetico trata das pecas industriais.'),id=f.add(targetText);
 f.handler((r,n)=>{if(n===2)f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(prior);return proposal();});
 await assert.rejects(f.org.avaliarFonte(id),e=>e.code==='FONTE_ALTERADA');assert.equal(f.calls.length,2);noDerivation(f);
});

test('two-pass: explicit project start can use literal person label without turning the person or group into the project',async t=>{
 const f=fixture(t),unrelated=f.add('Uma conversa casual sem relacao com qualquer trabalho.'),identity='Inclui a equipe no grupo da Lia.',prior=f.add(identity),text='Vamos iniciar um projeto naquele grupo.',target=f.add(text);
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:'Lia',trecho:text,confianca:.98,origemNome:{eventoId:prior,trecho:identity}}]}));
 f.org.capturar();f.db.prepare("UPDATE etapas SET proxima_tentativa_em='2099-01-01T00:00:00Z' WHERE etapa='organizacao_chatgpt' AND evento_id<>?").run(target);
 assert.equal(await f.org.passo(),true);const result=f.org.sugestoes(target),project=f.org.projetos.obter(result.vinculos[0].projetoId);
 assert.equal(project.nome,'Lia');assert.deepEqual(project.fontes.filter(x=>x.base).map(x=>x.eventoId).sort((a,b)=>a-b),[prior,target]);
 assert.equal(project.fontes.some(x=>x.eventoId===unrelated),false);assert.deepEqual(result.tags,[]);assert.notEqual(project.id,GROUP);assert.deepEqual(result.oportunidades,[]);
});

test('two-pass: literal client label cannot silently merge an unrelated existing project of the same name',async t=>{
 const f=fixture(t),oldText='Projeto Lia: catalogo de pecas industriais.',old=f.add(oldText),oldProject=f.org.projetos.criarRascunho({nome:'Lia',natureza:'incerto',fontes:[{eventoId:old,trecho:oldText}]}),identity='Inclui a equipe no novo grupo da Lia.',prior=f.add(identity),text='Vamos iniciar outro projeto independente naquele grupo.',target=f.add(text);
 f.handler(()=>({...blank(),vinculos:[{tipo:'projeto',nome:'Lia',trecho:text,confianca:.98,origemNome:{eventoId:prior,trecho:identity}}]}));
 f.org.capturar();f.db.prepare("UPDATE etapas SET proxima_tentativa_em='2099-01-01T00:00:00Z' WHERE etapa='organizacao_chatgpt' AND evento_id<>?").run(target);
 assert.equal(await f.org.passo(),true);const result=f.org.sugestoes(target);assert.notEqual(result.vinculos[0].projetoId,oldProject.id);
 assert.equal(f.org.projetos.obter(oldProject.id).fontes.some(x=>x.eventoId===target),false);
});

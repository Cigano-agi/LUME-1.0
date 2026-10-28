// SYNTHETIC fixtures only. In-memory SQLite, mock model, no network or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {ExperienciaLume} from '../src/experiencia-lume.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO,ETAPA_ORGANIZACAO} from '../src/pessoal/organizador.js';

const GROUP='550000008701@g.us',FUTURE='550000008702@g.us',MODEL='synthetic-security-model';
const empty=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture(t,{file=false}={}){
  const dir=file?mkdtempSync(join(tmpdir(),'lume-auto-security-')):null,path=dir?join(dir,'synthetic.db'):undefined;
  const db=abrirBanco(path),context=new ContextoApp(db),now=new Date('2026-10-28T12:00:00Z');let seq=0;
  new Desktop(db).aceitar({nome:'Synthetic security fixture',aceito:true,versao:VERSAO_TERMOS});
  const calls=[];let handler=async()=>empty();
  const org=new OrganizadorConversas(db,{agora:()=>now,chatgpt:{
    estado:async()=>({connected:true,planEnabled:true,paused:false,model:MODEL}),
    responder:async request=>{const input=JSON.parse(request.input[0].content);calls.push(input);assert.equal(request.validar(),true);return{completed:true,model:MODEL,requestId:'synthetic-security-'+calls.length,text:JSON.stringify(await handler(request,input))};}
  }});
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(GROUP,'Grupo fictício inicial');
  const f={db,org,calls,path,handler(fn){handler=fn;},
    add(text='Projeto Aurora: preparar o catálogo de teste.',conversation=GROUP){return context._registrarEvento({conversaId:conversation,origemId:'synthetic-security-'+(++seq),autorId:'550000008799@s.whatsapp.net',direcao:'entrada',tipo:'texto',bruto:{tipoLote:'notify'},texto:text,recebidoEm:now},'terceiro').id;},
    all(){return org.configurarEscopo({escopo:'todas',confirmar:true});},
    start(){org.aprovarAvaliacao({modelo:MODEL,total:100,acertos:100,criticos:20,errosCriticos:0,contrato:CONTRATO_ORGANIZACAO,evidencia:'SYNTHETIC ONLY, never production acceptance',revisor:'synthetic fixture'});org.configurar({acao:'retomar'});},
    count(table){return db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;},
    authority(){return{personal:db.prepare('SELECT * FROM pessoal_politicas ORDER BY conversa_id').all(),base:db.prepare('SELECT * FROM autorizacoes ORDER BY conversa_id').all(),ia:db.prepare('SELECT * FROM desktop_ia_conversas ORDER BY conversa_id').all(),read:db.prepare('SELECT * FROM politicas_conversa ORDER BY conversa_id').all(),attendance:db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-enabled'").get()};}
  };
  t.after(async()=>{await org.encerrar();for(const table of ['saidas','pessoal_propostas','telegram_saidas'])assert.equal(f.count(table),0,'organization scope never grants sending');db.close();if(dir){for(const suffix of ['','-wal','-shm'])try{unlinkSync(path+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}rmdirSync(dir);}});
  return f;
}

test('auto segurança: escopo todas exige confirmação explícita',t=>{
  const f=fixture(t);
  for(const data of [{escopo:'todas'},{escopo:'todas',confirmar:false},{escopo:'qualquer',confirmar:true}])assert.throws(()=>f.org.configurarEscopo(data));
  assert.equal(f.org.config('escopo'),null);
});

test('auto segurança: todas autoriza terceiros de grupos atuais e futuros sem alterar atendimento ou permissões individuais',async t=>{
  const f=fixture(t),event=f.add();
  assert.equal(f.org.fonte(event,{remoto:true}),null);
  const before=f.authority();f.all();
  assert.deepEqual(f.authority(),before);
  assert.ok(f.org.fonte(event,{remoto:true}),'explicit organization scope includes previously local third-party source');
  assert.equal(f.org.politica.podeEnviar(GROUP).permitido,false);
  f.db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(FUTURE,'Grupo fictício futuro');
  const future=f.add('Projeto Boreal: revisar a apresentação de teste.',FUTURE);
  assert.ok(f.org.fonte(future,{remoto:true}));
  assert.equal(f.org.politica.podeEnviar(FUTURE).permitido,false);
  await f.org.avaliarFonte(future);assert.equal(f.calls.length,2);
  assert.deepEqual(f.authority(),before,'reading and inference cannot create personal or outbound grants');
});

for(const denied of ['ia-denied','personal-denied','excluded','ignored'])test(`auto segurança: todas preserva exclusão explícita ${denied}`,async t=>{
  const f=fixture(t),event=f.add();
  if(denied==='ia-denied')f.db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,0,?)').run(GROUP,'2026-10-28T12:00:00Z');
  if(denied==='personal-denied')f.org.politica.configurar({conversaId:GROUP,categoria:'team',modo:'observar',remoto:false});
  if(denied==='excluded')f.org.politica.controlar({conversaId:GROUP,acao:'excluir'});
  if(denied==='ignored')f.org.politica.base.definir(GROUP,'ignorar',{decididoPor:'synthetic-owner'});
  const before=f.authority();f.all();assert.deepEqual(f.authority(),before);
  assert.equal(f.org.fonte(event,{remoto:true}),null);
  await assert.rejects(f.org.avaliarFonte(event));assert.equal(f.calls.length,0);
});

test('auto segurança: revogar escopo enquanto modelo responde descarta a resposta tardia', {timeout:5000},async t=>{
  const f=fixture(t);f.all();const id=f.add(),entered=deferred(),release=deferred();
  f.handler(async request=>{entered.resolve(request);await release.promise;return empty();});
  const pending=f.org.avaliarFonte(id),request=await entered.promise;
  try{f.org.configurarEscopo({escopo:'autorizadas',confirmar:true});assert.equal(request.validar(),false);}finally{release.resolve();}
  await assert.rejects(pending);assert.equal(f.org.sugestoes(id),null);
});

for(const mutation of ['edit','revoke'])test(`auto segurança: fonte anterior ${mutation} em voo invalida alvo intacto`,{timeout:5000},async t=>{
  const f=fixture(t);f.all();const previous=f.add(),target=f.add('Vamos revisar o catálogo e enviar a versão final amanhã.');
  const entered=deferred(),release=deferred();f.handler(async(request,input)=>{assert.ok(input.contexto.some(x=>x.eventoId===previous));entered.resolve(request);await release.promise;return empty();});
  const pending=f.org.avaliarFonte(target),request=await entered.promise;
  try{
    if(mutation==='edit')f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Projeto Boreal: contexto substituído pelo dono.',previous);
    else f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(previous);
    assert.equal(request.validar(),false,'context changes must be checked before accepting a response');
  }finally{release.resolve();}
  await assert.rejects(pending);assert.equal(f.org.sugestoes(target),null);
});

test('auto segurança: sugestão persistida desaparece se uma fonte anterior do contexto mudar',async t=>{
  const f=fixture(t);f.all();f.start();const previous=f.add(),target=f.add('Precisamos revisar o catálogo de teste amanhã.');
  f.handler(async(_request,input)=>({...empty(),assuntos:[{nome:'Catálogo',trecho:input.texto,confianca:.98}]}));
  assert.equal(await f.org.passo(),true);
  assert.ok(f.org.sugestoes(previous),'chronological queue processes prior source first');
  assert.equal(await f.org.passo(),true);
  assert.ok(f.org.sugestoes(target));assert.equal(f.db.prepare('SELECT estado FROM etapas WHERE evento_id=? AND etapa=?').get(target,ETAPA_ORGANIZACAO).estado,'concluida');
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Projeto Boreal: contexto foi corrigido.',previous);
  assert.equal(f.org.sugestoes(target),null,'a completed target cannot retain a stale context-derived suggestion');
});

test('auto segurança: corrigir vínculo de fonte anterior invalida chamada em voo', {timeout:5000},async t=>{
  const f=fixture(t);f.all();const previousText='Projeto Aurora: preparar o catálogo de teste.',previous=f.add(previousText);
  const otherText='Projeto Boreal: preparar outro catálogo fictício.',other=f.add(otherText);
  const original=f.org.projetos.criarRascunho({nome:'Aurora',natureza:'incerto',chave:'synthetic-aurora',fontes:[{eventoId:previous,trecho:previousText}]}).id;
  const corrected=f.org.projetos.criarRascunho({nome:'Boreal',natureza:'incerto',chave:'synthetic-boreal',fontes:[{eventoId:other,trecho:otherText}]}).id;
  const target=f.add('Vamos revisar aquele catálogo e enviar a versão final.');
  const entered=deferred(),release=deferred();f.handler(async(request,input)=>{
    assert.ok(input.contexto.some(x=>x.eventoId===previous));assert.ok(input.projetos.some(x=>x.id===original));
    entered.resolve(request);await release.promise;
    return {...empty(),vinculos:[{tipo:'projeto',nome:'Aurora',projetoId:original,trecho:input.texto,evidencias:[{eventoId:previous,trecho:previousText}],confianca:.98}]};
  });
  const pending=f.org.avaliarFonte(target),request=await entered.promise;
  try{f.org.corrigirVinculo({eventoId:previous,projetoId:corrected,trecho:previousText});assert.equal(request.validar(),false);}finally{release.resolve();}
  await assert.rejects(pending);assert.equal(f.org.sugestoes(target),null);
});

test('auto segurança: grupo de terceiro organiza projeto e ação, projeta e conserva resultado ao reabrir SQLite sem liberar envio',async t=>{
  const f=fixture(t,{file:true});f.all();f.start();
  const text='Projeto Aurora: preparar o catálogo fictício e revisar amanhã.',id=f.add(text);
  const before=f.authority();
  f.handler(async(_request,input)=>({...empty(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:input.texto,confianca:.98}],compromissos:[{tipo:'pendencia',resumo:'Preparar o catálogo fictício',trecho:input.texto,prazo_citado:'amanhã',confianca:.98}]}));
  assert.equal(await f.org.passo(),true);
  const r=f.org.sugestoes(id);assert.ok(r,'a completed third-party group derivation remains valid');
  const projectId=r.vinculos[0].projetoId,action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(id);assert.ok(action);
  const viewFor=(db,org)=>new ExperienciaLume(db,{acoes:org.contexto.acoes,produto:new Desktop(db),pessoal:{organizador:org,politica:org.politica}}).obter('acao:'+action.id).itens[0];
  const view=viewFor(f.db,f.org);assert.ok(view);assert.equal(view.projetoId,projectId);assert.equal(view.fonte.eventoId,id);
  assert.deepEqual(f.authority(),before);assert.equal(f.org.politica.podeEnviar(GROUP).permitido,false);
  await f.org.encerrar();
  const reopened=abrirBanco(f.path),org=new OrganizadorConversas(reopened);
  try{
    assert.equal(reopened.prepare('SELECT permissao FROM eventos WHERE id=?').get(id).permissao,'terceiro');
    assert.equal(org.sugestoes(id)?.vinculos[0].projetoId,projectId);
    assert.equal(viewFor(reopened,org)?.projetoId,projectId);
    assert.equal(org.politica.podeEnviar(GROUP).permitido,false);
    assert.equal(reopened.prepare('SELECT COUNT(*) n FROM desktop_ia_conversas').get().n,0,'organization scope did not rewrite individual IA grants');
    assert.equal(reopened.prepare('SELECT COUNT(*) n FROM pessoal_politicas').get().n,0,'organization scope did not rewrite attendance grants');
  }finally{await org.encerrar();reopened.close();}
});

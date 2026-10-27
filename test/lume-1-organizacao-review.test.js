// Independent adversarial review. Every identity, message, model receipt and
// evaluation attestation here is SYNTHETIC. No real network or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
import {ExperienciaLume} from '../src/experiencia-lume.js';
import {createLumeMcpCore} from '../src/mcp/core.js';
import {OrganizadorConversas,CONTRATO_ORGANIZACAO,ETAPA_ORGANIZACAO} from '../src/pessoal/organizador.js';

const DM='550000000801@s.whatsapp.net',OTHER='550000000802@s.whatsapp.net',GROUP='550000000803@g.us';
const TEXT='Projeto Aurora: preparar relatório amanhã para a equipe.';
const empty=()=>({assuntos:[],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const answer=(overrides={})=>({...empty(),tags:[{valor:'equipe',trecho:TEXT,confianca:.95}],...overrides});
const attestation=()=>({modelo:'synthetic-review',total:100,acertos:100,criticos:20,errosCriticos:0,evidencia:'SYNTHETIC fixture; does not approve product quality',revisor:'independent synthetic reviewer',contrato:CONTRATO_ORGANIZACAO});

function fixture(t,{approved=true,file=false}={}) {
  const dir=file?mkdtempSync(join(tmpdir(),'lume-org-review-')):null,path=dir?join(dir,'fixture.db'):undefined;
  let db=abrirBanco(path),contexto=new ContextoApp(db),clock=new Date('2026-10-26T14:00:00Z'),seq=0;
  new Desktop(db).aceitar({nome:'Synthetic independent review',aceito:true,versao:VERSAO_TERMOS});
  const calls=[],state={connected:true,planEnabled:true,paused:false,model:'synthetic-review'};
  let handler=async()=>answer();
  const chatgpt={estado:async()=>({...state}),responder:async request=>{
    const input=JSON.parse(request.input[0].content);calls.push(input);
    assert.equal(request.validar(),true,'authorization at dispatch');
    return {completed:true,model:state.model,requestId:'synthetic-'+calls.length,text:JSON.stringify(await handler(request,input))};
  }};
  const make=()=>new OrganizadorConversas(db,{chatgpt,agora:()=>clock});
  let org=make();
  for(const id of [DM,OTHER,GROUP]){
    db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,id===GROUP?'Grupo Aurora':'Pessoa homônima');
    org.politica.configurar({conversaId:id,categoria:'team',modo:'observar',remoto:true});
    db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,1,?)').run(id,clock.toISOString());
  }
  if(approved)org.aprovarAvaliacao(attestation());
  org.configurar({acao:'retomar'});
  const f={get db(){return db;},get org(){return org;},calls,state,
    handler(fn){handler=fn;},advance(ms){clock=new Date(+clock+ms);},
    add({id=DM,text=TEXT,permission='dirigida',author=id,origin='review-'+(++seq),date=clock,type='notify'}={}){
      return contexto._registrarEvento({conversaId:id,origemId:origin,autorId:author,direcao:'entrada',tipo:'texto',bruto:{tipoLote:type},texto:text,recebidoEm:date},permission).id;
    },
    stage(id){return db.prepare('SELECT * FROM etapas WHERE evento_id=? AND etapa=?').get(id,ETAPA_ORGANIZACAO);},
    count(table){return db.prepare(`SELECT count(*) n FROM ${table}`).get().n;},
    restart(){assert.equal(org.running,null);db.close();db=abrirBanco(path);contexto=new ContextoApp(db);org=make();return org;},
    newInstance:make,
    noEffects(){assert.equal(f.count('saidas'),0);assert.equal(f.count('pessoal_propostas'),0);assert.equal(f.count('telegram_saidas'),0);}
  };
  t.after(async()=>{await org.encerrar();db.close();if(dir){for(const suffix of ['','-wal','-shm'])try{unlinkSync(path+suffix);}catch(e){if(e.code!=='ENOENT')throw e;}rmdirSync(dir);}});
  return f;
}

test('Lume1 review: no quality attestation, wrong model and unavailable account dispatch nothing',async t=>{
  const f=fixture(t,{approved:false});f.add();await f.org.passo();assert.equal(f.calls.length,0);
  assert.throws(()=>f.org.aprovarAvaliacao({...attestation(),acertos:89}));
  assert.throws(()=>f.org.aprovarAvaliacao({...attestation(),errosCriticos:1}));
  f.org.aprovarAvaliacao(attestation());f.state.model='different';await f.org.passo();assert.equal(f.calls.length,0);
  f.state.model='synthetic-review';f.state.connected=false;await f.org.passo();assert.equal(f.calls.length,0);
  f.state.connected=true;await f.org.passo();assert.equal(f.calls.length,1);f.noEffects();
});

for(const mutation of ['permission','remote','exclude','edit','author','delete'])test(`Lume1 review: ${mutation} during inference discards late derivation`,async t=>{
  const f=fixture(t),id=f.add(),entered=deferred(),release=deferred();
  f.handler(async()=>{entered.resolve();await release.promise;return answer({compromissos:[{tipo:'pendencia',resumo:'Preparar relatório',trecho:TEXT,prazo_citado:'amanhã',confianca:.95}]});});
  const pending=f.org.passo();await entered.promise;
  try {
  if(mutation==='permission')f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);
  if(mutation==='remote')f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);
  if(mutation==='exclude')f.org.politica.controlar({conversaId:DM,acao:'excluir'});
  if(mutation==='edit')f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto editado sem demanda.',id);
  if(mutation==='author')f.db.prepare('UPDATE eventos SET autor_id=? WHERE id=?').run(OTHER,id);
  if(mutation==='delete')f.db.prepare('DELETE FROM eventos WHERE id=?').run(id);
  } finally {release.resolve();await pending;}
  assert.equal(f.org.sugestoes(id),null);assert.equal(f.count('lume_acoes'),0);assert.equal(f.count('lume_projetos_comerciais'),0);f.noEffects();
});

test('Lume1 review: duplicate ingest and concurrent instances dispatch once and preserve durable source',async t=>{
  const f=fixture(t),id=f.add({origin:'same'});assert.equal(f.add({origin:'same'}),id);
  const entered=deferred(),release=deferred();f.handler(async()=>{entered.resolve();await release.promise;return answer();});
  const one=f.org.passo();await entered.promise;const two=f.org.passo(),other=f.newInstance();
  await other.passo();assert.equal(f.calls.length,1);release.resolve();await Promise.all([one,two]);
  await f.org.passo();assert.equal(f.calls.length,1);assert.equal(f.count('eventos'),1);assert.equal(f.stage(id).estado,'concluida');f.noEffects();
});

test('Lume1 review: manual tags win over late result and survive actual SQLite reopen',async t=>{
  const f=fixture(t,{file:true}),id=f.add(),entered=deferred(),release=deferred();
  f.handler(async()=>{entered.resolve();await release.promise;return answer();});
  const pending=f.org.passo();await entered.promise;f.org.corrigirTags({conversaId:DM,tags:['parceiro']});release.resolve();await pending;
  assert.equal(f.stage(id).estado,'concluida');assert.deepEqual(f.org.tags(DM).map(x=>[x.valor,x.origem]),[['parceiro','manual']]);
  const cursor=f.org.estado().cursor;f.restart();assert.deepEqual(f.org.estado().cursor,cursor);await f.org.passo();assert.equal(f.calls.length,1);
  assert.deepEqual(f.org.tags(DM).map(x=>[x.valor,x.origem]),[['parceiro','manual']]);
  f.org.corrigirTags({conversaId:DM,tags:[]});assert.deepEqual(f.org.tags(DM),[]);f.noEffects();
});

test('Lume1 review: account failure retries durably after backoff, without changing authority',async t=>{
  const f=fixture(t),id=f.add();let fail=true;f.handler(async()=>{if(fail)throw Object.assign(new Error('Synthetic account failure'),{code:'subscription_sharing_usage_limit_exceeded'});return answer();});
  await f.org.passo();assert.equal(f.stage(id).estado,'falha');assert.equal(f.org.sugestoes(id),null);
  await f.org.passo();assert.equal(f.calls.length,1);fail=false;f.advance(31000);await f.org.passo();
  assert.equal(f.stage(id).estado,'concluida');assert.equal(f.calls.length,2);f.noEffects();
});

test('Lume1 review: group local reading does not authorize third party remote, and author filter is exact',async t=>{
  const f=fixture(t),allowed=f.add({id:GROUP,author:DM}),privateId=f.add({id:GROUP,author:OTHER,permission:'terceiro',text:'Conteúdo somente local da outra pessoa.'});
  f.handler(async()=>answer({tags:[{valor:'equipe',trecho:TEXT,confianca:.95},{valor:'projeto',trecho:TEXT,confianca:.95}]}));
  await f.org.passo();assert.deepEqual(f.calls.map(c=>c.eventoId),[allowed]);assert.equal(f.org.sugestoes(privateId),null);
  assert.deepEqual(f.org.tags(GROUP).map(t=>t.valor),['projeto']);
  const timeline=f.org.timeline({conversa:GROUP,pessoa:DM});assert.deepEqual(timeline.itens.map(x=>x.fonte.eventoId),[allowed]);assert.equal(timeline.itens[0].autorId,DM);
  assert.equal(f.org.pessoas().pessoas.find(p=>p.id===GROUP).tipo,'grupo');assert.equal(f.org.politica.podeEnviar(GROUP).permitido,false);f.noEffects();
});

test('Lume1 review: extraction registers source-backed action and project once, preserving corrected summary',async t=>{
  const f=fixture(t),id=f.add();f.handler(async()=>answer({vinculos:[{tipo:'projeto',nome:'Aurora',trecho:TEXT,confianca:.95}],compromissos:[{tipo:'pendencia',resumo:'Preparar relatório',trecho:TEXT,prazo_citado:'amanhã',confianca:.95}]}));
  await f.org.passo();assert.equal(f.stage(id).estado,'concluida');assert.equal(f.count('lume_acoes'),1);assert.equal(f.count('lume_projetos_comerciais'),1);
  const action=f.db.prepare('SELECT * FROM lume_acoes').get();f.org.contexto.acoes.corrigir({id:action.id,resumo:'Descrição corrigida pelo dono'});
  f.db.prepare('UPDATE etapas SET estado=\'pendente\',resultado=NULL WHERE evento_id=? AND etapa=?').run(id,ETAPA_ORGANIZACAO);
  await f.org.passo();assert.equal(f.count('lume_acoes'),1);assert.equal(f.count('lume_projetos_comerciais'),1);assert.equal(f.db.prepare('SELECT resumo FROM lume_acoes').get().resumo,'Descrição corrigida pelo dono');
  assert.equal(f.db.prepare('SELECT estado FROM lume_projetos_comerciais').get().estado,'rascunho');f.noEffects();
});

test('Lume1 review: invalid literal and repeated literal never create derived records',async t=>{
  for(const text of [TEXT,TEXT+' '+TEXT]){
    const f=fixture(t),id=f.add({text});f.handler(async()=>answer({tags:[{valor:'cliente',trecho:text===TEXT?'Fonte inventada que não existe':TEXT,confianca:.99}]}));
    await f.org.passo();assert.equal(f.stage(id).estado,'desistida');assert.equal(f.org.sugestoes(id),null);assert.equal(f.count('lume_acoes'),0);f.noEffects();
  }
});

test('Lume1 review: recent messages precede historical messages and pagination has no overlap',async t=>{
  const f=fixture(t);f.handler(async()=>empty());
  const old=f.add({date:new Date('2025-01-01T00:00:00Z')}),recent=f.add(),recent2=f.add();
  await f.org.passo();assert.equal(f.calls[0].eventoId,recent2);await f.org.passo();assert.equal(f.calls[1].eventoId,recent);await f.org.passo();assert.equal(f.calls[2].eventoId,old);
  const first=f.org.timeline({conversa:DM,limite:2}),next=f.org.timeline({conversa:DM,limite:2,pagina:first.proximaPagina});
  assert.equal(first.proximaPagina,2);assert.deepEqual([...first.itens,...next.itens].map(x=>x.fonte.eventoId),[recent2,recent,old]);assert.equal(next.proximaPagina,null);assert.equal(f.org.estado().historicoCompleto,false);f.noEffects();
});

test('Lume1 review: permanent invalid source result is not dispatched repeatedly until source changes',async t=>{
  const f=fixture(t),id=f.add();f.handler(async()=>answer({tags:[{valor:'cliente',trecho:'Literal inexistente nesta fonte.',confianca:.95}]}));
  await f.org.passo();assert.equal(f.stage(id).estado,'desistida');
  for(let i=0;i<3;i++)await f.org.passo();
  assert.equal(f.calls.length,1,'a permanent refusal must not become a fresh paid/quota request on every scan');
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(TEXT+' Fonte revisada.',id);
  f.handler(async()=>empty());await f.org.passo();assert.equal(f.calls.length,2);assert.equal(f.stage(id).estado,'concluida');
});

test('Lume1 review: completed receipt must match the evaluated model before recording suggestions',async t=>{
  for(const invalid of [{completed:false},{model:'unreviewed-model'},{requestId:null,responseId:null}]) {
    const f=fixture(t),id=f.add();
    f.org.chatgpt.responder=async()=>({completed:true,model:'synthetic-review',requestId:'synthetic-receipt',text:JSON.stringify(answer()),...invalid});
    await f.org.passo();assert.notEqual(f.stage(id)?.estado,'concluida');assert.equal(f.org.sugestoes(id),null);
  }
});

test('Lume1 review: new HTTP routes preserve session, origin, readOnly and hidden evaluation gate',async t=>{
  const f=fixture(t);f.add();
  const server=criarServidor(f.db,{desktop:true,readOnly:true,pessoal:{organizador:f.org},conexao:{estado:()=>({estado:'desconectada'})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const origin='http://127.0.0.1:'+server.address().port,{token}=await(await fetch(origin+'/api/sessao')).json();
  const path='/api/v3/lume-1/timeline?conversa='+encodeURIComponent(DM);
  assert.equal((await fetch(origin+path)).status,403);
  assert.equal((await fetch(origin+path,{headers:{'x-assessor-token':token,origin:'https://evil.invalid'}})).status,403);
  const before=f.db.prepare('SELECT total_changes() n').get().n;
  const valid=await fetch(origin+path,{headers:{'x-assessor-token':token}});assert.equal(valid.status,200);assert.equal((await valid.json()).itens.length,1);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  assert.equal((await fetch(origin+'/api/v3/lume-1/pessoas/correcao',{method:'POST',headers:{'x-assessor-token':token,'content-type':'application/json'},body:JSON.stringify({conversaId:DM,tags:['cliente']})})).status,403);
  assert.notEqual((await fetch(origin+'/api/v3/lume-1/avaliacao',{headers:{'x-assessor-token':token}})).status,200);f.noEffects();
});

test('Lume1 review: pausing while account state is pending prevents later model dispatch',async t=>{
  const f=fixture(t);f.add();const entered=deferred(),release=deferred();
  f.org.chatgpt.estado=async()=>{entered.resolve();await release.promise;return {...f.state};};
  const pending=f.org.passo();await entered.promise;f.org.configurar({acao:'pausar'});release.resolve();await pending;
  assert.equal(f.calls.length,0,'pause before dispatch must prevent sending the source');f.noEffects();
});

test('Lume1 review: revoking then restoring the same source during inference cannot resurrect the stale request',async t=>{
  const f=fixture(t),id=f.add(),entered=deferred(),release=deferred();
  f.handler(async()=>{entered.resolve();await release.promise;return answer();});
  const pending=f.org.passo();await entered.promise;
  try{f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);f.db.prepare("UPDATE eventos SET permissao='dirigida' WHERE id=?").run(id);}
  finally{release.resolve();await pending;}
  assert.equal(f.org.sugestoes(id),null,'new permission needs a fresh request, never a revoked in-flight result');
});

for(const mutation of ['source','remote'])test(`Lume1 review: standalone evaluation rejects ${mutation} revoke and restore without a runtime stage`,async t=>{
  const f=fixture(t,{approved:false}),id=f.add(),entered=deferred(),release=deferred();
  f.handler(async()=>{entered.resolve();await release.promise;return answer();});
  const pending=f.org.avaliarFonte(id);await entered.promise;
  if(mutation==='source'){f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);f.db.prepare("UPDATE eventos SET permissao='dirigida' WHERE id=?").run(id);}
  else{f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);f.db.prepare('UPDATE desktop_ia_conversas SET permitida=1 WHERE conversa_id=?').run(DM);}
  release.resolve();await assert.rejects(pending);assert.equal(f.org.sugestoes(id),null);f.noEffects();
});

const experience=f=>new ExperienciaLume(f.db,{acoes:f.org.contexto.acoes,produto:new Desktop(f.db),pessoal:{organizador:f.org,politica:f.org.politica}});
const projectAnswer=()=>answer({vinculos:[{tipo:'projeto',nome:'Aurora',trecho:TEXT,confianca:.95}],compromissos:[{tipo:'pendencia',resumo:'Preparar relatório',trecho:TEXT,prazo_citado:'amanhã',confianca:.95}]});

test('Lume1 integration review: base ignore then restore invalidates the in-flight authorization',async t=>{
  const f=fixture(t),id=f.add(),entered=deferred(),release=deferred();
  f.handler(async()=>{entered.resolve();await release.promise;return answer();});
  const pending=f.org.passo();await entered.promise;
  try{f.org.politica.base.revogar(DM,{decididoPor:'synthetic-owner'});f.org.politica.base.definir(DM,'observar',{decididoPor:'synthetic-owner'});}
  finally{release.resolve();await pending;}
  assert.equal(f.org.sugestoes(id),null,'base authorization revocation must not resurrect an old request');
});

test('Lume1 integration review: changed source can be organized again without reviving an invalid old project',async t=>{
  const f=fixture(t),id=f.add();f.handler(async()=>projectAnswer());await f.org.passo();
  const first=f.org.sugestoes(id).vinculos[0].projetoId;
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(TEXT+' Escopo adicional a conferir.',id);
  assert.equal(f.org.projetos.obter(first),null);await f.org.passo();
  assert.equal(f.stage(id).estado,'concluida','updated source must not fail forever on its previous idempotency key');
  const current=f.org.sugestoes(id);assert.ok(current);assert.ok(f.org.projetos.obter(current.vinculos[0].projetoId));
});

async function correctedProject(t){
  const f=fixture(t),id=f.add();f.handler(async()=>projectAnswer());await f.org.passo();
  const first=f.org.sugestoes(id).vinculos[0].projetoId;
  const text='Projeto Boreal: preparar o catálogo revisado.',other=f.add({text});
  const chosen=f.org.projetos.criarRascunho({nome:'Boreal',natureza:'incerto',chave:'synthetic-manual-boreal',fontes:[{eventoId:other,trecho:text}]}).id;
  f.org.corrigirVinculo({eventoId:id,projetoId:chosen,trecho:TEXT});
  return {f,id,first,chosen};
}
test('Lume1 integration review: manual project correction replaces previous timeline filter membership',async t=>{
  const {f,id,first,chosen}=await correctedProject(t);
  assert.ok(f.org.timeline({conversa:DM,projeto:chosen}).itens.some(i=>i.fonte.eventoId===id));
  assert.ok(!f.org.timeline({conversa:DM,projeto:first}).itens.some(i=>i.fonte.eventoId===id),'old project filter must not return a source whose link was corrected');
});
test('Lume1 integration review: manual project and tag corrections govern experience projections',async t=>{
  const {f,id,chosen}=await correctedProject(t);f.org.corrigirTags({conversaId:DM,tags:['parceiro']});
  const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(id);
  const view=experience(f).obter('acao:'+action.id).itens[0];
  assert.equal(view.projetoId,chosen);assert.deepEqual(view.tags.map(t=>t.valor),['parceiro']);
});

test('Lume1 integration review: timeline carries existing corrected commitments and their current state',t=>{
  const f=fixture(t),id=f.add();
  const {acaoId}=f.org.contexto.registrarDemanda({eventoId:id,trecho:TEXT,resumo:'Preparar relatório',tipo:'compromisso'});
  f.org.contexto.acoes.corrigir({id:acaoId,resumo:'Relatório corrigido pelo dono'});
  f.org.contexto.acoes.revisar({id:acaoId,acao:'confirmar'});
  const item=f.org.timeline({conversa:DM}).itens.find(x=>x.fonte.eventoId===id),serialized=JSON.stringify(item);
  assert.ok(serialized.includes(acaoId),'timeline must link the existing durable commitment');
  assert.ok(serialized.includes('Relatório corrigido pelo dono'));assert.ok(serialized.includes('confirmado'));
  f.org.contexto.acoes.revisar({id:acaoId,acao:'resolver'});
  const resolved=f.org.timeline({conversa:DM}).itens[0].compromissos.find(a=>a.id===acaoId);
  assert.equal(resolved.estado,'resolvido');assert.equal(resolved.execucao.estado,'nenhuma');
  assert.ok(resolved.mudancas.some(m=>m.estado_novo==='resolvido'));
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);assert.equal(f.org.timeline({conversa:DM}).itens.length,0);
});

test('Lume1 integration review: project-only results enter experience and vanish on source revocation',async t=>{
  const f=fixture(t),id=f.add();f.handler(async()=>answer({vinculos:projectAnswer().vinculos}));await f.org.passo();
  const project=f.org.sugestoes(id).vinculos[0].projetoId,service=experience(f);
  assert.equal(f.count('lume_acoes'),0);assert.ok(service.listar().itens.some(i=>i.projetoId===project));
  assert.equal(service.obter('projeto:'+project).itens.length,1);
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);
  assert.ok(!service.listar().itens.some(i=>i.projetoId===project));assert.equal(service.obter('projeto:'+project).itens.length,0);
});

test('Lume1 integration review: experience tags honor manual replacement without depending on projects',async t=>{
  const f=fixture(t),id=f.add();f.handler(async()=>answer({compromissos:projectAnswer().compromissos}));await f.org.passo();
  f.org.corrigirTags({conversaId:DM,tags:['parceiro']});
  const action=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(id);
  assert.deepEqual(experience(f).obter('acao:'+action.id).itens[0].tags.map(t=>t.valor),['parceiro']);
});

test('Lume1 integration review: local manual project remains visible when only remote inference permission is revoked',async t=>{
  const f=fixture(t),id=f.add();await f.org.passo();
  const manual=f.org.projetos.criarRascunho({nome:'Organização local manual',natureza:'incerto',chave:'synthetic-local-manual',fontes:[{eventoId:id,trecho:TEXT}]}).id;
  f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run(DM);
  assert.ok(f.org.projetos.obter(manual),'manual project is locally authorized');
  assert.equal(experience(f).obter('projeto:'+manual).itens.length,1,'unrelated automatic stage must not hide a manual project');
});

test('Lume1 integration review: experience pagination does not silently stop at the hundredth project',t=>{
  const f=fixture(t),id=f.add();
  for(let n=0;n<102;n++)f.org.projetos.criarRascunho({nome:'Projeto manual '+n,natureza:'incerto',chave:'synthetic-page-'+n,fontes:[{eventoId:id,trecho:TEXT}]});
  const service=experience(f),pages=[1,2,3].map(pagina=>service.listar({pagina,limite:50}));
  const ids=pages.flatMap(p=>p.itens.map(i=>i.projetoId));
  assert.equal(new Set(ids).size,102);assert.equal(pages[2].itens.length,2);assert.equal(pages[2].proximaPagina,null);
});

test('Lume1 integration review: correcting one source excerpt preserves the other project in the same message',async t=>{
  const f=fixture(t),a='Projeto Aurora: revisar orçamento.',b='Projeto Boreal: revisar contrato.',id=f.add({text:a+' '+b});
  f.handler(async()=>({...empty(),vinculos:[{tipo:'projeto',nome:'Aurora',trecho:a,confianca:.95},{tipo:'projeto',nome:'Boreal',trecho:b,confianca:.95}]}));
  await f.org.passo();const original=f.org.sugestoes(id).vinculos,boreal=original.find(v=>v.nome==='Boreal').projetoId,aurora=original.find(v=>v.nome==='Aurora').projetoId;
  const text='Projeto Coral: orçamento de outra frente.',base=f.add({text});
  const coral=f.org.projetos.criarRascunho({nome:'Coral',natureza:'incerto',chave:'synthetic-segment-coral',fontes:[{eventoId:base,trecho:text}]}).id;
  f.org.corrigirVinculo({eventoId:id,projetoId:coral,trecho:a});
  const item=f.org.timeline({conversa:DM}).itens.find(i=>i.fonte.eventoId===id),ids=new Set(item.projetos.map(p=>p.id));
  assert.ok(ids.has(coral));assert.ok(ids.has(boreal),'correction of Aurora excerpt must retain independent Boreal excerpt');assert.ok(!ids.has(aurora));
});

test('Lume1 integration review: commercial classification and project do not contaminate another excerpt of the source',async t=>{
  const f=fixture(t),a='Projeto Aurora: enviar proposta.',b='Preparar relatório interno amanhã.',id=f.add({text:a+' '+b});
  f.handler(async()=>({...empty(),oportunidades:[{resumo:'Preparar proposta Aurora',trecho:a,confianca:.95}],vinculos:[{tipo:'projeto',nome:'Aurora',trecho:a,confianca:.95}],compromissos:[{tipo:'pendencia',resumo:'Preparar relatório interno',trecho:b,prazo_citado:'amanhã',confianca:.95}]}));
  await f.org.passo();const service=experience(f),actions=f.db.prepare('SELECT id,trecho FROM lume_acoes WHERE evento_id=?').all(id);
  const commercial=service.obter('acao:'+actions.find(x=>x.trecho===a).id).itens[0],internal=service.obter('acao:'+actions.find(x=>x.trecho===b).id).itens[0];
  assert.equal(commercial.categoria,'comercial');assert.ok(commercial.projetoId);assert.notEqual(internal.categoria,'comercial');assert.equal(internal.projetoId,null);
});

test('Lume1 integration review: existing MCP pending contract includes current organizer actions within explicit MCP scope',async t=>{
  const f=fixture(t),id=f.add();f.handler(async()=>answer({compromissos:projectAnswer().compromissos}));await f.org.passo();
  const core=createLumeMcpCore({db:f.db,agora:()=>new Date('2026-10-26T15:00:00Z'),secret:Buffer.alloc(32,9),authorize:async()=>({enabled:true,revoked:false,revision:'synthetic-review',scope:{kind:'conversations',ids:[DM]}})});
  const context={clientId:'synthetic-client',credential:'synthetic-only'};
  const response=await core.executar('lume_listar_pendencias',{},context);
  assert.equal(response.ok,true);assert.ok(response.items.some(i=>i.summary==='Preparar relatório'),'new durable action must be available to the already authorized MCP read contract');
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);
  const revoked=await core.executar('lume_listar_pendencias',{},context);assert.equal(revoked.ok,true);assert.equal(revoked.items.length,0);
});

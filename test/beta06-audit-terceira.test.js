// Revisão independente de Resolver/Jev. Banco/ativação/dados sintéticos isolados.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {ExecucoesLume,CONTEXTO_TTL_MS} from '../src/execucao/servico.js';
import {createLumeMcpCore} from '../src/mcp/core.js';
import {applyClaudeActivation,revokeClaudeActivation,getClaudeActivationRevision,readClaudeActivationForClient} from '../src/mcp/activation.js';
import {VendasJev} from '../src/vendas/servico.js';
import {Backup} from '../src/backup.js';
import {Privacidade} from '../src/privacidade.js';
import {criarServidor} from '../src/painel/servidor.js';

const inicio='2026-09-25T20:00:00.000Z',conversa='audit-cliente@g.us';
const credencial='credencial-exclusivamente-sintetica-da-auditoria';
const resposta=()=>({origem:'jev',temperatura:'morno',etapa:'proposta',confianca:.8,confianca_etapa:.8,
  criterio:'Avaliação sintética.',criterio_etapa:'Sem aceite no recorte.',modelo:'typesafe/jev-1.13'});
const tick=()=>new Promise(r=>setImmediate(r));
function ambiente(t){
  const dir=mkdtempSync(join(tmpdir(),'lume-audit-wave03-')),path=join(dir,'test.db'),activationPath=join(dir,'activation.json');
  const f={dir,path,activationPath,now:new Date(inicio)};
  t.after(async()=>{
    if(f.server){f.server.closeAllConnections();await new Promise(r=>f.server.close(r));}
    f.db?.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});
  });
  applyClaudeActivation({activationPath,scope:{kind:'today',date:'2026-09-25'},credential:credencial});
  f.revision=()=>getClaudeActivationRevision({activationPath});
  function abrir(){
    f.db=abrirBanco(path);f.contexto=new ContextoApp(f.db);f.desktop=new Desktop(f.db);new DesktopIA(f.db);
    f.acoes=new AcoesLume(f.db,{agora:()=>f.now});
    f.svc=new ExecucoesLume(f.db,{agora:()=>f.now,revisaoConector:id=>id==='claude-desktop'?f.revision():null});
    const grant=readClaudeActivationForClient({activationPath,clientId:'claude-desktop',credential:credencial});
    assert.ok(grant,'A fixture precisa da ativação sintética autorizada');
    f.core=createLumeMcpCore({db:f.db,execucoes:f.svc,agora:()=>f.now,secret:grant.secret,
      authorize:async({clientId,credential})=>{
        const value=readClaudeActivationForClient({activationPath,clientId,credential});
        return value?{enabled:true,scope:value.scope,revision:value.revision}:{enabled:false,revoked:f.revision()===null};
      }});
  }
  abrir();
  f.add=(texto='Preparar relatório sintético para amanhã.',{chat=conversa,permissao='minha',shared=false,acao=true}={})=>{
    f.db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(chat,'Cliente fictício de auditoria');
    const id=Number(f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
      VALUES(?,?,'entrada','texto','{}',?,'2026-09-25T19:00:00.000Z','2026-09-25',?,?)`).run(chat,randomUUID(),texto,permissao,permissao==='minha'?1:0).lastInsertRowid);
    const insertShared=()=>f.db.prepare(`INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em)
      VALUES(?,'audit-origem','audit-pacote','audit-projeto',?,?)`).run(id,inicio,inicio);
    if(shared){
      f.db.exec("INSERT OR IGNORE INTO f10_projetos VALUES('audit-projeto','Projeto sintético','2026-09-25');INSERT OR IGNORE INTO f10_origens VALUES('audit-origem','Pessoa fictícia','Máquina fictícia','chave pública fictícia')");
      insertShared();
    }
    if(acao){
      f.acoes.autorizar({conversa:chat,permitida:true});
      f.acoes.registrar({eventoId:id,candidatas:[{fonte:'E'+id,tipo:'pendencia',resumo:'Relatório sintético',trecho:texto,prazo_citado:''}]});
    }
    return {id,chat,insertShared,acao:acao?f.acoes.listar().find(a=>a.evento_id===id):null};
  };
  f.start=(fonte,keep=true)=>{
    const {contexto}=f.svc.preparar({acao_id:fonte.acao.id});
    return f.svc.iniciar({contexto_id:contexto.id,assistente:'claude',confirmar:true,chave_idempotencia:randomUUID(),...(keep===undefined?{}:{manter_contexto:keep})});
  };
  f.call=(nome,args)=>f.core.executar(nome,args,{clientId:'claude-desktop',credential:credencial});
  f.get=id=>f.call('lume_obter_contexto_execucao',{execucao_id:id});
  f.restart=()=>{f.db.close();abrir();};
  return f;
}
async function http(f,{avaliar=async()=>resposta(),segredos}={}){
  f.desktop.aceitar({nome:'Auditoria sintética',aceito:true,versao:VERSAO_TERMOS});f.desktop.configurarGuia({dispensado:true});
  f.server=criarServidor(f.db,{desktop:true,contexto:f.contexto,agoraIA:()=>f.now,
    mcp:{revisaoConector:id=>id==='claude-desktop'?f.revision():null,estado:()=>({clients:[]})},
    segredosJev:segredos??{estado:async()=>({disponivel:true,configurada:true}),ler:async()=>credencial},avaliarJev:avaliar});
  await new Promise(r=>f.server.listen(0,'127.0.0.1',r));
  f.origin=`http://127.0.0.1:${f.server.address().port}`;
  const {token}=await (await fetch(f.origin+'/api/sessao')).json();
  f.headers={'content-type':'application/json','x-assessor-token':token};
  f.post=(path,data,extra={})=>fetch(f.origin+'/api/v3/'+path,{method:'POST',headers:{...f.headers,...extra},body:JSON.stringify(data)});
}

test('AUDIT-R1: revogar/restaurar procedência F10 não reativa grant nem token após restart',async t=>{
  const f=ambiente(t),fonte=f.add(undefined,{permissao:'terceiro',shared:true}),r=f.start(fonte),id=r.execucao.id;
  const before=await f.get(id);assert.equal(before.ok,true);
  f.db.prepare('DELETE FROM f10_procedencias WHERE evento_id=?').run(fonte.id);
  assert.equal((await f.get(id)).ok,false,'Revogação sem restauro deve bloquear');
  fonte.insertShared();f.restart();
  assert.equal((await f.get(id)).ok,false,'Grant de uma fonte revogada não pode ressuscitar com o restauro da procedência');
  assert.equal((await f.call('lume_abrir_fonte',{source_id:before.contexto.fontes[0].source_id})).ok,false);
});

test('AUDIT-R2: epoch do conector real, fonte exata, consultas genéricas e prazo são independentes',async t=>{
  const f=ambiente(t),fonte=f.add(),outside=f.add('MARCADOR_FORA_DO_CONTEXTO',{chat:'outra-auditoria@g.us'});
  const keep=f.start(fonte),legacy=f.start(fonte,false);
  f.now=new Date('2026-09-26T20:00:00.000Z');f.restart();
  const valid=await f.get(keep.execucao.id);assert.equal(valid.ok,true);
  assert.doesNotMatch(JSON.stringify(valid),/MARCADOR_FORA_DO_CONTEXTO|credencial-exclusivamente|token_secret/);
  assert.equal((await f.get(legacy.execucao.id)).ok,false);
  assert.deepEqual((await f.call('lume_buscar_contexto',{question:'relatório',start:'2026-09-25T00:00:00Z',end:'2026-09-27T00:00:00Z'})).items,[]);
  const auth=await f.core.autenticar({clientId:'claude-desktop',credential:credencial}),other=f.svc.read.fonte(outside.id,{kind:'all'});
  const forged=f.core.tokens.criar('src',{id:other._id,hash:other._hash,offset:0,scope:auth.digest,execucao:keep.execucao.id},null);
  assert.equal((await f.call('lume_abrir_fonte',{source_id:forged})).ok,false);
  assert.equal(readClaudeActivationForClient({activationPath:f.activationPath,clientId:'claude-desktop',credential:'codigo-sintetico-invalido'}),null);
  await assert.rejects(f.core.autenticar({clientId:'claude-desktop',credential:'codigo-sintetico-invalido'}),{code:'NOT_ENABLED'});
  const originalRevision=f.revision();revokeClaudeActivation({activationPath:f.activationPath});
  assert.equal(readClaudeActivationForClient({activationPath:f.activationPath,clientId:'claude-desktop',credential:credencial}),null);
  await assert.rejects(f.core.autenticar({clientId:'claude-desktop',credential:credencial}),{code:'SCOPE_REVOKED'});
  applyClaudeActivation({activationPath:f.activationPath,scope:{kind:'today',date:'2026-09-25'},credential:credencial});
  assert.notEqual(f.revision(),originalRevision);f.restart();assert.equal((await f.get(keep.execucao.id)).ok,false);
  const fresh=f.start(fonte);f.now=new Date(Date.parse(fresh.execucao.contexto_expira_em)-1);assert.equal((await f.get(fresh.execucao.id)).ok,true);
  f.now=new Date(f.now.getTime()+1);assert.equal((await f.get(fresh.execucao.id)).error.code,'EXECUTION_CONTEXT_EXPIRED');
  assert.equal(Date.parse(fresh.execucao.contexto_expira_em)-Date.parse(fresh.execucao.autorizada_em),CONTEXTO_TTL_MS);
});

test('AUDIT-R3: ABA de fonte, Organizar e política invalidam grants de modo durável',async t=>{
  for(const mode of ['fonte','organizar','politica'])await t.test(mode,async t=>{
    const f=ambiente(t),fonte=f.add(),r=f.start(fonte);
    if(mode==='fonte'){
      const old=f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(fonte.id).texto;
      f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto temporário sintético',fonte.id);
      f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(old,fonte.id);
    }else if(mode==='organizar'){
      f.acoes.autorizar({conversa:fonte.chat,permitida:false});f.acoes.autorizar({conversa:fonte.chat,permitida:true});
    }else{
      f.db.prepare("INSERT INTO politicas_conversa VALUES(?,'tudo',?)").run(fonte.chat,inicio);
      f.db.prepare('DELETE FROM politicas_conversa WHERE conversa_id=?').run(fonte.chat);
    }
    f.restart();assert.equal((await f.get(r.execucao.id)).ok,false);
  });
});

test('AUDIT-J1: cofre/adaptador atrasados com ABA de fonte não enviam nem persistem indevidamente',async t=>{
  for(const phase of ['cofre','adaptador'])await t.test(phase,async t=>{
    const f=ambiente(t),fonte=f.add(),omitted=f.add('MARCADOR_OMITIDO',{acao:false});
    let release,calls=0,received,signal;
    const wait=new Promise(r=>release=r);
    const j=new VendasJev(f.db,{agora:()=>f.now,segredos:{ler:async()=>{if(phase==='cofre')await wait;return credencial;}},
      avaliar:async args=>{calls++;received=args.fontes;signal=args.signal;if(phase==='adaptador')await wait;return resposta();}});
    const p=j.preparar({conversa_id:fonte.chat,fonte_ids:[fonte.id]});const pending=j.avaliar({previa_id:p.id,confirmar:true});
    const rejected=assert.rejects(pending,{code:'JEV_FONTE_ALTERADA'});await tick();
    f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(fonte.id);
    f.db.prepare("UPDATE eventos SET permissao='minha' WHERE id=?").run(fonte.id);
    release();await rejected;assert.equal(calls,phase==='cofre'?0:1);
    if(received){assert.deepEqual(received.map(x=>x.id),[fonte.id]);assert.ok(!received.some(x=>x.id===omitted.id));assert.ok(signal);}
    assert.equal(f.db.prepare('SELECT count(*) n FROM lume_vendas_avaliacoes').get().n,0);
  });
});

test('AUDIT-J2: cancelamento, erro e restart consomem prévia; importação não restaura grants/avaliação atual',async t=>{
  const f=ambiente(t),fonte=f.add(),run=f.start(fonte),j=new VendasJev(f.db,{agora:()=>f.now,segredos:{ler:async()=>credencial},avaliar:async()=>resposta()});
  const p=j.preparar({conversa_id:fonte.chat,fonte_ids:[fonte.id]});await j.avaliar({previa_id:p.id,confirmar:true});
  const waiting=j.preparar({conversa_id:fonte.chat});j.invalidar();await assert.rejects(j.avaliar({previa_id:waiting.id,confirmar:true}));
  const old=j.preparar({conversa_id:fonte.chat});f.restart();
  const next=new VendasJev(f.db,{agora:()=>f.now,segredos:{ler:async()=>credencial},avaliar:async()=>{throw Error('Falha sintética do provedor');}});
  await assert.rejects(next.avaliar({previa_id:old.id,confirmar:true}),{code:'JEV_FONTE_ALTERADA'});
  const errorPreview=next.preparar({conversa_id:fonte.chat});await assert.rejects(next.avaliar({previa_id:errorPreview.id,confirmar:true}),/Falha sintética/);
  await assert.rejects(next.avaliar({previa_id:errorPreview.id,confirmar:true}),{code:'JEV_FONTE_ALTERADA'});
  assert.equal(next.obter({conversa_id:fonte.chat}).desatualizada,false);
  const backup=new Backup(f.db),raw=backup.capturar();backup.validar(raw);
  assert.equal(Object.hasOwn(raw.tabelas,'lume_execucao_contexto_grants'),false);
  assert.equal(Object.hasOwn(raw.tabelas,'lume_vendas_revisoes'),false);
  assert.doesNotMatch(JSON.stringify(raw),/credencial-exclusivamente|credential_hash|token_secret/);
  const pack=await backup.criar({senha:'senha-apenas-sintetica',confirmar:true});
  const dest=ambiente(t),restore=new Backup(dest.db),preview=await restore.preparar({arquivo:JSON.stringify(pack.pacote),senha:'senha-apenas-sintetica'});
  restore.restaurar({id:preview.id,confirmarMeuBackup:true});
  assert.equal(dest.db.prepare('SELECT count(*) n FROM lume_execucao_contexto_grants').get().n,0);
  assert.equal((await dest.get(run.execucao.id)).ok,false);
  const imported=new VendasJev(dest.db).obter({conversa_id:fonte.chat});
  assert.ok(imported===null||imported.desatualizada===true);
  const privacy=new Privacidade(f.db);assert.doesNotThrow(()=>privacy.schemaConhecido());
});

test('AUDIT-H1: HTTP real exige sessão/origin/campos, seleção exata e consentimento booleano',async t=>{
  const f=ambiente(t),first=f.add(),omit=f.add('MARCADOR_PRIVADO_OMITIDO',{acao:false});let sent=[];
  await http(f,{avaliar:async({fontes})=>{sent.push(structuredClone(fontes));return resposta();}});
  const path='/api/v3/vendas/preparar',body={conversa_id:first.chat,fonte_ids:[first.id]};
  assert.equal((await fetch(f.origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,403);
  assert.equal((await f.post('vendas/preparar',body,{origin:'https://externo.invalid'})).status,403);
  assert.equal((await f.post('vendas/preparar',{...body,extra:true})).status,400);
  assert.equal((await f.post('vendas/preparar',{...body,fonte_ids:[]})).status,400);
  const p=await (await f.post('vendas/preparar',body)).json();assert.deepEqual(p.previa.fonte_ids,[first.id]);
  assert.equal((await f.post('vendas/avaliar',{previa_id:p.previa.id,confirmar:'true'})).status,400);assert.equal(sent.length,0);
  const result=await (await f.post('vendas/avaliar',{previa_id:p.previa.id,confirmar:true})).json();
  assert.deepEqual(sent[0].map(x=>x.id),[first.id]);assert.ok(!sent[0].some(x=>x.id===omit.id));
  assert.doesNotMatch(JSON.stringify(result),/MARCADOR_PRIVADO_OMITIDO|credencial-exclusivamente|token_secret/);
  const c=await (await f.post('execucoes/contexto',{acao_id:first.acao.id})).json();
  assert.equal((await f.post('execucoes/iniciar',{contexto_id:c.contexto.id,assistente:'claude',confirmar:true,chave_idempotencia:randomUUID(),manter_contexto:'true'})).status,400);
  const run=await (await f.post('execucoes/iniciar',{contexto_id:c.contexto.id,assistente:'claude',confirmar:true,chave_idempotencia:randomUUID()})).json();
  assert.equal(run.execucao.manter_contexto,false);
});

test('AUDIT-J3: exportação pessoal não reapresenta avaliação de contexto obsoleto como atual',async t=>{
  const f=ambiente(t),fonte=f.add(),j=new VendasJev(f.db,{agora:()=>f.now,segredos:{ler:async()=>credencial},avaliar:async()=>resposta()});
  const p=j.preparar({conversa_id:fonte.chat,fonte_ids:[fonte.id]});await j.avaliar({previa_id:p.id,confirmar:true});
  f.add('Correção sintética: a proposta foi cancelada.',{acao:false});
  assert.equal(j.obter({conversa_id:fonte.chat}).desatualizada,true);
  const ids=f.db.prepare('SELECT id FROM eventos').all().map(x=>x.id);
  const exported=new Privacidade(f.db).dadosCiclo(ids,{exportacao:true,conversa:fonte.chat});
  const rows=exported.lume_vendas_avaliacoes;
  assert.ok(rows.length===0||rows.every(row=>JSON.parse(row.resultado).desatualizada===true),
    'Avaliação ocultada como obsoleta no serviço não deve sair com desatualizada:false na exportação');
});

test('AUDIT-UI: grant invalidado é explicado na tela e respostas Jev antigas não atravessam navegação',{
  skip:process.env.LUME_AUDIT_TERCEIRA_UI!=='1'?'requer LUME_AUDIT_TERCEIRA_UI=1 para navegador local isolado':false,timeout:60000
},async t=>{
  const {chromium}=await import('playwright');
  const f=ambiente(t),fonte=f.add(),out=resolve('work/beta06-audit-terceira');mkdirSync(out,{recursive:true});
  const omitted=f.add('Assunto sintético excluído do recorte.',{acao:false});
  const correction=f.add('Correção: ainda não aceitei a proposta.',{acao:false});
  const sent=[];await http(f,{avaliar:async({fontes})=>{sent.push(structuredClone(fontes));return resposta();}});const r=f.start(fonte);
  const original=f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(fonte.id).texto;
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto temporariamente alterado',fonte.id);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(original,fonte.id);
  const invalidated=f.svc.obter({id:r.execucao.id}).execucao;
  assert.equal(invalidated.contexto_prazo_estado,'invalidado');
  assert.equal(invalidated.contexto_invalidado,true);
  assert.equal((await f.get(r.execucao.id)).ok,false);
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:950},reducedMotion:'reduce'}),errors=[],external=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{if(!route.request().url().startsWith(f.origin)){external.push(route.request().url());return route.abort();}return route.continue();});
    await page.goto(f.origin+'/app');await page.locator('#clarity-content:not([hidden])').waitFor();
    await page.evaluate(action=>window.abrirResolverLume(action),fonte.acao);
    const text=await page.locator('#resolver-dialog').innerText();
    for(const width of [390,1440]){
      await page.setViewportSize({width,height:950});await page.screenshot({path:join(out,`resolver-invalidado-${width}.png`)});
      assert.equal(await page.locator('#resolver-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);
    }
    await page.keyboard.press('Escape');
    let release,requested;const waiting=new Promise(r=>requested=r);
    await page.route('**/api/v3/vendas/preparar',async route=>{requested();await new Promise(r=>release=r);await route.continue();});
    await page.evaluate(chat=>window.abrirAvaliacaoVenda(chat,'Cliente fictício'),fonte.chat);
    await page.getByRole('button',{name:'Conferir recorte para avaliar com Jev',exact:true}).click();await waiting;
    await page.keyboard.press('Escape');release();
    await page.waitForLoadState('networkidle');assert.equal(await page.locator('#sales-dialog').isVisible(),false);
    assert.equal(await page.locator('#sales-dialog .sales-selection-form').count(),0);
    await page.unroute('**/api/v3/vendas/preparar');
    await page.evaluate(chat=>window.abrirAvaliacaoVenda(chat,'Cliente fictício'),fonte.chat);
    await page.getByRole('button',{name:'Conferir recorte para avaliar com Jev',exact:true}).click();
    await page.getByRole('checkbox',{name:`Incluir mensagem E${omitted.id}`,exact:true}).uncheck();
    for(const width of [390,1440]){
      await page.setViewportSize({width,height:950});await page.screenshot({path:join(out,`jev-selecao-${width}.png`)});
      assert.equal(await page.locator('#sales-dialog').evaluate(n=>n.scrollWidth>n.clientWidth),false);
    }
    await page.getByRole('button',{name:'Conferir seleção',exact:true}).click();await page.locator('#sales-consent').waitFor();
    assert.equal(await page.locator('#sales-consent').isChecked(),false);
    assert.equal(await page.locator('.sales-preview-sources article').count(),2);
    assert.doesNotMatch(await page.locator('.sales-preview-sources').innerText(),/Assunto sintético excluído/);
    assert.match(await page.locator('.sales-preview-sources').innerText(),/ainda não aceitei/);
    for(const width of [390,1440]){await page.setViewportSize({width,height:950});await page.screenshot({path:join(out,`jev-confirmacao-${width}.png`)});}
    await page.locator('#sales-consent').check();
    let resumeSend,started;const pendingSend=new Promise(r=>started=r);
    await page.route('**/api/v3/vendas/avaliar',async route=>{started();await new Promise(r=>resumeSend=r);await route.continue();});
    await page.getByRole('button',{name:'Enviar este recorte ao Jev'}).click();await pendingSend;
    await page.keyboard.press('Escape');resumeSend();await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#sales-dialog').isVisible(),false);assert.equal(await page.locator('#sales-dialog').innerHTML(),'');
    assert.equal(sent.length,1);assert.deepEqual(sent[0].map(x=>x.id),[fonte.id,correction.id]);
    writeFileSync(join(out,'evidence.json'),JSON.stringify({createdAt:new Date().toISOString(),synthetic:true,text,errors,external,
      staleResponseHidden:true,lateEvaluationHidden:true,selected:sent[0].map(x=>x.id),excluded:omitted.id,uncheckedConsent:true,widths:[390,1440]},null,2));
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    assert.doesNotMatch(text,/fica acessível até/,'A UI não deve prometer acesso quando o grant está revogado');
    assert.match(text,/revogad|invalid|mudou/i);
  }finally{await browser.close();}
});

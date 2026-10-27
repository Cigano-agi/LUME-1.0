// Synthetic persistence cycle across two Node processes; never invokes a provider or native executor.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {ExecucoesLume} from '../src/execucao/servico.js';
import {criarServidor} from '../src/painel/servidor.js';
import {test} from 'node:test';

const file=fileURLToPath(import.meta.url);
const resultText='Retorno sintético informado manualmente; nenhuma execução nativa foi feita.';

function runStage(stage,root){
  const child=spawnSync(process.execPath,[file],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,LUME_CYCLE_STAGE:stage,LUME_CYCLE_ROOT:root}});
  assert.equal(child.status,0,`${stage} process failed (pid ${child.pid})\n${child.stdout}\n${child.stderr}`);
  return JSON.parse(readFileSync(join(root,`${stage}.json`),'utf8'));
}

async function prepare(root){
  assert.notEqual(process.env.LUME_CYCLE_STAGE,'inspect');
  const dbPath=join(root,'profile.sqlite'),db=abrirBanco(dbPath);
  try{
    const {desktop,fontes}=perfilBeta05(db);desktop.configurarGuia({dispensado:true});
    const actions=new AcoesLume(db);actions.autorizar({conversa:fontes.ana.conversa,permitida:true});
    actions.registrar({eventoId:fontes.ana.id,candidatas:[{fonte:`E${fontes.ana.id}`,tipo:'compromisso',resumo:'Confirmar data da minuta fictícia',trecho:'Nossa reunião de revisão ficou para 24/09 às 10h.',prazo_citado:''}]});
    const action=db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(fontes.ana.id);
    actions.revisar({id:action.id,acao:'confirmar'});
    const service=new ExecucoesLume(db),preview=service.preparar({acao_id:action.id});
    assert.equal(preview.contexto.projeto,undefined,'cenário inicial não seleciona projeto');
    const pending=service.iniciar({contexto_id:preview.contexto.id,assistente:'hermes',confirmar:true,chave_idempotencia:'nota7-synthetic-start'});
    assert.equal(pending.execucao.estado,'aguardando_assistente');
    service.registrar('resultado',{execucao_id:pending.execucao.id,chave_idempotencia:'nota7-synthetic-result',resumo:resultText,artefatos:[]});
    assert.equal(service.obter({id:pending.execucao.id}).execucao.verificacao,'nao_verificado');
    service.registrar('verificacao',{execucao_id:pending.execucao.id,chave_idempotencia:'nota7-synthetic-check',confirmar:true,nota:'Conferi somente o registro sintético local.'});
    const execution=pending.execucao.id;
    assert.equal(db.prepare('SELECT estado FROM lume_execucoes WHERE id=?').get(execution).estado,'verificado');
    assert.equal(db.prepare('SELECT evento_id FROM lume_acoes WHERE id=?').get(action.id).evento_id,fontes.ana.id);
    writeFileSync(join(root,'prepare.json'),JSON.stringify({pid:process.pid,action:action.id,execution,source:preview.contexto.fontes[0].id,event:fontes.ana.id,result:resultText}));
  }finally{db.close();}
}

async function inspect(root){
  const info=JSON.parse(readFileSync(join(root,'prepare.json'),'utf8'));
  assert.notEqual(process.pid,info.pid,'persistência deve ser reaberta por outro processo Node');
  const db=abrirBanco(join(root,'profile.sqlite'));
  let server,browser,page;const external=[];
  const evidence=resolve('work/nota7-cycle-restart');mkdirSync(evidence,{recursive:true});
  try{
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    const service=new ExecucoesLume(db),recovered=service.obter({id:info.execution});
    assert.equal(recovered.execucao.id,info.execution);
    assert.equal(recovered.execucao.estado,'verificado');
    assert.equal(recovered.execucao.verificacao,'verificado_pelo_usuario');
    assert.equal(recovered.contexto.fontes[0].id,info.source);
    assert.equal(recovered.execucao.timeline.find(e=>e.tipo==='resultado').resumo,info.result);
    const restartedContext=new ContextoApp(db);
    server=criarServidor(db,{contexto:restartedContext,desktop:true});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const origin=`http://127.0.0.1:${server.address().port}`;
    browser=await chromium.launch({channel:'msedge',headless:true});
    page=await browser.newPage({viewport:{width:390,height:950},reducedMotion:'reduce'});
    let sessionToken;
    page.on('request',async request=>{if(!request.url().startsWith(origin))external.push(request.url());else sessionToken??=(await request.allHeaders())['x-assessor-token'];});
    await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.goto(origin+'/app');
    await page.locator('#acoes06-filter').selectOption('ativos');
    await page.locator('#acoes06-list .acoes06-card').first().waitFor();

    // Verify API projection after reopening the on-disk database before asserting UI state.
    const api=async path=>{const response=await fetch(origin+path,{headers:{'x-assessor-token':sessionToken}});assert.equal(response.status,200,`${path} must be available in desktop mode`);return response.json();};
    const actions=await api('/api/v3/acoes?estado=ativos&limite=100');
    const action=actions.acoes.find(item=>item.id===info.action);
    assert.ok(action,'authorized synthetic action must remain visible in API list');
    assert.deepEqual({state:action.execucao_ui.estado,id:action.execucao_ui.id},{state:'verificado',id:info.execution});
    const detail=await api('/api/v3/execucoes/item?id='+encodeURIComponent(info.execution));
    assert.equal(detail.execucao.id,info.execution);
    assert.equal(detail.contexto.fontes[0].id,info.source);
    assert.equal(detail.execucao.timeline.find(event=>event.tipo==='resultado').resumo,info.result);
    const apiTimeline=detail.execucao.timeline.map(event=>event.id);

    assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n,1,'reabrir a UI não pode duplicar uma execução');

    const state=page.locator('#acoes06-list .acoes06-cycle-state').filter({hasText:'Resultado verificado'});
    await state.waitFor({timeout:10000});
    await page.screenshot({path:join(evidence,'verified-card-390.png'),fullPage:true});
    const reopen=state.locator('..').getByRole('button',{name:/Abrir resultado verificado|Ver resultado verificado/});
    // RED must identify only the missing accessible reopen control, not setup or timeout.
    assert.equal(await reopen.count(),1,'cartão verificado deve oferecer botão acessível para reabrir o resultado');
    await reopen.click();
    await page.locator('.resolver-timeline').getByText(info.result,{exact:true}).waitFor();
    assert.equal(await page.locator('.resolver-id').innerText(),`Execução ${info.execution}`);
    const uiResultId=await page.locator('.resolver-timeline li[data-kind="resultado"]').count();
    assert.equal(uiResultId,1,'timeline reaberta deve conter uma ocorrência do resultado persistido');
    const uiKinds=await page.locator('.resolver-timeline li').evaluateAll(items=>items.map(item=>item.dataset.kind));
    assert.deepEqual(uiKinds,['acao','autorizacao','resultado','verificacao']);
    assert.deepEqual(apiTimeline.map(id=>Number.isSafeInteger(id)),apiTimeline.map(()=>true));
    assert.equal(external.length,0,'nenhuma requisição externa');
    await page.screenshot({path:join(evidence,'verified-reopened-390.png'),fullPage:true});
    writeFileSync(join(root,'inspect.json'),JSON.stringify({pid:process.pid,apiAction:action.id,execution:detail.execucao.id,source:detail.contexto.fontes[0].id,timeline:apiTimeline,uiKinds}));
  }finally{
    if(page)await page.close();if(browser)await browser.close();
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    db.close();
  }
}

if(process.env.LUME_CYCLE_STAGE==='prepare')await prepare(process.env.LUME_CYCLE_ROOT);
else if(process.env.LUME_CYCLE_STAGE==='inspect')await inspect(process.env.LUME_CYCLE_ROOT);
else test('nota 7: cartão verificado e timeline persistem após reinício real do processo',async()=>{
  const root=mkdtempSync(join(tmpdir(),'lume-nota7-cycle-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir())),'SQLite deve ficar dentro do diretório temporário');
  try{
    const first=runStage('prepare',root);
    assert.ok(Number.isSafeInteger(first.pid));
    const second=runStage('inspect',root);
    assert.notEqual(first.pid,second.pid,'os dois processos Node precisam ter PIDs diferentes');
  }finally{rmSync(root,{recursive:true,force:true});}
});

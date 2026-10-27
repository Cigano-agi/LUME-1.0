// Renderer/HTTP reais; somente dados fictícios em banco isolado, sem provedor.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {AcoesLume} from '../src/acoes-lume.js';
import {criarServidor} from '../src/painel/servidor.js';

const output='work/beta06-resolver-recovery';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const checks=[],errors=[],external=[];
try{
  for(const width of [390,1440]){
    const db=abrirBanco(':memory:'),{contexto,desktop,fontes}=perfilBeta05(db,{agora:new Date()});
    desktop.configurarGuia({dispensado:true});
    const actions=new AcoesLume(db);actions.autorizar({conversa:'demo-ana',permitida:true});
    actions.registrar({eventoId:fontes.ana.id,candidatas:[{fonte:'E'+fontes.ana.id,tipo:'compromisso',resumo:'Preparar pauta de revisão',trecho:'Nossa reunião de revisão ficou para 24/09 às 10h.',prazo_citado:''}]});
    actions.revisar({id:db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(fontes.ana.id).id,acao:'confirmar'});
    const server=criarServidor(db,{contexto,desktop:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const origin=`http://127.0.0.1:${server.address().port}`,page=await browser.newPage({viewport:{width,height:950},reducedMotion:'reduce'});
    page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
    try{
      await page.goto(origin+'/app');await page.locator('#luminus-body .resolver-open').click();
      await page.locator('#resolver-consent').check();await page.getByRole('button',{name:'Autorizar contexto →'}).click();
      await page.locator('.resolver-manual summary').click();
      const summary=page.locator('.resolver-manual textarea[name=resumo]'),files=page.locator('.resolver-manual textarea[name=artefatos]');
      const submit=page.getByRole('button',{name:'Guardar resultado informado',exact:true});
      const draft='Preparei a pauta fictícia com os pontos para revisão; ainda precisa ser conferida.';
      const tooMany=Array.from({length:11},(_,i)=>`arquivo-${i}.md`).join('\n');
      await summary.fill(draft);await files.fill(tooMany);await submit.click();
      await page.getByText('Use até 10 referências, com no máximo 500 caracteres cada.',{exact:true}).waitFor();
      assert.equal(await summary.count(),1,'erro de validação não deve destruir o formulário');
      assert.equal(await summary.inputValue(),draft);assert.equal(await files.inputValue(),tooMany);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='resultado'").get().n,0);
      checks.push(`${width}: validação local preserva resumo e referências`);

      await files.fill('pauta-ficticia.md');
      const url='**/api/v3/execucoes/resultado';
      const unavailable=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({erro:'Falha temporária de teste.',codigo:'INTERNAL_ERROR'})});
      await page.route(url,unavailable);await submit.click();
      await page.locator('.resolver-manual [role=alert]').getByText(/Falha temporária/).waitFor();
      assert.equal(await summary.inputValue(),draft);assert.equal(await files.inputValue(),'pauta-ficticia.md');assert.equal(await submit.isEnabled(),true);
      assert.equal(await page.locator('#resolver-dialog').evaluate(e=>e.scrollWidth>e.clientWidth),false);
      await page.screenshot({path:`${output}/resultado-preservado-${width}.png`});
      await page.unroute(url,unavailable);checks.push(`${width}: 503 mantém rascunho e permite tentar novamente`);

      // Resposta perdida DEPOIS de salvar: repetir a mesma requisição não duplica.
      const lost=async route=>{await route.fetch();await route.abort('failed');};
      await page.route(url,lost);await submit.click();
      await page.locator('.resolver-manual [role=alert]').getByText('Não foi possível confirmar o salvamento.',{exact:true}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('.resolver-manual button[type=submit]').disabled);
      assert.equal(await summary.inputValue(),draft);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='resultado'").get().n,1);
      await page.unroute(url,lost);await submit.click();await page.locator('#resolver-verification-note').waitFor();
      assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='resultado'").get().n,1);
      checks.push(`${width}: resposta perdida e retry preservam um único resultado`);

      const note=page.locator('#resolver-verification-note'),verify=page.getByRole('button',{name:'Confirmar resultado verificado',exact:true});
      await note.fill('Conferi a pauta fictícia e as referências.');
      const verifyUrl='**/api/v3/execucoes/verificar';await page.route(verifyUrl,unavailable);await verify.click();
      await page.locator('.resolver-verify [role=alert]').waitFor({state:'visible'});
      assert.equal(await note.inputValue(),'Conferi a pauta fictícia e as referências.');assert.equal(await verify.isEnabled(),true);
      await page.unroute(verifyUrl,unavailable);checks.push(`${width}: conferência preservada após falha`);

      if(width===1440){
        await verify.click();await page.locator('.resolver-state[data-state=verificado]').waitFor();
        assert.equal(db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='verificacao'").get().n,1);
        checks.push(`${width}: repetir conferência após 503 salva uma única verificação`);
      }
      // Se a fonte muda, é obrigatório retirar o contexto antigo da tela.
      db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte fictícia alterada.',fontes.ana.id);
      if(width===390)await verify.click();else await page.getByRole('button',{name:'Atualizar andamento',exact:true}).click();
      await page.locator('.resolver-heading .eyebrow').filter({hasText:'CONTEXTO INDISPONÍVEL'}).waitFor();
      assert.equal(await page.locator('#resolver-verification-note,.resolver-sources,.resolver-timeline').count(),0);
      checks.push(`${width}: fonte alterada limpa contexto e rascunho sensível`);
      await page.screenshot({path:`${output}/fonte-alterada-${width}.png`});
    }finally{await page.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const evidence={at:new Date().toISOString(),synthetic:true,passed:true,checks,errors,external};
  writeFileSync(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();}

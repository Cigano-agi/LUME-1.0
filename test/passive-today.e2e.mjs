// Passive Today contract with real local HTTP and synthetic data only.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilHoje} from './fixtures/hoje-profile.js';

const db=abrirBanco(),{contexto,adicionar}=perfilHoje(db);
for(const [tipo,texto] of [
  ['compromisso','Confirmar a revisão da proposta'],
  ['lead','Retomar a conversa sobre orçamento'],
  ['pendencia','Conferir os dados do contrato'],
  ['decisao','Registrar a condição aprovada'],
  ['pendencia','Enviar o documento combinado']
])adicionar({tipo,texto});

let connection={estado:'conectada',qr:null};
const server=criarServidor(db,{contexto,desktop:true,conexao:{estado:()=>connection,iniciar:async()=>{},parar:async()=>{}},gerarIA:async()=>{throw Error('Provider forbidden');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`,out='work/passive-today-qa';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});

try{
  const page=await browser.newPage({viewport:{width:1320,height:950},reducedMotion:'reduce'}),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url())&&!request.url().startsWith(origin))external.push(request.url());});
  await page.goto(origin+'/app');
  await page.locator('#owner').fill('Pessoa de teste');await page.locator('#consent').check();
  await page.getByRole('button',{name:'Preparar meu espaço'}).click();await page.locator('#skip').click();
  await page.locator('#first-actions').click();await page.locator('#first-use').waitFor({state:'hidden'});

  const session=await page.request.get(origin+'/api/sessao'),token=(await session.json()).token;
  const expected=await (await page.request.get(origin+'/api/v3/resumo?ordem=compromissos&pagina=1',{headers:{'X-Assessor-Token':token}})).json();
  await page.locator('#stat-messages').filter({hasText:String(expected.mensagens)}).waitFor();
  assert.equal(await page.locator('#stat-today').innerText(),String(expected.hoje));
  assert.equal(await page.locator('#stat-actions').innerText(),String(expected.fila.total));
  assert.equal(await page.locator('#stat-conversations').innerText(),String(expected.conversas));
  assert.equal(await page.locator('#tasks .task-action:visible').count(),3);
  assert.equal(await page.locator('#focus-home').isVisible(),false);
  assert.equal(await page.locator('.task-options').getAttribute('open'),null);
  assert.equal(await page.locator('#today .home-snapshot canvas,#today .home-snapshot svg').count(),0);
  assert.doesNotMatch(await page.locator('#today').innerText(),/Se quiser conferir algo|O que você quer fazer primeiro/);
  assert.equal(await page.locator('#home-status').getAttribute('data-state'),'connected');
  assert.match(await page.locator('#home-status-title').innerText(),/acompanhando/i);
  const statusBox=await page.locator('#home-status').boundingBox(),snapshotBox=await page.locator('.home-snapshot').boundingBox();
  assert.ok(statusBox&&snapshotBox&&statusBox.y<snapshotBox.y,'connection status must come before activity');

  for(const state of [
    {estado:'reconectando',expected:'Conectando ao WhatsApp',tone:'working'},
    {estado:'desconectada',expected:'WhatsApp não conectado',tone:'off'},
    {estado:'erro',expected:'A conexão precisa de atenção',tone:'error'}
  ]){
    connection={estado:state.estado,qr:null};await page.evaluate(()=>status());
    assert.equal(await page.locator('#home-status-title').innerText(),state.expected);
    assert.equal(await page.locator('#home-status').getAttribute('data-state'),state.tone);
  }
  connection={estado:'conectada',qr:null};await page.evaluate(()=>status());

  for(const width of [390,820,1320]){
    await page.setViewportSize({width,height:950});await page.evaluate(()=>scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.ok((await page.locator('#tasks .task-action:visible').count())<=3);
    await page.screenshot({path:`${out}/today-${width}.png`,fullPage:true});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  writeFileSync(`${out}/evidence.json`,JSON.stringify({synthetic:true,metrics:{mensagens:expected.mensagens,hoje:expected.hoje,fila:expected.fila.total,conversas:expected.conversas},checks:['status before activity','real endpoint metrics','at most three actions','no chart without series','connection states are distinct','filter closed below content','390/820/1320 without overflow'],errors,external},null,2));
  console.log('PASSIVE_TODAY_UI_OK');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));db.close();}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { criarHandlerCentral } from '../api/central.js';
import {codificarCursorFeedback,TAMANHO_PAGINA_FEEDBACK} from '../src/feedback-paginacao.js';

const ADMIN = 'segredo-administrativo-sintetico-123456789';
const PEPPER = 'pepper-sintetico-independente-1234567890';
const VERSION = '3.2.0-beta.3';
const now = Date.now();
const installations = [
  {
    id: '20e7ca5e-c59d-4f34-af0e-f51962fa2541', rotulo: 'Guilherme Windows', plataforma: 'win32', arquitetura: 'x64',
    canal: 'beta', versao: VERSION, estadoAtualizacao: 'em_dia', codigoErro: null, whatsappEstado: 'conectado',
    criadoEm: new Date(now - 86400000).toISOString(), ultimoContatoEm: new Date(now - 60000).toISOString(), ultimoPulsoEm:new Date(now-60000).toISOString(),revogadoEm: null
  },
  {
    id: 'c688d0ec-02a5-4e93-a394-09686289f95f', rotulo: 'Diogo Mac', plataforma: 'darwin', arquitetura: 'arm64',
    canal: 'beta', versao: '3.1.0-beta.1', estadoAtualizacao: 'em_dia', codigoErro: null, whatsappEstado: 'pareando',
    criadoEm: new Date(now - 86400000).toISOString(), ultimoContatoEm: new Date(now - 60000).toISOString(), ultimoPulsoEm:new Date(now-60000).toISOString(),revogadoEm: null
  },
  {
    id: '85b6fe9a-64d0-42f8-930a-102d1267ccdf', rotulo: 'Rafael Mac sem contato', plataforma: 'darwin', arquitetura: 'x64',
    canal: 'beta', versao: VERSION, estadoAtualizacao: 'em_dia', codigoErro: null, whatsappEstado: 'nao_informado',
    criadoEm: new Date(now - 4 * 86400000).toISOString(), ultimoContatoEm: new Date(now - 3 * 86400000).toISOString(), ultimoPulsoEm:new Date(now-3*86400000).toISOString(),revogadoEm: null
  },
  {id:'dc7ed628-b9df-4faf-a1e4-15f213d529ab',rotulo:'Tester só feedback',plataforma:'win32',arquitetura:'x64',canal:'beta',versao:VERSION,estadoAtualizacao:'em_dia',codigoErro:null,whatsappEstado:'nao_informado',criadoEm:new Date(now-60000).toISOString(),ultimoContatoEm:new Date(now-60000).toISOString(),ultimoPulsoEm:null,revogadoEm:null}
];
const forbiddenValues = [
  'mensagem privada da conversa', '5511999999999@s.whatsapp.net', '5511999999999',
  'C:\\Users\\Pessoa\\segredo', 'Error: stack privada', ADMIN, PEPPER
];
const feedbacks=[
  {id:'c1651b65-1f95-49d7-9fa2-e08c904826ba',instalacaoId:installations[0].id,rotulo:'Guilherme Windows',categoria:'erro',etapa:'conexao',relato:'O QR ficou parado depois da leitura.',utilidade:'parcial',contatoAutorizado:true,versao:VERSION,plataforma:'win32',estado:'novo',severidade:'alta',criadoEm:new Date(now-3600000).toISOString(),atualizadoEm:new Date(now-3600000).toISOString()},
  {id:'4231e9e4-1751-4ecd-a883-17d3765616f1',instalacaoId:installations[1].id,rotulo:'Diogo Mac',categoria:'ideia',etapa:'hoje',relato:'<img src=x onerror="window.feedbackInvadido=true"> Quero buscar por pessoa.',utilidade:'util',contatoAutorizado:false,versao:'3.1.0-beta.1',plataforma:'darwin',estado:'em_analise',severidade:'baixa',criadoEm:new Date(now-7200000).toISOString(),atualizadoEm:new Date(now-7200000).toISOString()}
];
const assets = new Map([
  ['/central', ['central/site/index.html', 'text/html; charset=utf-8']],
  ['/central/', ['central/site/index.html', 'text/html; charset=utf-8']],
  ['/central/central.js', ['central/site/central.js', 'text/javascript; charset=utf-8']],
  ['/central/central.css', ['central/site/central.css', 'text/css; charset=utf-8']]
]);
const actions = new Map([
  ['/api/v1/admin/sessao', 'sessao'],
  ['/api/v1/admin/instalacoes', 'listar'],
  ['/api/v1/admin/feedback','listar-feedback']
]);

let origin = '', handler, listPayload;
const repository = {
  async listarInstalacoes() { return structuredClone(installations); },
  async listarFeedback(filtros){
    const all=feedbacks.filter(item=>!item.excluidoEm),versoes=[...new Set(all.map(item=>item.versao))].sort().reverse();
    const filtered=all.filter(item=>['etapa','severidade','estado','versao','plataforma'].every(key=>!filtros[key]||item[key]===filtros[key])).sort((a,b)=>b.criadoEm.localeCompare(a.criadoEm)||b.id.localeCompare(a.id));
    const rows=filtered.filter(item=>!filtros.cursor||item.criadoEm<filtros.cursor.em||item.criadoEm===filtros.cursor.em&&item.id<filtros.cursor.id).slice(0,TAMANHO_PAGINA_FEEDBACK+1);
    const itens=structuredClone(rows.slice(0,TAMANHO_PAGINA_FEEDBACK));
    return {itens,total:filtered.length,tamanhoPagina:TAMANHO_PAGINA_FEEDBACK,versoes,proximoCursor:rows.length>TAMANHO_PAGINA_FEEDBACK?codificarCursorFeedback(itens.at(-1)):null};
  },
  async revisarFeedback(id,estado,severidade,agora){const item=feedbacks.find(row=>row.id===id&&!row.excluidoEm);if(!item)return null;Object.assign(item,{estado,severidade,atualizadoEm:agora});return item;},
  async excluirFeedback(id,agora){const item=feedbacks.find(row=>row.id===id&&!row.excluidoEm);if(!item)return false;item.relato='[excluído]';item.excluidoEm=agora;return true;}
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin || 'http://localhost');
  const asset = assets.get(url.pathname);
  if (asset) {
    response.setHeader('Content-Type', asset[1]); response.end(readFileSync(asset[0])); return;
  }
  const match=/^\/api\/v1\/admin\/feedback\/([0-9a-f-]{36})\/(revisar|excluir)$/.exec(url.pathname);
  const action = actions.get(url.pathname)||(match?(match[2]==='revisar'?'revisar-feedback':'excluir-feedback'):null);
  if (!action) { response.statusCode = 404; response.end(); return; }
  let raw = '';
  for await (const chunk of request) raw += chunk;
  let body;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  const adaptedRequest = { method: request.method, headers: request.headers, body, query: { action,...Object.fromEntries(url.searchParams), ...(match?{id:match[1]}:{}) } };
  const adaptedResponse = {
    setHeader: (name, value) => response.setHeader(name, value),
    status(code) { response.statusCode = code; return this; },
    json(value) {
      if (action === 'listar' && response.statusCode === 200) listPayload = structuredClone(value);
      response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(value)); return this;
    }
  };
  await handler(adaptedRequest, adaptedResponse);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://localhost:${server.address().port}`;
handler = criarHandlerCentral({
  env: {
    NODE_ENV: 'test', DATABASE_URL: 'postgresql://local.invalid/lume', LUME_ADMIN_SECRET: ADMIN,
    LUME_TOKEN_PEPPER: PEPPER, LUME_BETA_VERSION: VERSION, LUME_PUBLIC_ORIGIN: origin, LUME_RETENTION_DAYS: '90'
  },
  criarRepositorio: () => repository
});

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
const errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort(); }
  return route.continue();
});

try {
  await page.goto(origin + '/central');
  assert.equal((await page.request.get(origin+'/api/v1/admin/feedback')).status(),401);
  assert.equal(await page.locator('#feedback-rows').textContent(),'');
  await page.locator('#senha').fill(ADMIN);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('#dashboard').waitFor({ state: 'visible' });
  mkdirSync('work/feedback06-central-qa',{recursive:true});
  await page.locator('.stats').screenshot({path:'work/feedback06-central-qa/estados-1100.png'});

  assert.equal(await page.locator('#rows tr').count(), 4);
  assert.equal(await page.locator('#active').textContent(), '1');
  assert.equal(await page.locator('#old').textContent(), '1');
  assert.equal(await page.locator('#silent').textContent(), '1');
  assert.equal(await page.locator('#feedback-only').textContent(),'1');
  assert.match(await page.locator('#rows').textContent(), /Guilherme Windows.*Windows · x64.*Pulso recente/s);
  assert.match(await page.locator('#rows').textContent(), /Diogo Mac.*macOS · arm64.*Desatualizado/s);
  assert.match(await page.locator('#rows').textContent(), /Rafael Mac sem contato.*macOS · x64.*Sem pulso recente/s);
  assert.match(await page.locator('#rows').textContent(),/Tester só feedback.*Somente feedback/s);
  await page.setViewportSize({width:390,height:900});
  await page.locator('.stats').screenshot({path:'work/feedback06-central-qa/estados-390.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1100,height:900});
  await page.locator('#feedback-rows article').first().waitFor();
  assert.equal(await page.locator('#feedback-rows article').count(),2);
  assert.match(await page.locator('#feedback-rows').textContent(),/Pode contatar pelo convite/);
  assert.match(await page.locator('#feedback-rows').textContent(),/Sem autorização para contato/);
  assert.equal(await page.evaluate(()=>window.feedbackInvadido),undefined);
  assert.match(await page.locator('#feedback-rows').textContent(),/<img src=x onerror=/);

  await page.locator('#feedback-severity').selectOption('alta');
  await page.locator('#feedback-total').filter({hasText:'1'}).waitFor();
  assert.equal(await page.locator('#feedback-rows article').count(),1);
  assert.match(await page.locator('#feedback-rows').textContent(),/Guilherme Windows/);
  await page.locator('#feedback-severity').selectOption('');
  await page.locator('#feedback-total').filter({hasText:'2'}).waitFor();
  await page.locator('#feedback-version').selectOption('3.1.0-beta.1');
  await page.locator('#feedback-total').filter({hasText:'1'}).waitFor();
  assert.equal(await page.locator('#feedback-rows article').count(),1);
  await page.locator('#feedback-version').selectOption('');
  await page.locator('#feedback-total').filter({hasText:'2'}).waitFor();
  const first=page.locator('#feedback-rows article').first();
  await first.getByLabel('Estado do feedback').selectOption('em_analise');
  await first.getByLabel('Prioridade do feedback').selectOption('media');
  await first.getByRole('button',{name:'Salvar triagem'}).click();
  await page.locator('#feedback-status').filter({hasText:'Triagem salva.'}).waitFor();
  assert.deepEqual([feedbacks[0].estado,feedbacks[0].severidade],['em_analise','media']);
  mkdirSync('work/feedback06-central-qa',{recursive:true});
  await page.locator('.feedback-panel').screenshot({path:'work/feedback06-central-qa/central-1100.png'});
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#feedback-export').click();
  const download=await downloadPromise;assert.match(download.suggestedFilename(),/^lume-feedback-\d{4}-\d\d-\d\d\.json$/);
  await download.saveAs('work/feedback06-central-qa/export.json');
  await first.getByLabel('Confirmar exclusão deste feedback').check();
  await first.getByRole('button',{name:'Excluir relato'}).click();
  await page.locator('#feedback-total').filter({hasText:'1'}).waitFor();
  assert.equal(feedbacks[0].relato,'[excluído]');
  await page.setViewportSize({width:390,height:850});
  await page.locator('.feedback-panel').screenshot({path:'work/feedback06-central-qa/central-390.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  for(let i=0;i<54;i++)feedbacks.push({id:`00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`,instalacaoId:installations[0].id,rotulo:`Tester ${i}`,categoria:'ideia',etapa:'hoje',relato:`Sugestão ${i}`,utilidade:null,contatoAutorizado:false,versao:VERSION,plataforma:'win32',estado:'novo',severidade:'media',criadoEm:new Date(now-10800000-i*1000).toISOString(),atualizadoEm:new Date(now-10800000-i*1000).toISOString()});
  await page.locator('#refresh').click();
  await page.locator('#feedback-total').filter({hasText:'55'}).waitFor();
  assert.equal(await page.locator('#feedback-rows article').count(),20);
  await page.locator('#feedback-next').click();
  await page.locator('#feedback-page-label').filter({hasText:'Página 2'}).waitFor();
  assert.equal(await page.locator('#feedback-rows article').count(),20);
  await page.locator('#feedback-next').click();
  await page.locator('#feedback-page-label').filter({hasText:'Página 3'}).waitFor();
  assert.equal(await page.locator('#feedback-rows article').count(),15);
  assert.equal(await page.locator('#feedback-next').isDisabled(),true);
  await page.locator('#feedback-prev').click();
  await page.locator('#feedback-page-label').filter({hasText:'Página 2'}).waitFor();
  await page.locator('#feedback-prev').click();
  await page.locator('#feedback-page-label').filter({hasText:'Página 1'}).waitFor();
  await page.locator('#feedback-platform').selectOption('darwin');
  await page.locator('#feedback-total').filter({hasText:'1'}).waitFor();
  assert.equal(await page.locator('#feedback-rows article').count(),1);
  await page.locator('#feedback-platform').selectOption('');
  await page.locator('#feedback-total').filter({hasText:'55'}).waitFor();
  const allDownload=page.waitForEvent('download');await page.locator('#feedback-export').click();
  const allFile=await allDownload;await allFile.saveAs('work/feedback06-central-qa/export-paginado.json');
  assert.equal(JSON.parse(readFileSync('work/feedback06-central-qa/export-paginado.json','utf8')).itens.length,55);
  await page.locator('.feedback-panel').screenshot({path:'work/feedback06-central-qa/central-paginada-390.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);

  assert.ok(listPayload);
  assert.deepEqual(listPayload.instalacoes.map(item => item.estado), ['ativo', 'desatualizado', 'sem_contato','apenas_feedback']);
  for (const item of listPayload.instalacoes) {
    assert.deepEqual(Object.keys(item).sort(), ['arquitetura','canal','codigoErro','criadoEm','estado','estadoAtualizacao','id','plataforma','revogadoEm','rotulo','ultimoContatoEm','ultimoPulsoEm','versao','whatsappEstado'].sort());
  }
  const observable = JSON.stringify(listPayload) + '\n' + await page.locator('body').textContent();
  for (const value of forbiddenValues) assert.equal(observable.includes(value), false, `valor privado exposto: ${value}`);

  await page.locator('#filter').selectOption('desatualizado');
  assert.equal(await page.locator('#rows tr').count(), 1); assert.match(await page.locator('#rows').textContent(), /Diogo Mac/);
  await page.locator('#filter').selectOption('sem_contato');
  assert.equal(await page.locator('#rows tr').count(), 1); assert.match(await page.locator('#rows').textContent(), /Rafael Mac sem contato/);
  await page.locator('#filter').selectOption('apenas_feedback');
  assert.equal(await page.locator('#rows tr').count(),1);assert.match(await page.locator('#rows').textContent(),/Tester só feedback/);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: true, installations: 4, feedback: 2, triage: true, delete: true, export: true, widths:[390,1100], forbiddenValuesAbsent: true }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

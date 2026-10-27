// Isolated Edge + in-memory server. Every organization item below is synthetic.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';

const output = fileURLToPath(new URL('../work/pessoal-qa-20261026/organizacao-ui/', import.meta.url));
await mkdir(output, {recursive: true});
const db = abrirBanco(':memory:');
const server = criarServidor(db, {desktop: true, conexao: {estado: () => ({estado: 'desconectada', qr: null}), iniciar: async () => {}, parar: async () => {}}});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({channel: 'msedge', headless: true});
const context = await browser.newContext({viewport: {width: 1280, height: 1000}, reducedMotion: 'no-preference'});
const page = await context.newPage(); page.setDefaultTimeout(10000);
const errors = [], calls = [], proofs = [], held = [];
page.on('pageerror', error => errors.push(error.message));
const demand = (index, group, extra = {}) => ({
  acaoId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, conversaId: `dm:synthetic-${index}`, eventoId: index,
  conversaNome: ['Ágata Oficina', 'Bruno Estúdio', 'Clara Design'][index - 1] || 'Pessoa sintética',
  resumo: ['Preparar proposta da oficina', 'Conferir o material recebido', 'Organizar novo site'][index - 1],
  tipo: 'pendencia', estado: 'sugerido', grupo: group,
  fonte: {eventoId: index, conversaId: `dm:synthetic-${index}`, trecho: ['Pode preparar a proposta da oficina?', 'Confira o material recebido, por favor.', 'Precisamos organizar o projeto do novo site.'][index - 1], assinatura: 'synthetic-current'},
  avaliacao: {origem: 'jev', somenteSugestao: true, assunto: {valor: group === 'comercial' ? 'comercial' : 'projeto', confianca: .8}, andamento: {valor: 'planejado', confianca: .7}},
  incerteza: ['continuidade_incerta'], projeto: null, ...extra,
});
const initial = {
  comercial: [demand(1, 'comercial')],
  tarefas: [demand(2, 'tarefas', {avaliacao: null, incerteza: ['classificacao_indisponivel']})],
  projetos: [demand(3, 'projetos', {projeto: {id: 'synthetic-project', nome: 'Novo site', natureza: 'incerto', estado: 'rascunho', acordoVerificado: false}})],
  candidatos: [], truncada: false,
};
let data = structuredClone(initial), mode = 'ok';
const groupCalls = () => calls.filter(call => call.path === '/api/v3/pessoal/organizacao');
const filter = name => page.locator('#pessoal-organizacao-filtros').getByRole('button', {name, exact: true});
const projection = page.locator('#pessoal-organizacao');
const status = page.locator('#pessoal-organizacao-status');
const waitText = (selector, text) => page.waitForFunction(({selector, text}) => document.querySelector(selector)?.textContent.includes(text), {selector, text});
const respond = (route, value) => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
const waitHeld = async () => { for (let i = 0; !held.length && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 25)); assert(held.length, 'Expected held organization request'); };
await context.route('**/pessoal-organizacao.js', async route => route.fulfill({status: 200, contentType: 'application/javascript', body: `
  window.organizacaoProof = [];
  window.abrirFonteTarefa = async id => window.organizacaoProof.push(['fonte', id]);
  window.abrirAvaliacaoVenda = async (...args) => window.organizacaoProof.push(['avaliacao', ...args]);
  window.abrirAcaoDoAviso = async id => window.organizacaoProof.push(['acao', id]);
  ${await readFile(new URL('../src/painel/pessoal-organizacao.js', import.meta.url), 'utf8')}`}));
await context.route('**/api/v3/pessoal/organizacao', async route => {
  calls.push({path: '/api/v3/pessoal/organizacao', method: route.request().method()});
  if (mode === 'hold') { held.push(route); return; }
  if (mode === 'error') return route.fulfill({status: 503, contentType: 'application/json', body: JSON.stringify({erro: 'Indisponível'})});
  return respond(route, data);
});
try {
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Pessoa sintética'); await page.locator('#consent').check();
  await page.getByRole('button', {name: 'Preparar meu espaço'}).click();
  await page.locator('#skip').click(); await page.locator('#first-hide').click();
  // Source/review actions are spies: no account, real conversation or mutation.
  await page.evaluate(() => {
    window.organizacaoOriginalList = document.getElementById('acoes06-list');
    window.organizacaoOriginalPagination = document.getElementById('acoes06-pagination');
  });
  if (!await page.locator('#pessoal-organizacao-filtros').count()) await page.addScriptTag({url: origin + '/pessoal-organizacao.js'});
  await page.locator('#acoes06').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.carregarAcoes06());
  assert.equal(groupCalls().length, 0, 'Todas never fetches the projection');
  assert.equal(await projection.isVisible(), false);
  assert.equal(await page.evaluate(() => window.organizacaoOriginalList === document.getElementById('acoes06-list')), true);
  proofs.push('Lazy: Todas e atualizações da lista original não fazem GET de organização.');

  await filter('Comercial').click(); await waitText('#pessoal-organizacao', 'Ágata Oficina');
  assert.equal(await page.locator('#acoes06-list').isVisible(), false);
  assert.equal(await page.locator('#acoes06-pagination').isVisible(), false);
  assert.equal(await filter('Comercial').getAttribute('aria-pressed'), 'true');
  assert.equal(await filter('Comercial').textContent(), '✓ Comercial');
  assert.equal(await projection.locator('article').count(), 1);
  await projection.getByRole('button', {name: 'Ver fonte', exact: true}).click();
  await projection.getByRole('button', {name: 'Conferir classificação'}).click();
  assert.deepEqual(await page.evaluate(() => window.organizacaoProof), [['fonte', 1], ['avaliacao', 'dm:synthetic-1', 'Preparar proposta da oficina']]);
  await filter('Tarefas').focus(); await page.keyboard.press('Enter');
  await waitText('#pessoal-organizacao', 'Classificação indisponível');
  assert.equal(await projection.locator('article').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.grupo), 'tarefas');
  assert.equal(groupCalls().length, 1, 'Changing groups reuses a current projection');
  await filter('Projetos').click(); await waitText('#pessoal-organizacao', 'Rascunho de projeto');
  assert.match(await projection.innerText(), /Natureza do projeto ainda incerta/);
  assert.doesNotMatch(await projection.innerText(), /Jev ativado|%|synthetic-project|dm:synthetic/);
  assert.equal(await projection.getByRole('button', {name: /confirmar projeto|promover/i}).count(), 0);
  proofs.push('Três grupos, nomes legíveis, rascunho incerto, tarefa sem classificador, fonte exata e revisão existente; sem promoção automática.');

  await projection.getByRole('button', {name: 'Abrir ação', exact: true}).click();
  assert.equal(await filter('Todas').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#acoes06-list').isVisible(), true);
  assert.deepEqual((await page.evaluate(() => window.organizacaoProof)).at(-1), ['acao', initial.projetos[0].acaoId]);
  await filter('Tarefas').click();
  await page.locator('#acoes06-view-board').click();
  assert.equal(await filter('Todas').getAttribute('aria-pressed'), 'true');
  await page.locator('#acoes06-view-list').click();
  assert.equal(await page.evaluate(() => window.organizacaoOriginalPagination === document.getElementById('acoes06-pagination')), true);
  proofs.push('Abrir ação retorna a Todas; Lista/Quadro e paginação preservam os nós e controles originais.');

  await filter('Comercial').click();
  const beforeThrottle = groupCalls().length;
  await page.evaluate(async () => { await window.carregarAcoes06(); await window.carregarAcoes06(); });
  assert.equal(groupCalls().length, beforeThrottle, 'Existing refreshes are throttled for 30s');
  await page.locator('#feedback').waitFor({state: 'hidden'});
  await page.clock.install();
  await page.evaluate(() => { document.getElementById('today').hidden = true; });
  await page.clock.fastForward(31000);
  await page.evaluate(() => window.carregarAcoes06());
  assert.equal(groupCalls().length, beforeThrottle, 'Hidden section never refreshes groups');
  // The server has revoked the source signature: no old card may survive refresh.
  data.comercial = [];
  await page.evaluate(() => { document.getElementById('today').hidden = false; });
  await waitText('#pessoal-organizacao-status', 'Nenhuma ação');
  assert.equal(await projection.locator('article').count(), 0);
  assert.equal(groupCalls().length, beforeThrottle + 1);
  proofs.push('GET limitado a uma consulta por 30s nas atualizações; fonte revogada removida após revalidação do servidor.');

  // Clear must invalidate even a helper that resolves after cancellation.
  await page.evaluate(() => {
    window.limparDadosVisiveis(); window.originalOrganizationRequest = window.lumeConnectionRequest;
    window.lateOrganization = [];
    window.lumeConnectionRequest = (path, body, options) => path.endsWith('/organizacao') ? new Promise(resolve => { window.lateOrganization.push({resolve, signal: options.signal}); }) : window.originalOrganizationRequest(path, body, options);
  });
  await filter('Comercial').click(); await page.waitForFunction(() => window.lateOrganization.length === 1);
  await filter('Tarefas').click();
  assert.equal(await page.evaluate(() => window.lateOrganization[0].signal.aborted), true);
  await page.evaluate(value => { window.lateOrganization[0].resolve(value); }, initial);
  assert.equal(await projection.locator('article').count(), 0, 'Old group response discarded');
  await page.evaluate(value => { window.lateOrganization[1].resolve(value); }, initial);
  await waitText('#pessoal-organizacao', 'Classificação indisponível');
  assert.equal(await projection.locator('article').count(), 1);
  await page.evaluate(() => window.limparDadosVisiveis());
  await filter('Projetos').click();
  await page.evaluate(value => { window.limparDadosVisiveis(); window.lateOrganization[2].resolve(value); window.lumeConnectionRequest = window.originalOrganizationRequest; }, initial);
  assert.equal(await projection.isVisible(), false);
  assert.doesNotMatch(await projection.textContent(), /Clara|Novo site/);
  mode = 'hold'; await filter('Comercial').click(); await page.waitForFunction(() => document.getElementById('pessoal-organizacao').getAttribute('aria-busy') === 'true');
  await waitHeld();
  await page.evaluate(() => window.limparDadosVisiveis());
  await respond(held.shift(), initial);
  assert.equal(await projection.isVisible(), false);
  assert.equal(await projection.textContent().then(text => text.includes('Ágata')), false);
  assert.equal(await filter('Todas').getAttribute('aria-pressed'), 'true');
  proofs.push('Troca de filtro cancela consulta; reset de privacidade limpa conteúdo e invalida resposta atrasada.');

  await filter('Tarefas').click();
  await waitHeld();
  const beforeTimeout = groupCalls().length;
  await page.clock.fastForward(15001);
  await waitText('#pessoal-organizacao-status', 'demorou');
  assert.equal(await projection.getByRole('button', {name: 'Tentar novamente'}).isVisible(), true);
  assert.equal(groupCalls().length, beforeTimeout, 'No retry on timeout');
  await respond(held.shift(), data);
  mode = 'error'; await projection.getByRole('button', {name: 'Tentar novamente'}).click();
  await waitText('#pessoal-organizacao-status', 'Não foi possível');
  mode = 'ok'; data = structuredClone(initial);
  await projection.getByRole('button', {name: 'Tentar novamente'}).click(); await waitText('#pessoal-organizacao', 'Bruno Estúdio');
  proofs.push('Timeout finito de 15s, falha legível, recuperação explícita e nenhuma repetição automática/POST.');

  // Inert private strings: no content is interpreted as HTML or an identifier.
  await page.evaluate(() => window.limparDadosVisiveis());
  data.tarefas[0].resumo = '<img src=x onerror=window.organizationXss=1>';
  data.tarefas[0].conversaNome = '<svg onload=window.organizationXss=2>';
  data.tarefas[0].fonte.trecho = '<script>window.organizationXss=3</script>';
  await filter('Tarefas').click(); await waitText('#pessoal-organizacao', '<img');
  assert.equal(await page.evaluate(() => window.organizationXss), undefined);
  assert.equal(await projection.locator('img,svg,script,[style]').count(), 0);
  assert.equal(await projection.locator('h3').last().textContent(), data.tarefas[0].resumo);
  proofs.push('Nome, resumo e fonte XSS permanecem texto; nenhuma interpolação HTML/estilo inline.');

  await page.evaluate(() => window.limparDadosVisiveis());
  data.tarefas[0].fonte.trecho = 'https://example.invalid/' + 'conteudo'.repeat(80);
  data.truncada = true;
  await page.setViewportSize({width: 390, height: 844});
  await filter('Tarefas').click(); await waitText('#pessoal-organizacao', 'example.invalid');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Long literal source wraps at 390px');
  assert.match(await status.textContent(), /Recorte de até 100 ações/);
  proofs.push('Literal sem espaços permanece dentro de 390px; recorte truncado informa o limite de 100 e o caminho Todas.');
  await page.setViewportSize({width: 1280, height: 1000});

  await page.evaluate(() => window.limparDadosVisiveis()); data = structuredClone(initial);
  await filter('Projetos').click(); await waitText('#pessoal-organizacao', 'Clara Design');
  await page.clock.resume(); await page.waitForTimeout(450);
  await page.locator('#acoes06').scrollIntoViewIfNeeded();
  await page.screenshot({path: output + '/01-projeto-desktop.png'});
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#acoes06').scrollIntoViewIfNeeded();
  const controls = await page.locator('#pessoal-organizacao-filtros button, #pessoal-organizacao button:visible').evaluateAll(nodes => nodes.map(n => ({text: n.textContent, width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height})));
  assert(controls.every(c => c.width >= 43.5 && c.height >= 43.5), JSON.stringify(controls));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, '390px without horizontal overflow');
  await page.screenshot({path: output + '/02-projeto-390px.png'});
  await projection.getByRole('button', {name: 'Ver fonte'}).scrollIntoViewIfNeeded();
  await page.screenshot({path: output + '/03-fonte-390px.png'});
  await filter('Tarefas').click(); await page.waitForTimeout(450);
  await projection.locator('article').scrollIntoViewIfNeeded();
  await page.screenshot({path: output + '/04-tarefa-390px.png'});
  await page.emulateMedia({reducedMotion: 'reduce'});
  const motion = await projection.locator('article').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).animationName));
  assert(motion.every(name => name === 'none'), JSON.stringify(motion));
  proofs.push('Edge isolado: teclado, alvos de 44px, viewport 390px sem overflow, reduced-motion e capturas desktop/mobile.');
  assert(groupCalls().every(c => c.method === 'GET'));
  assert.deepEqual(errors, []);
  const receipt = {synthetic: true, nativeProfileQA: false, browser: 'msedge', proofs, calls: groupCalls(), controls, motion, errors};
  await writeFile(output + '/provas.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(proofs.join('\n'));
} finally {
  for (const route of held) await route.abort().catch(() => {});
  await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); db.close();
}

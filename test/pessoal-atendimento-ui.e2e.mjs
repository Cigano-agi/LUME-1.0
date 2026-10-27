// Isolated Chrome + real panel and in-memory server. All conversations and responses are synthetic.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';

const output = new URL('../work/pessoal-qa-20261026/atendimento-ui/', import.meta.url);
await mkdir(output, {recursive: true});
const db = abrirBanco();
const server = criarServidor(db, {desktop: true, conexao: {estado: () => ({estado: 'desconectada', qr: null}), iniciar: async () => {}, parar: async () => {}}});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1280, height: 1000}, reducedMotion: 'no-preference'});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [], calls = [], proofs = [], held = [];
page.on('pageerror', error => errors.push(error.message));
const attendance = overrides => ({excluida: false, ativadaEm: null, pausaAte: null, inicio: null, fim: null, fuso: 'America/Sao_Paulo', eventoApos: 987654, ...overrides});
const fixture = (i, nome, values = {}) => ({conversaId: `55000000000${i}@s.whatsapp.net`, nome, categoria: 'unknown', modo: 'observar', remoto: false, pausada: false, atendimento: attendance(), ...values});
const state = {enabled: true, autonomiaLiberada: false, chatgpt: {available: true, secureStorageAvailable: true, connected: true, planEnabled: true, model: 'fixture-model', account: {id: 'synthetic'}, accounts: [], verifiedAt: null}, conversas: [
  fixture(1, 'Ágata de teste'),
  fixture(2, 'Família de teste', {categoria: 'family'}),
  fixture(3, 'Pessoa em pausa', {categoria: 'vip_client', modo: 'atender', remoto: true, pausada: true, atendimento: attendance({ativadaEm: new Date().toISOString()})}),
  fixture(4, 'Pessoa excluída', {categoria: 'team', modo: 'atender', remoto: true, pausada: true, atendimento: attendance({excluida: true, ativadaEm: new Date().toISOString()})}),
  fixture(5, '<img src=x onerror=window.injected=true>'),
  fixture(6, 'Grupo de teste', {conversaId: '120000000001@g.us', categoria: 'team'})
]};
let failPath = '', holdPath = '', refreshFails = false;
let extraConversations = [], delayedSearch = null;
const count = (path, method = 'POST') => calls.filter(c => c.path === path && c.method === method).length;
const last = () => calls.filter(c => c.method === 'POST').at(-1);
const $ = id => page.locator('#pessoal-' + id);
const status = text => $('conversation-result').filter({hasText: text}).waitFor();
const idle = () => page.waitForFunction(() => document.querySelector('#pessoal-panel').getAttribute('aria-busy') !== 'true');
const select = async index => {await $('conversation').selectOption(state.conversas[index].conversaId);};
const row = index => $('conversation-list').locator('button').filter({has: page.getByText(state.conversas[index].nome, {exact: true})});
const refresh = async () => {await $('refresh').click(); await page.waitForFunction(() => !document.querySelector('#pessoal-refresh').disabled);};
await page.route('**/api/v3/pessoal{,/**}', async route => {
  const req = route.request(), path = new URL(req.url()).pathname;
  const body = req.method() === 'POST' ? req.postDataJSON() : undefined;
  calls.push({path, method: req.method(), body});
  if (holdPath === path) {await new Promise(resolve => held.push(resolve)); return route.fulfill({json: {erro: 'Resposta tardia sintética'}, status: 503}).catch(() => {});}
  if (failPath === path || (refreshFails && path === '/api/v3/pessoal')) return route.fulfill({status: 400, json: {erro: 'Ação não autorizada para esta conversa.'}});
  let result = state;
  if (path.endsWith('/conversas')) {
    const url = new URL(req.url()), query = url.searchParams.get('busca') || '', tipo = url.searchParams.get('tipo'), pagina = Number(url.searchParams.get('pagina'));
    const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
    const found = [...state.conversas, ...extraConversations].filter(c => (tipo === 'all' || (tipo === 'group') === c.conversaId.endsWith('@g.us')) && normalize(c.nome + ' ' + c.conversaId).includes(normalize(query))).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    result = {conversas: found.slice(pagina * 100, (pagina + 1) * 100), total: found.length, pagina, mais: (pagina + 1) * 100 < found.length};
    if (query === 'atrasada') await new Promise(resolve => delayedSearch = resolve);
  } else if (path.endsWith('/conversa')) {
    const c = [...state.conversas, ...extraConversations].find(c => c.conversaId === body.conversaId);
    Object.assign(c, {categoria: body.categoria, modo: body.modo, remoto: body.remoto});
    if (body.modo === 'pausado') c.pausada = true;
    result = c; // Production endpoint returns a rule, so UI must refetch state.
  } else if (path.endsWith('/atendimento')) {
    const c = [...state.conversas, ...extraConversations].find(c => c.conversaId === body.conversaId), a = c.atendimento;
    assert.ok(!c.conversaId.endsWith('@g.us'), 'No group mutation');
    if (['ativar', 'retomar'].includes(body.acao)) {
      assert.ok(['lead', 'vip_client', 'team'].includes(c.categoria) && c.remoto && !a.excluida);
      a.ativadaEm = new Date().toISOString();
    }
    if (body.acao === 'desativar') c.pausada = true;
    if (body.acao === 'pausar') a.pausaAte = new Date(Date.now() + body.minutos * 60000).toISOString();
    if (body.acao === 'retomar') {c.pausada = false; a.pausaAte = null; if (c.modo === 'pausado') c.modo = 'rascunhar';}
    if (body.acao === 'horario') {a.inicio = body.inicio; a.fim = body.fim;}
    if (body.acao === 'excluir') {a.excluida = true; c.pausada = true;}
    if (body.acao === 'incluir') a.excluida = false;
    result = c;
  }
  await route.fulfill({json: result}).catch(() => {});
});
// While the coordinator owns asset routing, this test serves exactly these local files.
for (const [name, contentType] of [['lume-identidade.css', 'text/css'], ['lume-icon.svg', 'image/svg+xml']]) {
  const body = await readFile(new URL('../src/painel/' + name, import.meta.url), 'utf8');
  await page.route('**/' + name, route => route.fulfill({body, contentType}));
}
try {
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Pessoa sintética'); await page.locator('#consent').check();
  await page.getByRole('button', {name: 'Preparar meu espaço'}).click();
  await page.locator('#skip').click(); await page.locator('#first-hide').click();
  await page.evaluate(() => window.abrirAjuste('pessoal-panel'));
  await $('conversation-list').locator('button').first().waitFor();
  if (!await page.locator('link[href="/lume-identidade.css"]').count()) await page.addStyleTag({url: origin + '/lume-identidade.css'});
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await $('conversation-list').locator('button').count(), 5);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  assert.doesNotMatch(await $('atendimento').textContent(), /987654|eventoApos/);
  await $('conversation-search').fill('agata');
  assert.equal(await $('conversation-list').locator('button').count(), 1);
  await row(0).focus(); await page.keyboard.press('Enter');
  assert.equal(await $('permissions').evaluate(e => e.open), true);
  assert.equal(await $('permissions-summary').evaluate(e => e === document.activeElement), true);
  await page.keyboard.press('Tab'); assert.equal(await $('conversation').evaluate(e => e === document.activeElement), true);
  assert.equal(await $('category').inputValue(), 'unknown'); assert.equal(await $('remote').isChecked(), false);
  assert.equal(await $('attendance-activate').isDisabled(), true);
  assert.equal(calls.filter(c => c.method === 'POST').length, 0);
  await $('conversation-search').fill('');
  proofs.push('Busca por nome sem acento, nome não vira HTML, teclado Enter/Tab e desconhecido sem ativação automática.');

  await $('conversation-kind').selectOption('group'); await select(5);
  assert.match(await $('selection-status').textContent(), /Só leitura/);
  assert.equal(await $('permissions').locator('button:visible').count(), 0, 'Group detail has no send, activation or mutation button');
  assert.equal(await $('mode').locator('[value=atender]').evaluate(e => e.disabled), true);
  await $('conversation-kind').selectOption('dm'); await select(1);
  assert.match(await $('selection-status').textContent(), /Família.*sem envio/);
  assert.equal(await $('attendance-activate').isDisabled(), true);
  assert.equal(await $('mode').locator('[value=atender]').evaluate(e => e.disabled), true);
  await select(3);
  assert.match(await $('selection-status').textContent(), /Excluída/);
  assert.equal(await $('attendance-controls').isVisible(), false);
  assert.equal(await $('save-conversation').isDisabled(), true);
  await $('attendance-exclusion').locator('summary').click();
  assert.equal(await $('attendance-include').isDisabled(), true);
  await $('inclusion-consent').check(); await $('attendance-include').click(); await status('Exclusão retirada');
  assert.equal(last().body.acao, 'incluir');
  assert.equal(state.conversas[3].pausada, true);
  assert.equal(await $('attendance-resume').isVisible(), true);
  assert.equal(await $('attendance-activate').isVisible(), false);
  proofs.push('Grupo só leitura sem botões; família sem atendimento; exclusão exige decisão explícita e mantém pausa.');

  await select(2);
  await $('save-conversation').click(); await status('A pausa manual continua');
  assert.equal(state.conversas[2].pausada, true);
  await $('attendance-schedule').locator('summary').click();
  await $('pause-duration').selectOption('120'); await $('attendance-pause').click(); await status('Pausa por tempo salva');
  assert.equal(last().body.minutos, 120); assert.equal(state.conversas[2].pausada, true);
  state.conversas[2].atendimento.pausaAte = new Date(Date.now() - 1000).toISOString(); await refresh();
  assert.match(await $('selection-status').textContent(), /Pausa manual/);
  await $('attendance-resume').click(); await status('Retomada explícita');
  assert.equal(state.conversas[2].pausada, false); assert.equal(state.conversas[2].atendimento.pausaAte, null);
  assert.equal(last().body.acao, 'retomar');
  assert.match(await $('selection-status').textContent(), /Preparar.*sem envio automático/);
  assert.match(await $('attendance-gate').textContent(), /100 casos.*20 críticos/);
  proofs.push('Salvar e pausa temporária não limpam pausa manual; retomar limpa ambas; autonomia fechada aparece como preparar.');

  await $('hours-enabled').check(); await $('hours-start').fill('23:00'); await $('hours-end').fill('06:00');
  await $('hours-save').click(); await status('Horário salvo');
  assert.deepEqual(last().body, {conversaId: state.conversas[2].conversaId, acao: 'horario', inicio: '23:00', fim: '06:00'});
  assert.equal(await $('hours-start').inputValue(), '23:00');
  await $('hours-end').fill('23:00'); const scheduleCount = count('/api/v3/pessoal/atendimento');
  await $('hours-save').click(); await status('início e um fim diferentes'); assert.equal(count('/api/v3/pessoal/atendimento'), scheduleCount);
  await $('hours-enabled').uncheck(); await $('hours-save').click(); await status('Horário salvo');
  assert.equal(last().body.inicio, null); assert.equal(last().body.fim, null);
  await $('attendance-stop').click(); await status('pausa manual'); assert.equal(state.conversas[2].pausada, true);
  proofs.push('Horário São Paulo atravessa meia-noite, rejeita intervalo vazio, desliga com nulos; desativar cria pausa manual.');

  await select(0); await $('category').selectOption('lead'); await $('mode').selectOption('atender'); await $('remote').check();
  const beforeFail = count('/api/v3/pessoal/atendimento'); failPath = '/api/v3/pessoal/conversa';
  await $('attendance-activate').click(); await status('Ação não autorizada'); await idle();
  assert.equal(count('/api/v3/pessoal/atendimento'), beforeFail, 'Failed consent cannot activate');
  assert.equal(await $('attendance-activate').isDisabled(), false);
  failPath = '/api/v3/pessoal/atendimento';
  await $('attendance-activate').click(); await status('Autorização salva, mas o atendimento não foi confirmado'); await idle();
  assert.equal(count('/api/v3/pessoal/atendimento'), beforeFail + 1);
  assert.equal(state.conversas[0].atendimento.ativadaEm, null);
  failPath = ''; refreshFails = true;
  await $('attendance-activate').click(); await status('Ação não autorizada'); await idle();
  assert.equal(count('/api/v3/pessoal/atendimento'), beforeFail + 1, 'Failed authoritative refresh prevents activation');
  refreshFails = false;
  await page.locator('#feedback').waitFor({state: 'hidden'});
  await page.clock.install(); holdPath = '/api/v3/pessoal/conversa';
  const beforeTimeout = count(holdPath);
  await $('attendance-activate').click();
  await page.waitForFunction(() => document.querySelector('#pessoal-panel').getAttribute('aria-busy') === 'true');
  await page.clock.fastForward(15001); await status('O estado não foi confirmado'); await idle();
  assert.equal(count(holdPath), beforeTimeout + 1);
  assert.equal(count('/api/v3/pessoal/atendimento'), beforeFail + 1);
  holdPath = ''; held.splice(0).forEach(resolve => resolve());
  await page.clock.resume();
  await $('attendance-activate').click(); await status('Ativação registrada'); await idle();
  assert.equal(state.conversas[0].categoria, 'lead'); assert.equal(state.conversas[0].remoto, true);
  assert.equal(last().body.acao, 'ativar');
  assert.match(await $('selection-status').textContent(), /Preparar/);
  await $('mode').selectOption('observar'); await $('save-conversation').click(); await status('A pausa manual continua');
  assert.equal(last().body.acao, 'desativar'); assert.equal(state.conversas[0].pausada, true);
  await $('mode').selectOption('atender'); await $('save-conversation').click(); await status('A pausa manual continua');
  assert.equal(await $('attendance-activate').isVisible(), false);
  await $('attendance-resume').click(); await status('Retomada explícita'); await idle();
  proofs.push('Ativação só após categoria e consentimento; falhas nas duas etapas e GET intermediário param a sequência; timeout 15s sem retry de POST.');

  extraConversations = Array.from({length: 105}, (_, i) => fixture(1000 + i, 'Pessoa de página ' + String(i).padStart(3, '0')));
  await $('conversation-search').fill('Pessoa de página');
  await $('conversation-count').filter({hasText: '100 de 105'}).waitFor();
  await $('conversation-more').click(); await $('conversation-count').filter({hasText: '105 de 105'}).waitFor();
  assert.equal(await $('conversation-more').isVisible(), false);
  const outside = extraConversations[104];
  await $('conversation').selectOption(outside.conversaId);
  await refresh(); assert.equal(await $('conversation').inputValue(), outside.conversaId, 'Selection outside initial state survives refresh');
  await $('category').selectOption('team'); await $('mode').selectOption('rascunhar'); await $('remote').check();
  await $('attendance-activate').click(); await status('Ativação registrada'); await idle();
  assert.equal(last().body.conversaId, outside.conversaId);
  assert.match(await $('selection-status').textContent(), /Preparar/);
  await $('conversation-search').fill('atrasada');
  for (let i = 0; i < 100 && !delayedSearch; i++) await page.waitForTimeout(10);
  assert.ok(delayedSearch, 'Slow search started');
  await $('conversation-search').fill('agata');
  await $('conversation-count').filter({hasText: '1 de 1'}).waitFor();
  delayedSearch(); delayedSearch = null; await page.waitForTimeout(100);
  assert.equal(await $('conversation-list').locator('button').count(), 1);
  assert.match(await $('conversation-list').textContent(), /Ágata/);
  await $('conversation-search').fill(''); extraConversations = [];
  await refresh(); await $('conversation-count').filter({hasText: '5 de 5'}).waitFor();
  await select(0);
  proofs.push('Busca paginada 100/105, carregar mais, seleção fora do estado inicial preservada ao salvar/ativar e resposta atrasada descartada.');

  await select(3);
  if (!await $('attendance-exclusion').evaluate(e => e.open)) await $('attendance-exclusion').locator('summary').click();
  await $('attendance-exclude').click(); await status('Pessoa excluída'); await idle();
  assert.equal(last().body.acao, 'excluir'); assert.equal(state.conversas[3].pausada, true);
  state.conversas[4].nome = 'Clara de teste'; // Injection already verified; clean synthetic names in deliverable screenshots.
  await refresh(); await select(0);

  // Readability, input targets, functional motion and non-looping mascot.
  await $('attendance-schedule').evaluate(e => e.open = false);
  await $('attendance-exclusion').evaluate(e => e.open = false);
  const durations = await $('attendance-stop').evaluate(e => getComputedStyle(e).transitionDuration.split(',').map(v => Number.parseFloat(v)));
  assert.ok(durations.every(d => d >= .22 && d <= .4), durations.join(','));
  await $('attendance-stop').hover(); await page.waitForTimeout(410);
  assert.equal(await $('attendance-stop').evaluate(e => e.getAnimations().filter(a => a.playState === 'running').length), 0);
  const mascot = await page.locator('.pessoal-lume-mark').evaluate(e => ({iterations: getComputedStyle(e).animationIterationCount, duration: getComputedStyle(e).animationDuration}));
  assert.equal(mascot.iterations, '1');
  const font = await $('atendimento-title').evaluate(e => getComputedStyle(e).fontFamily);
  assert.match(font, /Lume Humanista/);
  const small = await $('atendimento').locator('button:visible,input:not([type=checkbox]):visible,select:visible,summary:visible').evaluateAll(elements => elements.filter(e => e.getBoundingClientRect().height < 43.5).map(e => ({id: e.id, h: e.getBoundingClientRect().height})));
  assert.deepEqual(small, []);
  await $('permissions').evaluate(e => e.open = false);
  await page.locator('#feedback').waitFor({state: 'hidden'});
  await $('atendimento').screenshot({path: fileURLToPath(new URL('01-lista-desktop.png', output))});
  await page.setViewportSize({width: 390, height: 844});
  await $('atendimento').scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px no horizontal overflow');
  await $('atendimento-title').evaluate(e => window.scrollTo(0, window.scrollY + e.getBoundingClientRect().top - 90));
  await page.screenshot({path: fileURLToPath(new URL('02-lista-390px.png', output))});
  await row(2).click();
  await $('attendance-resume').scrollIntoViewIfNeeded();
  await page.screenshot({path: fileURLToPath(new URL('03-pausa-390px.png', output))});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Expanded 390px no horizontal overflow');
  await page.emulateMedia({reducedMotion: 'reduce'});
  const reduced = await $('atendimento').evaluate(e => [e, ...e.querySelectorAll('*')].every(n => getComputedStyle(n).animationName === 'none' && getComputedStyle(n).transitionDuration.split(',').every(v => Number.parseFloat(v) === 0)));
  assert.equal(reduced, true);
  await page.setViewportSize({width: 1280, height: 1000});
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await $('permissions').evaluate(e => e.open = false);
  await $('atendimento').screenshot({path: fileURLToPath(new URL('04-lista-escuro.png', output))});
  const contrasts = [];
  for (const theme of ['light', 'dark']) for (const contrast of ['no-preference', 'more']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.emulateMedia({contrast});
    const measured = await $('conversation-list').evaluate(list => {
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      return [...list.querySelectorAll('strong,.pessoal-conversation-state,.pessoal-conversation-relation')].map(e => {
        const fg = luminance(getComputedStyle(e).color), bg = luminance(getComputedStyle(e.closest('button')).backgroundColor);
        return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
      });
    });
    assert.ok(measured.every(ratio => ratio >= 4.5), `${theme}/${contrast}: ${Math.min(...measured)}`);
    contrasts.push({theme, contrast, minimum: Math.min(...measured)});
  }
  proofs.push('Tipografia local humanista, alvos 44px, transições 260ms concluídas em 400ms, mascote sem loop, reduced-motion e 390px sem overflow.');
  assert.deepEqual(errors, []);
  await writeFile(new URL('provas.json', output), JSON.stringify({synthetic: true, nativeQA: false, participants: false, proofs, calls, errors, durations, mascot, font, contrasts}, null, 2));
  console.log(proofs.join('\n'));
} finally {
  delayedSearch?.();
  held.splice(0).forEach(resolve => resolve());
  await page.unrouteAll({behavior: 'ignoreErrors'}); await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve)); db.close();
}

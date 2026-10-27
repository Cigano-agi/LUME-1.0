// Isolated browser + in-memory database; no account, real conversation or message.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';

const baseline = process.argv.includes('--baseline');
const output = new URL('../work/pessoal-qa-20261026/', import.meta.url);
await mkdir(output, {recursive: true});
const db = abrirBanco();
const server = criarServidor(db, {desktop: true, conexao: {estado: () => ({estado: 'desconectada', qr: null}), iniciar: async () => {}, parar: async () => {}}});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1280, height: 1000}, reducedMotion: 'reduce'});
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [], calls = [], proofs = [], holds = new Set(), held = [];
let syntheticError = '';
page.on('pageerror', error => errors.push(error.message));
const state = {enabled: false, autonomiaLiberada: false, chatgpt: {available: true, secureStorageAvailable: true, connected: true, planEnabled: true, account: {id: 'fixture', email: 'conta@example.test'}, accounts: [], model: 'fixture-model', pending: false, verifiedAt: null}, conversas: [
  {conversaId: '550000000001@s.whatsapp.net', nome: 'João de teste', categoria: 'team', modo: 'rascunhar', remoto: false},
  {conversaId: '550000000002@s.whatsapp.net', nome: '<img src=x onerror=window.injected=true>', categoria: 'unknown', modo: 'observar', remoto: false},
  {conversaId: '120000000001@g.us', nome: 'Grupo de teste', categoria: 'team', modo: 'observar', remoto: false}
]};
const telegram = {enabled: false, running: false, available: true, secureStorageAvailable: true, tokenConfigured: false, chatId: '', botUsername: ''};
const release = () => held.splice(0).forEach(resolve => resolve());
const count = path => calls.filter(call => call.path === path).length;
async function requested(path, total) {
  for (let attempt = 0; attempt < 500 && count(path) < total; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(count(path) >= total, `Request started: ${path}`);
}
async function textContains(id, text) {await page.locator(id).filter({hasText: text}).waitFor();}
async function disabled(id, value) {await page.waitForFunction(({id, value}) => document.querySelector(id)?.disabled === value, {id, value});}
async function settle() {await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));}
await page.route('**/api/v3/{pessoal,pessoal/**,telegram-hoje,telegram-hoje/**,mcp,mcp/**}', async route => {
  const req = route.request(), path = new URL(req.url()).pathname;
  const body = req.method() === 'POST' ? req.postDataJSON() : undefined;
  calls.push({path, method: req.method()}); // No body/credentials are exported.
  if (holds.has(path)) await new Promise(resolve => held.push(resolve));
  if (syntheticError === path) return route.fulfill({status: 500, json: {erro: 'Erro sintético de conexão'}}).catch(() => {});
  let result = state;
  if (path === '/api/v3/pessoal/config') {state.enabled = body.enabled;}
  else if (path.endsWith('/chatgpt/testar')) {state.chatgpt.verifiedAt = new Date().toISOString(); result = {completed: true};}
  else if (path.endsWith('/chatgpt/modelos')) result = {modelos: [{id: 'fixture-model', name: 'Modelo de teste'}]};
  else if (path.endsWith('/conversa')) Object.assign(state.conversas.find(c => c.conversaId === body.conversaId), {categoria: body.categoria, modo: body.modo, remoto: body.remoto});
  else if (path.startsWith('/api/v3/telegram-hoje')) {if (body && !path.endsWith('/desativar')) Object.assign(telegram, {enabled: true, running: true, tokenConfigured: true, chatId: body.chatId, botUsername: body.botUsername}); result = telegram;}
  else if (path.startsWith('/api/v3/mcp')) result = {clientes: [{id: 'claude-desktop', estado: 'desligado', pacote_disponivel: true, sistema_compativel: true, instalacao: 'detectado'}]};
  await route.fulfill({status: 200, json: result}).catch(() => {});
});
if (baseline) {
  for (const file of ['app.js', 'mcp.js', 'telegram.js', 'pessoal.js', 'beta05.js']) {
    const source = execFileSync('git', ['show', `HEAD:src/painel/${file}`], {encoding: 'utf8'});
    await page.route(`**/${file}`, route => route.fulfill({contentType: 'text/javascript', body: source}));
  }
}
try {
  console.log('UI: abrindo perfil sintético');
  await page.goto(`http://127.0.0.1:${server.address().port}/app`);
  await page.locator('#owner').fill('Pessoa sintética');
  await page.locator('#consent').check();
  await page.getByRole('button', {name: 'Preparar meu espaço'}).click();
  await page.locator('#skip').click();
  await page.locator('#first-hide').click();
  await page.evaluate(() => window.abrirAjuste('pessoal-panel'));
  await textContains('#pessoal-chatgpt-status', 'Conta conectada');
  await page.clock.install();
  if (baseline) {
    holds.add('/api/v3/pessoal/chatgpt/testar');
    await page.locator('#pessoal-test').click();
    await page.clock.fastForward(200000);
    await disabled('#pessoal-test', true);
    assert.equal((await page.locator('#pessoal-test-result').textContent()).trim(), '');
    assert.match(await page.locator('.sidebar .brand').textContent(), /Beta 0.6/);
    proofs.push('RED reproduzido em HEAD: teste ChatGPT continua bloqueado e sem erro após 200s; marca Beta 0.6 visível.');
  } else {
    console.log('UI: conta e seleção');
    await textContains('#pessoal-model-verification', 'ainda não verificado');
    assert.equal(await page.locator('#mcp-optional').getAttribute('open'), null);
    assert.equal(count('/api/v3/mcp'), 0, 'Optional Claude never loads while collapsed');
    assert.doesNotMatch(await page.locator('.sidebar .brand').textContent(), /Beta 0.6/);
    await page.locator('#pessoal-test').click();
    await textContains('#pessoal-test-result', 'Teste concluído');
    await textContains('#pessoal-model-verification', 'Modelo verificado');
    proofs.push('Conta conectada separada de modelo verificado; Claude opcional sem consulta inicial; marca limpa.');

    await page.locator('#pessoal-permissions > summary').click();
    assert.equal(await page.locator('#pessoal-conversation option').count(), 3);
    await page.locator('#pessoal-conversation-search').fill('joao');
    assert.equal(await page.locator('#pessoal-conversation option').count(), 2);
    await page.locator('#pessoal-conversation').selectOption(state.conversas[0].conversaId);
    await page.locator('#pessoal-remote').check();
    await page.locator('#pessoal-refresh').click();
    await disabled('#pessoal-refresh', false);
    assert.equal(await page.locator('#pessoal-remote').isChecked(), true, 'Refresh preserves unsaved authorization');
    assert.equal(await page.locator('#pessoal-conversation-id').isVisible(), false);
    await page.locator('#pessoal-conversation-search').fill('');
    await page.locator('#pessoal-conversation-kind').selectOption('group');
    await page.locator('#pessoal-conversation').selectOption(state.conversas[2].conversaId);
    assert.equal(await page.locator('#pessoal-mode option[value=atender]').evaluate(e => e.disabled), true);
    await page.locator('#pessoal-conversation-kind').selectOption('dm');
    assert.equal(await page.locator('#pessoal-conversation').inputValue(), '');
    await disabled('#pessoal-save-conversation', true);
    assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
    proofs.push('Busca sem acentos, DMs/grupos, campos não salvos preservados, identificador recolhido e política de grupo mantida.');

    holds.add('/api/v3/pessoal');
    console.log('UI: concorrência e polling');
    const beforeSingle = count('/api/v3/pessoal');
    await page.evaluate(() => {window.carregarPessoal(); window.carregarPessoal(); window.carregarPessoal();});
    await settle();
    assert.equal(count('/api/v3/pessoal') - beforeSingle, 1);
    holds.delete('/api/v3/pessoal'); release();
    await disabled('#pessoal-refresh', false);
    state.chatgpt.pending = true;
    await page.locator('#pessoal-refresh').click();
    await disabled('#pessoal-refresh', false);
    const beforePoll = count('/api/v3/pessoal');
    await page.clock.fastForward(2600); await settle();
    assert.equal(count('/api/v3/pessoal'), beforePoll + 1);
    await page.evaluate(() => show('today'));
    const beforeHidden = count('/api/v3/pessoal');
    await page.clock.fastForward(10000); await settle();
    assert.equal(count('/api/v3/pessoal'), beforeHidden);
    state.chatgpt.pending = false;
    await page.evaluate(() => window.abrirAjuste('pessoal-panel'));
    await disabled('#pessoal-refresh', false);
    proofs.push('Atualização singleflight e polling de login interrompido ao sair de Conexões.');

    holds.add('/api/v3/pessoal/config');
    console.log('UI: timeouts');
    await page.locator('#pessoal-enable').click();
    await requested('/api/v3/pessoal/config', 1);
    await page.clock.fastForward(15001);
    await textContains('#pessoal-action-result', 'O estado não foi confirmado');
    await disabled('#pessoal-enable', false);
    assert.equal(count('/api/v3/pessoal/config'), 1);
    holds.delete('/api/v3/pessoal/config'); release();
    await page.locator('#pessoal-refresh').click(); await disabled('#pessoal-refresh', false);
    holds.add('/api/v3/pessoal/chatgpt/testar');
    const testsBeforeTimeout = count('/api/v3/pessoal/chatgpt/testar');
    await page.locator('#pessoal-test').click();
    await requested('/api/v3/pessoal/chatgpt/testar', testsBeforeTimeout + 1);
    await page.clock.fastForward(90001);
    await textContains('#pessoal-test-result', 'O estado não foi confirmado');
    await disabled('#pessoal-test', false);
    holds.delete('/api/v3/pessoal/chatgpt/testar'); release();
    await page.locator('#pessoal-model-settings summary').click();
    holds.add('/api/v3/pessoal/chatgpt/modelos');
    await page.locator('#pessoal-load-models').click();
    await requested('/api/v3/pessoal/chatgpt/modelos', 1);
    await page.clock.fastForward(30001);
    await textContains('#pessoal-model-status', 'O estado não foi confirmado');
    await disabled('#pessoal-load-models', false);
    holds.delete('/api/v3/pessoal/chatgpt/modelos'); release();
    proofs.push('Ativação 15s, teste 90s e catálogo 30s: erro legível, botões recuperados, nenhuma repetição automática.');

    await page.locator('#pessoal-open-telegram').click();
    console.log('UI: Telegram');
    await textContains('#telegram-hoje-status', 'Desligado');
    await page.locator('#telegram-hoje-token').fill('synthetic-token-not-a-secret');
    await page.locator('#telegram-hoje-chat').fill('123456789');
    await page.locator('#telegram-hoje-name').fill('fixture_bot');
    await page.locator('#telegram-hoje-consent').check();
    holds.add('/api/v3/telegram-hoje');
    const telegramBeforeTimeout = count('/api/v3/telegram-hoje');
    await page.locator('#telegram-hoje-save').click();
    await requested('/api/v3/telegram-hoje', telegramBeforeTimeout + 1);
    await disabled('#telegram-hoje-disable', true);
    await page.clock.fastForward(15001);
    await textContains('#telegram-hoje-status', 'O estado não foi confirmado');
    await disabled('#telegram-hoje-save', false);
    assert.equal(await page.locator('#telegram-hoje-token').inputValue(), '');
    holds.delete('/api/v3/telegram-hoje'); release();
    await page.locator('#telegram-hoje-refresh').click(); await disabled('#telegram-hoje-refresh', false);
    await textContains('#telegram-hoje-status', 'Bot ativo');
    assert.equal(await page.locator('#telegram-hoje-open').getAttribute('href'), 'https://t.me/fixture_bot');
    proofs.push('Telegram recupera formulário após timeout sem reter token; refresh confirma estado e link do bot.');

    holds.add('/api/v3/mcp');
    console.log('UI: Claude e feedback');
    await page.locator('#mcp-optional > summary').click();
    await requested('/api/v3/mcp', 1);
    await page.clock.fastForward(15001);
    await textContains('#mcp-compat-note', 'O estado não foi confirmado');
    await disabled('#mcp-open-help', false);
    holds.delete('/api/v3/mcp'); release();
    await page.locator('#mcp-open-help').click();
    await textContains('#mcp-claude-status', 'Acesso desligado');
    await page.locator('#mcp-optional > summary').click();
    await page.locator('#pessoal-feedback').click();
    assert.equal(await page.locator('#central-feedback-text').evaluate(e => document.activeElement === e), true);
    assert.equal(calls.some(c => c.path.endsWith('/central/feedback')), false);
    proofs.push('Claude recupera consulta após timeout; atalho abre feedback existente sem enviar.');

    await page.evaluate(() => window.abrirAjuste('pessoal-panel'));
    await page.locator('#pessoal-test').click();
    await textContains('#pessoal-test-result', 'Teste concluído');
    await page.locator('#pessoal-permissions').evaluate(e => e.open = false);
    await page.locator('#pessoal-model-settings').evaluate(e => e.open = false);
    await page.locator('#telegram-hoje-settings').evaluate(e => e.open = false);
    await page.evaluate(() => {document.activeElement?.blur(); window.scrollTo(0, 0);});
    await page.clock.runFor(5000);
    await page.locator('#feedback').waitFor({state: 'hidden'});
    await page.screenshot({path: new URL('UI-conexoes.png', output).pathname.replace(/^\/(?:([A-Z]:))/, '$1'), fullPage: true});
    await page.locator('#pessoal-panel').screenshot({path: new URL('UI-chatgpt.png', output).pathname.replace(/^\/(?:([A-Z]:))/, '$1')});
    assert.equal(await page.locator('#pessoal-enable').evaluate(e => getComputedStyle(e).transitionDuration), '0s');
    await context.setDefaultTimeout(10000);
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#pessoal-panel').scrollIntoViewIfNeeded();
    await page.screenshot({path: new URL('UI-conexoes-mobile.png', output).pathname.replace(/^\/(?:([A-Z]:))/, '$1')});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow at 390px');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.screenshot({path: new URL('UI-conexoes-dark.png', output).pathname.replace(/^\/(?:([A-Z]:))/, '$1')});
    proofs.push('Screenshots desktop/mobile/escuro; reduced-motion sem transição e sem overflow a 390px.');
    assert.deepEqual(errors, []);
  }
  await writeFile(new URL(baseline ? 'UI-baseline.json' : 'UI-prova.json', output), JSON.stringify({synthetic: true, baseline, proofs, errors, calls}, null, 2));
  console.log(proofs.join('\n'));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  console.log('UI: encerrando perfil sintético');
  holds.clear();
  release();
  await page.unrouteAll({behavior: 'ignoreErrors'});
  console.log('UI: rotas removidas');
  await context.close();
  console.log('UI: contexto encerrado');
  await browser.close();
  console.log('UI: navegador encerrado');
  await new Promise(resolve => server.close(resolve));
  db.close();
  console.log('UI: servidor e banco encerrados');
}

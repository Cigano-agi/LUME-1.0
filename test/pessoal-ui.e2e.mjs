// Synthetic fixtures exercise the real settings UI. No ChatGPT login or external message is performed.
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';

const output = new URL('../work/pessoal-qa-20261026/ui-regressao/', import.meta.url);
await mkdir(output, {recursive: true});
const db = abrirBanco();
const server = criarServidor(db, {desktop: true, conexao: {estado: () => ({estado: 'desconectada', qr: null}), iniciar: async () => {}, parar: async () => {}}});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 1280, height: 1100}, reducedMotion: 'reduce'});
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors = [], calls = [];
page.on('pageerror', error => errors.push(error.message));
let completed = true, loginUrl = 'https://auth.openai.com/oauth/authorize?fixture=synthetic';
let credentialFails = false, credentialReceived = null, holdEvaluation = false, releaseEvaluation, quotaNext = false, evaluationAttempts = 0;
const evaluation = {id: null, executados: 0, revisados: 0, atual: false, busy: false, aceita: false, liberada: false, avaliacao: {aprovadoAutonomia: false}};
const evaluationCases = Array.from({length: 100}, (_, index) => ({id: `P${String(index + 1).padStart(3, '0')}`, ficticio: true, critico: index < 20,
  criterio: {interpretacao: 'Interpretar somente o pedido sintético.', fontes: 'Conferir a fonte sintética correta.', resposta: 'Não inventar autorização.', critico: 'Nunca enviar sem o direito exigido.'}, esperado: {decisao: 'consultar_dono', fontes: ['F-sintetica'], proibidos: ['envio sem autorização'], obrigatorios: []}}));
let evaluationResults = [];
const evaluationReport = () => ({...evaluation, casos: evaluationCases, execucao: evaluation.id ? {resultados: evaluationResults} : null});
const state = {
  enabled: false, autonomiaLiberada: false, pendencias: [],
  chatgpt: {available: true, secureStorageAvailable: true, connected: false, planEnabled: true, account: null, accounts: [], pending: false, model: '', verifiedAt: null, paused: false, error: null, usageUrl: 'https://chatgpt.com/codex/settings/usage'},
  conversas: [
    {conversaId: '550000000001@s.whatsapp.net', nome: 'Cliente sintético', categoria: 'unknown', modo: 'observar', remoto: false, pausada: false},
    {conversaId: '550000000002@s.whatsapp.net', nome: 'Família sintética', categoria: 'family', modo: 'observar', remoto: false, pausada: false},
    {conversaId: '120000000001@g.us', nome: 'Grupo sintético', categoria: 'team', modo: 'observar', remoto: false, pausada: false}
  ]
};
await page.route('**/api/v3/pessoal{,/**}', async route => {
  const req = route.request(), path = new URL(req.url()).pathname;
  const body = req.method() === 'POST' ? req.postDataJSON() : undefined;
  calls.push({path, method: req.method(), body: path.endsWith('/credencial') ? {...body, token: '[redacted synthetic token]'} : body});
  let result = state;
  if (path.endsWith('/config')) state.enabled = body.enabled;
  else if (path.endsWith('/chatgpt/login')) { state.chatgpt.pending = true; result = {url: loginUrl, expiresAt: new Date(Date.now() + 300000).toISOString()}; }
  else if (path.endsWith('/chatgpt/modelos')) result = {modelos: [{id: 'fixture-model', name: 'Modelo sintético'}]};
  else if (path.endsWith('/chatgpt/modelo')) { state.chatgpt.model = body.model; state.chatgpt.verifiedAt = null; }
  else if (path.endsWith('/chatgpt/testar')) { if (completed) state.chatgpt.verifiedAt = new Date().toISOString(); result = {completed, text: 'Resposta sintética'}; }
  else if (path.endsWith('/chatgpt/conta')) { state.chatgpt.account = state.chatgpt.accounts.find(a => a.id === body.id); state.chatgpt.verifiedAt = null; }
  else if (path.endsWith('/chatgpt/retomar')) state.chatgpt.paused = false;
  else if (path.endsWith('/chatgpt/sair')) { state.chatgpt.connected = false; state.chatgpt.account = null; state.chatgpt.accounts = []; state.chatgpt.verifiedAt = null; }
  else if (path.endsWith('/conversa')) Object.assign(state.conversas.find(c => c.conversaId === body.conversaId), {categoria: body.categoria, modo: body.modo, remoto: body.remoto});
  else if (path.endsWith('/vinculo')) {
    const conversation = state.conversas.find(c => c.conversaId === body.conversaId);
    conversation.vinculos = (conversation.vinculos || []).filter(link => link.tipo !== body.tipo || link.recurso !== body.recurso);
    if (!body.remover) conversation.vinculos.push({tipo: body.tipo, recurso: body.recurso});
    result = conversation.vinculos;
  }
  else if (path.endsWith('/credencial')) {
    credentialReceived = body;
    if (credentialFails) {await route.fulfill({status: 400, contentType: 'application/json', body: JSON.stringify({erro: 'Synthetic server error containing ' + body.token})}); return;}
    result = {ok: true};
  }
  else if (path.endsWith('/avaliacao/relatorio')) result = evaluationReport();
  else if (path.endsWith('/avaliacao')) result = evaluation;
  else if (path.endsWith('/avaliacao/iniciar')) {
    Object.assign(evaluation, {id: 'synthetic-evaluation', executados: 0, revisados: 0, atual: true, aceita: false, liberada: false, avaliacao: {aprovadoAutonomia: false}});
    evaluationResults = []; result = evaluation;
  }
  else if (path.endsWith('/avaliacao/proximo')) {
    evaluationAttempts++;
    if (holdEvaluation) await new Promise(resolve => releaseEvaluation = resolve);
    if (quotaNext) {quotaNext = false; state.chatgpt.paused = true; await route.fulfill({status: 429, contentType: 'application/json', body: JSON.stringify({erro: 'Limite sintético atingido.', codigo: 'RATE_LIMIT'})}); return;}
    const c = evaluationCases[evaluation.executados];
    evaluationResults.push({id: c.id, input: {mensagemAtual: {id: 1, texto: 'Pedido inteiramente sintético.'}, contexto: {fontes: [{id: 1, texto: 'Fonte sintética.'}]}}, output: '<img src=x onerror="window.pessoalInjected=true"> Resposta sintética para revisão.', requestId: 'synthetic-request-' + c.id, digest: c.id.padStart(64, 'a'), revisao: null});
    evaluation.executados = evaluationResults.length; result = {...evaluation, busy: true};
  }
  else if (path.endsWith('/avaliacao/revisar')) {
    const item = evaluationResults.find(result => result.id === body.id);
    assert.equal(body.digest, item.digest);
    item.revisao = {...body}; evaluation.revisados = evaluationResults.filter(result => result.revisao).length;
    result = evaluation;
  }
  else if (path.endsWith('/avaliacao/aceitar')) {assert.equal(evaluation.atual && evaluation.avaliacao.aprovadoAutonomia, true); evaluation.aceita = true; evaluation.liberada = true; state.autonomiaLiberada = true; result = evaluation;}
  await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(result)});
});
await page.route('**/api/v3/telegram-hoje', route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({enabled: true, running: true, available: true, secureStorageAvailable: true, chatId: '123456789', botUsername: 'fixture_bot', tokenConfigured: true})}));

try {
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Pessoa sintética');
  await page.locator('#consent').check();
  await page.getByRole('button', {name: 'Preparar meu espaço'}).click();
  await page.locator('#skip').click();
  await page.locator('#first-hide').click();
  await page.evaluate(() => window.abrirAjuste('pessoal-panel'));
  const panel = page.locator('#pessoal-panel');
  await panel.locator('#pessoal-status').filter({hasText: 'desligado'}).waitFor();
  assert.equal(await panel.locator('#pessoal-test').isDisabled(), true);
  assert.match(await panel.locator('#pessoal-autonomia').textContent(), /ainda não liberado/);
  await panel.locator('#pessoal-enable').click();
  await panel.locator('#pessoal-status').filter({hasText: 'ativado'}).waitFor();
  assert.match(await page.locator('#telegram-hoje-title').textContent(), /Conversar com o Lume/);
  assert.match(await page.locator('#telegram-hoje-description').textContent(), /\/hoje/);
  assert.equal(await page.locator('#telegram-hoje-token').inputValue(), '');

  loginUrl = 'https://auth.openai.com.evil.invalid/oauth/authorize';
  await panel.locator('#pessoal-login').click();
  await panel.locator('#pessoal-action-result').filter({hasText: 'não é válido'}).waitFor();
  assert.equal(await panel.locator('#pessoal-login-link').getAttribute('href'), null);
  loginUrl = 'https://auth.openai.com/oauth/authorize?fixture=synthetic';
  await panel.locator('#pessoal-login').click();
  await panel.locator('#pessoal-login-step').waitFor();
  assert.equal(await panel.locator('#pessoal-login-link').getAttribute('href'), loginUrl);
  assert.equal(context.pages().length, 1, 'Login does not open a browser automatically');
  state.chatgpt.connected = true; state.chatgpt.pending = false;
  state.chatgpt.accounts = [{id: 'fixture-a', email: 'conta-a@example.test', connected: true}, {id: 'fixture-b', email: 'conta-b@example.test', connected: true}];
  state.chatgpt.account = state.chatgpt.accounts[0];
  await panel.locator('#pessoal-refresh').click();
  await panel.locator('#pessoal-model-verification').filter({hasText: 'nenhuma requisição'}).waitFor();
  assert.equal(await panel.locator('#pessoal-login-link').getAttribute('href'), null);
  await panel.locator('#pessoal-model-settings summary').click();
  await panel.locator('#pessoal-load-models').click();
  await panel.locator('#pessoal-model-form').waitFor();
  await panel.locator('#pessoal-model-form button').click();
  await panel.locator('#pessoal-model-status').filter({hasText: 'Modelo selecionado'}).waitFor();
  await panel.locator('#pessoal-test').click();
  await panel.locator('#pessoal-test-result').filter({hasText: 'Teste concluído'}).waitFor();
  await panel.locator('#pessoal-account').selectOption('fixture-b');
  await panel.locator('#pessoal-account-settings > summary').click();
  await panel.locator('#pessoal-chatgpt-detail').filter({hasText: 'conta-b@example.test'}).waitFor();
  assert.equal(await panel.locator('#pessoal-test-result').textContent(), '');
  assert.equal(await panel.locator('#pessoal-model-form').isVisible(), false);
  completed = false;
  await panel.locator('#pessoal-test').click();
  await panel.locator('#pessoal-test-result').filter({hasText: 'não foi concluída'}).waitFor();
  state.chatgpt.paused = true;
  await panel.locator('#pessoal-refresh').click();
  await panel.locator('#pessoal-resume').waitFor();
  assert.equal(await panel.locator('#pessoal-test').isDisabled(), true);
  await panel.locator('#pessoal-resume').click();
  await panel.locator('#pessoal-resume').waitFor({state: 'hidden'});

  await panel.locator('#pessoal-permissions > summary').click();
  await panel.locator('#pessoal-conversation').selectOption(state.conversas[0].conversaId);
  assert.equal(await panel.locator('#pessoal-category').inputValue(), 'unknown');
  assert.equal(await panel.locator('#pessoal-mode').inputValue(), 'observar');
  assert.equal(await panel.locator('#pessoal-remote').isChecked(), false);
  assert.equal(await panel.locator('#pessoal-mode option[value="atender"]').evaluate(node => node.disabled), true);
  await panel.locator('#pessoal-category').selectOption('vip_client');
  await panel.locator('#pessoal-mode').selectOption('atender');
  await panel.locator('#pessoal-remote').check();
  await panel.locator('#pessoal-save-conversation').click();
  await panel.locator('#pessoal-conversation-result').filter({hasText: 'Autorização salva'}).waitFor();
  assert.deepEqual(calls.find(c => c.path.endsWith('/conversa')).body, {conversaId: state.conversas[0].conversaId, categoria: 'vip_client', modo: 'atender', remoto: true});
  await panel.locator('#pessoal-conversation').selectOption(state.conversas[1].conversaId);
  assert.equal(await panel.locator('#pessoal-remote').isChecked(), false, 'Consent does not carry to another conversation');
  assert.equal(await panel.locator('#pessoal-mode option[value="atender"]').evaluate(node => node.disabled), true);
  await panel.locator('#pessoal-conversation-kind').selectOption('group');
  await panel.locator('#pessoal-conversation').selectOption(state.conversas[2].conversaId);
  assert.equal(await panel.locator('#pessoal-mode option[value="atender"]').evaluate(node => node.disabled), true, 'Groups cannot attend even when categorized as team');
  await panel.locator('#pessoal-conversation-kind').selectOption('dm');
  await panel.locator('#pessoal-conversation').selectOption(state.conversas[0].conversaId);
  await page.locator('#feedback').waitFor({state: 'hidden'});
  await panel.screenshot({path: new URL('pessoal-ui-desktop-sintetico.png', output).pathname.replace(/^\/(\w:)/, '$1')});
  await page.setViewportSize({width: 390, height: 844});
  await panel.evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 100));
  await page.screenshot({path: new URL('pessoal-ui-mobile-sintetico.png', output).pathname.replace(/^\/(\w:)/, '$1')});
  await panel.locator('#pessoal-conversation').evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 125));
  await page.screenshot({path: new URL('pessoal-ui-mobile-autorizacao-sintetico.png', output).pathname.replace(/^\/(\w:)/, '$1')});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No mobile horizontal overflow');
  await page.setViewportSize({width: 1280, height: 1100});
  await panel.locator('#pessoal-links summary').first().click();
  await panel.locator('#pessoal-link-resource').fill('synthetic/project');
  await panel.locator('#pessoal-link-save').click();
  await panel.locator('#pessoal-link-result').filter({hasText: 'Recurso vinculado'}).waitFor();
  assert.deepEqual(calls.find(call => call.path.endsWith('/vinculo')).body, {conversaId: state.conversas[0].conversaId, tipo: 'github', recurso: 'synthetic/project', remover: false});
  await panel.locator('#pessoal-conversation').selectOption(state.conversas[1].conversaId);
  assert.match(await panel.locator('#pessoal-links-list').textContent(), /Nenhum recurso/);
  await panel.locator('#pessoal-conversation').selectOption(state.conversas[0].conversaId);
  await panel.getByRole('button', {name: 'Remover github synthetic/project'}).click();
  await panel.locator('#pessoal-link-result').filter({hasText: 'Vínculo removido'}).waitFor();
  await panel.locator('#pessoal-link-type').selectOption('clickup');
  await panel.locator('#pessoal-link-resource').fill('synthetic_task_42');
  await panel.locator('#pessoal-link-save').click();
  await panel.locator('#pessoal-links-list').getByText('ClickUp · synthetic_task_42').waitFor();
  await panel.getByText('Credencial própria para consultas privadas', {exact: true}).click();
  await panel.locator('#pessoal-credential-type').selectOption('clickup');
  await panel.locator('#pessoal-credential-token').fill('synthetic-token-not-real');
  await panel.locator('#pessoal-credential-save').click();
  await panel.locator('#pessoal-credential-result').filter({hasText: 'Credencial guardada'}).waitFor();
  assert.deepEqual(credentialReceived, {tipo: 'clickup', token: 'synthetic-token-not-real'});
  assert.equal(await panel.locator('#pessoal-credential-token').inputValue(), '');
  assert.doesNotMatch(await panel.textContent(), /synthetic-token-not-real/);
  credentialFails = true;
  await panel.locator('#pessoal-credential-token').fill('synthetic-failed-token');
  await panel.locator('#pessoal-credential-save').click();
  await panel.locator('#pessoal-credential-result').filter({hasText: 'Não foi possível guardar'}).waitFor();
  assert.equal(await panel.locator('#pessoal-credential-token').inputValue(), '');
  assert.doesNotMatch(await panel.textContent(), /synthetic-failed-token/);

  await panel.locator('#pessoal-evaluation > summary').click();
  await panel.locator('#pessoal-evaluation-status').filter({hasText: 'Nenhuma avaliação'}).waitFor();
  await panel.locator('#pessoal-evaluation-start').click();
  await panel.locator('#pessoal-evaluation-result').filter({hasText: 'Nenhuma requisição'}).waitFor();
  assert.equal(evaluationAttempts, 0, 'Preparation does not execute a model request');
  assert.equal(await panel.locator('#pessoal-evaluation-run').isDisabled(), true);
  assert.equal(await panel.locator('#pessoal-evaluation-start').isDisabled(), true, 'Replacing an evaluation requires explicit confirmation');
  await panel.locator('#pessoal-evaluation-consent').check();
  holdEvaluation = true;
  await panel.locator('#pessoal-evaluation-run').click();
  await panel.locator('#pessoal-evaluation-stop').click();
  await panel.locator('#pessoal-evaluation-result').filter({hasText: 'Vou pausar'}).waitFor();
  assert.equal(evaluationAttempts, 1);
  holdEvaluation = false; releaseEvaluation();
  await panel.locator('#pessoal-evaluation-result').filter({hasText: 'Execução pausada'}).waitFor();
  await panel.locator('#pessoal-evaluation-stop').waitFor({state: 'hidden'});
  assert.equal(evaluation.executados, 1); assert.equal(evaluationAttempts, 1);
  quotaNext = true;
  await panel.locator('#pessoal-evaluation-run').click();
  await panel.locator('#pessoal-evaluation-result').filter({hasText: 'Execução interrompida'}).waitFor();
  assert.equal(evaluationAttempts, 2); assert.equal(evaluation.executados, 1, 'Quota preserves completed cases');
  await panel.locator('#pessoal-resume').click();
  await panel.locator('#pessoal-resume').waitFor({state: 'hidden'});
  await panel.locator('#pessoal-evaluation-next').click();
  await panel.locator('#pessoal-evaluation-result').filter({hasText: 'Caso executado'}).waitFor();
  assert.equal(evaluation.executados, 2); assert.equal(evaluationAttempts, 3, 'Single-case button makes exactly one request');
  await panel.locator('#pessoal-evaluation-review > summary').click();
  assert.match(await panel.locator('#pessoal-evaluation-rubric').textContent(), /Conferir a fonte sintética/);
  assert.match(await panel.locator('#pessoal-evaluation-output').textContent(), /<img/);
  assert.equal(await panel.locator('#pessoal-evaluation-output img').count(), 0);
  assert.equal(await page.evaluate(() => window.pessoalInjected), undefined);
  for (const criterion of ['interpretacao', 'fontes', 'resposta']) await panel.locator('#pessoal-review-' + criterion).check();
  await panel.locator('#pessoal-review-author').fill('Revisor sintético');
  await panel.locator('#pessoal-review-evidence').fill('Falhou no limite crítico do caso; evidência inteiramente sintética.');
  await panel.locator('#pessoal-review-save').click();
  await panel.locator('#pessoal-review-result').filter({hasText: 'Revisão registrada'}).waitFor();
  const reviewed = calls.find(call => call.path.endsWith('/avaliacao/revisar')).body;
  assert.equal(reviewed.id, 'P001'); assert.equal(reviewed.digest, evaluationResults[0].digest);
  assert.equal(reviewed.criticoAtendido, false, 'Unmarked criteria persist as failures, not implicit approval');
  assert.equal(await panel.locator('#pessoal-evaluation-case').inputValue(), 'P002');
  await panel.locator('#pessoal-evaluation-accept-confirm').check();
  assert.equal(await panel.locator('#pessoal-evaluation-accept').isDisabled(), true);
  await panel.locator('#pessoal-evaluation-run').click();
  await panel.locator('#pessoal-evaluation-result').filter({hasText: 'Os 100 casos foram executados'}).waitFor({timeout: 30000});
  assert.equal(evaluation.executados, 100); assert.equal(evaluationAttempts, 101);
  assert.equal(await panel.locator('#pessoal-evaluation-accept').isDisabled(), true, 'Execution alone cannot release autonomy');
  // Synthetic backend gate fixture only: this does not represent real model execution, review or acceptance.
  for (const result of evaluationResults) result.revisao = {interpretacao: true, fontes: true, resposta: true, criticoAtendido: true, revisadoPor: 'Revisor da fixture', evidencia: 'Aprovação sintética somente para verificar o gate visual.'};
  evaluation.revisados = 100; evaluation.avaliacao.aprovadoAutonomia = true; evaluation.atual = false;
  await panel.locator('#pessoal-evaluation-refresh').click();
  await panel.locator('#pessoal-evaluation-status').filter({hasText: 'modelo ou o contrato mudou'}).waitFor();
  assert.equal(await panel.locator('#pessoal-evaluation-accept').isDisabled(), true);
  assert.equal(await panel.locator('#pessoal-evaluation-accept-confirm').isChecked(), false);
  evaluation.atual = true;
  await panel.locator('#pessoal-evaluation-refresh').click();
  await panel.locator('#pessoal-evaluation-status').filter({hasText: '100 revisados'}).waitFor();
  await panel.locator('#pessoal-evaluation-accept-confirm').check();
  await panel.locator('#pessoal-evaluation-accept').click();
  await panel.locator('#pessoal-evaluation-result').filter({hasText: 'Avaliação aceita'}).waitFor();
  assert.equal(calls.filter(call => call.path.endsWith('/avaliacao/aceitar')).length, 1);
  assert.match(await panel.locator('#pessoal-autonomia').textContent(), /somente nas conversas autorizadas como Atender/);
  await panel.locator('#pessoal-evaluation').screenshot({path: new URL('pessoal-ui-avaliacao-desktop-sintetico.png', output).pathname.replace(/^\/(\w:)/, '$1')});
  await page.setViewportSize({width: 390, height: 844});
  await panel.locator('#pessoal-evaluation').evaluate(node => window.scrollTo(0, window.scrollY + node.getBoundingClientRect().top - 100));
  await page.screenshot({path: new URL('pessoal-ui-avaliacao-mobile-sintetico.png', output).pathname.replace(/^\/(\w:)/, '$1')});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Evaluation has no mobile horizontal overflow');
  await panel.locator('#pessoal-logout').click();
  await panel.locator('#pessoal-chatgpt-status').filter({hasText: 'Nenhuma conta'}).waitFor();
  assert.equal(await panel.locator('#pessoal-test').isDisabled(), true);
  assert.deepEqual(errors, []);
  await writeFile(new URL('pessoal-ui-proof.json', output), JSON.stringify({synthetic: true, realLogin: false, externalMessages: false, realEvaluation: false, syntheticEvaluationAttempts: evaluationAttempts, assertions: 'login origin, no auto browser, configured vs completed, account switch, model, pause/resume, exact conversation consent, group/family denial, exact GitHub/ClickUp links, credential clearing and no echo, prepare without inference, batch/single evaluation, pause after current case, quota stop without retry, source/output review bound to digest, unchecked critical fails, model mismatch prevents acceptance, explicit gated acceptance, mobile overflow', errors, calls}, null, 2));
  console.log('PASS pessoal UI — synthetic fixtures; no real login, inference or messages. Screenshots and receipt: work/pessoal-qa-20261026/ui-regressao.');
} finally {
  releaseEvaluation?.();
  await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve)); db.close();
}

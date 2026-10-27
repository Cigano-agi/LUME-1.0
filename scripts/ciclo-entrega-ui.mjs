// UI real e API local; perfil e autorização MCP simulados, sem conector/IA/piloto real.
// Reutiliza a fixture e a inicialização do servidor usadas pelos E2Es existentes.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { perfilBeta05 } from '../test/fixtures/beta05-profile.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { createLumeMcpCore } from '../src/mcp/core.js';
import { criarServidor } from '../src/painel/servidor.js';
import { Desktop } from '../src/desktop.js';
import { ContextoApp } from '../src/contexto-app.js';

const out = resolve('work/beta06-ciclo-entrega', new Date().toISOString().replaceAll(':', '-'));
const reviewPatch = process.argv.includes('--review-patch');
mkdirSync(out, { recursive: true });
const dbPath = join(out, 'perfil-sintetico.db');
let db = abrirBanco(dbPath), server, browser, page;
const evidence = { at: new Date().toISOString(), synthetic: true, actualExternalClient: false,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  hashes: {}, reviewPatch, widths: [390, 1440], checks: {}, findings: [], errors: [], external: [], screenshots: [] };
for (const file of ['src/painel/acoes.js', 'src/execucao/servico.js', 'src/execucao/esquema.js'])
  evidence.hashes[file] = createHash('sha256').update(readFileSync(file)).digest('hex');
const now = new Date();
const profile = perfilBeta05(db, { agora: now, vazio: true });
profile.desktop.configurarGuia({ dispensado: true });
const quote = 'Combinado: preparar o roteiro da reunião de demonstração.';
const source = profile.mensagem({ nome: 'Ana · conversa sintética de auditoria', texto: quote });
profile.mensagem({ conversa: 'outra-sintetica', nome: 'Outra conversa sintética', texto: 'SENTINELA_FORA_DO_CONTEXTO: assunto de outro projeto.' });
const actions = new AcoesLume(db);
actions.autorizar({ conversa: source.conversa, permitida: true });
actions.registrar({ eventoId: source.id, candidatas: [{ fonte: 'E' + source.id,
  tipo: 'compromisso', resumo: 'Preparar roteiro sintético', trecho: quote, prazo_citado: '' }] });
const task = actions.listar()[0];
actions.revisar({ id: task.id, acao: 'confirmar' });
let inference = 0;
server = criarServidor(db, { contexto: profile.contexto, desktop: true,
  conexao: { estado: () => ({ estado: 'desconectada', qr: null }), iniciar: async () => {}, parar: async () => {} },
  gerarIA: async () => { inference++; throw Error('Inferência proibida na auditoria'); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  page = await browser.newPage({ viewport: { width: 390, height: 950 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  page.on('pageerror', e => evidence.errors.push(e.message));
  await page.route('**/*', route => {
    if (!route.request().url().startsWith(origin)) { evidence.external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  async function shot(name, widths = evidence.widths) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 950 });
      await page.screenshot({ path: join(out, `${name}-${width}.png`) });
      evidence.screenshots.push(`${name}-${width}.png`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (await page.locator('#resolver-dialog[open]').count())
        assert.equal(await page.locator('#resolver-dialog').evaluate(n => n.scrollWidth > n.clientWidth), false);
    }
  }
  await page.goto(origin + '/app');
  await page.locator('#clarity-content:not([hidden])').waitFor();
  await page.locator('nav [data-view=memory]').click();
  await page.locator('#memory-mode-conversations').click();
  const conversation = page.locator('.conversation-card').filter({ hasText: 'Ana · conversa sintética' });
  await conversation.getByRole('button', { name: 'Abrir conversa', exact: true }).click();
  await page.locator('#conversation-heading').waitFor();
  const card = page.locator('#conversation-detail .acoes06-card').filter({ hasText: 'Preparar roteiro sintético' });
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await shot('01-conversa-combinado');
  await card.getByRole('button', { name: 'Conferir fonte E' + source.id, exact: true }).click();
  await page.locator('#results').getByText(quote, { exact: true }).waitFor();
  assert.match(await page.locator('#results').innerText(), /Combinado: preparar o roteiro/);
  evidence.checks.conversationTaskSource = true;
  await page.locator('nav [data-view=memory]').click();
  await page.locator('#memory-mode-conversations').click();
  await conversation.getByRole('button', { name: 'Abrir conversa', exact: true }).click();
  const resolver = card.getByRole('button', { name: 'Resolver com →', exact: true });
  await resolver.focus(); await page.keyboard.press('Enter');
  await page.locator('#resolver-consent').waitFor();
  assert.equal(await page.locator('#resolver-title').evaluate(n => n === document.activeElement), true);
  evidence.checks.keyboardOpenFocus = true;
  evidence.checks.reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await page.keyboard.press('Shift+Tab');
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#resolver-dialog').evaluate(n => n.contains(document.activeElement)), true);
  }
  evidence.checks.keyboardFocusStaysInDialog = true;
  evidence.checks.reducedMotionAnimations = await page.evaluate(() => document.getAnimations().map(a => ({
    state: a.playState, duration: a.effect?.getComputedTiming().duration,
    target: a.effect?.target?.className ?? ''
  })));
  assert.equal(await page.locator('#resolver-dialog').innerText().then(t => t.includes('SENTINELA_FORA_DO_CONTEXTO')), false);
  await shot('02-contexto-consentimento');
  await page.locator('#resolver-consent').focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Autorizar contexto →' }).click();
  await page.locator('.resolver-state[data-state=aguardando_assistente]').waitFor();
  const execution = db.prepare('SELECT id FROM lume_execucoes').get();
  const service = new ExecucoesLume(db);
  const core = createLumeMcpCore({ db, execucoes: service,
    authorize: async () => ({ enabled: true, revision: 'sintetica-1', scope: { kind: 'all' } }) });
  const client = { clientId: 'claude-desktop', credential: 'autorizacao-simulada-sem-segredo' };
  const context = await core.executar('lume_obter_contexto_execucao', { execucao_id: execution.id }, client);
  assert.equal(context.ok, true);
  assert.equal(JSON.stringify(context).includes('SENTINELA_FORA_DO_CONTEXTO'), false);
  assert.equal((await core.executar('lume_abrir_fonte', { source_id: context.contexto.fontes[0].source_id }, client)).ok, true);
  assert.equal((await core.executar('lume_iniciar_execucao', { execucao_id: execution.id, chave_idempotencia: 'ciclo-ui-inicio' }, client)).ok, true);
  assert.equal((await core.executar('lume_registrar_progresso', { execucao_id: execution.id,
    chave_idempotencia: 'ciclo-ui-progresso', texto: 'Roteiro fictício em preparação.' }, client)).ok, true);
  const returned = { execucao_id: execution.id, chave_idempotencia: 'ciclo-ui-resultado',
    resumo: 'Roteiro sintético preparado para conferência.', artefatos: ['roteiro-sintetico.md'] };
  assert.equal((await core.executar('lume_registrar_resultado', returned, client)).execucao.estado, 'resultado_informado');
  assert.equal((await core.executar('lume_registrar_resultado', returned, client)).repetido, true);
  await page.getByRole('button', { name: 'Atualizar andamento', exact: true }).click();
  await page.locator('#resolver-verification-note').waitFor();
  await shot('03-retorno-informado');
  assert.equal(await page.locator('.resolver-timeline [data-kind=resultado]').count(), 1);
  await page.locator('#resolver-verification-note').fill('Conferi o roteiro fictício; corresponde ao combinado de teste.');
  await page.getByRole('button', { name: 'Confirmar resultado verificado', exact: true }).click();
  await page.locator('.resolver-state[data-state=verificado]').waitFor();
  evidence.checks.mcpSimulatedAuthRoundtrip = true;
  evidence.checks.idempotentResultAndSeparateLocalVerification = true;
  await shot('04-verificado');
  await page.keyboard.press('Escape');
  assert.equal(await resolver.evaluate(n => n === document.activeElement), true);
  evidence.checks.escapeReturnsFocus = true;
  let unverified;
  if (reviewPatch) {
    // Segundo retorno não conferido para verificar que o patch também retira
    // controles que estariam presentes antes da correção (não apenas concluídos).
    const nextContext = service.preparar({ acao_id: task.id }).contexto;
    unverified = service.iniciar({ contexto_id: nextContext.id, assistente: 'claude',
      confirmar: true, chave_idempotencia: 'ciclo-ui-segundo-inicio' }).execucao;
    assert.equal((await core.executar('lume_registrar_resultado', { execucao_id: unverified.id,
      chave_idempotencia: 'ciclo-ui-segundo-resultado', resumo: 'Segundo material ainda não conferido.',
      artefatos: ['perguntas-sinteticas.md'] }, client)).ok, true);
  }
  if (await card.locator('.acoes06-options > summary').count()) await card.locator('.acoes06-options > summary').click();
  await card.locator('.acoes06-correction > summary').click();
  await card.locator('.acoes06-correction input').fill('Conferir roteiro e preparar perguntas sintéticas');
  await card.getByRole('button', { name: 'Salvar correção', exact: true }).click();
  const corrected = page.locator('#conversation-detail .acoes06-card').filter({ hasText: 'Conferir roteiro e preparar perguntas sintéticas' });
  await corrected.getByRole('button', { name: 'Ver andamento', exact: true }).click();
  await page.getByText('HISTÓRICO DA TAREFA', { exact: true }).waitFor();
  evidence.checks.afterCorrection = {
    persistedExecutions: db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n,
    listedExecutions: service.listar({ acao_id: task.id }).execucoes.length,
    visibleText: await page.locator('#resolver-dialog').innerText()
  };
  if (evidence.checks.afterCorrection.listedExecutions !== evidence.checks.afterCorrection.persistedExecutions)
    evidence.findings.push('C2: histórico local oculta execução após corrigir descrição');
  await shot('05-historico-apos-correcao');
  if (reviewPatch) {
    assert.equal(evidence.checks.afterCorrection.listedExecutions, 2);
    const historical = page.locator('.resolver-history-row').filter({ hasText: /Resultado informado/i });
    assert.match(await historical.innerText(), /Contexto alterado · histórico/);
    assert.match(await historical.innerText(), /antes da mudança/);
    assert.doesNotMatch(await historical.innerText(), /· confira/);
    await historical.getByRole('button', { name: 'Ver histórico preservado', exact: true }).click();
    await page.locator('.resolver-context-invalidated').waitFor();
    assert.match(await page.locator('.resolver-state').innerText(), /antes da mudança/);
    assert.doesNotMatch(await page.locator('.resolver-state').innerText(), /· confira/);
    assert.equal(await page.locator('.resolver-manual, .resolver-verify').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Copiar pedido', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Preparar nova autorização', exact: true }).count(), 1);
    const stale = await core.executar('lume_registrar_progresso', { execucao_id: unverified.id,
      chave_idempotencia: 'ciclo-ui-retorno-tardio', texto: 'Este retorno deve ser bloqueado.' }, client);
    assert.equal(stale.ok, false);
    evidence.checks.invalidatedHistory = { warning: await page.locator('.resolver-context-invalidated').innerText(),
      historicalCopyExplicit: true, externalWriteRefused: true, resultControlsAbsent: true, newAuthorizationAvailable: true };
    await shot('06-contexto-invalidado-sem-controles');
  }
  await browser.close(); browser = null;
  server.closeAllConnections(); await new Promise(r => server.close(r)); server = null;
  db.close(); db = abrirBanco(dbPath);
  new ContextoApp(db); new Desktop(db); new AcoesLume(db);
  const resumed = new ExecucoesLume(db);
  evidence.checks.restartAfterCorrection = {
    persistedExecutions: db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n,
    persistedResultEvents: db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='resultado'").get().n,
    listedExecutions: resumed.listar({ acao_id: task.id }).execucoes.length
  };
  if (reviewPatch) {
    assert.equal(evidence.checks.restartAfterCorrection.listedExecutions, 2);
    assert.equal(resumed.obter({ id: unverified.id }).execucao.contexto_invalidado, true);
    assert.throws(() => resumed.registrar('verificacao', { execucao_id: unverified.id,
      chave_idempotencia: 'ciclo-ui-conferencia-antiga', confirmar: true, nota: 'Não autorizar conferência antiga.' }));
    assert.deepEqual(evidence.findings, []);
  }
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.external, []); assert.equal(inference, 0);
  evidence.inference = inference;
  evidence.completed = true;
} catch (error) {
  evidence.failed = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) {
    evidence.failed.body = await page.locator('body').innerText();
    await page.screenshot({ path: join(out, 'failure.png') });
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  db.close();
  writeFileSync(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ out, completed: evidence.completed, failed: evidence.failed?.message, findings: evidence.findings, checks: evidence.checks }, null, 2));
}

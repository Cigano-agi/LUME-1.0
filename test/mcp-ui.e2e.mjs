import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import pacote from '../package.json' with { type: 'json' };

const MCPB_NAME = `Lume-${pacote.version}.mcpb`;
const ACTIVATION_CODE = 'codigo-unico-do-teste-1234567890';
const TEST_PROMPT = 'Quais são minhas demandas de hoje?';

let backendState = 'desligado';
let installation = 'nao_confirmado';
let packageAvailable = true;
let compatible = true;
const calls = [];
const snapshot = () => ({
  clientes: [
    {
      id: 'claude-desktop',
      nome: 'Claude Desktop',
      estado: backendState,
      escopo: backendState === 'preparado' ? 'Hoje' : null,
      problema: backendState === 'erro' ? 'O arquivo de acesso ficou inválido.' : null,
      pacote_disponivel: packageAvailable,
      sistema_compativel: compatible,
      instalacao: installation
    },
    { id: 'chatgpt', nome: 'ChatGPT', estado: 'em_breve', escopo: null }
  ],
  mac_validado: false
});
const mcp = {
  estado: snapshot,
  ativarClaudeHoje: ({ confirmar, renovar }) => {
    calls.push(['ativar', confirmar, Boolean(renovar)]);
    backendState = 'preparado';
    return { ...snapshot(), activation_code: ACTIVATION_CODE };
  },
  revogarClaude: ({ confirmar }) => {
    calls.push(['revogar', confirmar]);
    backendState = 'desligado';
    return snapshot();
  },
  testarClaudeLocal: async () => {
    calls.push(['testar']);
    return { ok: true, estado: 'aprovado', provas: { pacote: true, configuracao: true, leitura_local: true, transporte_stdio: true }, claude_conectado: false };
  },
  pacoteClaude: () => ({ name: MCPB_NAME, bytes: Buffer.from('PK\u0003\u0004teste') })
};

const db = abrirBanco();
const server = criarServidor(db, { desktop: true, mcp, conexao: { estado: () => ({ estado: 'desconectada', qr: null }), iniciar: async () => {}, parar: async () => {} } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));

const openClaude = async () => {
  await page.evaluate(() => window.abrirAjuste('mcp-panel'));
  await page.locator('#mcp-panel').waitFor();
};
const expectState = async (panel, state, action) => {
  await panel.locator(`.mcp-primary-next:visible`).waitFor();
  assert.equal(await panel.getAttribute('data-mcp-state'), state);
  assert.equal(await panel.locator('.mcp-primary-next:visible').count(), 1);
  assert.equal((await panel.locator('.mcp-primary-next:visible').textContent()).trim(), action);
};

try {
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Pessoa teste');
  await page.locator('#consent').check();
  await page.getByRole('button', { name: 'Preparar meu espaço' }).click();
  await page.locator('#skip').click();
  await page.locator('#first-hide').click();
  await openClaude();

  const panel = page.locator('#mcp-panel');
  await panel.getByRole('heading', { name: 'Use suas conversas no Claude' }).waitFor();
  await panel.getByText('Acesso desligado.').waitFor();
  await expectState(panel, 'desligado', 'Preparar acesso');
  assert.equal(await panel.locator('#mcp-activate').isDisabled(), true);
  assert.match(await panel.textContent(), /somente nas conversas de hoje/i);
  assert.match(await panel.textContent(), /ChatGPT no Lume pessoal/);
  assert.equal(await panel.locator('#mcp-open-pessoal').isVisible(), true);
  assert.equal(await panel.locator('#mcp-troubleshoot').getAttribute('open'), null);
  assert.equal(await panel.locator('#mcp-self-test').evaluate(node => node.closest('details')?.id), 'mcp-troubleshoot');
  assert.equal(await panel.locator('#mcp-revoke').evaluate(node => node.closest('details')?.id), 'mcp-stop');

  await panel.locator('#mcp-confirm').check();
  await panel.getByText('Autorização confirmada. Prepare o acesso.').waitFor();
  await expectState(panel, 'autorizado', 'Preparar acesso');
  assert.equal(await panel.locator('#mcp-activate').isEnabled(), true);

  await panel.locator('#mcp-activate').click();
  await panel.getByText('Acesso preparado. Agora baixe a extensão.').waitFor();
  await expectState(panel, 'preparado', '2. Baixar extensão');
  assert.equal(await panel.locator('#mcp-claude-pill').textContent(), 'ACESSO PREPARADO');
  assert.equal(await panel.locator('#mcp-code').textContent(), ACTIVATION_CODE);
  assert.match(await panel.locator('#mcp-code-box').textContent(), /aparece uma vez/i);
  assert.deepEqual(calls[0], ['ativar', true, false]);
  assert.equal(await panel.locator('#mcp-code-box').evaluate((codeBox, downloadActions) => Boolean(codeBox.compareDocumentPosition(downloadActions) & Node.DOCUMENT_POSITION_FOLLOWING), await panel.locator('#mcp-download-actions').elementHandle()), true);
  assert.equal(await panel.locator('#mcp-download-actions').evaluate((downloadActions, steps) => Boolean(downloadActions.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING), await panel.locator('#mcp-steps').elementHandle()), true);

  const downloadPromise = page.waitForEvent('download');
  await panel.locator('#mcp-download').click();
  const downloaded = await downloadPromise;
  assert.equal(downloaded.suggestedFilename(), MCPB_NAME);
  await panel.getByText('Extensão baixada. Siga a instalação e teste no Claude.').waitFor();
  await expectState(panel, 'pronto-para-teste', 'Copiar pergunta de teste');
  assert.equal(await panel.locator('#mcp-steps').isVisible(), true);
  assert.equal(await panel.locator('#mcp-steps').getAttribute('open'), '');
  assert.match(await panel.locator('#mcp-steps').textContent(), /Mac ainda precisa ser validada em um Mac/i);

  await panel.locator('#mcp-test-prompt').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), TEST_PROMPT);

  await panel.getByText('Resolver problema', { exact: true }).last().click();
  assert.equal(await panel.locator('#mcp-troubleshoot').getAttribute('open'), '');
  assert.match(await panel.locator('#mcp-test-caveat').textContent(), /não confirma uma conexão com o Claude Desktop/i);
  await panel.locator('#mcp-self-test').click();
  await panel.getByText(/Teste local aprovado/).waitFor();
  assert.match(await panel.locator('#mcp-test-result').textContent(), /não confirma conexão com o Claude Desktop/i);
  assert.deepEqual(calls.at(-1), ['testar']);
  await expectState(panel, 'pronto-para-teste', 'Copiar pergunta de teste');

  await page.reload();
  await openClaude();
  await panel.getByText('Acesso preparado. Gere um novo código para continuar.').waitFor();
  await expectState(panel, 'preparado', 'Gerar novo código');
  assert.equal(await panel.locator('#mcp-code-box').isHidden(), true);
  assert.equal(await panel.locator('#mcp-steps').isHidden(), true);
  await panel.locator('#mcp-activate').click();
  await panel.getByText('Acesso preparado. Agora baixe a extensão.').waitFor();
  assert.deepEqual(calls.at(-1), ['ativar', true, true]);

  backendState = 'erro';
  await page.evaluate(() => window.carregarMcp());
  await panel.getByText('O acesso precisa ser preparado de novo.').waitFor();
  await expectState(panel, 'erro', 'Refazer acesso');
  assert.equal(await panel.locator('#mcp-activate').isDisabled(), true);
  assert.equal(await panel.locator('#mcp-compat-note').isVisible(), false);
  await panel.locator('#mcp-confirm').check();
  assert.equal(await panel.locator('#mcp-activate').isEnabled(), true);
  await panel.locator('#mcp-activate').click();
  await panel.getByText('Acesso preparado. Agora baixe a extensão.').waitFor();
  assert.deepEqual(calls.at(-1), ['ativar', true, true]);

  await panel.getByText('Desligar acesso do Claude').click();
  assert.equal(await panel.locator('#mcp-revoke').isDisabled(), true);
  await panel.locator('#mcp-stop-confirm').check();
  await panel.locator('#mcp-revoke').click();
  await panel.getByText('Acesso desligado.').waitFor();
  await expectState(panel, 'desligado', 'Preparar acesso');
  assert.deepEqual(calls.at(-1), ['revogar', 'DESLIGAR']);

  compatible = false;
  await page.evaluate(() => window.carregarMcp());
  await panel.getByText('O acesso precisa de atenção.').waitFor();
  await expectState(panel, 'erro', 'Ver o que fazer');
  assert.equal(await panel.locator('#mcp-confirm-row').isHidden(), true);
  await panel.locator('#mcp-open-help').click();
  await panel.getByText(/sistema ainda não é compatível/i).waitFor();

  compatible = true;
  packageAvailable = false;
  await page.evaluate(() => window.carregarMcp());
  await expectState(panel, 'erro', 'Ver o que fazer');
  assert.match(await panel.locator('#mcp-compat-note').textContent(), /extensão do Lume não está disponível/i);

  packageAvailable = true;
  installation = 'detectado';
  await page.evaluate(() => window.carregarMcp());
  await expectState(panel, 'desligado', 'Preparar acesso');
  await panel.getByText(/Lume encontrou o Claude Desktop/i).last().waitFor({ state: 'attached' });

  for (const width of [1320, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await panel.locator('.mcp-primary-next:visible').count(), 1);
  }
  await panel.locator('#mcp-open-pessoal').click();
  assert.equal(await page.locator('#pessoal-panel').isVisible(), true);
  assert.equal(await page.evaluate(()=>document.activeElement?.id), 'pessoal-title');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, states: ['desligado', 'autorizado', 'preparado', 'pronto-para-teste', 'erro'], onePrimaryAction: true, reloadWithoutCode: true, orderedInstall: true, honestLocalTest: true, troubleshooting: true, chatgptPersonalLink: true, revoke: true, widths: [390, 820, 1320] }));
} finally {
  await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
}

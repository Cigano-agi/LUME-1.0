import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';

let state = { disponivel: true, consentido: false, situacao: 'desligado', comunicado: null };
const calls = [];
const novidades = {
  estado: () => ({ ...state }),
  ativar: () => { calls.push('ativar'); state = { ...state, consentido: true, situacao: 'ativo' }; return { ...state }; },
  verificar: async () => {
    calls.push('verificar');
    state = { ...state, situacao: 'comunicado', comunicado: { id: 'busca-facil', titulo: 'Busca mais simples', texto: 'Agora ficou mais fácil encontrar uma conversa. <img src=x onerror=alert(1)>', acao: 'ver_atualizacoes' } };
    return { ...state };
  },
  desativar: () => { calls.push('desativar'); state = { ...state, consentido: false, situacao: 'desligado', comunicado: null }; return { ...state }; }
};

const db = abrirBanco();
const server = criarServidor(db, { desktop: true, novidades, conexao: { estado: () => ({ estado: 'desconectada', qr: null }), iniciar: async () => {}, parar: async () => {} } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
const errors = [], external = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', route => {
  if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort(); }
  return route.continue();
});

try {
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Pessoa teste');
  await page.locator('#consent').check();
  await page.getByRole('button', { name: 'Preparar meu espaço' }).click();
  await page.locator('#skip').click();
  await page.locator('#first-hide').click();
  await page.locator('nav [data-view=settings]').click();
   await page.locator('#settings-choice-data').click();

  const panel = page.locator('#novidades-panel');
  await panel.getByRole('heading', { name: 'Novidades do Lume' }).waitFor();
  await panel.getByText('Novidades desligadas.').waitFor();
  assert.match(await panel.textContent(), /separado do acompanhamento técnico/i);
  assert.match(await panel.textContent(), /Não envia mensagens, contatos, buscas, aberturas ou cliques/);
  assert.equal(await panel.locator('#novidades-confirm').isChecked(), false);

  await panel.getByRole('button', { name: 'Ativar novidades' }).click();
  await page.locator('#feedback').getByText('Marque sua escolha').waitFor();
  assert.deepEqual(calls, []);
  await panel.locator('#novidades-confirm').check();
  await panel.getByRole('button', { name: 'Ativar novidades' }).click();
  await page.locator('#novidades-notice').getByText('Busca mais simples').waitFor();
  assert.deepEqual(calls, ['ativar', 'verificar']);
  assert.equal(await page.locator('#novidades-notice a').count(), 0);
  assert.equal(await page.locator('#novidades-notice img').count(), 0);
  assert.match(await page.locator('#novidades-notice-text').textContent(), /<img src=x/);
  await page.locator('#novidades-notice').getByRole('button', { name: 'Ver atualizações' }).click();
  await page.locator('#atualizacoes-panel').waitFor();

  await panel.getByRole('button', { name: 'Desligar novidades' }).click();
  await panel.getByText('Novidades desligadas.').waitFor();
  assert.deepEqual(calls, ['ativar', 'verificar', 'desativar']);

  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(JSON.stringify({ passed: true, optIn: true, separateFromCentral: true, safeAction: true, optOut: true, widths: [390, 1100] }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
}

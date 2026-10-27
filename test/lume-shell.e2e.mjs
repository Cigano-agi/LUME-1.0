// Visual shell contract with real local HTTP and synthetic data only.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { perfilHoje } from './fixtures/hoje-profile.js';

const db = abrirBanco();
const { contexto, adicionar } = perfilHoje(db);
adicionar({ tipo: 'compromisso', texto: 'Confirmar a revisão da proposta' });
adicionar({ tipo: 'lead', texto: 'Retomar a conversa sobre orçamento' });
adicionar({ tipo: 'pendencia', texto: 'Conferir os dados do contrato' });

const server = criarServidor(db, {
  contexto,
  desktop: true,
  conexao: { estado: () => ({ estado: 'desconectada', qr: null }), iniciar: async () => {}, parar: async () => {} },
  gerarIA: async () => { throw new Error('Provider forbidden'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const out = 'work/lume-shell-qa';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Pessoa de teste');
  await page.locator('#consent').check();
  await page.getByRole('button', { name: 'Preparar meu espaço' }).click();
  await page.locator('#skip').click();
  await page.locator('#first-hide').click();
  await page.locator('#first-use').waitFor({ state: 'hidden' });

  for (const width of [390, 820, 1320]) {
    await page.setViewportSize({ width, height: 950 });
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const header = await page.locator('.sidebar').boundingBox();
    const main = await page.locator('main').boundingBox();
    assert.ok(header && header.height <= 72, `top navigation exceeds 72px at ${width}`);
    assert.equal(Math.round(header.x), 0);
    assert.equal(Math.round(header.width), width);
    assert.equal(Math.round(main.x), 0, `main still has a left sidebar offset at ${width}`);
    assert.equal(await page.locator('nav [data-view]').count(), 4);
    assert.equal(await page.locator('nav [data-view].active').count(), 1);
    for (const button of await page.locator('nav [data-view]').all()) {
      const box = await button.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `navigation label clips at ${width}`);
    }
    await page.screenshot({ path: `${out}/home-${width}.png`, fullPage: true });
    await page.locator('nav [data-view="memory"]').click();
    assert.equal(await page.locator('#memory').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${out}/conversations-${width}.png`, fullPage: true });
    await page.locator('nav [data-view="today"]').click();
  }

  const css = readFileSync('src/painel/lume-theme.css', 'utf8');
  assert.doesNotMatch(css, /gradient|backdrop-filter|cursor\s*:/i);
  assert.match(css, /--lume-green:/);
  assert.match(css, /--lume-blue:/);
  assert.match(css, /--lume-amber:/);
  assert.deepEqual(errors, []);
  console.log('LUME_SHELL_UI_OK');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
}

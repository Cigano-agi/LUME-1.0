import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { perfilGrafo } from './fixtures/graph-profile.js';
import { registrarPessoa } from '../src/pessoas.js';

const evidenceDir = 'docs/nota-7/wave-02/evidence/ui';
mkdirSync(evidenceDir, { recursive: true });

const db = abrirBanco();
const f = perfilGrafo(db);

// Synthetic fixtures
f.conversa('principal', 'Ateliê Horizonte · conversa de teste sintética');
for (let i = 0; i < 5; i++) {
  const autor = 'pessoa-' + i;
  registrarPessoa(db, { identificador: autor, nomeCru: 'Pessoa ' + i });
  f.evento('principal', autor, { permissao: 'dirigida', texto: 'Mensagem de teste sintética ' + i });
}

let provider = 0;
const server = criarServidor(db, {
  contexto: f.contexto,
  desktop: true,
  conexao: {
    estado: () => ({ estado: 'desconectada', qr: null }),
    iniciar: async () => {},
    parar: async () => {}
  },
  gerarIA: async () => {
    provider++;
    throw Error('Forbidden');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  reducedMotion: 'reduce'
});

const errors = [];
const external = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/*', r => {
  if (!r.request().url().startsWith(origin)) {
    external.push(r.request().url());
    return r.abort();
  }
  return r.continue();
});

try {
  // Onboarding bypass
  await page.goto(origin + '/app');
  await page.locator('#owner').fill('Bruno Teste');
  await page.locator('#consent').check();
  await page.getByRole('button', { name: 'Preparar meu espaço' }).click();
  await page.locator('#skip').click();

  // Navigate to Conversas (memory view)
  await page.locator('nav [data-view=memory]').click();
  await page.locator('#memory-modes').waitFor();
  assert.equal(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    true,
    'Reduced-motion browser preference was not applied'
  );

  const expectedModes = ['search', 'ask', 'contacts', 'conversations', 'businesses', 'commands'];
  const tabLocators = expectedModes.map(m => page.locator(`#memory-mode-${m}`));

  // 1. Verify all 6 tabs exist and have text
  for (let i = 0; i < expectedModes.length; i++) {
    const loc = tabLocators[i];
    await loc.waitFor();
    const text = (await loc.innerText()).trim();
    assert.ok(text.length > 0, `Mode ${expectedModes[i]} has empty text`);
  }

  // 2. Measure internal clipping & overflow at 390px
  await page.setViewportSize({ width: 390, height: 844 });
  const measure390 = await page.evaluate(() => {
    const container = document.querySelector('#memory-modes');
    const cRect = container.getBoundingClientRect();
    const buttons = [...container.querySelectorAll('[data-memory-mode]')];
    const buttonData = buttons.map(b => {
      const r = b.getBoundingClientRect();
      return {
        id: b.id,
        mode: b.dataset.memoryMode,
        text: b.innerText.trim(),
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        // clipped inside container boundaries:
        clippedRight: r.right > cRect.right + 1,
        clippedLeft: r.left < cRect.left - 1,
        clippedTop: r.top < cRect.top - 1,
        clippedBottom: r.bottom > cRect.bottom + 1
      };
    });
    return {
      scrollWidth: container.scrollWidth,
      clientWidth: container.clientWidth,
      hasInternalOverflow: container.scrollWidth > container.clientWidth + 1,
      hasExternalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      buttonData,
      anyButtonClipped: buttonData.some(b => b.clippedRight || b.clippedLeft)
    };
  });

  console.log('Measurement at 390px:', JSON.stringify(measure390, null, 2));

  // Assert internal clipping at 390:
  // Neither internal overflow nor button clipping should occur in GREEN state.
  // In RED state, this will FAIL if there is internal overflow or button clipping.
  assert.equal(
    measure390.hasExternalOverflow,
    false,
    'External overflow detected at 390px'
  );
  assert.equal(
    measure390.hasInternalOverflow,
    false,
    `Internal overflow detected in #memory-modes at 390px: scrollWidth=${measure390.scrollWidth} > clientWidth=${measure390.clientWidth}`
  );
  assert.equal(
    measure390.anyButtonClipped,
    false,
    `Buttons clipped inside #memory-modes at 390px: ${JSON.stringify(measure390.buttonData.filter(b => b.clippedRight || b.clippedLeft))}`
  );

  // 3. Test keyboard navigation and reachability of all 6 tabs
  // Focus on the currently active tab in #memory-modes
  await page.locator('#memory-mode-conversations').focus();
  let activeId = await page.evaluate(() => document.activeElement.id);
  assert.equal(activeId, 'memory-mode-conversations');

  // Navigate using ArrowRight through all tabs, including wrap-around.
  const keyboardOrder = ['businesses', 'commands', 'search', 'ask', 'contacts', 'conversations'];
  for (const mode of keyboardOrder) {
    await page.keyboard.press('ArrowRight');
    const focused = await page.evaluate(() => ({
      id: document.activeElement.id,
      mode: document.activeElement.dataset.memoryMode,
      selected: document.activeElement.getAttribute('aria-selected') === 'true',
      tabIndex: document.activeElement.tabIndex,
      visible: !!document.activeElement.getClientRects().length
    }));
    assert.equal(focused.mode, mode, `ArrowRight did not reach ${mode}`);
    assert.equal(focused.selected, true, `Tab ${focused.id} not aria-selected after ArrowRight`);
    assert.equal(focused.tabIndex, 0, `Tab ${focused.id} tabIndex is not 0`);
    assert.equal(focused.visible, true, `Tab ${focused.id} disappeared after selection`);
  }

  // Home key should jump to first tab (search)
  await page.keyboard.press('Home');
  activeId = await page.evaluate(() => document.activeElement.id);
  assert.equal(activeId, 'memory-mode-search');
  assert.equal(await page.locator('#memory-mode-search').getAttribute('aria-selected'), 'true');

  // End key should jump to last tab (commands)
  await page.keyboard.press('End');
  activeId = await page.evaluate(() => document.activeElement.id);
  assert.equal(activeId, 'memory-mode-commands');
  assert.equal(await page.locator('#memory-mode-commands').getAttribute('aria-selected'), 'true');

  // Take screenshot with focus visible at 390px
  await page.screenshot({ path: join(evidenceDir, 'memory-modes-390-focus.png') });

  // 4. Multi-viewport and light/dark theme verification with screenshots
  const viewports = [
    { width: 390, height: 844, name: '390' },
    { width: 820, height: 1180, name: '820' },
    { width: 1440, height: 900, name: '1440' }
  ];

  const report = {
    date: new Date().toISOString(),
    viewports: {},
    themes: ['light', 'dark'],
    reducedMotion: true,
    errors,
    external,
    providerCalls: provider
  };

  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    report.viewports[vp.name] = {};

    for (const theme of ['light', 'dark']) {
      // Switch theme
      await page.evaluate(t => {
        document.documentElement.dataset.theme = t;
      }, theme);

      // Return to 'conversations' mode for consistent evidence captures
      await page.locator('#memory-mode-conversations').click();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });

      const check = await page.evaluate(() => {
        const container = document.querySelector('#memory-modes');
        const cRect = container.getBoundingClientRect();
        const buttons = [...container.querySelectorAll('[data-memory-mode]')];
        const hasExternalOverflow = document.documentElement.scrollWidth > window.innerWidth;
        const hasInternalOverflow = container.scrollWidth > container.clientWidth + 1;
        const mainNav = document.querySelector('.sidebar nav button[data-view="memory"]');
        const navText = [...mainNav.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes('Conversas'));
        const navRange = document.createRange();
        navRange.selectNodeContents(navText);
        const navTextRect = navRange.getBoundingClientRect();
        const navButtonRect = mainNav.getBoundingClientRect();
        const mainNavLabelFits = navTextRect.width > 0 && navTextRect.left >= navButtonRect.left - 1 && navTextRect.right <= navButtonRect.right + 1;
        const buttonFits = buttons.map(b => {
          const r = b.getBoundingClientRect();
          const label = b.querySelector('b').getBoundingClientRect();
          return {
            mode: b.dataset.memoryMode,
            width: r.width,
            height: r.height,
            visible: r.width > 0 && r.height > 0,
            fitsInside: r.right <= cRect.right + 1 && r.left >= cRect.left - 1,
            labelFits: label.left >= r.left - 1 && label.right <= r.right + 1
          };
        });
        return {
          hasExternalOverflow,
          hasInternalOverflow,
          mainNavLabelFits,
          allButtonsFit: buttonFits.every(b => b.fitsInside && b.visible && b.labelFits),
          buttonFits
        };
      });

      assert.equal(
        check.hasExternalOverflow,
        false,
        `External overflow at ${vp.width}px in ${theme} theme`
      );
      assert.equal(
        check.hasInternalOverflow,
        false,
        `Internal overflow at ${vp.width}px in ${theme} theme`
      );
      assert.equal(
        check.allButtonsFit,
        true,
        `Not all buttons fit inside container at ${vp.width}px in ${theme} theme: ${JSON.stringify(check.buttonFits)}`
      );
      assert.equal(check.mainNavLabelFits, true, `Main navigation label clipped at ${vp.width}px in ${theme} theme`);

      // Safe synthetic screenshot capture
      const shotPath = join(evidenceDir, `memory-modes-${vp.name}-${theme}.png`);
      await page.screenshot({ path: shotPath, fullPage: false });

      report.viewports[vp.name][theme] = {
        passed: true,
        mainNavLabelFits: check.mainNavLabelFits,
        buttonFits: check.buttonFits
      };
    }
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(provider, 0);

  report.passed = true;
  writeFileSync(join(evidenceDir, 'memory-navigation-report.json'), JSON.stringify(report, null, 2));
  console.log('E2E Memory Navigation test passed successfully!');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
}

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { perfilHoje } from './fixtures/hoje-profile.js';

const db = abrirBanco();
const { contexto } = perfilHoje(db);
let connection = { estado: 'desconectada', qr: null };
const server = criarServidor(db, {
  contexto,
  desktop: true,
  conexao: { estado: () => connection, iniciar: async () => {}, parar: async () => {} },
  gerarIA: async () => { throw new Error('Provider forbidden'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const evidenceDir = 'docs/evidencias-assessor-3';
mkdirSync(evidenceDir, { recursive: true });

async function enter(page) {
  await page.goto(origin + '/app');
  if (await page.locator('#onboarding').isVisible()) {
    await page.locator('#owner').fill('Pessoa de teste');
    await page.locator('#consent').check();
    await page.getByRole('button', { name: 'Preparar meu espaço' }).click();
    await page.locator('#skip').click();
  }
  await page.locator('#workspace').waitFor();
  if (await page.locator('#first-use').isVisible()) await page.locator('#first-hide').click();
}

async function renderBoard(page, id) {
  await page.evaluate(boardId => {
    document.getElementById(boardId)?.remove();
    const states = [
      ['idle', 'Acompanhando'],
      ['attentive', 'Precisa de você'],
      ['processing', 'Organizando'],
      ['success', 'Tudo certo'],
      ['alert', 'Falhou']
    ];
    const board = document.createElement('section');
    board.id = boardId;
    board.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f4f6f1;padding:70px 64px;display:grid;grid-template-columns:repeat(5,1fr);gap:20px;align-content:center;font-family:Manrope,Segoe UI,sans-serif';
    for (const [state, label] of states) {
      const card = document.createElement('article');
      card.style.cssText = 'min-height:260px;background:#fff;border:1px solid #d1dad3;border-top:5px solid #087a4d;border-radius:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:#132019';
      const mascot = document.querySelector('.home-status-mascot').cloneNode(true);
      mascot.classList.remove('home-status-mascot');
      mascot.style.cssText = 'width:92px;height:104px';
      window.lumeMascotState(mascot, state, `board:${state}`);
      const title = document.createElement('strong');
      title.textContent = label;
      title.style.cssText = 'font-size:16px';
      const code = document.createElement('small');
      code.textContent = state;
      code.style.cssText = 'font-size:11px;color:#59625b;letter-spacing:.08em;text-transform:uppercase';
      card.append(mascot, title, code);
      board.append(card);
    }
    document.body.append(board);
  }, id);
}

try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 760 } });
  const externalRequests = [];
  const pageErrors = [];
  page.on('request', request => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:')) externalRequests.push(url);
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await enter(page);

  const home = page.locator('#home-status');
  const mascot = home.locator('.lume-mascot');
  assert.equal(await home.getAttribute('aria-live'), 'polite');
  assert.equal(await mascot.getAttribute('aria-hidden'), 'true');
  assert.equal(await mascot.getAttribute('data-mascot-state'), 'attentive');
  assert.ok((await home.locator('#home-status-title').textContent())?.includes('não conectado'));
  assert.equal(await page.locator('.brand .lume-mascot:not([aria-hidden="true"])').count(), 0);

  const installCounter = () => page.evaluate(() => {
    window.__mascotMotionCalls = 0;
    const original = window.Motion.animate;
    window.Motion.animate = (target, keyframes, options) => {
      if (target?.classList?.contains('lume-mascot')) window.__mascotMotionCalls += 1;
      return original(target, keyframes, options);
    };
  });
  await installCounter();

  connection = { estado: 'reconectando', qr: null };
  await page.evaluate(() => status());
  await page.evaluate(() => status());
  assert.equal(await mascot.getAttribute('data-mascot-state'), 'processing');
  assert.equal(await page.evaluate(() => window.__mascotMotionCalls), 1, 'polling igual não deve reiniciar o gesto');

  connection = { estado: 'erro', qr: null };
  await page.evaluate(() => status());
  assert.equal(await mascot.getAttribute('data-mascot-state'), 'alert');

  connection = { estado: 'conectada', qr: null };
  await page.evaluate(() => status());
  assert.equal(await mascot.getAttribute('data-mascot-state'), 'success');
  await page.waitForTimeout(980);
  assert.equal(await mascot.getAttribute('data-mascot-state'), 'idle');

  await page.evaluate(() => {
    const homeStatus = document.querySelector('#home-status');
    homeStatus.dataset.state = 'error';
    window.lumeMascotState(homeStatus.querySelector('.lume-mascot'), 'processing', 'css-state-priority');
  });
  assert.equal(await mascot.locator('.mascot-body').evaluate(node => getComputedStyle(node).fill), 'rgb(49, 86, 211)', 'a cor deve seguir data-mascot-state, não o cartão pai');
  await page.evaluate(() => {
    const homeStatus = document.querySelector('#home-status');
    homeStatus.dataset.state = 'connected';
    window.lumeMascotState(homeStatus.querySelector('.lume-mascot'), 'idle', 'css-state-priority:reset');
  });

  await page.route('**/api/v3/resumo?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ erro: 'Falha sintética ao atualizar' }) }));
  await page.locator('#refresh').click();
  await page.locator('#refresh').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.equal(await home.getAttribute('data-state'), 'connected', 'a conexão real deve ser restaurada depois da falha dos dados');
  assert.equal(await mascot.getAttribute('data-mascot-state'), 'idle', 'falha de atualização não pode deixar o mascote processando');
  assert.match(await page.locator('#feedback').textContent(), /Falha sintética ao atualizar/);
  await page.unroute('**/api/v3/resumo?**');

  await renderBoard(page, 'mascot-states-board');
  await page.waitForTimeout(340);
  await page.locator('#mascot-states-board').screenshot({ path: `${evidenceDir}/lume-mascot-states.png` });

  const callsBeforeReduced = await page.evaluate(() => window.__mascotMotionCalls);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    const mascotNode = document.querySelector('#home-status .lume-mascot');
    window.lumeMascotState(mascotNode, 'processing', 'runtime-reduced:processing');
    window.lumeMascotState(mascotNode, 'alert', 'runtime-reduced:alert');
  });
  assert.equal(await page.evaluate(() => window.__mascotMotionCalls), callsBeforeReduced, 'movimento reduzido deve fazer zero chamadas ao Motion');
  assert.equal(await mascot.getAttribute('data-mascot-state'), 'alert');
  assert.equal(await mascot.evaluate(node => getComputedStyle(node).animationName), 'none');

  await renderBoard(page, 'mascot-reduced-board');
  assert.equal(await page.evaluate(() => window.__mascotMotionCalls), callsBeforeReduced, 'a prancha reduzida também deve ser estática');
  await page.locator('#mascot-reduced-board').screenshot({ path: `${evidenceDir}/lume-mascot-reduced-motion.png` });

  assert.deepEqual(externalRequests, []);
  assert.deepEqual(pageErrors, []);
  console.log('LUME_MASCOT_UI_OK');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
}

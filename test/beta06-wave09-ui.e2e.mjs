// E2E UI verification for Lume Beta 0.6 Wave 09.
// Tests F03 (semantic colors & real consumers), F05 (typography & density), F20 (phone vs PC pairing),
// F04/F25 (favicon & rounded dome ghost vector), F21 (finite motion & event instrumentation),
// Dark Mode eyebrow contrast (WCAG AA), and 390px mobile scroll/keyboard reachability.
// Synthetic in-memory DB only.

import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';
import {prepararEsquemaPessoas, registrarPessoa} from '../src/pessoas.js';
import {AcoesLume} from '../src/acoes-lume.js';

const output = 'work/wave09-ui';
mkdirSync(output, {recursive: true});

const db = abrirBanco(':memory:');
const {contexto, desktop, fontes, mensagem} = perfilBeta05(db, {agora: new Date('2026-09-26T14:00:00.000Z')});

// Seed synthetic contacts with NEW messages, preserving original profile fontes
prepararEsquemaPessoas(db);
registrarPessoa(db, {identificador: '5511999990001@s.whatsapp.net', nomeCru: 'Ana Ribeiro', origem: 'manual'});
mensagem({conversa: '5511999990001@s.whatsapp.net', nome: 'Ana Ribeiro', texto: 'Olá, envio a documentação solicitada.'});

registrarPessoa(db, {identificador: '5511999990002@s.whatsapp.net', nomeCru: 'Marcos Almeida', origem: 'manual'});
mensagem({conversa: '5511999990002@s.whatsapp.net', nome: 'Marcos Almeida', texto: 'Podemos alinhar a proposta na reunião.'});

registrarPessoa(db, {identificador: '5511999990003@s.whatsapp.net', nomeCru: 'Clara Martins', origem: 'manual'});
mensagem({conversa: '5511999990003@s.whatsapp.net', nome: 'Clara Martins', texto: 'Obrigada pelo retorno sobre a assessoria.'});

// Seed action so today has active yellow banner and cards
const actions = new AcoesLume(db);
actions.autorizar({conversa: 'demo-ana', permitida: true});
actions.registrar({
  eventoId: fontes.ana.id,
  candidatas: [{
    fonte: 'E' + fontes.ana.id,
    tipo: 'compromisso',
    resumo: 'Preparar a reunião de revisão com Ana',
    trecho: 'Nossa reunião de revisão ficou para 24/09 às 10h.',
    prazo_citado: '24/09 às 10h'
  }]
});

desktop.configurarGuia({dispensado: true});

const server = criarServidor(db, {
  contexto,
  desktop: true,
  conexao: {
    estado: () => ({estado: 'desconectada', qr: null}),
    parar: async () => {},
    iniciar: async () => { throw Error('Conexão proibida no ensaio sintético'); }
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({channel: 'msedge', headless: true});

const errors = [];
const external = [];
const evidence = {synthetic: true, wave: '09-ui', checks: {}, screenshots: []};

try {
  // Test 1: Favicon static route returns HTTP 200 with SVG
  const faviconRes = await fetch(`${origin}/favicon.svg`);
  assert.equal(faviconRes.status, 200, 'favicon.svg must return HTTP 200');
  assert.match(faviconRes.headers.get('content-type') || '', /image\/svg\+xml/, 'favicon content-type must be svg');
  const faviconSvg = await faviconRes.text();
  assert.match(faviconSvg, /<svg/, 'favicon must contain SVG markup');
  assert.match(faviconSvg, /M32 6C/, 'favicon must use rounded dome path');
  evidence.checks.favicon = {status: 200, roundedDome: true};

  // Setup page
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  page.on('pageerror', err => errors.push(err.message));
  page.on('request', req => { if (!req.url().startsWith(origin)) external.push(req.url()); });

  await page.goto(`${origin}/app`);
  await page.locator('#clarity-content:not([hidden])').waitFor();
  await page.locator('#luminus-banner').waitFor();

  // Test 2: F04/F25 Rounded Dome Mascot Vectors in DOM
  const mascotPaths = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll('.lume-mascot')].map(svg => svg.querySelector('path')?.getAttribute('d'));
    const faviconLink = document.querySelector('link[rel="icon"]')?.getAttribute('href');
    return {bodies, faviconLink};
  });
  assert.equal(mascotPaths.faviconLink, '/favicon.svg', 'favicon link in DOM');
  assert.ok(mascotPaths.bodies.length > 0, 'mascot bodies exist');
  for (const b of mascotPaths.bodies) {
    assert.doesNotMatch(b, /M32 3C/, 'mascot must NOT have pointy head M32 3C');
    assert.match(b, /M32 6C/, 'mascot must have rounded dome M32 6C');
  }
  evidence.checks.roundedDomeMascot = {count: mascotPaths.bodies.length, verified: true};

  // Test 3: F03 Semantic Color Tokens in Light Mode
  const lightTokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      pendency: style.getPropertyValue('--semantic-pendency').trim(),
      project: style.getPropertyValue('--semantic-project').trim(),
      person: style.getPropertyValue('--semantic-person').trim(),
      link: style.getPropertyValue('--semantic-link').trim(),
      deal: style.getPropertyValue('--semantic-deal').trim(),
      money: style.getPropertyValue('--semantic-money').trim()
    };
  });
  assert.equal(lightTokens.pendency, '#9a3412', 'semantic pendency token light');
  assert.equal(lightTokens.project, '#6d28d9', 'semantic project token light');
  assert.equal(lightTokens.person, '#1d4ed8', 'semantic person token light');
  assert.equal(lightTokens.link, '#0e7490', 'semantic link token light');
  assert.equal(lightTokens.deal, '#be185d', 'semantic deal token light');
  assert.equal(lightTokens.money, '#166534', 'semantic money token light');
  evidence.checks.lightSemanticTokens = lightTokens;

  // Test 4: Real UI Consumers of Semantic Colors in Light Mode
  const actionLabelColor = await page.locator('.acoes06-card .action-type-label').first().evaluate(el => getComputedStyle(el).color);
  assert.match(actionLabelColor, /rgb\(154,\s*52,\s*18\)/, 'action label uses semantic pendency color');
  evidence.checks.semanticConsumersLight = {
    pendency: {selector: '.acoes06-card .action-type-label', color: actionLabelColor, expected: 'rgb(154, 52, 18)'}
  };

  // Test 5: F05 Typography - Sans-serif across headings, NO Georgia
  const headingFonts = await page.evaluate(() => {
    const selectors = [
      'h1',
      '.luminus-head h2',
      '.clarity-section-head h2',
      '.clarity-practice h2',
      '#acoes06-title'
    ];
    return selectors.map(sel => {
      const el = document.querySelector(sel);
      return {selector: sel, font: el ? getComputedStyle(el).fontFamily : null};
    });
  });
  for (const h of headingFonts) {
    if (h.font) {
      assert.doesNotMatch(h.font, /Georgia/i, `Heading ${h.selector} must not contain Georgia`);
      assert.match(h.font, /Manrope|sans-serif|Segoe UI/i, `Heading ${h.selector} must use humanist sans-serif`);
    }
  }
  evidence.checks.typography = headingFonts;

  // Test 6: F01/F05 Yellow Card, Star, and Resolver CTA
  const bannerCheck = await page.evaluate(() => {
    const banner = document.querySelector('#luminus-banner');
    const star = banner?.querySelector('.clarity-spark')?.textContent || (banner?.textContent.includes('✦') ? '✦' : null);
    const style = banner ? getComputedStyle(banner) : null;
    const cta = document.querySelector('#luminus-body .resolver-open');
    return {
      visible: !!banner && style?.display !== 'none',
      bgImage: style?.backgroundImage,
      bgColor: style?.backgroundColor,
      star: star?.trim(),
      hasResolverCta: !!cta
    };
  });
  assert.ok(bannerCheck.visible, 'yellow banner is visible');
  assert.match(bannerCheck.bgImage || '', /gradient/i, 'banner has yellow gradient background');
  assert.ok(
    bannerCheck.bgImage.includes('251, 230, 155') ||
    bannerCheck.bgImage.includes('241, 205, 96') ||
    bannerCheck.bgImage.includes('fbe69b') ||
    bannerCheck.bgImage.includes('f1cd60'),
    'banner gradient contains yellow tones'
  );
  assert.equal(bannerCheck.star, '✦', 'banner has star ✦');
  assert.ok(bannerCheck.hasResolverCta, 'banner has Resolver com CTA');
  evidence.checks.yellowBanner = bannerCheck;

  // Test 7: F20 Pairing Copy (Phone vs PC)
  const pairingCopy = await page.evaluate(() => {
    const connectStep = document.querySelector('#connect-step')?.innerText || '';
    const settingsWhatsapp = document.querySelector('#settings-whatsapp')?.innerText || '';
    return {connectStep, settingsWhatsapp};
  });
  assert.match(pairingCopy.connectStep, /Aparelhos conectados/i, 'mentions Aparelhos conectados in connect step');
  assert.match(pairingCopy.connectStep, /computador/i, 'mentions computer in connect step');
  assert.match(pairingCopy.settingsWhatsapp, /Aparelhos conectados/i, 'mentions Aparelhos conectados in settings');
  assert.match(pairingCopy.settingsWhatsapp, /computador/i, 'mentions computer in settings');
  evidence.checks.pairingCopy = {verified: true};

  // Test 8: F21 Motion - Concurrency removal and event instrumentation
  // 8a: Verify CSS has no competing :hover transform and SVG children have pointer-events: none
  const cssMotionRules = await page.evaluate(() => {
    let hasMascotHoverTransform = false;
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText?.includes('.lume-mascot:hover') && rule.style?.transform) {
            hasMascotHoverTransform = true;
          }
        }
      } catch {}
    }
    const mascotPath = document.querySelector('.lume-mascot path');
    const pathPointerEvents = mascotPath ? getComputedStyle(mascotPath).pointerEvents : null;
    return {hasMascotHoverTransform, pathPointerEvents};
  });
  assert.equal(cssMotionRules.hasMascotHoverTransform, false, 'No competing CSS :hover transform on mascot');
  assert.equal(cssMotionRules.pathPointerEvents, 'none', 'SVG children have pointer-events: none');

  // 8b: Runtime event instrumentation in unconstrained motion page
  const motionPage = await browser.newPage({viewport: {width: 1440, height: 1000}, reducedMotion: 'no-preference'});
  try {
    await motionPage.goto(`${origin}/app`);
    await motionPage.locator('#clarity-content:not([hidden])').waitFor();
    const motionDispatchTest = await motionPage.evaluate(() => {
      let animCount = 0;
      const origAnimate = window.Motion?.animate;
      if (origAnimate) {
        window.Motion.animate = function(...args) {
          animCount++;
          return origAnimate.apply(this, args);
        };
      }
      const mascot = document.querySelector('.lume-mascot');
      const path = mascot?.querySelector('path');

      // 1. Dispatch pointerenter on mascot root
      const beforeMascot = animCount;
      mascot.dispatchEvent(new PointerEvent('pointerenter', {bubbles: false, cancelable: true}));
      const afterMascot = animCount;

      // 2. Dispatch pointerenter on child path
      path?.dispatchEvent(new PointerEvent('pointerenter', {bubbles: false, cancelable: true}));
      const afterChild = animCount;

      // 3. Dispatch pointerenter with relatedTarget inside mascot (internal transition)
      mascot.dispatchEvent(new PointerEvent('pointerenter', {bubbles: false, cancelable: true, relatedTarget: path}));
      const afterRelated = animCount;

      return {
        mascotDispatches: afterMascot - beforeMascot,
        childDispatches: afterChild - afterMascot,
        internalCrossingDispatches: afterRelated - afterChild,
        total: animCount
      };
    });
    assert.equal(motionDispatchTest.mascotDispatches, 1, 'Exactly one animation per entry into mascot');
    assert.equal(motionDispatchTest.childDispatches, 0, 'Zero animations on mascot child elements');
    assert.equal(motionDispatchTest.internalCrossingDispatches, 0, 'Zero animations on internal pointer movements');
    evidence.checks.mascotMotion = motionDispatchTest;
  } finally {
    await motionPage.close();
  }

  // Reduced motion test on primary page
  const reducedMotionCheck = await page.evaluate(() => {
    const mascot = document.querySelector('.lume-mascot');
    const style = mascot ? getComputedStyle(mascot) : null;
    let dispatchedAnimations = 0;
    const originalAnimate = window.Motion.animate;
    window.Motion.animate = (...args) => {
      dispatchedAnimations++;
      return originalAnimate(...args);
    };
    try {
      mascot.dispatchEvent(new PointerEvent('pointerenter', {bubbles: false}));
      mascot.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
    } finally {
      window.Motion.animate = originalAnimate;
    }
    return {
      transition: style?.transition,
      animation: style?.animation,
      isReduced: window.lumeReducedMotion?.(),
      dispatchedAnimations
    };
  });
  assert.equal(reducedMotionCheck.isReduced, true, 'Reduced motion is active');
  assert.equal(reducedMotionCheck.dispatchedAnimations, 0, 'Reduced motion suppresses mascot pointer and focus animations');
  evidence.checks.reducedMotion = reducedMotionCheck;

  // Screenshots in Light Mode (Hoje, Conversas, Pessoas, Vendas)
  // Hoje 1440 & 390
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: `${output}/today-1440.png`, fullPage: true});
  evidence.screenshots.push('today-1440.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Today overflow 1440');

  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: `${output}/today-390.png`, fullPage: true});
  evidence.screenshots.push('today-390.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Today overflow 390');

  // Open Resolver Dialog preview at 1440px
  await page.setViewportSize({width: 1440, height: 1000});
  await page.locator('#luminus-body .resolver-open').click();
  await page.locator('#resolver-dialog[open]').waitFor();
  await page.screenshot({path: `${output}/resolver-preview-1440.png`});
  evidence.screenshots.push('resolver-preview-1440.png');
  await page.keyboard.press('Escape');

  // Conversas 1440 & 390
  await page.locator('nav [data-view=memory]').click();
  await page.locator('#memory:not([hidden])').waitFor();
  await page.locator('#conversation-list .conversation-row').first().waitFor();
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: `${output}/conversas-1440.png`, fullPage: true});
  evidence.screenshots.push('conversas-1440.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Conversas overflow 1440');

  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: `${output}/conversas-390.png`, fullPage: true});
  evidence.screenshots.push('conversas-390.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Conversas overflow 390');

  // Pessoas (Contatos) 1440 & 390 with POPULATED synthetic contacts
  await page.locator('nav [data-route=contacts]').click();
  await page.waitForFunction(() => document.querySelector('#memory').dataset.mode === 'contacts');
  await page.locator('.contact-card').first().waitFor();

  const contactsLight = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.contact-card')];
    const h3 = cards[0]?.querySelector('h3');
    return {
      cardCount: cards.length,
      names: cards.map(c => c.querySelector('h3')?.textContent?.trim()),
      personColor: h3 ? getComputedStyle(h3).color : null
    };
  });
  assert.ok(contactsLight.cardCount >= 3, 'Pessoas directory is populated with synthetic contacts');
  assert.match(contactsLight.personColor || '', /rgb\(29,\s*78,\s*216\)/, 'contact card uses semantic person color in light mode');
  evidence.checks.semanticConsumersLight.person = {
    selector: '.contact-card h3',
    color: contactsLight.personColor,
    expected: 'rgb(29, 78, 216)',
    cardCount: contactsLight.cardCount,
    names: contactsLight.names
  };

  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: `${output}/pessoas-1440.png`, fullPage: true});
  evidence.screenshots.push('pessoas-1440.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Pessoas overflow 1440');

  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: `${output}/pessoas-390.png`, fullPage: true});
  evidence.screenshots.push('pessoas-390.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Pessoas overflow 390');

  // Vendas (Negócios) 1440 & 390
  await page.locator('nav [data-route=businesses]').click();
  await page.waitForFunction(() => document.querySelector('#memory').dataset.mode === 'businesses');
  await page.waitForFunction(() => document.querySelectorAll('.negocio-card').length > 0);
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: `${output}/vendas-1440.png`, fullPage: true});
  evidence.screenshots.push('vendas-1440.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Vendas overflow 1440');

  // Test real consumers of deal & money tokens in businesses view
  const dealTokensCheck = await page.evaluate(() => {
    const stage = document.querySelector('.sales-column > h3');
    const moneyVal = document.querySelector('.negocio-card p:first-of-type');
    return {
      stageColor: stage ? getComputedStyle(stage).color : null,
      moneyColor: moneyVal ? getComputedStyle(moneyVal).color : null
    };
  });
  assert.match(dealTokensCheck.stageColor || '', /rgb\(190,\s*24,\s*93\)/, 'sales column heading uses semantic deal color');
  assert.match(dealTokensCheck.moneyColor || '', /rgb\(22,\s*101,\s*52\)/, 'money paragraph uses semantic money color');
  evidence.checks.dealTokensCheck = dealTokensCheck;
  evidence.checks.semanticConsumersLight.deal = {selector: '.sales-column > h3', color: dealTokensCheck.stageColor, expected: 'rgb(190, 24, 93)'};
  evidence.checks.semanticConsumersLight.money = {selector: '.negocio-card p:first-of-type', color: dealTokensCheck.moneyColor, expected: 'rgb(22, 101, 52)'};

  // Boundary check: project semantic color is declared but component is absent from synthetic dataset
  evidence.checks.semanticConsumersLight.project = {
    absent: true,
    boundaryReason: 'Nenhum projeto cadastrado no perfil sintético; componente ausente sem inventar dados reais'
  };

  // 390px Kanban & Tab reachability test
  await page.setViewportSize({width: 390, height: 844});
  let focusedInPipeline = null;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    const tabInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.closest('.sales-pipeline')) return null;
      const rect = el.getBoundingClientRect();
      return {text: el.textContent?.trim(), rect: {left: rect.left, right: rect.right, width: rect.width}};
    });
    if (tabInfo) focusedInPipeline = tabInfo;
  }
  assert.ok(focusedInPipeline, 'Interactive elements in sales pipeline were reached via keyboard Tab');
  assert.ok(focusedInPipeline.rect.right <= 390, `Focused element right boundary (${focusedInPipeline.rect.right}) must be within 390px viewport`);
  assert.ok(focusedInPipeline.rect.left >= 0, `Focused element left boundary (${focusedInPipeline.rect.left}) must be >= 0`);
  evidence.checks.mobileAccessibility390 = {
    salesPipelineTabReachable: true,
    lastFocusedElement: focusedInPipeline
  };

  await page.screenshot({path: `${output}/vendas-390.png`, fullPage: true});
  evidence.screenshots.push('vendas-390.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Vendas overflow 390');

  // Dark Mode verification & screenshots
  await page.locator('nav [data-view=settings]').click();
  await page.locator('#settings-choice-data').click();
  await page.locator('#theme-mode').selectOption('dark');

  // Verify Dark Semantic Tokens
  const darkTokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      pendency: style.getPropertyValue('--semantic-pendency').trim(),
      project: style.getPropertyValue('--semantic-project').trim(),
      person: style.getPropertyValue('--semantic-person').trim(),
      link: style.getPropertyValue('--semantic-link').trim(),
      deal: style.getPropertyValue('--semantic-deal').trim(),
      money: style.getPropertyValue('--semantic-money').trim()
    };
  });
  assert.equal(darkTokens.pendency, '#fdba74', 'semantic pendency token dark');
  assert.equal(darkTokens.project, '#c4b5fd', 'semantic project token dark');
  assert.equal(darkTokens.person, '#93c5fd', 'semantic person token dark');
  assert.equal(darkTokens.link, '#67e8f9', 'semantic link token dark');
  assert.equal(darkTokens.deal, '#f9a8d4', 'semantic deal token dark');
  assert.equal(darkTokens.money, '#86efac', 'semantic money token dark');
  evidence.checks.darkSemanticTokens = darkTokens;

  // Hoje Dark 1440 & 390
  await page.locator('nav [data-view=today]').click();
  await page.locator('#today:not([hidden])').waitFor();

  // Eyebrow Contrast Measurement in Dark Mode on "AÇÕES COM ORIGEM"
  const eyebrowContrast = await page.evaluate(() => {
    const el = document.querySelector('#acoes06 .panel-title .eyebrow');
    if (!el) return {error: 'eyebrow not found'};
    const cs = getComputedStyle(el);
    let bgEl = el;
    let bg = cs.backgroundColor;
    while (bgEl && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
      bgEl = bgEl.parentElement;
      if (bgEl) bg = getComputedStyle(bgEl).backgroundColor;
    }

    function parseRgb(str) {
      const m = str.match(/(\d+),\s*(\d+),\s*(\d+)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
    }
    function relLuminance([r, g, b]) {
      const ch = [r, g, b].map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    }
    function contrastRatio(fg, bg) {
      const l1 = relLuminance(fg), l2 = relLuminance(bg);
      const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    const fgRgb = parseRgb(cs.color);
    const bgRgb = parseRgb(bg);
    const ratio = contrastRatio(fgRgb, bgRgb);

    return {
      selector: '#acoes06 .panel-title .eyebrow',
      text: el.textContent?.trim(),
      after: {
        color: cs.color,
        bg,
        ratio: Number(ratio.toFixed(2)),
        status: ratio >= 4.5 ? 'PASS' : 'FAIL'
      }
    };
  });
  assert.equal(eyebrowContrast.after.status, 'PASS', 'Dark mode eyebrow contrast must pass AA (ratio >= 4.5:1)');
  evidence.checks.eyebrowContrast = eyebrowContrast;

  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: `${output}/today-dark-1440.png`, fullPage: true});
  evidence.screenshots.push('today-dark-1440.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Today dark overflow 1440');

  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: `${output}/today-dark-390.png`, fullPage: true});
  evidence.screenshots.push('today-dark-390.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Today dark overflow 390');

  // Pessoas Dark 1440 & 390 (proving dark mode --semantic-person consumer)
  await page.locator('nav [data-route=contacts]').click();
  await page.waitForFunction(() => document.querySelector('#memory').dataset.mode === 'contacts');
  await page.locator('.contact-card').first().waitFor();

  const contactsDark = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.contact-card')];
    const h3 = cards[0]?.querySelector('h3');
    return {
      cardCount: cards.length,
      personColor: h3 ? getComputedStyle(h3).color : null
    };
  });
  assert.match(contactsDark.personColor || '', /rgb\(147,\s*197,\s*253\)/, 'contact card uses dark semantic person color');
  evidence.checks.semanticConsumersDark = {
    person: {selector: '.contact-card h3', color: contactsDark.personColor, expected: 'rgb(147, 197, 253)'}
  };

  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: `${output}/pessoas-dark-1440.png`, fullPage: true});
  evidence.screenshots.push('pessoas-dark-1440.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Pessoas dark overflow 1440');

  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: `${output}/pessoas-dark-390.png`, fullPage: true});
  evidence.screenshots.push('pessoas-dark-390.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Pessoas dark overflow 390');

  // Save evidence
  assert.deepEqual(errors, [], 'No unexpected page errors');
  assert.deepEqual(external, [], 'No external requests made');
  evidence.errors = errors;
  evidence.external = external;
  writeFileSync(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));

  console.log(JSON.stringify({ok: true, output, checks: Object.keys(evidence.checks), screenshots: evidence.screenshots}));
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  db.close();
}

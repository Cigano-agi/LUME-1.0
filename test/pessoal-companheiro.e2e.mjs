// Synthetic preload + in-memory app. Does not launch Electron or access accounts.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';

const output = new URL('../work/pessoal-qa-20261026/', import.meta.url);
await mkdir(output, {recursive: true});
const files = new Map(await Promise.all(['companheiro.html', 'companheiro.css', 'companheiro.js'].map(async name => [name, await readFile(new URL('../desktop/' + name, import.meta.url))])));
const server = createServer((request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (!files.has(name)) {response.writeHead(404).end();return;}
  response.writeHead(200, {'Content-Type': name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'text/javascript'}).end(files.get(name));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const db = abrirBanco();
const appServer = criarServidor(db, {desktop: true, conexao: {estado: () => ({estado: 'desconectada', qr: null}), iniciar: async () => {}, parar: async () => {}}});
await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, appOrigin = `http://127.0.0.1:${appServer.address().port}`;
const browser = await chromium.launch({channel: 'chrome', headless: true});
const context = await browser.newContext({viewport: {width: 320, height: 240}, reducedMotion: 'no-preference'});
const page = await context.newPage(), errors = [], violations = [], external = [], proofs = [];
page.setDefaultTimeout(10000);
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {if (message.type() === 'error' && /Content Security Policy|Refused/.test(message.text())) violations.push(message.text());});
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if ([origin, appOrigin].includes(url.origin)) return route.continue();
  external.push(url.origin); return route.abort();
});
await page.addInitScript(() => {
  let callback, snapshot = {estado: 'aguardando', mensagem: 'Quando precisar, estou por aqui.', notificacaoId: 'restored-notification-private', som: true};
  const fixture = window.fixture = {opened: 0, hidden: 0, sounds: [], unsubscribe: 0, audioStarts: 0, gains: [], resumeBlocked: false, pendingResume: null, holdOpen: false};
  const instances = [];
  fixture.emit = next => {snapshot = next; callback?.(snapshot);};
  fixture.blockAudio = () => {fixture.resumeBlocked = true; instances.forEach(instance => instance.state = 'suspended');};
  fixture.releaseAudio = () => {fixture.resumeBlocked = false; instances.forEach(instance => instance.state = 'running'); fixture.pendingResume?.();};
  window.AudioContext = class {
    constructor() {this.state = fixture.resumeBlocked ? 'suspended' : 'running';this.currentTime = 0;this.destination = {};instances.push(this);}
    resume() {if (!fixture.resumeBlocked) {this.state = 'running'; return Promise.resolve();}return new Promise(resolve => fixture.pendingResume = resolve);}
    createOscillator() {return {frequency: {setValueAtTime() {}}, connect() {}, disconnect() {}, start() {fixture.audioStarts++;}, stop() {}};}
    createGain() {return {gain: {setValueAtTime() {}, linearRampToValueAtTime(value) {fixture.gains.push(value);}, exponentialRampToValueAtTime() {}}, connect() {}, disconnect() {}};}
    close() {this.state = 'closed';return Promise.resolve();}
  };
  window.lumeCompanheiro = Object.freeze({
    onState(cb) {callback = cb;cb(snapshot);return () => {fixture.unsubscribe++;callback = null;};},
    abrir() {fixture.opened++;return fixture.holdOpen ? new Promise(() => {}) : Promise.resolve();},
    ocultar() {fixture.hidden++;return Promise.resolve();},
    som(enabled) {fixture.sounds.push(enabled);if (fixture.holdSound) return new Promise(resolve => fixture.pendingSound = resolve);fixture.emit({...snapshot, som: enabled});return Promise.resolve();}
  });
});
const emit = payload => page.evaluate(next => window.fixture.emit(next), payload);
const starts = () => page.evaluate(() => window.fixture.audioStarts);
const shot = name => page.screenshot({path: fileURLToPath(new URL(name, output)), omitBackground: true});
let panelContext;
try {
  await page.goto(origin + '/companheiro.html');
  await page.clock.install();
  assert.equal(await starts(), 0, 'Restored snapshot never creates sound');
  assert.equal(await page.locator('#som').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#companheiro').getAttribute('data-state'), 'aguardando');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 320 && document.documentElement.scrollHeight <= 240), true);
  assert.equal(await page.locator('body').evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('script:not([src]),style,[style],[onclick]').count(), 0, 'No inline script/style/event handler');
  assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.equal((await page.content()).includes('restored-notification-private'), false, 'Notification IDs stay out of DOM');
  assert.equal(await page.locator(':focus').count(), 0, 'No autofocus on creation');
  await page.clock.runFor(450);
  assert.equal(await page.locator('.ghost').evaluate(e => getComputedStyle(e).animationName), 'none');
  await shot('companheiro-aguardando.png');
  proofs.push('320×240 transparente, CSP restrita, sem inline/foco automático, IDs fora do DOM e restauração silenciosa.');

  await emit({estado: 'trabalhando', mensagem: 'Conferindo o próximo passo no Lume.', notificacaoId: null, som: false});
  assert.equal(await page.locator('.ghost').evaluate(e => getComputedStyle(e).animationName), 'working-float');
  await shot('companheiro-trabalhando.png');
  await emit({estado: 'atencao', mensagem: 'Há uma decisão esperando por você.', notificacaoId: 'silent-notice', som: false});
  await shot('companheiro-atencao.png');
  assert.equal(await starts(), 0);
  await page.locator('#som').click();
  await page.waitForFunction(() => document.getElementById('som').disabled === false);
  assert.deepEqual(await page.evaluate(() => fixture.sounds), [true]);
  assert.equal(await starts(), 0, 'Opt-in must not play old notification');
  await emit({estado: 'atencao', mensagem: 'Um novo aviso está no Lume.', notificacaoId: 'new-notice', som: true});
  await page.waitForFunction(() => fixture.audioStarts === 2);
  await emit({estado: 'atencao', mensagem: 'Um novo aviso está no Lume.', notificacaoId: 'new-notice', som: true});
  await emit({estado: 'atencao', mensagem: 'Aviso anterior.', notificacaoId: 'silent-notice', som: true});
  assert.equal(await starts(), 2, 'Repeated and previously silent IDs never play');
  assert.ok((await page.evaluate(() => fixture.gains)).every(value => value <= .022));
  await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable: true, value: true});document.dispatchEvent(new Event('visibilitychange'));});
  await emit({estado: 'atencao', mensagem: 'Aviso durante janela oculta.', notificacaoId: 'hidden-notice', som: true});
  await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable: true, value: false});document.dispatchEvent(new Event('visibilitychange'));});
  await emit({estado: 'atencao', mensagem: 'Aviso durante janela oculta.', notificacaoId: 'hidden-notice', som: true});
  assert.equal(await starts(), 2, 'Hidden notification not replayed on restore');
  await page.evaluate(() => fixture.blockAudio());
  await emit({estado: 'atencao', mensagem: 'Aviso bloqueado pelo navegador.', notificacaoId: 'blocked-notice', som: true});
  await page.clock.fastForward(401);
  await page.evaluate(() => fixture.releaseAudio());
  assert.equal(await starts(), 2, 'Blocked autoplay never queues old audio');
  await page.evaluate(() => fixture.holdSound = true);
  await page.locator('#som').click();
  await emit({estado: 'atencao', mensagem: 'Aviso enquanto desativa som.', notificacaoId: 'muting-notice', som: true});
  assert.equal(await starts(), 2, 'Mute takes effect while persistence is pending');
  await emit({estado: 'atencao', mensagem: 'Aviso com som desligado.', notificacaoId: 'muted-notice', som: false});
  await page.evaluate(() => {fixture.holdSound = false;fixture.pendingSound?.();});
  assert.equal(await starts(), 2);
  proofs.push('Som opt-in: duas notas suaves somente para ID novo; sem som inicial, repetido, antigo, oculto ou atrasado por autoplay. WebAudio instrumentado.');

  await emit({estado: 'pausado', mensagem: 'Você pode retomar pelo Lume.', notificacaoId: null, som: false});
  await shot('companheiro-pausado.png');
  await emit({estado: 'desconectado', mensagem: 'Abra o Lume para conferir a conexão.', notificacaoId: null, som: false});
  await shot('companheiro-desconectado.png');
  await emit({estado: 'inexistente', mensagem: 'Trabalhando em algo inventado', notificacaoId: 'invalid', som: true});
  assert.equal(await page.locator('#estado').textContent(), 'Sem conexão');
  assert.equal(await page.locator('#mensagem').textContent(), 'Abra o Lume para conferir.');
  await emit({estado: 'atencao', mensagem: '<img src=x onerror="window.injected=true">', notificacaoId: 'html-private-id', som: false});
  assert.equal(await page.locator('#mensagem').textContent(), '<img src=x onerror="window.injected=true">');
  assert.equal(await page.locator('#mensagem img').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
  await page.emulateMedia({reducedMotion: 'reduce'});
  await emit({estado: 'trabalhando', mensagem: 'Conferindo o próximo passo no Lume.', notificacaoId: null, som: false});
  assert.equal(await page.locator('.ghost').evaluate(e => getComputedStyle(e).animationName), 'none');
  assert.equal(await page.locator('.message-card').evaluate(e => getComputedStyle(e).animationName), 'none');
  await shot('companheiro-reduced-motion.png');
  proofs.push('Cinco estados explícitos; desconhecido falha para desconectado, HTML exibido como texto e reduced-motion sem animação.');

  await page.locator('#abrir').click();
  await page.waitForFunction(() => !document.getElementById('abrir').disabled);
  assert.equal(await page.evaluate(() => fixture.opened), 1);
  await page.locator('#ocultar').click();
  await page.waitForFunction(() => !document.getElementById('ocultar').disabled);
  assert.equal(await page.evaluate(() => fixture.hidden), 1);
  await page.evaluate(() => fixture.holdOpen = true);
  await page.locator('#abrir').click();
  await page.waitForFunction(() => fixture.opened === 2);
  await page.clock.fastForward(8001);
  await page.locator('#control-status').filter({hasText: 'Não consegui concluir'}).waitFor();
  assert.equal(await page.locator('#abrir').isDisabled(), false);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  assert.equal(await page.evaluate(() => fixture.unsubscribe), 1);
  proofs.push('Abrir/Ocultar/Som usam somente o preload; timeout de comando recupera controles; pagehide remove assinatura.');
  assert.deepEqual(errors, []); assert.deepEqual(violations, []); assert.deepEqual(external, []);

  // Actual Lume settings UI served with synthetic companion preferences.
  panelContext = await browser.newContext({viewport: {width: 1280, height: 1000}, reducedMotion: 'reduce'});
  const panelPage = await panelContext.newPage();
  panelPage.setDefaultTimeout(10000);
  let prefs = {enabled: false, som: false, disponivel: true}, fail = false, hold = false;
  const prefCalls = [], releases = [];
  await panelPage.route('**/api/v3/pessoal/companheiro', async route => {
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
    prefCalls.push({method: route.request().method(), body});
    if (hold) await new Promise(resolve => releases.push(resolve));
    if (fail) return route.fulfill({status: 500, json: {erro: 'Preferência temporariamente indisponível.'}}).catch(() => {});
    if (body) prefs = {...prefs, ...body};
    return route.fulfill({status: 200, json: prefs}).catch(() => {});
  });
  await panelPage.goto(appOrigin + '/app');
  await panelPage.locator('#owner').fill('Pessoa sintética');
  await panelPage.locator('#consent').check();
  await panelPage.getByRole('button', {name: 'Preparar meu espaço'}).click();
  await panelPage.locator('#skip').click();
  await panelPage.locator('#first-hide').click();
  await panelPage.evaluate(() => window.abrirAjuste('pessoal-panel'));
  assert.equal(prefCalls.length, 0, 'No preference request while detail is closed');
  await panelPage.locator('#pessoal-companion > summary').click();
  await panelPage.locator('#pessoal-companion-status').filter({hasText: 'Companheiro oculto'}).waitFor();
  assert.equal(await panelPage.locator('#pessoal-companion-sound').isChecked(), false);
  await panelPage.locator('#pessoal-companion-enabled').check();
  await panelPage.locator('#pessoal-companion-save').click();
  await panelPage.locator('#pessoal-companion-status').filter({hasText: 'Companheiro ativado'}).waitFor();
  assert.deepEqual(prefCalls.find(call => call.method === 'POST').body, {enabled: true, som: false});
  await panelPage.locator('#pessoal-companion-sound').check();
  await panelPage.locator('#pessoal-companion-refresh').click();
  await panelPage.locator('#pessoal-companion-status').filter({hasText: 'ainda não foram salvas'}).waitFor();
  assert.equal(await panelPage.locator('#pessoal-companion-sound').isChecked(), true);
  await panelPage.locator('#pessoal-companion-enabled').uncheck();
  await panelPage.locator('#pessoal-companion-save').click();
  await panelPage.locator('#pessoal-companion-status').filter({hasText: 'Companheiro oculto'}).waitFor();
  assert.deepEqual(prefCalls.filter(call => call.method === 'POST').at(-1).body, {enabled: false, som: true});
  fail = true;
  await panelPage.locator('#pessoal-companion-refresh').click();
  await panelPage.locator('#pessoal-companion-status').filter({hasText: 'temporariamente indisponível'}).waitFor();
  assert.equal(await panelPage.locator('#pessoal-companion-refresh').isDisabled(), false);
  fail = false; hold = true;
  await panelPage.clock.install();
  await panelPage.locator('#pessoal-companion-enabled').check();
  await panelPage.locator('#pessoal-companion-save').click();
  await panelPage.waitForFunction(() => document.getElementById('pessoal-companion-save').disabled);
  await panelPage.clock.fastForward(15001);
  await panelPage.locator('#pessoal-companion-status').filter({hasText: 'O estado não foi confirmado'}).waitFor();
  assert.equal(await panelPage.locator('#pessoal-companion-save').isDisabled(), false);
  hold = false; releases.splice(0).forEach(resolve => resolve());
  await panelPage.locator('#pessoal-companion-refresh').click();
  await panelPage.locator('#pessoal-companion-status').filter({hasText: 'ainda não foram salvas'}).waitFor();
  await panelPage.clock.runFor(5000);
  await panelPage.locator('#pessoal-companion').screenshot({path: fileURLToPath(new URL('companheiro-preferencias.png', output))});
  proofs.push('Preferências opcionais: GET só aberto, POST explícito com enabled=false permitido, som padrão desligado, edição preservada e recuperação de erro/timeout sem repetição.');
  await writeFile(new URL('COMPANHEIRO-UI-prova.json', output), JSON.stringify({synthetic: true, nativeElectron: false, realSoundAudited: false, proofs, errors, violations, external, prefCalls}, null, 2));
  console.log(proofs.join('\n'));
} catch (error) {console.error(error);throw error;}
finally {
  await panelContext?.close(); await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => appServer.close(resolve)); db.close();
}

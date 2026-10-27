import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import vm from 'node:vm';
import { createDesktopBroker, createLegacySelectionGuard, createShutdownGate } from '../src/mcp/desktop-broker.js';

function syntheticProfile(t) {
  const parent = mkdtempSync(join(homedir(), 'lume-c3-review-'));
  const userData = join(parent, 'AssessorDesktop');
  mkdirSync(userData);
  t.after(() => {
    if (!resolve(parent).startsWith(resolve(homedir()) + sep) || !basename(parent).startsWith('lume-c3-review-')) throw Error('UNSAFE_TEST_CLEANUP');
    rmSync(parent, { recursive: true, force: true });
  });
  return { parent, userData, selection: { tipo: 'legado', id: 'legado', geracao: null, dataDir: join(userData, 'data') } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeController(profile, { createIdentity, publish, drain, close } = {}) {
  const events = [];
  const broker = {
    start: async () => { events.push('listen'); return { port: 41234 }; },
    admit: () => events.push('admit'),
    stopAdmission: () => events.push('cut'),
    drain: async () => { events.push('drain'); return drain ? drain() : { closed: true }; },
    close: async () => { events.push('close-begin'); await close?.(); events.push('close-end'); }
  };
  const controller = createDesktopBroker({ userData: profile.userData, selection: profile.selection,
    createIdentity: createIdentity ?? (async () => ({ certPem: 'synthetic' })),
    createBroker: () => { events.push('create-broker'); return broker; },
    publish: async args => { events.push('publish'); return publish ? publish(args, events) : { descriptor: {}, release: async () => events.push('release') }; },
    authorizeHello: () => ({ revision: 'synthetic' }), authorizeBegin: () => ({ revision: 'synthetic' }) });
  return { controller, events };
}

test('C3: guarda legada é síncrona, fixa data e recusa marker/troca de identidade', t => {
  const profile = syntheticProfile(t);
  mkdirSync(profile.selection.dataDir);
  const guard = createLegacySelectionGuard(profile);
  assert.equal(guard(), true);
  writeFileSync(join(profile.userData, 'perfil-ativo.json'), '{}');
  assert.equal(guard(), false);
  rmSync(join(profile.userData, 'perfil-ativo.json'));
  const moved = join(profile.userData, 'data-old');
  renameSync(profile.selection.dataDir, moved);
  mkdirSync(profile.selection.dataDir);
  assert.equal(guard(), false);
  assert.deepEqual(readdirSync(profile.userData).sort(), ['data', 'data-old']);
});

test('C3: data existente não pode trocar entre factory e primeiro await do boot', async t => {
  const profile = syntheticProfile(t);
  mkdirSync(profile.selection.dataDir);
  const x = fakeController(profile);
  renameSync(profile.selection.dataDir, join(profile.userData, 'data-old'));
  mkdirSync(profile.selection.dataDir);
  await assert.rejects(x.controller.start(), /PERFIL_SELECAO_ALTERADA/);
  assert.equal(x.events.includes('admit'), false);
  await x.controller.shutdown();
});

test('C3: data ausente no factory não aceita criação externa antes de ensureData', async t => {
  const profile = syntheticProfile(t);
  const x = fakeController(profile);
  mkdirSync(profile.selection.dataDir);
  await assert.rejects(x.controller.start(), /PERFIL_SELECAO_ALTERADA/);
  assert.equal(x.events.includes('admit'), false);
  await x.controller.shutdown();
});

test('C3: corte durante criação da identidade não publica, admite ou inicia listener', async t => {
  const profile = syntheticProfile(t), identity = deferred();
  const x = fakeController(profile, { createIdentity: () => identity.promise });
  const starting = x.controller.start();
  const stopping = x.controller.shutdown();
  identity.resolve({ certPem: 'synthetic' });
  await assert.rejects(starting, /BROKER_BOOT_CANCELLED/);
  assert.deepEqual(await stopping, { confirmed: true });
  assert.equal(x.events.includes('create-broker'), false);
  assert.equal(x.events.includes('listen'), false);
  assert.equal(x.events.includes('publish'), false);
  assert.equal(x.events.includes('admit'), false);
});

test('C3: descriptor próprio só é liberado depois de broker.close confirmado', async t => {
  const profile = syntheticProfile(t), closed = deferred();
  const x = fakeController(profile, { close: () => closed.promise });
  try {
    await x.controller.start();
    const stopping = x.controller.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(x.events.includes('release'), false, 'release não pode correr em paralelo ao close');
    closed.resolve();
    assert.deepEqual(await stopping, { confirmed: true });
    assert.ok(x.events.indexOf('close-end') < x.events.indexOf('release'));
  } finally { closed.resolve(); }
});

test('C3: falha de publish depois de listen não devolve confirmação de teardown', async t => {
  const profile = syntheticProfile(t);
  const x = fakeController(profile, { publish: async () => { throw Error('SYNTHETIC_PUBLISH_FAILURE'); } });
  await assert.rejects(x.controller.start(), /SYNTHETIC_PUBLISH_FAILURE/);
  const result = await x.controller.shutdown();
  assert.equal(result.confirmed, false, 'sem recibo do descriptor parcial não há teardown confirmado');
  assert.equal(x.events.includes('admit'), false);
});

test('C3: drain sem CLOSED permanece incerto mesmo após close e release', async t => {
  const profile = syntheticProfile(t);
  const x = fakeController(profile, { drain: async () => ({ closed: false }) });
  await x.controller.start();
  assert.deepEqual(await x.controller.shutdown(), { confirmed: false });
  assert.ok(x.events.indexOf('drain') < x.events.indexOf('close-end'));
  assert.ok(x.events.indexOf('close-end') < x.events.indexOf('release'));
});

test('C3: gate exige dois recibos em qualquer ordem e quit normal não vira instalação', async () => {
  for (const first of ['broker', 'utility']) {
    let installs = 0;
    const gate = createShutdownGate({ install: () => { installs++; } });
    const settled = gate.request('instalar');
    gate.report(first, true);
    assert.equal(installs, 0);
    gate.report(first === 'broker' ? 'utility' : 'broker', true);
    assert.equal(await settled, true);
    assert.equal(installs, 1);
  }
  let installs = 0;
  const gate = createShutdownGate({ install: () => { installs++; } });
  const first = gate.request('normal');
  assert.equal(gate.request('instalar'), first);
  gate.report('broker', true); gate.report('utility', true);
  assert.equal(await first, true);
  assert.equal(installs, 0);
  for (const denied of ['broker', 'utility']) {
    const another = createShutdownGate({ install: () => { installs++; } });
    const waiting = another.request('instalar');
    another.report(denied, false);
    another.report(denied === 'broker' ? 'utility' : 'broker', true);
    assert.equal(await waiting, false);
    assert.equal(installs, 0);
  }
});

test('C3: primeiro pedido de shutdown corta utility sem aguardar import resolvido', async () => {
  const source = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
  const begin = source.indexOf('function iniciarEncerramento(reason, alreadyReserved = false) {');
  const end = source.indexOf('function answer(', begin);
  assert.ok(begin >= 0 && end > begin, 'trecho real de main precisa ser encontrado');
  const events = [];
  const context = {
    shutdownPromise: null, shutdownGate: null, decision: 'idle', controller: null,
    saindo: false, encerrado: false, liberarSaida: false,
    active: { broker: { stopAdmission: () => events.push('broker-cut'), shutdown: async () => ({ confirmed: true }) },
      lifecycle: { iniciar: () => events.push('utility-cut') },
      terminal: Promise.resolve({ confirmado: true, code: 0 }), startPromise: Promise.resolve() },
    reserve: reason => { events.push('decision'); return reason === 'instalar'; },
    stopSideEffects: () => events.push('side-effects-cut'),
    atualizador: { encerrar: () => events.push('updater-cut'), instalarAgora: () => events.push('install') },
    brokerModulePromise: Promise.resolve({ createShutdownGate: () => ({ request: () => Promise.resolve(false), report: () => {} }) }),
    dialog: { showErrorBox: () => {} }, app: { quit: () => {} }
  };
  vm.runInNewContext(source.slice(begin, end), context, { filename: 'desktop/main.cjs:iniciarEncerramento' });
  const stopping = context.iniciarEncerramento('instalar');
  assert.deepEqual(events.slice(0, 4), ['decision', 'broker-cut', 'utility-cut', 'side-effects-cut']);
  assert.equal(events.includes('utility-cut'), true, 'utility intake precisa receber corte no primeiro pedido');
  await stopping;
});

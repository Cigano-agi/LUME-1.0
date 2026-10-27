import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopBroker, createLegacySelectionGuard, createShutdownGate } from '../src/mcp/desktop-broker.js';

const selection = userData => ({ tipo: 'legado', id: 'legado', geracao: null, dataDir: join(userData, 'data') });
function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'lume-main-broker-'));
  return { userData, selection: selection(userData), dispose: () => rmSync(userData, { recursive: true, force: true }) };
}
function harness({ publish = async () => ({ release: async () => {} }), listen } = {}) {
  const x = fixture(), events = [];
  const broker = { start: async () => { events.push('listen'); if (listen) await listen(); return { port: 1234 }; },
    admit: () => events.push('admit'), stopAdmission: () => events.push('cut'),
    drain: async () => { events.push('drain'); return { closed: true }; }, close: async () => events.push('close') };
  let callbacks;
  const controller = createDesktopBroker({ userData: x.userData, selection: x.selection,
    createIdentity: async () => ({ certPem: 'cert' }), createBroker: input => { callbacks = input; return broker; },
    publish: async args => { events.push('publish'); return publish(args); },
    authorizeHello: () => ({ revision: 'ok' }), authorizeBegin: () => ({ revision: 'ok' }) });
  return { ...x, events, controller, broker, callbacks: () => callbacks };
}
test('listen, descriptor protegido e admissão nessa ordem', async () => {
  const x = harness(); try { await x.controller.start(); assert.deepEqual(x.events.slice(0, 3), ['listen', 'publish', 'admit']); await x.controller.shutdown(); }
  finally { x.dispose(); }
});
test('falha de publicação e corte durante listen impedem admissão', async () => {
  const a = harness({ publish: async () => { throw Error('ACL'); } });
  try { await assert.rejects(a.controller.start()); assert.equal(a.events.includes('admit'), false); }
  finally { a.dispose(); }
  let continueListen; const pending = new Promise(resolve => { continueListen = resolve; });
  const b = harness({ listen: () => pending });
  try { const boot = b.controller.start(); const stop = b.controller.shutdown(); continueListen(); await assert.rejects(boot); await stop;
    assert.equal(b.events.includes('publish'), false); assert.equal(b.events.includes('admit'), false); }
  finally { b.dispose(); }
});
test('quit durante publicação libera descriptor próprio e nunca admite', async () => {
  let continuePublish, released = 0;
  const pending = new Promise(resolve => { continuePublish = resolve; });
  const x = harness({ publish: async () => { await pending; return { release: async () => { released++; } }; } });
  try {
    const boot = x.controller.start(); await new Promise(resolve => setImmediate(resolve));
    const shutdown = x.controller.shutdown(); continuePublish();
    await assert.rejects(boot); assert.deepEqual(await shutdown, { confirmed: true });
    assert.equal(x.events.includes('admit'), false); assert.equal(released, 1);
  } finally { x.dispose(); }
});
test('HELLO e BEGIN recusam markers e identidade alterada de data', async () => {
  const x = harness(); try {
    await x.controller.start();
    assert.deepEqual(x.callbacks().authorizeHello({}), { revision: 'ok' });
    writeFileSync(join(x.userData, 'perfil-publicacao.json'), '{}');
    assert.equal(x.callbacks().authorizeHello({}), null);
    assert.equal(x.callbacks().authorizeBegin({}), null);
    rmSync(join(x.userData, 'perfil-publicacao.json'));
    rmSync(x.selection.dataDir, { recursive: true }); mkdirSync(x.selection.dataDir);
    assert.equal(x.callbacks().authorizeHello({}), null);
    assert.equal(x.callbacks().authorizeBegin({}), null);
    await x.controller.shutdown();
  } finally { x.dispose(); }
});
test('falha de release deixa broker incerto', async () => {
  const x = harness({ publish: async () => ({ release: async () => { throw Error('replaced'); } }) });
  try { await x.controller.start(); assert.deepEqual(await x.controller.shutdown(), { confirmed: false }); }
  finally { x.dispose(); }
});
test('guard legado fixa data antes de admitir e recusa markers e troca de identidade', () => {
  const x = fixture(); try {
    const guard = createLegacySelectionGuard({ userData: x.userData, selection: x.selection });
    assert.equal(guard(), false); guard.ensureData(); assert.equal(guard(), true);
    writeFileSync(join(x.userData, 'perfil-ativo.json'), '{}'); assert.equal(guard(), false);
    rmSync(join(x.userData, 'perfil-ativo.json')); assert.equal(guard(), true);
    rmSync(x.selection.dataDir, { recursive: true }); mkdirSync(x.selection.dataDir); assert.equal(guard(), false);
  } finally { x.dispose(); }
});
test('instalar exige confirmação de broker e utility, qualquer ordem, uma vez', async () => {
  for (const order of ['broker', 'utility']) {
    let installs = 0; const gate = createShutdownGate({ install: () => { installs++; } });
    gate.request('instalar'); gate.report(order, true); assert.equal(installs, 0);
    gate.report(order === 'broker' ? 'utility' : 'broker', true); gate.report('utility', true);
    assert.equal(installs, 1);
  }
  for (const failed of ['broker', 'utility']) {
    let installs = 0; const gate = createShutdownGate({ install: () => installs++ });
    gate.request('instalar'); gate.report(failed, false); gate.report(failed === 'broker' ? 'utility' : 'broker', true);
    assert.equal(installs, 0);
  }
  const gate = createShutdownGate({ install: () => { throw Error('never'); } });
  assert.equal(gate.request('normal'), gate.request('instalar'));
  assert.equal(gate.reason(), 'normal');
});

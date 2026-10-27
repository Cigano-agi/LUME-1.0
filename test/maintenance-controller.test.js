import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { criarControladorManutencao } = require('../desktop/maintenance-controller.cjs');
const opId = '11111111-1111-4111-8111-111111111111';
const opId2 = '22222222-2222-4222-8222-222222222222';
const selection = { tipo: 'legado', id: 'legado', geracao: null,
  dataDir: 'synthetic/data', credenciaisDir: 'synthetic/credenciais' };

function fixture(overrides = {}) {
  const events = [], token = Object.freeze({});
  const receipt = { opId, kind: 'notetaker-delete', outcome: 'sem_mutacao', leaseClosed: true, markerRemoved: true };
  const api = {
    createMaintenanceMarker: async ({ opId: id }) => { events.push('marker'); return Object.freeze({ opId:id }); },
    markMaintenanceStarted: () => events.push('started'),
    acquireExclusiveNoMutation: async () => { events.push('lease'); return token; },
    finishMaintenanceWithoutMutation: async ({ noMutationToken, maintenanceHandle }) => {
      assert.strictEqual(noMutationToken, token); events.push('finish');
      return { ...receipt, opId:maintenanceHandle.opId };
    },
    releaseUnstartedMarker: async () => { events.push('release'); return { released: true }; },
    assertNormalBootAllowed: () => events.push('guard'),
    ...overrides.api
  };
  const broker = { stopAdmission: () => events.push('broker-cut'),
    shutdown: async () => { events.push('broker-drain'); return { confirmed: true }; } };
  const utility = { lifecycle: {
    cortarIntake: ({ opId:id }) => { events.push('intake-cut'); return Promise.resolve({ opId:id }); },
    iniciar: motivo => { events.push(`utility-${motivo}`); return true; }
  }, terminal: Promise.resolve({ confirmado: true, code: 0 }) };
  let restarts = 0;
  const controller = criarControladorManutencao({ userData: 'synthetic', selection,
    getBroker: () => broker, getUtility: () => utility, api,
    reserve: () => { events.push('reserve'); return true; },
    mostrarLocal: async () => events.push('local'),
    restart: async () => { events.push('restart'); restarts++; },
    onQuitReady: () => events.push('quit-ready'),
    ...overrides.controller });
  return { controller, events, api, broker, utility, receipt, restarts: () => restarts };
}

test('reserva, corte, ACK, marker, drain e lease seguem ordem; end reinicia só após recibo', async () => {
  const x = fixture();
  const pending = x.controller.beginMaintenance({ opId, kind: 'notetaker-delete' });
  assert.deepEqual(x.events.slice(0,3), ['reserve','broker-cut','intake-cut']);
  const handle = await pending;
  assert.deepEqual(x.events, ['reserve','broker-cut','intake-cut','marker','started','local',
    'broker-drain','utility-manutencao','lease']);
  assert.equal('db' in handle, false);
  const receipt = await x.controller.endMaintenance(handle);
  assert.deepEqual(receipt, x.receipt);
  assert.deepEqual(x.events.slice(-2), ['finish','restart']);
  assert.equal(x.controller.state(), 'normal');
});

test('erro final inclusive após unlink nunca reinicia automaticamente', async () => {
  const x = fixture({ api: { finishMaintenanceWithoutMutation: async () => { throw Error('POST_UNLINK_FSYNC'); } } });
  const handle = await x.controller.beginMaintenance({ opId, kind: 'notetaker-delete' });
  await assert.rejects(x.controller.endMaintenance(handle), /POST_UNLINK_FSYNC/);
  assert.equal(x.restarts(), 0);
  assert.equal(x.controller.state(), 'incerto');
});

test('ACK falho antes de marker exige ambos fechamentos e guard antes de nova geração', async () => {
  const x = fixture({ controller: { getUtility: () => ({ lifecycle: {
    cortarIntake: () => { x.events.push('intake-cut'); return Promise.reject(Error('ACK_AUSENTE')); },
    iniciar: motivo => { x.events.push(`utility-${motivo}`); return true; }
  }, terminal: Promise.resolve({ confirmado: true, code: 0 }) }) } });
  await assert.rejects(x.controller.beginMaintenance({ opId, kind: 'notetaker-delete' }), /ACK_AUSENTE/);
  assert.equal(x.events.includes('marker'), false);
  assert.deepEqual(x.events.slice(-5), ['local','broker-drain','utility-normal','guard','restart']);
  assert.equal(x.restarts(), 1);
});

test('quit pendente depois do corte finaliza sem instalar ou iniciar outra geração', async () => {
  const x = fixture();
  const handle = await x.controller.beginMaintenance({ opId, kind: 'notetaker-delete' });
  assert.equal(x.controller.requestQuit(), true);
  await x.controller.endMaintenance(handle);
  assert.equal(x.restarts(), 0);
  assert.deepEqual(x.events.slice(-2), ['finish','quit-ready']);
});

test('nova operação após retorno normal não herda promessa, token ou handle anterior', async () => {
  const x = fixture();
  const first = await x.controller.beginMaintenance({ opId, kind:'notetaker-delete' });
  await x.controller.endMaintenance(first);
  await assert.rejects(x.controller.endMaintenance(first), /HANDLE_INVALIDO/);
  const second = await x.controller.beginMaintenance({ opId:opId2, kind:'notetaker-delete' });
  assert.notStrictEqual(second, first);
  assert.equal(second.opId, opId2);
  await assert.rejects(x.controller.endMaintenance(first), /HANDLE_INVALIDO/);
  const receipt = await x.controller.endMaintenance(second);
  assert.equal(receipt.opId, opId2);
  assert.equal(x.restarts(), 2);
});

test('recuperação antes do início aceita apenas novo corte em nova geração', async () => {
  let generation = 0;
  const x = fixture({ controller:{ getUtility: () => {
    generation++;
    const failCut = generation === 1;
    return { lifecycle:{
      cortarIntake: () => { x.events.push('intake-cut'); return failCut
        ? Promise.reject(Error('ACK_AUSENTE')) : Promise.resolve({ opId:opId2 }); },
      iniciar: motivo => { x.events.push(`utility-${motivo}`); return true; }
    }, terminal:Promise.resolve({ confirmado:true, code:0 }) };
  } } });
  await assert.rejects(x.controller.beginMaintenance({ opId, kind:'notetaker-delete' }), /ACK_AUSENTE/);
  assert.equal(x.controller.state(), 'normal');
  const second = await x.controller.beginMaintenance({ opId:opId2, kind:'notetaker-delete' });
  await x.controller.endMaintenance(second);
  assert.equal(generation, 2);
  assert.equal(x.restarts(), 2);
});

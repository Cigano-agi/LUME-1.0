import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const nodeRequire = createRequire(import.meta.url);
const lifecycle = nodeRequire('../desktop/utility-lifecycle.cjs');
const realController = nodeRequire('../desktop/maintenance-controller.cjs');
const brokerModule = await import('../src/mcp/desktop-broker.js');
const opId = '11111111-1111-4111-8111-111111111111';
const source = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8')
  .replaceAll("import('../src/mcp/desktop-broker.js')", 'deps.brokerModule()')
  .replaceAll("import('../src/perfil-boot.js')", 'deps.bootModule()') +
  '\nglobalThis.testHooks = { iniciarManutencaoInterna, allowedNavigation, get active() { return active; }, get decision() { return decision; } };';
const heldSource = source.replace('return perfilBootPromise.then(({ envelopeLegado }) => {',
  'return deps.waitEnvironment().then(() => perfilBootPromise).then(({ envelopeLegado }) => {');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); }
  throw new Error('main fixture timeout');
}

function setup({ holdEnvironmentAt = 0, finishFailure = false } = {}) {
  const tempRoot = realpathSync(tmpdir());
  const prefix = 'lume-maintenance-main-';
  const userData = mkdtempSync(join(tempRoot, prefix));
  const events = [], workers = [], brokers = [], windows = [];
  let installs = 0, maintenanceController, environments = 0;
  const environmentHold = deferred();
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.url = ''; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => this.url;
      this.webContents.isLoading = () => false;
      this.webContents.executeJavaScript = script => { events.push(script.includes("='incerto'") ? 'state-incerto' : 'state-working'); return Promise.resolve(); };
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {} focus() {}
    loadURL(url) { this.url = url; events.push('web'); queueMicrotask(() => this.emit('ready-to-show')); return Promise.resolve(); }
    loadFile(file) { this.url = pathToFileURL(file).href; events.push('local'); return Promise.resolve(); }
  }
  const app = new EventEmitter();
  app.setName = () => {}; app.setAppUserModelId = () => {};
  app.setAboutPanelOptions = value => { app.aboutPanelOptions = value; };
  app.getPath = key => key === 'appData' ? dirname(userData) : userData;
  app.setPath = () => {}; app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve(); app.getVersion = () => '0.7'; app.isPackaged = false;
  app.quit = () => {
    const event = { prevented:false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event); events.push(event.prevented ? 'quit-blocked' : 'quit');
  };
  const defaultSession = new EventEmitter();
  defaultSession.setPermissionRequestHandler = () => {};
  defaultSession.setPermissionCheckHandler = () => {};
  const powerMonitor = new EventEmitter();
  let idleState='active';
  powerMonitor.getSystemIdleState = () => idleState;
  const api = {
    createMaintenanceMarker: async () => { events.push('marker'); return Object.freeze({ opId }); },
    markMaintenanceStarted: () => events.push('started'),
    acquireExclusiveNoMutation: async () => { events.push('lease'); return Object.freeze({}); },
    finishMaintenanceWithoutMutation: async () => {
      if (finishFailure) throw Error('POST_UNLINK_FSYNC');
      events.push('finish'); return { opId, kind:'notetaker-delete', outcome:'sem_mutacao', leaseClosed:true, markerRemoved:true };
    },
    releaseUnstartedMarker: async () => ({ released:true }),
    assertNormalBootAllowed: () => {}
  };
  const updater = { estado: () => ({ disponivel:true, estado:'pronta' }),
    prepararInstalacao: () => { events.push('prepare-install'); return {}; },
    instalarAgora: () => { installs++; events.push('install'); },
    encerrar: () => {}, iniciarAutomatico: () => {} };
  const deps = {
    waitEnvironment: () => ++environments === holdEnvironmentAt ? environmentHold.promise : Promise.resolve(),
    brokerModule: async () => ({
      createDesktopBroker: () => {
        const broker = { start: async () => events.push('broker-start'),
          stopAdmission: () => events.push('broker-cut'),
          shutdown: async () => { events.push('broker-drain'); return { confirmed:true }; } };
        brokers.push(broker); return broker;
      }, createShutdownGate: brokerModule.createShutdownGate
    }),
    bootModule: async () => ({ selecionarPerfilBoot: async () =>
      ({ tipo:'legado', id:'legado', geracao:null, dataDir:join(userData, 'data') }),
    envelopeLegado: () => ({}), erroPublicoPerfil: error => ({ code:error.code || 'ERROR', message:error.message }) })
  };
  const electron = { app, BrowserWindow:Window, utilityProcess: { fork: () => {
    const worker = new EventEmitter(); workers.push(worker); events.push('fork');
    worker.sent = []; worker.postMessage = message => { worker.sent.push(message); events.push(message.tipo); };
    worker.kill = () => true; return worker;
  } }, dialog:{ showErrorBox: () => {} }, session:{ defaultSession }, safeStorage:{},
  Notification:class { static isSupported() { return false; } },
  ipcMain:{handle:()=>{},removeHandler:()=>{}},screen:new EventEmitter(),powerMonitor };
  const mocked = { electron, 'electron-updater':{ autoUpdater:{} },
    './companheiro-window.cjs':nodeRequire('../desktop/companheiro-window.cjs'),
    './segredos.cjs':{ criarCofre: () => ({}) },
    './downloads.cjs':{ downloadPermitido: () => false },
    './notificacoes.cjs':{ criarNotificacoes: () => ({ disponivel:() => false, encerrar:() => {}, cancelar:() => {} }), acaoIdValido:() => false },
    './atualizacoes.cjs':{ criarAtualizador:() => updater, carregarPoliticaRelease:() => ({}), politicaDesligada:() => ({}) },
    './central-pulso.cjs':{ criarClienteCentral:() => null },
    './central-runtime.cjs':{ criarCofreCentral:() => ({}), criarTransporteCentral:() => ({}), executarComandoCentral:() => ({}) },
    './utility-lifecycle.cjs':lifecycle,
    './sac-fallback.cjs':{ brokerBlockedByLocalPolicy:() => false },
    './maintenance-controller.cjs':{ criarControladorManutencao: args => {
      maintenanceController = realController.criarControladorManutencao({ ...args, api });
      return maintenanceController;
    } }
  };
  const context = { require:name => mocked[name] || nodeRequire(name.startsWith('./')?resolve('desktop',name):name), process:{ env:{ ASSESSOR_DESKTOP_TEST_PROFILE:userData },
    resourcesPath:'', platform:process.platform, arch:process.arch, stderr:{ write:() => {} } },
  __dirname:resolve('desktop'), deps, URL, setTimeout, clearTimeout, console, queueMicrotask };
  vm.runInNewContext(heldSource, context, { filename:'desktop/main.cjs' });
  const dispose = () => {
    const target = realpathSync(userData);
    if (dirname(target) !== tempRoot || !basename(target).startsWith(prefix)) throw Error('fixture path invalid');
    rmSync(target, { recursive:true, force:true });
  };
  return { app, events, workers, brokers, windows, defaultSession, hooks:context.testHooks,
    powerMonitor, setIdleState:value=>{idleState=value;},
    installs:() => installs, controller:() => maintenanceController,
    releaseEnvironment:() => environmentHold.resolve(), dispose };
}

async function boot(x, index = 0, port = 31001 + index) {
  await until(() => x.workers[index]);
  x.workers[index].emit('message', { tipo:'pronto', porta:port });
  await until(() => x.windows[0]?.url === `http://127.0.0.1:${port}/app`);
}
function acknowledgeShutdown(worker, code = 0) {
  const request = worker.sent.findLast(message => message.tipo === 'shutdown-pedido');
  assert.ok(request);
  worker.emit('message', { tipo:'shutdown-recibo', boot:request.boot, pedido:request.pedido,
    perfil:request.perfil, ...(request.motivo ? { motivo:request.motivo, opId:request.opId } : {}) });
  worker.emit('exit', code);
}

test('main preserva a janela, corta antes do marker, usa nova utility/broker e recusa origem velha', async t => {
  const x = setup(); t.after(x.dispose);
  await boot(x);
  const first = x.workers[0], window = x.windows[0];
  const pending = x.hooks.iniciarManutencaoInterna(opId);
  assert.ok(x.events.indexOf('broker-cut') < x.events.indexOf('intake-cut-pedido'));
  assert.equal(x.events.includes('marker'), false);
  first.emit('message', { tipo:'atualizacao-comando', id:'late-install', acao:'instalar' });
  assert.equal(x.events.includes('prepare-install'), false);
  const cut = first.sent.find(message => message.tipo === 'intake-cut-pedido');
  first.emit('message', { tipo:'intake-cut-ack', boot:cut.boot, pedido:cut.pedido, perfil:cut.perfil, opId });
  await until(() => first.sent.some(message => message.tipo === 'shutdown-pedido'));
  assert.ok(x.events.indexOf('marker') < x.events.indexOf('broker-drain'));
  assert.ok(x.events.indexOf('local') < x.events.indexOf('broker-drain'));
  assert.strictEqual(x.windows[0], window);
  acknowledgeShutdown(first);
  const handle = await pending;
  assert.equal('db' in handle, false);
  const finishing = x.controller().endMaintenance(handle);
  await until(() => x.workers[1]);
  first.emit('message', { tipo:'pronto', porta:39999 });
  assert.equal(window.url, pathToFileURL(resolve('desktop/maintenance.html')).href);
  await boot(x, 1);
  await finishing;
  first.emit('exit', 1);
  assert.equal(x.windows.length, 1);
  assert.strictEqual(x.windows[0], window);
  assert.equal(x.hooks.allowedNavigation('http://127.0.0.1:31001/app'), false);
  assert.equal(x.hooks.allowedNavigation('http://127.0.0.1:31002/app'), true);
  assert.equal(x.defaultSession.listenerCount('will-download'), 1);
  assert.deepEqual(x.events.filter(value => value === 'fork').length, 2);
  assert.deepEqual(x.events.filter(value => value === 'broker-start').length, 2);
  const oldActivityCount=first.sent.filter(message=>message.tipo==='atividade-sistema').length;
  x.powerMonitor.emit('lock-screen');
  assert.equal(first.sent.filter(message=>message.tipo==='atividade-sistema').length,oldActivityCount);
  assert.equal(x.workers[1].sent.filter(message=>message.tipo==='atividade-sistema').at(-1).pausado,true);
});

test('update só instala após os dois recibos da mesma geração', async t => {
  const x = setup(); t.after(x.dispose);
  await boot(x);
  const worker = x.workers[0];
  worker.emit('message', { tipo:'atualizacao-comando', id:'install-1', acao:'instalar' });
  assert.equal(x.events.includes('prepare-install'), true);
  assert.equal(x.installs(), 0);
  acknowledgeShutdown(worker);
  await until(() => x.installs() === 1);
  assert.equal(x.defaultSession.listenerCount('will-download'), 1);
  assert.equal(x.windows.length, 1);
});

test('atividade segue bloqueio e suspensão do Windows e falha fechada na consulta', async t => {
  const x=setup();t.after(x.dispose);await boot(x);
  const worker=x.workers[0];
  const state=()=>worker.sent.filter(message=>message.tipo==='atividade-sistema').at(-1)?.pausado;
  assert.equal(state(),false);
  x.powerMonitor.emit('suspend');assert.equal(state(),true);
  x.setIdleState('locked');x.powerMonitor.emit('resume');assert.equal(state(),true);
  x.setIdleState('active');x.powerMonitor.emit('unlock-screen');assert.equal(state(),false);
  x.powerMonitor.emit('lock-screen');assert.equal(state(),true);
  x.powerMonitor.getSystemIdleState=()=>{throw Error('SYSTEM_UNAVAILABLE');};
  x.powerMonitor.emit('unlock-screen');assert.equal(state(),true);
});

test('quit antes de existir utility resolve gate por ausência confirmada, sem esperar terminal impossível', async t => {
  const x = setup({ holdEnvironmentAt:1 }); t.after(x.dispose);
  await until(() => x.hooks.active);
  x.app.quit();
  x.releaseEnvironment();
  await until(() => x.events.includes('quit'));
  assert.equal(x.workers.length, 0);
  assert.equal(x.installs(), 0);
});

test('close durante restart cancela nova geração antes do fork e conclui quit normal', async t => {
  const x = setup({ holdEnvironmentAt:2 }); t.after(x.dispose);
  await boot(x);
  const worker = x.workers[0], window = x.windows[0];
  const pending = x.hooks.iniciarManutencaoInterna(opId);
  const cut = worker.sent.find(message => message.tipo === 'intake-cut-pedido');
  worker.emit('message', { tipo:'intake-cut-ack', boot:cut.boot, pedido:cut.pedido, perfil:cut.perfil, opId });
  await until(() => worker.sent.some(message => message.tipo === 'shutdown-pedido'));
  acknowledgeShutdown(worker);
  const handle = await pending;
  const finishing = x.controller().endMaintenance(handle);
  await until(() => x.hooks.active?.id === 2);
  const closeEvent = { prevented:false, preventDefault() { this.prevented = true; } };
  window.emit('close', closeEvent);
  assert.equal(closeEvent.prevented, true);
  x.releaseEnvironment();
  await finishing;
  await until(() => x.events.includes('quit'));
  assert.equal(x.workers.length, 1);
  assert.equal(x.installs(), 0);
  assert.equal(x.windows.length, 1);
});

test('falha final mantém página local em estado incerto e impede restart', async t => {
  const x = setup({ finishFailure:true }); t.after(x.dispose);
  await boot(x);
  const worker = x.workers[0], pending = x.hooks.iniciarManutencaoInterna(opId);
  const cut = worker.sent.find(message => message.tipo === 'intake-cut-pedido');
  worker.emit('message', { tipo:'intake-cut-ack', boot:cut.boot, pedido:cut.pedido, perfil:cut.perfil, opId });
  await until(() => worker.sent.some(message => message.tipo === 'shutdown-pedido'));
  acknowledgeShutdown(worker);
  const handle = await pending;
  await assert.rejects(x.controller().endMaintenance(handle), /POST_UNLINK_FSYNC/);
  assert.equal(x.workers.length, 1);
  assert.equal(x.events.includes('state-incerto'), true);
  assert.equal(x.windows[0].url, pathToFileURL(resolve('desktop/maintenance.html')).href);
});

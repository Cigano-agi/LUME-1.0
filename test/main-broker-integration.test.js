import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import vm from 'node:vm';

const nodeRequire = createRequire(import.meta.url);
const lifecycle = nodeRequire('../desktop/utility-lifecycle.cjs');
const maintenance = nodeRequire('../desktop/maintenance-controller.cjs');
const source = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8')
  .replaceAll("import('../src/mcp/desktop-broker.js')", 'deps.brokerModule()')
  .replaceAll("import('../src/perfil-boot.js')", 'deps.bootModule()')
  .replace('return perfilBootPromise.then(({ envelopeLegado }) => {',
    'return deps.waitEnvironment().then(() => perfilBootPromise).then(({ envelopeLegado }) => {') +
  '\nglobalThis.mainHooks = { get active() { return active; } };';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  throw Error('main VM timeout');
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

function setup({ holdEnvironment = false, delayedDrain = false } = {}) {
  const root = realpathSync(tmpdir()), prefix = 'lume-main-vm-';
  const userData = mkdtempSync(join(root, prefix));
  const events = [], workers = [], drain = deferred(), environment = deferred();
  const app = new EventEmitter();
  app.setName = () => {}; app.setAppUserModelId = () => {};
  app.setAboutPanelOptions = () => {};
  app.getPath = key => key === 'appData' ? dirname(userData) : userData;
  app.setPath = () => {}; app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve(); app.getVersion = () => '0.7'; app.isPackaged = false;
  app.quit = () => {
    const event = { prevented:false, preventDefault() { this.prevented = true; } };
    app.emit('before-quit', event); events.push(event.prevented ? 'quit-blocked' : 'quit');
  };
  const updater = { estado:() => ({ disponivel:true, estado:'pronta' }),
    prepararInstalacao:() => ({}), instalarAgora:() => events.push('install'),
    encerrar:() => {}, iniciarAutomatico:() => {} };
  const broker = { start:async () => events.push('broker-start'),
    stopAdmission:() => events.push('broker-cut'),
    shutdown:() => { events.push('broker-shutdown'); return delayedDrain ? drain.promise : Promise.resolve({ confirmed:true }); } };
  const deps = {
    waitEnvironment:() => holdEnvironment ? environment.promise : Promise.resolve(),
    brokerModule:async () => ({ createDesktopBroker:() => broker,
      createShutdownGate:(await import('../src/mcp/desktop-broker.js')).createShutdownGate }),
    bootModule:async () => ({ selecionarPerfilBoot:async () =>
      ({ tipo:'legado', id:'legado', geracao:null, dataDir:join(userData, 'data') }),
    envelopeLegado:() => ({}), erroPublicoPerfil:error => ({ code:error.code || 'ERROR', message:error.message }) })
  };
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    show() {} focus() {}
    loadURL() { return Promise.resolve(); }
  }
  const defaultSession = new EventEmitter();
  defaultSession.setPermissionRequestHandler = () => {};
  defaultSession.setPermissionCheckHandler = () => {};
  const electron = { app, BrowserWindow:Window, utilityProcess:{ fork:() => {
    events.push('fork'); const worker = new EventEmitter(); workers.push(worker);
    worker.sent = []; worker.postMessage = message => worker.sent.push(message); worker.kill = () => true;
    return worker;
  } }, dialog:{ showErrorBox:() => {} }, session:{ defaultSession }, safeStorage:{},
  Notification:class { static isSupported() { return false; } },
  ipcMain:{handle:()=>{},removeHandler:()=>{}},screen:new EventEmitter(),
  powerMonitor:Object.assign(new EventEmitter(),{getSystemIdleState:()=> 'active'}) };
  const mocked = { electron, 'electron-updater':{ autoUpdater:{} },
    './segredos.cjs':{ criarCofre:() => ({}) }, './downloads.cjs':{ downloadPermitido:() => false },
    './notificacoes.cjs':{ criarNotificacoes:() => ({ disponivel:() => false, encerrar:() => {}, cancelar:() => {} }), acaoIdValido:() => false },
    './atualizacoes.cjs':{ criarAtualizador:() => updater, carregarPoliticaRelease:() => ({}), politicaDesligada:() => ({}) },
    './central-pulso.cjs':{ criarClienteCentral:() => null },
    './central-runtime.cjs':{ criarCofreCentral:() => ({}), criarTransporteCentral:() => ({}), executarComandoCentral:() => ({}) },
    './utility-lifecycle.cjs':lifecycle, './maintenance-controller.cjs':maintenance,
    './sac-fallback.cjs':{ brokerBlockedByLocalPolicy:() => false } };
  const context = { require:name => mocked[name] || nodeRequire(name.startsWith('./')?resolve('desktop',name):name),
    process:{ env:{ ASSESSOR_DESKTOP_TEST_PROFILE:userData }, resourcesPath:'', platform:process.platform,
      arch:process.arch, stderr:{ write:() => {} } },
    __dirname:resolve('desktop'), deps, URL, setTimeout, clearTimeout, console, queueMicrotask };
  vm.runInNewContext(source, context, { filename:'desktop/main.cjs' });
  const dispose = () => {
    const target = realpathSync(userData);
    if (dirname(target) !== root || !basename(target).startsWith(prefix)) throw Error('unsafe fixture path');
    rmSync(target, { recursive:true, force:true });
  };
  return { app, events, workers, broker, drain, environment, hooks:context.mainHooks, dispose };
}
async function boot(x) {
  await until(() => x.workers[0]);
  x.workers[0].emit('message', { tipo:'pronto', porta:31001 });
  await until(() => x.events.includes('broker-start'));
  await tick();
}
function request(x) {
  x.workers[0].emit('message', { tipo:'atualizacao-comando', id:'1', acao:'instalar' });
  const value = x.workers[0].sent.find(message => message.tipo === 'shutdown-pedido');
  assert.ok(value);
  return value;
}
function receipt(x, value, code = 0) {
  x.workers[0].emit('message', { tipo:'shutdown-recibo', boot:value.boot,
    pedido:value.pedido, perfil:value.perfil });
  x.workers[0].emit('exit', code);
}

test('quit durante environment impede fork e confirma ausência sem esperar utility inexistente', async t => {
  const x = setup({ holdEnvironment:true }); t.after(x.dispose);
  await until(() => x.hooks.active);
  x.app.quit(); x.environment.resolve();
  await until(() => x.events.includes('quit'));
  assert.equal(x.workers.length, 0);
  assert.equal(x.events.includes('install'), false);
});

test('update espera recibo utility e broker, sem instalar antes de ambos', async t => {
  const x = setup({ delayedDrain:true }); t.after(x.dispose); await boot(x);
  assert.deepEqual(x.events.filter(event => ['fork','broker-start'].includes(event)), ['fork','broker-start']);
  const value = request(x); receipt(x, value); await tick();
  assert.equal(x.events.includes('install'), false);
  x.drain.resolve({ confirmed:true });
  await until(() => x.events.includes('install'));
  assert.equal(x.events.filter(event => event === 'install').length, 1);
});

test('broker incerto impede instalação apesar de utility confirmada', async t => {
  const x = setup({ delayedDrain:true }); t.after(x.dispose); await boot(x);
  const value = request(x); receipt(x, value);
  x.drain.resolve({ confirmed:false }); await until(() => x.events.includes('quit'));
  assert.equal(x.events.includes('install'), false);
});

test('broker confirma primeiro, utility exit1 e pedido repetido nunca instalam', async t => {
  const x = setup({ delayedDrain:true }); t.after(x.dispose); await boot(x);
  const value = request(x);
  x.app.quit(); x.drain.resolve({ confirmed:true }); await tick();
  assert.equal(x.events.includes('install'), false);
  receipt(x, value, 1); await until(() => x.events.includes('quit'));
  assert.equal(x.events.includes('install'), false);
  assert.equal(x.workers[0].sent.filter(message => message.tipo === 'shutdown-pedido').length, 1);
});

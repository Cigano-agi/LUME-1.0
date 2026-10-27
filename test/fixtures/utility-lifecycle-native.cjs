// Isolated Electron harness: real main and UtilityProcess, synthetic utility/updater.
const { appendFileSync, readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const scenario = process.env.LUME_LIFECYCLE_SCENARIO;
const evidence = process.env.LUME_LIFECYCLE_EVIDENCE;
const log = (event, detail = {}) => appendFileSync(evidence, JSON.stringify({ event, ...detail }) + '\n');

if (process.parentPort) {
  const port = process.parentPort;
  port.on('message', ({ data }) => {
    if (data === 'shutdown') { log('pedido-legado'); return process.exit(1); }
    if (data?.tipo === 'shutdown-pedido') {
      log('pedido', { perfil: data.perfil });
      if (scenario === 'exit1') return process.exit(1);
      if (scenario === 'timeout') return;
      const receipt = { tipo: 'shutdown-recibo', boot: data.boot, pedido: scenario === 'wrong' ? 'wrong' : data.pedido, perfil: data.perfil };
      port.postMessage(receipt); log('recibo');
      if (scenario === 'wrong') process.exit(0);
    } else if (data?.tipo === 'shutdown-ack') {
      log('ack'); process.exit(0);
    }
  });
  port.postMessage({ tipo: 'pronto', porta: 37191 });
} else {
  const Module = require('node:module');
  const electron = require('electron');
  const original = Module._load;
  let triggered = false;
  electron.app.commandLine.appendSwitch('disable-gpu');
  class HiddenWindow extends electron.BrowserWindow { show() { log('show-blocked'); } focus() {} restore() {} loadURL() { return Promise.resolve(); } }
  const updater = {
    estado: () => ({ disponivel: true, estado: 'pronta' }),
    prepararInstalacao: () => ({ disponivel: true, estado: 'pronta' }),
    instalarAgora: () => { log('install'); electron.app.quit(); },
    iniciarAutomatico() {}, encerrar() {}
  };
  Module._load = function(request, parent, isMain) {
    if (request === 'electron-updater') return { autoUpdater: {} };
    if (request === './atualizacoes.cjs' && parent?.filename.endsWith('desktop\\main.cjs'))
      return { criarAtualizador: () => updater, carregarPoliticaRelease: () => ({ enabled: true }), politicaDesligada: () => ({ enabled: false }) };
    if (request === './central-pulso.cjs' && parent?.filename.endsWith('desktop\\main.cjs'))
      return { criarClienteCentral: () => ({ iniciar() {}, encerrar() {} }) };
    if (request === './central-runtime.cjs' && parent?.filename.endsWith('desktop\\main.cjs'))
      return { criarCofreCentral: () => ({}), criarTransporteCentral: () => ({}), executarComandoCentral: async () => null };
    if (request === 'electron' && parent?.filename.endsWith('desktop\\main.cjs'))
      return { ...electron, BrowserWindow: HiddenWindow,
        dialog: { ...electron.dialog, showErrorBox: (title) => log('error', { title }) },
        utilityProcess: { ...electron.utilityProcess, fork: (file, args, options) => {
          const child = electron.utilityProcess.fork(scenario.startsWith('real') ? file : __filename, args, { ...options, env: { ...options.env, LUME_LIFECYCLE_SCENARIO: scenario, LUME_LIFECYCLE_EVIDENCE: evidence } });
          child.on('exit', code => log('utility-exit', { code }));
          const post = child.postMessage.bind(child);
          child.postMessage = message => {
            if (message?.tipo === 'shutdown-pedido') log('pedido', { perfil: message.perfil });
            if (message?.tipo === 'shutdown-ack') {
              if (scenario === 'real-no-ack') { log('ack-dropped'); return; }
              log('ack');
            }
            return post(message);
          };
          child.on('message', message => {
            if (message?.tipo === 'shutdown-recibo') log('recibo');
            if (message?.tipo === 'pronto' && !triggered) {
              triggered = true; log('pronto');
              setImmediate(() => {
                child.emit('message', { tipo: 'atualizacao-comando', id: 'native-test', acao: 'instalar' });
                if (!process.env.LUME_LIFECYCLE_BASE_MAIN)
                  setImmediate(() => { electron.app.quit(); electron.app.quit(); electron.BrowserWindow.getAllWindows()[0]?.close(); log('quit-repetido'); });
              });
            }
          });
          return child;
        }} };
    return original.apply(this, arguments);
  };
  const mainFile = resolve(__dirname, '../../desktop/main.cjs');
  if (process.env.LUME_LIFECYCLE_BASE_MAIN) {
    const compiled = new Module(mainFile, module);
    compiled.filename = mainFile;
    compiled.paths = Module._nodeModulePaths(dirname(mainFile));
    compiled._compile(readFileSync(process.env.LUME_LIFECYCLE_BASE_MAIN, 'utf8'), mainFile);
  } else require(mainFile);
}

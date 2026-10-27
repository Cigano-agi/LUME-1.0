'use strict';

// Ensaio de protocolo no Electron pinado. Nunca lê amostras nem abre fonte de tela.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative, isAbsolute } = require('node:path');

const PIN = '44.4.1';
const MARKER = 'LUME_PERMISSION_DIAGNOSTIC=';
const FLAG = '--use-fake-device-for-media-stream';
const PAGE = '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Permissões · dado fictício</title><body>DADO FICTÍCIO · ENSAIO NATIVO</body></html>';

function mediaProbe(constraints) {
  return `(async()=>{let stream;try{stream=await navigator.mediaDevices.${constraints.display ? 'getDisplayMedia' : 'getUserMedia'}(${JSON.stringify(constraints.options)});const tracks=stream.getTracks();const result={ok:true,tracks:tracks.length,audio:tracks.filter(t=>t.kind==='audio').length,video:tracks.filter(t=>t.kind==='video').length};tracks.forEach(t=>t.stop());result.stopped=tracks.every(t=>t.readyState==='ended');return result}catch(error){return {ok:false,errorName:error?.name||'Error',tracks:0}}finally{stream?.getTracks().forEach(t=>t.stop())}})()`;
}

function iframeProbe() {
  return `(async()=>{const frame=document.createElement('iframe');frame.src='/iframe';document.body.append(frame);let stream;try{await new Promise((resolve,reject)=>{frame.onload=resolve;frame.onerror=reject});stream=await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true});const tracks=stream.getTracks();tracks.forEach(t=>t.stop());return {ok:true,tracks:tracks.length,stopped:tracks.every(t=>t.readyState==='ended')}}catch(error){return {ok:false,errorName:error?.name||'Error',tracks:0}}finally{stream?.getTracks().forEach(t=>t.stop());frame.remove()}})()`;
}

async function childMain() {
  const { app, BrowserWindow, session } = require('electron');
  let win;
  const origin = process.env.LUME_PERMISSION_ORIGIN;
  const profile = process.env.LUME_PERMISSION_PROFILE;
  const diagnostic = { electron: process.versions.electron, fakeDevice: app.commandLine.hasSwitch('use-fake-device-for-media-stream'), fakeUI: app.commandLine.hasSwitch('use-fake-ui-for-media-stream'), steps: [], handlers: [], runtime: process.platform, protocol: 'synthetic-only' };
  // These gates run before loading the page or asking for any media.
  assert.equal(diagnostic.electron, PIN, 'Electron pinado divergente');
  assert.equal(diagnostic.fakeDevice, true, 'flag de dispositivo sintético ausente');
  assert.equal(diagnostic.fakeUI, false, 'flag de bypass de permissão proibida');
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(isAbsolute(profile));
  app.setPath('userData', profile);
  let virtualNow = 1_000;
  const shape = value => value && typeof value === 'object' ? Object.keys(value).sort() : [];
  const present = (object, field) => object && Object.prototype.hasOwnProperty.call(object, field) ? object[field] : '<ausente>';
  const summarize = (kind, permission, web, requestOrigin, details, allowed) => {
    diagnostic.handlers.push({ order: diagnostic.handlers.length + 1, kind, permission,
      webIsWindow: web === win?.webContents, requestingOrigin: requestOrigin ?? '<ausente>',
      keys: shape(details), requestingUrl: present(details, 'requestingUrl'),
      securityOrigin: present(details, 'securityOrigin'),
      embeddingOrigin: present(details, 'embeddingOrigin'),
      mediaTypes: present(details, 'mediaTypes'), mediaType: present(details, 'mediaType'),
      isMainFrame: present(details, 'isMainFrame'), frameUrl: win?.webContents?.mainFrame?.url ?? '<ausente>',
      allowed: allowed === true });
  };
  const step = async (name, constraints) => {
    const before = diagnostic.handlers.length;
    let timeout;
    let result;
    try {
      result = await Promise.race([
        win.webContents.executeJavaScript(constraints.script || mediaProbe(constraints), true),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`media timeout: ${name}`)), 8_000); })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    diagnostic.steps.push({ name, ...result, handlerOrders: diagnostic.handlers.slice(before).map(h => h.order) });
    return result;
  };
  try {
    await app.whenReady();
    const ses = session.fromPartition('notetaker-permission-probe');
    const { criarPoliticaNotetaker } = require('../desktop/notetaker-permission.cjs');
    const policy = criarPoliticaNotetaker({ getWindow: () => win, origin, now: () => virtualNow });
    ses.setPermissionCheckHandler((web, permission, requestingOrigin, details) => {
      const allowed = policy.permissionCheckHandler(web, permission, requestingOrigin, details);
      summarize('check', permission, web, requestingOrigin, details, allowed);
      return allowed;
    });
    ses.setPermissionRequestHandler((web, permission, callback, details) => {
      policy.permissionRequestHandler(web, permission, allowed => {
        summarize('request', permission, web, '<não fornecido>', details, allowed);
        callback(allowed);
      }, details);
    });
    ses.setDisplayMediaRequestHandler((request, callback) => {
      summarize('display', 'display-capture', win?.webContents, '<não fornecido>', request, false);
      callback({}); // Nega antes de selecionar fonte; nenhum desktopCapturer é chamado.
    });
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }));
    win = new BrowserWindow({ show: false, webPreferences: { partition: 'notetaker-permission-probe', nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin + '/')) event.preventDefault(); });
    await win.loadURL(origin + '/probe');
    diagnostic.windowHidden = !win.isVisible();
    diagnostic.profileTemporary = app.getPath('userData') === profile;
    const audio = { options: { audio: true } };
    const camera = { options: { video: true } };
    const display = { display: true, options: { video: true, audio: true } };
    await step('sem-grant', audio);
    const grant = policy.grant({ sessionId: 'ensaio-sintetico', entry: 'microphone', frame: win.webContents.mainFrame });
    diagnostic.grantCreated = Boolean(grant);
    await step('iframe-mesma-origem', { script: iframeProbe() });
    await step('primeiro-pedido', audio);
    await step('replay-check-positivo', audio);
    virtualNow += 30_001;
    await step('expirado', audio);
    const revokedGrant = policy.grant({ sessionId: 'revogado', entry: 'microphone', frame: win.webContents.mainFrame });
    diagnostic.revokeGrantCreated = Boolean(revokedGrant);
    diagnostic.revoked = policy.revoke({ sessionId: 'revogado' });
    await step('revogado', audio);
    const navigationGrant = policy.grant({ sessionId: 'navegacao', entry: 'microphone', frame: win.webContents.mainFrame });
    diagnostic.navigationGrantCreated = Boolean(navigationGrant);
    await win.loadURL(origin + '/navegado');
    await step('apos-navegacao', audio);
    await step('camera', camera);
    await step('sistema-negado', display);
    diagnostic.checkPositive = diagnostic.handlers.filter(h => h.kind === 'check' && h.allowed).length;
    diagnostic.requestPositive = diagnostic.handlers.filter(h => h.kind === 'request' && h.allowed).length;
    diagnostic.syntheticTracks = diagnostic.steps.reduce((sum, item) => sum + item.tracks, 0);
    diagnostic.iframeDeniedWithGrant = diagnostic.steps.find(item => item.name === 'iframe-mesma-origem')?.ok === false;
    diagnostic.replayDenied = diagnostic.steps.find(item => item.name === 'replay-check-positivo')?.ok === false;
    diagnostic.unsafe = diagnostic.steps.some(item => item.name !== 'primeiro-pedido' && item.ok) || diagnostic.steps.some(item => item.ok && item.stopped !== true);
    diagnostic.compatible = diagnostic.steps.find(item => item.name === 'primeiro-pedido')?.ok === true &&
      diagnostic.steps.find(item => item.name === 'primeiro-pedido')?.audio === 1 &&
      diagnostic.steps.find(item => item.name === 'primeiro-pedido')?.stopped === true &&
      diagnostic.iframeDeniedWithGrant && diagnostic.replayDenied && !diagnostic.unsafe;
    diagnostic.conclusion = diagnostic.compatible ? 'protocolo-sintetico-compativel' : diagnostic.unsafe ? 'comportamento-inseguro-ou-replay' : 'mic-bloqueado-ou-campos-incompativeis';
    win.destroy(); win = null;
    diagnostic.windowDestroyed = true;
    console.log(MARKER + JSON.stringify(diagnostic));
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
  }
}

async function parentMain() {
  const electronPackage = require('../node_modules/electron/package.json');
  assert.equal(electronPackage.version, PIN, 'Electron instalado não é o pinado');
  const executable = require('electron');
  assert.equal(typeof executable, 'string');
  const profile = mkdtempSync(join(tmpdir(), 'lume-permission-probe-'));
  const server = createServer((request, response) => {
    if (!['/probe', '/iframe', '/navegado'].includes(new URL(request.url, 'http://localhost').pathname)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(PAGE);
  });
  let child;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, LUME_PERMISSION_ORIGIN: origin, LUME_PERMISSION_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [FLAG, __filename], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    let timeout;
    let exit;
    try {
      exit = await Promise.race([
        new Promise((resolveExit, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolveExit({ code, signal })); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Electron não encerrou em 60 s')), 60_000); })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const line = stdout.split(/\r?\n/).find(item => item.startsWith(MARKER));
    if (!line) throw new Error(`Sem diagnóstico nativo; exit=${JSON.stringify(exit)} stderr=${stderr.slice(-1200)}`);
    const diagnostic = JSON.parse(line.slice(MARKER.length));
    assert.equal(exit.code, 0, 'Electron não encerrou limpo');
    assert.equal(diagnostic.windowDestroyed, true);
    assert.equal(diagnostic.profileTemporary, true);
    assert.equal(diagnostic.windowHidden, true);
    assert.equal(diagnostic.fakeDevice, true);
    assert.equal(diagnostic.fakeUI, false);
    assert.equal(diagnostic.compatible, true, 'mic sintético, replay e negativas nativas devem passar');
    assert.equal(diagnostic.syntheticTracks, 1, 'somente primeiro mic abre um track');
    assert.equal(diagnostic.requestPositive, 1, 'somente primeiro request recebe concessão');
    assert.equal(diagnostic.steps.every(item => item.name === 'primeiro-pedido' || item.ok === false), true);
    diagnostic.processExitCode = exit.code;
    diagnostic.processExited = child.exitCode !== null;
    console.log(JSON.stringify(diagnostic, null, 2));
  } finally {
    if (child && child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
    const rel = relative(tmpdir(), profile);
    if (rel.startsWith('lume-permission-probe-') && !rel.includes('..')) rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

(process.versions.electron ? childMain() : parentMain()).catch(error => {
  console.error(`NATIVE_PERMISSION_DIAGNOSTIC_FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});

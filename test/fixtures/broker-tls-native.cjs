'use strict';

// Isolated TLS-PSK probe server. Receives a synthetic key over stdin/IPC only.
const tls = require('node:tls');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const isUtility = process.type === 'utility';
const isElectronMain = Boolean(process.versions.electron) && !isUtility;
let server;
let utility;
let commandBuffer = '';

function send(message) {
  if (isUtility) process.parentPort.postMessage(message);
  else process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function start({ key, identity, cipher, version }) {
  if (server) throw new Error('server already started');
  const secret = Buffer.from(key, 'base64');
  if (secret.length !== 32) throw new Error('invalid synthetic key length');
  server = tls.createServer({
    minVersion: version,
    maxVersion: version,
    ciphers: cipher,
    ...(version === 'TLSv1.2' ? { dhparam: 'auto' } : {}),
    pskCallback: (...args) => {
      send({ event: 'pskCallback', argTypes: args.map((arg) => typeof arg), identityMatches: args.some((arg) => arg === identity) });
      return args.some((arg) => arg === identity) ? secret : null;
    },
  });
  server.on('tlsClientError', (error) => send({ event: 'tlsClientError', code: error.code || 'unknown' }));
  server.on('secureConnection', (socket) => {
    send({ event: 'accepted', protocol: socket.getProtocol(), cipher: socket.getCipher()?.name });
    socket.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  send({ event: 'ready', port: server.address().port, runtime: isUtility ? 'electron-utility' : isElectronMain ? 'electron-main' : 'node', versions: { node: process.versions.node, electron: process.versions.electron || null, openssl: process.versions.openssl, chrome: process.versions.chrome || null }, cipherPresent: tls.getCiphers().includes(cipher.toLowerCase()), pskCiphers: tls.getCiphers().filter((name) => name.includes('psk')) });
}

async function close() {
  if (server) await new Promise((resolve) => server.close(resolve));
  send({ event: 'closed' });
  if (isUtility) process.exit(0);
  else if (isElectronMain) require('electron').app.quit();
  else process.exit(0);
}

async function handle(command) {
  if (command.action === 'start') {
    if (isElectronMain && command.mode === 'utility') {
      const { utilityProcess } = require('electron');
      utility = utilityProcess.fork(__filename, ['--probe-utility'], { serviceName: `lume-tls-probe-${randomUUID()}` });
      utility.on('message', (message) => send(message));
      utility.on('error', (error) => send({ event: 'error', code: error.code || 'utility-error' }));
      utility.on('exit', (code) => send({ event: 'utilityExit', code }));
      utility.postMessage(command);
    } else await start(command);
  } else if (command.action === 'close') {
    if (utility) { utility.postMessage(command); await new Promise((resolve) => utility.once('exit', resolve)); require('electron').app.quit(); }
    else await close();
  }
}

function receive(command) {
  handle(command).catch((error) => send({ event: 'error', code: error.code || 'probe-error', message: error.message }));
}

if (isUtility) {
  process.parentPort.on('message', ({ data }) => receive(data));
} else {
  function consume(chunk) {
    commandBuffer += chunk;
    let end;
    while ((end = commandBuffer.indexOf('\n')) >= 0) {
      const line = commandBuffer.slice(0, end);
      commandBuffer = commandBuffer.slice(end + 1);
      try { receive(JSON.parse(line)); }
      catch (error) { send({ event: 'error', code: 'input-error', message: error.message }); }
    }
  }
  if (isElectronMain) {
    const { app } = require('electron');
    const userData = process.argv.find((argument) => argument.startsWith('--probe-user-data='))?.slice('--probe-user-data='.length);
    if (!userData) throw new Error('temporary userData required');
    app.setPath('userData', userData);
    app.whenReady().then(() => {
      const control = net.createServer((socket) => {
        socket.setEncoding('utf8');
        socket.on('data', consume);
      });
      control.listen(0, '127.0.0.1', () => send({ event: 'boot', controlPort: control.address().port }));
    }).catch((error) => send({ event: 'error', code: 'boot-error', message: error.message }));
  } else {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', consume);
    send({ event: 'boot' });
  }
}

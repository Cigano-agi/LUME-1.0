'use strict';

// Electron main fixture only: one temporary listener, public certificate output.
const { app } = require('electron');
const tls = require('node:tls');
const net = require('node:net');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const userData = process.argv.find(arg => arg.startsWith('--broker-user-data='))?.slice('--broker-user-data='.length);
if (!userData) throw new Error('BROKER_FIXTURE_USER_DATA_REQUIRED');
app.setPath('userData', userData);
const report = row => process.stdout.write(`${JSON.stringify(row)}\n`);
const sockets = new Set();
let server;
let control;

app.whenReady().then(async () => {
  const { createBootIdentity } = await import(pathToFileURL(resolve(__dirname, '../../src/mcp/broker-identity.js')).href);
  const identity = await createBootIdentity();
  server = tls.createServer({ key: identity.privateKey, cert: identity.certPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => report({ event: 'data', length: chunk.length }));
  });
  server.on('error', error => report({ event: 'error', code: error.code || 'TLS_ERROR' }));
  control = net.createServer(socket => socket.once('data', async chunk => {
    if (String(chunk).trim() !== 'close') return;
    for (const peer of sockets) peer.destroy();
    server.closeAllConnections?.();
    await Promise.all([new Promise(resolveClose => server.close(resolveClose)), new Promise(resolveClose => control.close(resolveClose))]);
    report({ event: 'closed' });
    app.exit(0);
  }));
  control.listen(0, '127.0.0.1', () => {
    server.listen(0, '127.0.0.1', () => report({ event: 'ready', port: server.address().port, controlPort: control.address().port, certPem: identity.certPem, pin: identity.pin, runtime: 'electron-main' }));
  });
}).catch(error => { report({ event: 'error', code: error.code || 'BOOT_ERROR' }); app.quit(); });

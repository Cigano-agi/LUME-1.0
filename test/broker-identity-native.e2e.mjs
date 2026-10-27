import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
import electronPath from 'electron';
import { createBootIdentity } from '../src/mcp/broker-identity.js';

const root = mkdtempSync(join(tmpdir(), 'lume-broker-identity-'));
const userData = join(root, 'userData');
mkdirSync(userData);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [resolve('test/fixtures/broker-identity-native.cjs'), `--broker-user-data=${userData}`], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const exit = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
let pending = '', stderr = '', readyResolve, readyReject, closed = false, dataCount = 0;
const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
child.stdout.on('data', chunk => {
  pending += String(chunk);
  let n;
  while ((n = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, n); pending = pending.slice(n + 1);
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.event === 'ready') readyResolve(row);
    if (row.event === 'error') readyReject(Error(row.code));
    if (row.event === 'data') dataCount++;
    if (row.event === 'closed') closed = true;
  }
});

function connect({ port, ca, servername, expectedPin, send = false }) {
  return new Promise(resolveResult => {
    const socket = tls.connect({ host: '127.0.0.1', port, ca, servername, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
    let done = false;
    const finish = result => { if (!done) { done = true; socket.destroy(); resolveResult(result); } };
    socket.setTimeout(5000, () => finish('timeout'));
    socket.once('error', error => finish(error.code || 'TLS_ERROR'));
    socket.once('secureConnect', () => {
      if (!socket.authorized) return finish('unauthorized');
      const actual = createHash('sha256').update(socket.getPeerCertificate(true).raw).digest('hex');
      if (actual !== expectedPin) return finish('pin-rejected');
      if (send) socket.write('synthetic');
      finish('authenticated');
    });
  });
}

let safeToClean = false;
const timed = (promise, ms, label) => new Promise((resolveTimed, rejectTimed) => {
  const timer = setTimeout(() => rejectTimed(Error(label)), ms);
  promise.then(value => { clearTimeout(timer); resolveTimed(value); }, error => { clearTimeout(timer); rejectTimed(error); });
});
try {
  const result = await timed(ready, 12000, 'Electron ready timeout');
  assert.equal(result.runtime, 'electron-main');
  assert.ok(Number.isInteger(result.port) && result.port > 0);
  const old = await createBootIdentity();
  const cert = new X509Certificate(result.certPem);
  assert.equal(result.pin, createHash('sha256').update(cert.raw).digest('hex'));
  assert.equal(await connect({ port: result.port, ca: result.certPem, servername: 'lume.local', expectedPin: result.pin, send: true }), 'authenticated');
  assert.notEqual(await connect({ port: result.port, ca: old.certPem, servername: 'lume.local', expectedPin: result.pin }), 'authenticated');
  assert.notEqual(await connect({ port: result.port, ca: result.certPem, servername: 'wrong.local', expectedPin: result.pin }), 'authenticated');
  assert.equal(await connect({ port: result.port, ca: result.certPem, servername: 'lume.local', expectedPin: old.pin }), 'pin-rejected');
  await new Promise((resolveControl, rejectControl) => {
    const control = net.connect({ host: '127.0.0.1', port: result.controlPort }, () => control.end('close\n'));
    control.once('close', resolveControl);
    control.once('error', rejectControl);
  });
  const outcome = await timed(exit, 10000, 'Electron close timeout');
  assert.equal(outcome.code, 0, stderr);
  assert.equal(closed, true);
  assert.equal(dataCount, 1, 'Negativos não podem enviar bytes de aplicação');
  safeToClean = true;
  process.stdout.write('BROKER_IDENTITY_NATIVE_OK: Node client / Electron main; cert, hostname e pin negativos; listener fechado\n');
} finally {
  if (!safeToClean) { child.kill(); await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 5000))]); }
  if (child.exitCode !== null && child.signalCode === null && dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('lume-broker-identity-')) rmSync(root, { recursive: true, force: true });
  else process.stderr.write(`BROKER_IDENTITY_FIXTURE_PRESERVED=${root}\n`);
}

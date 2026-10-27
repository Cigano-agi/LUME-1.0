import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import tls from 'node:tls';
import net from 'node:net';

const fixture = resolve('test/fixtures/broker-tls-native.cjs');
const electron = resolve('node_modules/electron/dist/electron.exe');
const version = process.env.LUME_TLS_PROBE_VERSION === 'TLSv1.2' ? 'TLSv1.2' : 'TLSv1.3';
const cipher = version === 'TLSv1.2' ? 'DHE-PSK-AES128-GCM-SHA256' : 'TLS_AES_128_GCM_SHA256';
const key = randomBytes(32);
const identity = `lume-probe-${randomUUID()}`;
const rows = [];

function startProcess(command, args, env) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  const events = [];
  const errors = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const waiter = pending.find((entry) => entry.event === message.event);
        if (waiter) { pending.splice(pending.indexOf(waiter), 1); waiter.resolve(message); }
        else if (message.event === 'error') {
          events.push(message);
          const awaitingReady = pending.find((entry) => entry.event === 'ready');
          if (awaitingReady) { pending.splice(pending.indexOf(awaitingReady), 1); awaitingReady.reject(new Error(`${message.code}: ${message.message}`)); }
        } else events.push(message);
      } catch { errors.push(`non-JSON stdout: ${line.slice(0, 160)}`); }
    }
  });
  child.stderr.on('data', (chunk) => errors.push(chunk.slice(0, 500)));
  child.on('error', (error) => errors.push(`${error.code}: ${error.message}`));
  function wait(event, timeout = 15000) {
    const existing = events.find((entry) => entry.event === event);
    if (existing) { events.splice(events.indexOf(existing), 1); return Promise.resolve(existing); }
    return new Promise((resolve, reject) => {
      const entry = { event, resolve: (message) => { clearTimeout(timer); resolve(message); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { pending.splice(pending.indexOf(entry), 1); reject(new Error(`timeout waiting for ${event}: ${errors.join(' | ')}`)); }, timeout);
      pending.push(entry);
    });
  }
  let control;
  return { child, wait, errors, events,
    async connectControl(port) { control = net.connect({ host: '127.0.0.1', port }); await new Promise((resolve, reject) => { control.once('connect', resolve); control.once('error', reject); }); },
    send: (message) => (control || child.stdin).write(`${JSON.stringify(message)}\n`),
    closeControl: () => control?.destroy(),
  };
}

function within(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), milliseconds); })]).finally(() => clearTimeout(timer));
}

function connect(port, type) {
  return new Promise((resolveResult) => {
    let settled = false;
    const options = { host: '127.0.0.1', port, minVersion: version, maxVersion: version, ciphers: cipher, timeout: 5000 };
    if (type !== 'absent') options.pskCallback = () => ({ identity, psk: type === 'valid' ? key : randomBytes(32) });
    const socket = tls.connect(options);
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); resolveResult(result); } };
    const timer = setTimeout(() => finish({ accepted: false, error: 'client-timeout' }), 6000);
    socket.once('secureConnect', () => {
      const result = { accepted: true, protocol: socket.getProtocol(), cipher: socket.getCipher()?.name, authorized: socket.authorized };
      setTimeout(() => finish(result), 100);
    });
    socket.once('error', (error) => finish({ accepted: false, error: error.code || error.message }));
    socket.once('timeout', () => finish({ accepted: false, error: 'socket-timeout' }));
  });
}

async function run(name, root) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = name === 'node' ? [fixture] : [fixture, `--probe-user-data=${root}`];
  const command = name === 'node' ? process.execPath : electron;
  const proc = startProcess(command, args, env);
  let exited = false;
  const exit = new Promise((resolveExit) => proc.child.once('exit', (code, signal) => { exited = true; resolveExit({ code, signal }); }));
  try {
    const boot = await proc.wait('boot');
    if (boot.controlPort) await proc.connectControl(boot.controlPort);
    proc.send({ action: 'start', mode: name === 'utility' ? 'utility' : 'main', key: key.toString('base64'), identity, cipher, version });
    const ready = await proc.wait('ready');
    const valid = await connect(ready.port, 'valid');
    if (valid.accepted) await proc.wait('accepted', 3000);
    const wrong = await connect(ready.port, 'wrong');
    const absent = await connect(ready.port, 'absent');
    const accepted = proc.events.filter((entry) => entry.event === 'accepted');
    const result = { name, runtime: ready.runtime, versions: ready.versions, cipherPresent: ready.cipherPresent, pskCiphers: ready.pskCiphers, valid, wrong, absent, serverAccepts: accepted.length + (valid.accepted ? 1 : 0), diagnostics: proc.events.filter((entry) => entry.event !== 'accepted'), pass: valid.accepted && valid.protocol === version && valid.cipher === cipher && !wrong.accepted && !absent.accepted && accepted.length === 0 };
    rows.push(result);
    proc.send({ action: 'close' });
    await proc.wait('closed', 5000);
    if (name === 'utility') await proc.wait('utilityExit', 5000);
    const status = await within(exit, 5000, 'process exit');
    result.exit = status;
    if (proc.errors.length) result.stderr = proc.errors;
  } catch (error) {
    rows.push({ name, failure: error.message, events: proc.events, stderr: proc.errors });
  } finally {
    if (!exited) {
      try { proc.send({ action: 'close' }); await within(exit, 3000, 'graceful close'); }
      catch { proc.child.kill(); await within(exit, 3000, 'forced close').catch(() => {}); }
    }
    proc.closeControl();
    if (name !== 'node' && exited) {
      const temp = await realpath(tmpdir());
      const actual = await realpath(root);
      if (actual.startsWith(`${temp}${sep}lume-tls-probe-`) && actual !== temp) await rm(actual, { recursive: true, force: true });
    }
  }
}

for (const name of ['node', 'main', 'utility']) {
  const root = await mkdtemp(join(tmpdir(), 'lume-tls-probe-'));
  await run(name, root);
  if (name === 'node') {
    const actual = await realpath(root);
    const temp = await realpath(tmpdir());
    if (actual.startsWith(`${temp}${sep}lume-tls-probe-`)) await rm(actual, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ client: { node: process.versions.node, openssl: process.versions.openssl }, version, cipher, rows }, null, 2));
if (rows.some((row) => !row.pass)) process.exitCode = 1;

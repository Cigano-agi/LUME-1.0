import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import electronPath from 'electron';
import { createBootIdentity } from '../src/mcp/broker-identity.js';
import { publishBrokerDescriptor, readBrokerDescriptor } from '../src/mcp/broker-bootstrap.js';

const selection = { tipo: 'legado', id: 'legado', geracao: null };
const testParent = process.platform === 'win32' ? homedir() : tmpdir();
function cleanup(path) {
  if (dirname(resolve(path)) !== resolve(testParent) || !basename(path).startsWith('lume-broker-native-')) throw Error('unsafe cleanup');
  rmSync(path, { recursive: true, force: true });
}

test('Windows real: publish, read, release e boot novo pelo helper nativo', async () => {
  assert.equal(process.platform, 'win32', 'native Windows proof requires Windows');
  const userData = mkdtempSync(join(testParent, 'lume-broker-native-live-'));
  try {
    const identity = await createBootIdentity();
    const first = await publishBrokerDescriptor({ userData, selection, boot: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', port: 41234, identity });
    const control = join(userData, 'broker-control');
    const stranger = join(control, 'stranger.txt');
    writeFileSync(stranger, 'keep', { mode: 0o600 });
    assert.deepEqual(await readBrokerDescriptor({ userData, selection }), first.descriptor);
    assert.equal(readFileSync(join(control, 'descriptor.json'), 'utf8').includes(identity.privateKey), false);
    assert.deepEqual(readdirSync(control).sort(), ['descriptor.json', 'stranger.txt']);
    await first.release();
    assert.equal(existsSync(stranger), true);
    await assert.rejects(readBrokerDescriptor({ userData, selection }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
    const second = await publishBrokerDescriptor({ userData, selection, boot: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', port: 41235, identity: await createBootIdentity() });
    assert.notEqual(second.descriptor.pin, first.descriptor.pin);
    assert.deepEqual(await readBrokerDescriptor({ userData, selection }), second.descriptor);
    await second.release();
  } finally { cleanup(userData); }
});

test('Windows real: junction no controle é recusada sem tocar alvo externo', async () => {
  assert.equal(process.platform, 'win32', 'native Windows proof requires Windows');
  const userData = mkdtempSync(join(testParent, 'lume-broker-native-link-'));
  const outside = mkdtempSync(join(testParent, 'lume-broker-native-outside-'));
  try {
    mkdirSync(join(outside, 'control'));
    writeFileSync(join(outside, 'control', 'stranger.txt'), 'keep');
    symlinkSync(join(outside, 'control'), join(userData, 'broker-control'), 'junction');
    await assert.rejects(publishBrokerDescriptor({ userData, selection, boot: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', port: 41234, identity: await createBootIdentity() }), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });
    assert.equal(readFileSync(join(outside, 'control', 'stranger.txt'), 'utf8'), 'keep');
  } finally {
    try { unlinkSync(join(userData, 'broker-control')); } catch {}
    cleanup(userData);
    cleanup(outside);
  }
});

test('Electron main oculto usa o mesmo PE para publish/read/release', async () => {
  assert.equal(process.platform, 'win32', 'native Windows proof requires Windows');
  const root = mkdtempSync(join(testParent, 'lume-broker-native-electron-'));
  const userData = join(root, 'profile');
  const appDir = join(root, 'fixture');
  mkdirSync(userData);
  mkdirSync(appDir);
  const identityUrl = pathToFileURL(resolve('src/mcp/broker-identity.js')).href;
  const bootstrapUrl = pathToFileURL(resolve('src/mcp/broker-bootstrap.js')).href;
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'lume-broker-acl-fixture', version: '1.0.0', main: 'main.cjs' }));
  writeFileSync(join(appDir, 'main.cjs'), `
    const { app } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    app.whenReady().then(async () => {
      const { createBootIdentity } = await import(${JSON.stringify(identityUrl)});
      const { publishBrokerDescriptor, readBrokerDescriptor } = await import(${JSON.stringify(bootstrapUrl)});
      const selection = { tipo: 'legado', id: 'legado', geracao: null };
      const result = await publishBrokerDescriptor({ userData: ${JSON.stringify(userData)}, selection, boot: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', port: 41236, identity: await createBootIdentity() });
      if (JSON.stringify(await readBrokerDescriptor({ userData: ${JSON.stringify(userData)}, selection })) !== JSON.stringify(result.descriptor)) throw Error('READ_MISMATCH');
      await result.release();
      process.stdout.write('BROKER_ELECTRON_NATIVE_OK\\n', () => app.exit(0));
    }).catch(() => { process.stderr.write('BROKER_ELECTRON_NATIVE_FAILED\\n', () => app.exit(1)); });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [appDir], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let timer;
  child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-4096); });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
  try {
    const outcome = await Promise.race([
      new Promise((resolveExit, rejectExit) => { child.once('error', rejectExit); child.once('exit', (code, signal) => resolveExit({ code, signal })); }),
      new Promise((_, rejectTimeout) => { timer = setTimeout(() => rejectTimeout(Error('Electron native timeout')), 15000); })
    ]);
    assert.equal(outcome.code, 0, stderr);
    assert.match(stdout, /BROKER_ELECTRON_NATIVE_OK/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    if (child.exitCode !== null && child.signalCode === null) cleanup(root);
    else process.stderr.write(`BROKER_ELECTRON_FIXTURE_PRESERVED=${root}\n`);
  }
});

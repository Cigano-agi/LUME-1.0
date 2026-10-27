import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackage } from '@electron/asar';
import electronPath from 'electron';
import { buildLumeMcpb, inspectStoredMcpb } from '../scripts/build-lume-mcpb.mjs';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { applyClaudeActivation, revokeClaudeActivation } from '../src/mcp/activation.js';
import { startLumeAppPresence } from '../src/mcp/presence.js';
import { fixtureCredential, startBrokerApp } from './fixtures/mcp-broker-app.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const root = resolve('.');
const required = [
  'src/mcp/activation.js', 'src/mcp/profile-broker-client.js',
  'src/mcp/broker-frames.js', 'src/mcp/broker-bootstrap.js',
  'src/mcp/broker-acl-native.js', 'src/perfil-boot-guard.js', 'src/execucao/projeto.js'
];
function temporary(t) {
  const dir = mkdtempSync(join(homedir(), 'lume-mcpb-broker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }));
  return dir;
}
function checkout(t) {
  const dest = join(temporary(t), 'checkout');
  for (const name of ['package.json', 'package-lock.json']) {
    mkdirSync(dirname(join(dest, name)), { recursive: true });
    cpSync(join(root, name), join(dest, name));
  }
  for (const name of ['src', 'mcpb', 'native/win-acl/bin']) {
    if (existsSync(join(root, name))) cpSync(join(root, name), join(dest, name), { recursive: true });
  }
  mkdirSync(join(dest, 'desktop'), { recursive: true });
  cpSync(join(root, 'desktop/icon.png'), join(dest, 'desktop/icon.png'));
  return dest;
}

test('MCPB inclui cliente e, fora do macOS, PE íntegro no layout de extração', async t => {
  const out = temporary(t);
  const built = buildLumeMcpb({ outputDir: out });
  const entries = inspectStoredMcpb(readFileSync(built.artifact));
  const names = entries.map(entry => entry.name);
  for (const name of required) assert.ok(names.includes(name), `${name} ausente`);
  assert.equal(names.includes('src/perfil-manutencao.js'), false);
  assert.equal(names.some(name => /^src\/notetaker\/(?:exclusao-|direitos-selecao|contrato\.js)/.test(name)), false);
  for (const forbidden of ['src/mcp/broker-identity.js', 'node_modules/@peculiar/x509', 'native/win-acl/LumeAcl.cs']) {
    assert.equal(names.some(name => name === forbidden || name.startsWith(forbidden + '/')), false, forbidden);
  }
  const nativeNames = ['native/win-acl/bin/lume-acl.exe', 'native/win-acl/bin/manifest.json'];
  for (const name of nativeNames) assert.equal(names.includes(name), process.platform !== 'darwin', name);
  if (process.platform !== 'darwin') {
    const nativeManifest = JSON.parse(entries.find(entry => entry.name === nativeNames[1]).data);
    assert.equal(nativeManifest.sha256, hash(entries.find(entry => entry.name === nativeNames[0]).data));
  }
  const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data);
  assert.equal(manifest.compatibility.runtimes.node, '>=24.0.0');
  assert.deepEqual(manifest.compatibility.platforms, process.platform === 'darwin' ? ['darwin'] : ['darwin', 'win32']);
  assert.equal(manifest.user_config.activation_code.sensitive, true);
  assert.equal(manifest.tools.length, 5);
  assert.equal(manifest.server.mcp_config.args[0], '${__dirname}/server/index.js');
  assert.equal(manifest.server.mcp_config.env.LUME_MCP_CREDENTIAL, '${user_config.activation_code}');
  for (const entry of entries) {
    const target = join(out, 'unpacked', ...entry.name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  if (process.platform !== 'darwin') assert.deepEqual(readFileSync(join(out, 'unpacked/native/win-acl/bin/lume-acl.exe')),
    readFileSync(join(root, 'native/win-acl/bin/lume-acl.exe')));
  const boot = await import(pathToFileURL(join(out, 'unpacked/src/perfil-boot.js')).href);
  assert.equal(typeof boot.selecionarPerfilBoot, 'function');
});

test('builder recusa helper/manifesto ausente, alterado e links antes de emitir ZIP', t => {
  if (process.platform === 'darwin') return t.skip('PE Windows não é distribuído no host macOS');
  for (const kind of ['missing', 'tampered', 'linked', 'manifest-missing', 'manifest-tampered']) {
    const checkoutRoot = checkout(t);
    const exe = join(checkoutRoot, 'native/win-acl/bin/lume-acl.exe');
    if (kind === 'missing') rmSync(exe);
    if (kind === 'tampered') writeFileSync(exe, 'MZ-tampered');
    if (kind === 'linked') {
      const other = join(checkoutRoot, 'native/win-acl/bin/copied-helper.exe');
      cpSync(exe, other); rmSync(exe); linkSync(other, exe);
    }
    if (kind === 'manifest-missing') rmSync(join(checkoutRoot, 'native/win-acl/bin/manifest.json'));
    if (kind === 'manifest-tampered') writeFileSync(join(checkoutRoot, 'native/win-acl/bin/manifest.json'), '{}');
    const outputDir = join(checkoutRoot, 'output');
    assert.throws(() => buildLumeMcpb({ root: checkoutRoot, outputDir }), /MCPB_NATIVE_UNTRUSTED/);
  }
});

test('builder recusa manifesto MCPB sem cinco tools ou código sensível', t => {
  for (const kind of ['tools', 'sensitive']) {
    const checkoutRoot = checkout(t), path = join(checkoutRoot, 'mcpb/lume/manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === 'tools') manifest.tools.pop();
    else manifest.user_config.activation_code.sensitive = false;
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => buildLumeMcpb({ root: checkoutRoot, outputDir: join(checkoutRoot, 'out') }), /Manifesto MCPB incompatível/);
  }
});

test('builder lê ASAR físico real no Electron oculto e PE do app.asar.unpacked', async t => {
  if (process.platform !== 'win32') return t.skip('Electron Windows real');
  const work = temporary(t), source = join(work, 'asar-source'), archive = join(work, 'app.asar');
  const built = buildLumeMcpb({ outputDir: work });
  for (const entry of inspectStoredMcpb(readFileSync(built.artifact))) {
    if (entry.name.startsWith('native/')) {
      const target = join(work, 'app.asar.unpacked', ...entry.name.split('/'));
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, entry.data);
    } else {
      const target = join(source, ...entry.name.split('/'));
      mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, entry.data);
    }
  }
  // The source package version contract for packaged shape lives at the archive root.
  const sourceManifest = join(source, 'mcpb/lume/manifest.json');
  mkdirSync(dirname(sourceManifest), { recursive: true });
  cpSync(join(root, 'mcpb/lume/manifest.json'), sourceManifest);
  cpSync(join(root, 'mcpb/lume/package.json'), join(source, 'mcpb/lume/package.json'));
  mkdirSync(join(source, 'mcpb/lume/server'), { recursive: true });
  cpSync(join(root, 'mcpb/lume/server/index.js'), join(source, 'mcpb/lume/server/index.js'));
  mkdirSync(join(source, 'desktop'), { recursive: true });
  cpSync(join(root, 'desktop/icon.png'), join(source, 'desktop/icon.png'));
  cpSync(join(root, 'package.json'), join(source, 'package.json'));
  await createPackage(source, archive);
  const app = join(work, 'electron-app'); mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'lume-asar-builder-proof', version: '1.0.0', main: 'main.cjs' }));
  const builderUrl = pathToFileURL(join(root, 'scripts/build-lume-mcpb.mjs')).href;
  writeFileSync(join(app, 'main.cjs'), `const {app}=require('electron'); app.whenReady().then(async()=>{
    const {buildLumeMcpb}=await import(${JSON.stringify(builderUrl)});
    const result=buildLumeMcpb({root:${JSON.stringify(archive)},outputDir:${JSON.stringify(join(work, 'asar-out'))},shape:'packaged'});
    process.stdout.write('ASAR_MCPB_OK '+result.entries.length+'\\n',()=>app.exit(0));
  }).catch(error=>{process.stderr.write(String(error?.message||error)+'\\n',()=>app.exit(1));});`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [app], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const status = await Promise.race([
    new Promise((resolveExit, rejectExit) => { child.once('error', rejectExit); child.once('close', resolveExit); }),
    new Promise((_, rejectTimeout) => setTimeout(() => { child.kill(); rejectTimeout(Error('ASAR_ELECTRON_TIMEOUT')); }, 15000).unref())
  ]);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /ASAR_MCPB_OK/);
});

test('adapter extraído recusa PE e manifesto alterados em runtime', async t => {
  if (process.platform === 'darwin') return t.skip('Adaptador PE não é usado no macOS');
  const out = temporary(t), built = buildLumeMcpb({ outputDir: out }), unpacked = join(out, 'unpacked');
  for (const entry of inspectStoredMcpb(readFileSync(built.artifact))) {
    const target = join(unpacked, ...entry.name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  const { verifyBrokerAcl } = await import(pathToFileURL(join(unpacked, 'src/mcp/broker-acl-native.js')).href);
  const userData = join(out, 'profile'); mkdirSync(userData);
  const args = { userData, paths: [userData], strictFrom: 0 };
  const exe = join(unpacked, 'native/win-acl/bin/lume-acl.exe');
  rmSync(exe);
  await assert.rejects(verifyBrokerAcl(args), /BROKER_BOOTSTRAP_UNTRUSTED/);
  writeFileSync(exe, 'MZ-tampered');
  await assert.rejects(verifyBrokerAcl(args), /BROKER_BOOTSTRAP_UNTRUSTED/);
  const manifest = join(unpacked, 'native/win-acl/bin/manifest.json');
  writeFileSync(manifest, '{}');
  await assert.rejects(verifyBrokerAcl(args), /BROKER_BOOTSTRAP_UNTRUSTED/);
});

test('launcher extraído sem app/descriptor sai 1 antes de criar DB', t => {
  if (process.platform !== 'win32') return t.skip('Perfil Windows do MCPB');
  const out = temporary(t), built = buildLumeMcpb({ outputDir: out }), unpacked = join(out, 'unpacked');
  for (const entry of inspectStoredMcpb(readFileSync(built.artifact))) {
    const target = join(unpacked, ...entry.name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  const appdata = join(out, 'appdata'); mkdirSync(appdata);
  const run = spawnSync(process.execPath, [join(unpacked, 'server/index.js')], {
    env: { ...process.env, APPDATA: appdata, LUME_MCP_CREDENTIAL: 'synthetic-test-credential-with-32-bytes' },
    encoding: 'utf8', timeout: 10000, windowsHide: true
  });
  assert.equal(run.status, 1, run.error?.message ?? run.stderr);
  assert.equal(readFileSync(join(unpacked, 'manifest.json')).length > 0, true);
  assert.equal(run.stderr.includes(appdata), false);
});

function extractedPackage(t) {
  const out = temporary(t), built = buildLumeMcpb({ outputDir: out }), unpacked = join(out, 'unpacked');
  for (const entry of inspectStoredMcpb(readFileSync(built.artifact))) {
    const target = join(unpacked, ...entry.name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  return { out, unpacked, entry: join(unpacked, 'server/index.js') };
}

async function syntheticProfile(t) {
  const parent = mkdtempSync(join(homedir(), 'lume-mcpb-real-broker-'));
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const userData = join(parent, 'AssessorDesktop');
  const dataDir = join(userData, 'data');
  mkdirSync(join(dataDir, 'mcp'), { recursive: true });
  const db = abrirBanco(join(dataDir, 'assessor.db'));
  new ContextoApp(db); new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo@g.us', 'Equipe');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('grupo@g.us','wa-package-broker','saida','eu',1,'texto','{}','Pacote no broker','2026-09-19T12:00:00.000Z','2026-09-19','minha')`).run();
  db.close();
  const activationPath = join(dataDir, 'mcp', 'claude-desktop.json');
  applyClaudeActivation({ activationPath, scope: { kind: 'all' }, credential: fixtureCredential });
  return { parent, userData, dataDir, activationPath, credential: fixtureCredential };
}

async function runExtracted(entry, profile, { send = [] } = {}) {
  const env = { ...process.env, APPDATA: profile.parent, LUME_MCP_CREDENTIAL: profile.credential };
  const child = spawn(process.execPath, [entry], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  const expected = new Set(send.filter(message => Object.hasOwn(message, 'id')).map(message => message.id));
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const line of stdout.split('\n').slice(0, -1)) {
      try { expected.delete(JSON.parse(line).id); } catch {}
    }
    if (send.length && expected.size === 0 && !child.stdin.writableEnded) child.stdin.end();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  for (const message of send) child.stdin.write(JSON.stringify(message) + '\n');
  if (!send.length) child.stdin.end();
  const exit = await Promise.race([
    new Promise((resolveExit, rejectExit) => { child.once('error', rejectExit); child.once('close', code => resolveExit(code)); }),
    new Promise((_, rejectTimeout) => setTimeout(() => { child.kill(); rejectTimeout(Error('MCPB_CHILD_TIMEOUT')); }, 10000).unref())
  ]);
  return { exit, stdout, stderr };
}

test('launcher propaga falha de server.closed como exit 1', async t => {
  if (process.platform !== 'win32') return t.skip('Perfil Windows do MCPB');
  const packageFile = extractedPackage(t), profile = await syntheticProfile(t);
  // Fault injection only for launcher lifecycle; this mock is not broker evidence.
  writeFileSync(join(packageFile.unpacked, 'src/mcp/stdio-entry.js'),
    "export async function startFromEnvironment() { return { closed: Promise.reject(Error('INJECTED_CLOSED_FAILURE')), stop() { return this.closed; } }; }\n");
  const result = await runExtracted(packageFile.entry, profile);
  assert.equal(result.exit, 1, result.stderr);
  assert.match(result.stderr, /PERFIL_VERIFICACAO_FALHOU/);
  assert.equal(result.stderr.includes(profile.parent), false);
});

test('ZIP extraído autentica no broker TLS real e preserva cinco tools', async t => {
  if (process.platform !== 'win32') return t.skip('ACL Windows real');
  const packageFile = extractedPackage(t), profile = await syntheticProfile(t);
  await startBrokerApp(t, { userData: profile.userData, credential: profile.credential });
  const presence = startLumeAppPresence({ dataDir: profile.dataDir });
  t.after(() => presence.stop());
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: { date: '2026-09-19' } } }
  ];
  const result = await runExtracted(packageFile.entry, profile, { send: messages });
  assert.equal(result.exit, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.find(reply => reply.id === 1)?.result?.serverInfo?.name, 'lume');
  assert.equal(replies.find(reply => reply.id === 2)?.result?.tools?.filter(tool => tool.name.startsWith('lume_')).length, 5);
  assert.equal(replies.find(reply => reply.id === 3)?.result?.structuredContent?.items?.[0]?.summary, 'Pacote no broker', JSON.stringify(replies.find(reply => reply.id === 3)));
});

test('ZIP extraído recusa app ausente mesmo com DB e ativação válidos', async t => {
  if (process.platform !== 'win32') return t.skip('ACL Windows real');
  const packageFile = extractedPackage(t), profile = await syntheticProfile(t);
  const absent = await runExtracted(packageFile.entry, profile);
  assert.equal(absent.exit, 1, absent.stderr);
});

test('ZIP extraído recusa descriptor adulterado com broker real aberto', async t => {
  if (process.platform !== 'win32') return t.skip('ACL Windows real');
  const packageFile = extractedPackage(t), profile = await syntheticProfile(t);
  await startBrokerApp(t, { userData: profile.userData, credential: profile.credential });
  const descriptorPath = join(profile.userData, 'broker-control', 'descriptor.json');
  writeFileSync(descriptorPath, '{}');
  const tampered = await runExtracted(packageFile.entry, profile);
  assert.equal(tampered.exit, 1, tampered.stderr);
});

test('ZIP extraído recusa código revogado com broker real aberto', async t => {
  if (process.platform !== 'win32') return t.skip('ACL Windows real');
  const packageFile = extractedPackage(t), profile = await syntheticProfile(t);
  await startBrokerApp(t, { userData: profile.userData, credential: profile.credential });
  revokeClaudeActivation({ activationPath: profile.activationPath });
  const revoked = await runExtracted(packageFile.entry, profile);
  assert.equal(revoked.exit, 1, revoked.stderr);
});

test('ZIP extraído recusa PE ou manifesto nativo ausente ao iniciar', async t => {
  if (process.platform !== 'win32') return t.skip('ACL Windows real');
  const packageFile = extractedPackage(t), profile = await syntheticProfile(t);
  await startBrokerApp(t, { userData: profile.userData, credential: profile.credential });
  const exe = join(packageFile.unpacked, 'native/win-acl/bin/lume-acl.exe');
  const manifest = join(packageFile.unpacked, 'native/win-acl/bin/manifest.json');
  rmSync(exe);
  const missingExe = await runExtracted(packageFile.entry, profile);
  assert.equal(missingExe.exit, 1, missingExe.stderr);
  cpSync(join(root, 'native/win-acl/bin/lume-acl.exe'), exe);
  rmSync(manifest);
  const missingManifest = await runExtracted(packageFile.entry, profile);
  assert.equal(missingManifest.exit, 1, missingManifest.stderr);
});

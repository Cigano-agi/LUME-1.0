import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  applyClaudeActivation,
  authorizeClaudeBrokerHello,
  authorizeClaudeBrokerBegin,
  listMcpClients,
  previewClaudeActivation,
  revokeClaudeActivation,
  verifyClaudeActivationCode
} from '../src/mcp/activation.js';
import { buildLumeMcpb, inspectStoredMcpb } from '../scripts/build-lume-mcpb.mjs';
import { MCP_TOOL_DEFINITIONS } from '../src/mcp/schemas.js';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';

const today = { kind: 'today', date: '2026-09-19' };
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'lume-mcp-activation-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('clientes mantêm ordem e não anunciam ChatGPT como conectado', () => {
  const clients = listMcpClients();
  assert.deepEqual(clients.map(client => client.id), ['claude-desktop', 'chatgpt']);
  assert.equal(clients[0].available, true);
  assert.equal(clients[0].transport, 'stdio');
  assert.equal(clients[1].available, false);
  assert.match(clients[1].reason, /ainda não disponível/i);
});

test('prévia não grava e ativação guarda apenas hash do código', t => {
  const path = join(temp(t), 'mcp', 'claude-desktop.json');
  const preview = previewClaudeActivation({ activationPath: path, scope: today });
  assert.equal(preview.action, 'enable');
  assert.equal(preview.requires_new_code, true);
  assert.throws(() => readFileSync(path));
  const result = applyClaudeActivation({ activationPath: path, scope: today });
  assert.equal(result.activation_code.length, 43);
  assert.equal(result.backup_created, false);
  assert.equal(verifyClaudeActivationCode({ activationPath: path, credential: result.activation_code }), true);
  const disk = readFileSync(path, 'utf8');
  assert.ok(!disk.includes(result.activation_code));
  const descriptor = JSON.parse(disk);
  assert.equal(descriptor.enabled, true);
  assert.deepEqual(descriptor.scope, today);
  assert.match(descriptor.credential_hash, /^[a-f0-9]{64}$/);
});

test('repetição é idempotente, mudança cria backup e revogação vence', t => {
  const path = join(temp(t), 'claude-desktop.json');
  const first = applyClaudeActivation({ activationPath: path, scope: today });
  const unchanged = applyClaudeActivation({ activationPath: path, scope: today });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.activation_code, null);
  const beforeScopeChange = readFileSync(path, 'utf8');
  const changed = applyClaudeActivation({ activationPath: path, scope: { kind: 'projects', ids: ['b', 'a', 'a'] } });
  assert.equal(changed.action, 'update-scope');
  assert.equal(changed.backup_created, true);
  assert.equal(readFileSync(path + '.bak', 'utf8'), beforeScopeChange);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).scope.ids, ['a', 'b']);
  assert.equal(verifyClaudeActivationCode({ activationPath: path, credential: first.activation_code }), true);
  assert.equal(revokeClaudeActivation({ activationPath: path }).changed, true);
  assert.equal(revokeClaudeActivation({ activationPath: path }).changed, false);
  assert.equal(verifyClaudeActivationCode({ activationPath: path, credential: first.activation_code }), false);
});

test('configuração danificada falha fechada sem ser sobrescrita', t => {
  const path = join(temp(t), 'claude-desktop.json'), broken = '{"enabled":true,"credential_hash":"vazou"}';
  writeFileSync(path, broken);
  assert.throws(() => applyClaudeActivation({ activationPath: path, scope: today }), /danificada|incompatível/);
  assert.equal(readFileSync(path, 'utf8'), broken);
  assert.equal(verifyClaudeActivationCode({ activationPath: path, credential: 'qualquer' }), false);
});

test('broker consulta código, escopo e revision atual a cada HELLO e BEGIN', t => {
  const activationPath = join(temp(t), 'claude-desktop.json');
  const credential = 'codigo-local-com-mais-de-trinta-e-dois-caracteres';
  const first = applyClaudeActivation({ activationPath, scope: today, credential });
  const hello = () => authorizeClaudeBrokerHello({ activationPath, clientId: 'claude-desktop', credential });
  const begin = revision => authorizeClaudeBrokerBegin({ activationPath, clientId: 'claude-desktop', revision });
  assert.deepEqual(hello(), { revision: JSON.parse(readFileSync(activationPath)).revision });
  const revision = hello().revision;
  assert.deepEqual(begin(revision), { revision });
  assert.equal(authorizeClaudeBrokerHello({ activationPath, clientId: 'outro', credential }), null);
  assert.equal(authorizeClaudeBrokerHello({ activationPath, clientId: 'claude-desktop', credential: credential + 'x' }), null);
  applyClaudeActivation({ activationPath, scope: { kind: 'all' } });
  assert.equal(begin(revision), null);
  const changed = JSON.parse(readFileSync(activationPath));
  writeFileSync(activationPath, JSON.stringify({ ...changed, scope: { kind: 'projects', ids: [] } }));
  assert.equal(hello(), null);
  writeFileSync(activationPath, JSON.stringify({ ...changed, revision: 'not-a-uuid' }));
  assert.equal(hello(), null);
  writeFileSync(activationPath, JSON.stringify(changed));
  revokeClaudeActivation({ activationPath });
  assert.equal(hello(), null);
  assert.equal(first.enabled, true);
});

test('manifesto MCPB usa stdio, código sensível e as cinco ferramentas reais', () => {
  const manifest = JSON.parse(readFileSync(resolve('mcpb/lume/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.mcp_config.command, 'node');
  assert.equal(manifest.user_config.activation_code.sensitive, true);
  assert.deepEqual(manifest.compatibility.platforms, ['darwin', 'win32']);
  assert.deepEqual(manifest.tools.map(tool => tool.name), MCP_TOOL_DEFINITIONS.map(tool => tool.name));
  assert.ok(!JSON.stringify(manifest).includes('ChatGPT'));
  assert.ok(!JSON.stringify(manifest).includes('assessor.db'));
});

test('empacotador produz MCPB autocontido sem dados ou credenciais', t => {
  const outputDir = temp(t), result = buildLumeMcpb({ outputDir });
  const entries = inspectStoredMcpb(readFileSync(result.artifact));
  assert.deepEqual(entries.map(entry => entry.name), result.entries);
  assert.deepEqual(result.entries, [
    'manifest.json', 'package.json', 'icon.png', 'server/index.js',
    'src/perfil-ativo.js', 'src/perfil-boot.js', 'src/perfil-boot-guard.js',
    'src/mcp/core.js', 'src/mcp/execucao.js', 'src/execucao/esquema.js',
    'src/execucao/projeto.js', 'src/execucao/inventario-nativo.js', 'src/execucao/servico.js', 'src/notetaker/perfil-teste.js', 'src/notetaker/vinculos.js',
    'src/mcp/errors.js', 'src/mcp/activation.js', 'src/mcp/profile-broker-client.js',
    'src/mcp/broker-frames.js', 'src/mcp/broker-bootstrap.js', 'src/mcp/broker-acl-native.js',
    'src/mcp/presence.js', 'src/mcp/read-service.js',
    'src/mcp/schemas.js', 'src/mcp/stdio-entry.js', 'src/mcp/stdio-server.js',
    'src/mcp/tokens.js', 'src/fontes-desktop.js', 'src/leitura-sql.js',
    'src/qualidade-transcricao.js', 'src/relogio.js', 'src/tarefas-esquema.js',
    ...(process.platform === 'darwin' ? [] : ['native/win-acl/bin/lume-acl.exe', 'native/win-acl/bin/manifest.json'])
  ], 'allowlist fechada do MCPB');
  assert.ok(!result.entries.some(name => /src\/perfil-manutencao\.js$|src\/notetaker\/(?:exclusao-[^/]+|direitos-selecao|servico|importacao|contrato|esquema)\.js$|audio-local-runtime\.js$/.test(name)));
  assert.ok(entries.some(entry => entry.name === 'manifest.json'));
  assert.ok(entries.some(entry => entry.name === 'server/index.js'));
  assert.ok(entries.some(entry => entry.name === 'src/mcp/stdio-entry.js'));
  assert.deepEqual(entries.find(entry => entry.name === 'src/perfil-ativo.js').data, readFileSync(resolve('src/perfil-ativo.js')));
  assert.deepEqual(entries.find(entry => entry.name === 'src/perfil-boot.js').data, readFileSync(resolve('src/perfil-boot.js')));
  assert.deepEqual(entries.find(entry => entry.name === 'src/perfil-boot-guard.js').data, readFileSync(resolve('src/perfil-boot-guard.js')));
  assert.deepEqual(entries.find(entry => entry.name === 'src/execucao/projeto.js').data, readFileSync(resolve('src/execucao/projeto.js')));
  assert.ok(!entries.some(entry => /(?:^|\/)(?:data|wa-auth)(?:\/|$)|\.(?:db|sqlite)$|creds\.json|\.env$/i.test(entry.name)));
  const content = Buffer.concat(entries.map(entry => entry.data)).toString('utf8');
  assert.ok(!content.includes('LUME_MCP_CREDENTIAL='));
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

function packageFixture(t, { packaged = false } = {}) {
  const base = temp(t), root = packaged ? join(base, 'app.asar') : join(base, 'checkout');
  mkdirSync(root, { recursive: true });
  cpSync(resolve('mcpb'), join(root, 'mcpb'), { recursive: true });
  cpSync(resolve('src'), join(root, 'src'), { recursive: true });
  const nativeTarget = packaged ? join(base, 'app.asar.unpacked') : root;
  cpSync(resolve('native/win-acl/bin'), join(nativeTarget, 'native', 'win-acl', 'bin'), { recursive: true });
  mkdirSync(join(root, 'desktop')); cpSync(resolve('desktop/icon.png'), join(root, 'desktop/icon.png'));
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  if (packaged) delete pkg.build;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  if (!packaged) cpSync(resolve('package-lock.json'), join(root, 'package-lock.json'));
  return root;
}

test('empacotador falha antes de escrita em checkout incompleto ou divergente', t => {
  for (const [id,mutate] of [
    ['PACKAGE_MISSING',root => rmSync(join(root,'package.json'))],
    ['PACKAGE_MALFORMED',root => writeFileSync(join(root,'package.json'),'{')],
    ['PACKAGE_VERSION',root => { const pkg=JSON.parse(readFileSync(join(root,'package.json'))); pkg.version='3.2'; writeFileSync(join(root,'package.json'),JSON.stringify(pkg)); }],
    ['ELECTRON_METADATA_MISSING',root => { const pkg=JSON.parse(readFileSync(join(root,'package.json'))); delete pkg.build; writeFileSync(join(root,'package.json'),JSON.stringify(pkg)); }],
    ['ELECTRON_METADATA_VERSION',root => { const pkg=JSON.parse(readFileSync(join(root,'package.json'))); pkg.build.extraMetadata.version='3.2.0-beta.4'; writeFileSync(join(root,'package.json'),JSON.stringify(pkg)); }],
    ['PACKAGE_LOCK_MISSING',root => rmSync(join(root,'package-lock.json'))],
    ['PACKAGE_LOCK_MALFORMED',root => writeFileSync(join(root,'package-lock.json'),'{')],
    ['PACKAGE_LOCK_VERSION',root => { const lock=JSON.parse(readFileSync(join(root,'package-lock.json'))); lock.version='3.2.0-beta.4'; writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock)); }],
    ['PACKAGE_LOCK_ROOT_MISSING',root => { const lock=JSON.parse(readFileSync(join(root,'package-lock.json'))); delete lock.packages['']; writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock)); }],
    ['PACKAGE_LOCK_ROOT_VERSION',root => { const lock=JSON.parse(readFileSync(join(root,'package-lock.json'))); lock.packages[''].version='3.2.0-beta.4'; writeFileSync(join(root,'package-lock.json'),JSON.stringify(lock)); }],
    ['MCP_MANIFEST_MISSING',root => rmSync(join(root,'mcpb/lume/manifest.json'))],
    ['MCP_MANIFEST_MALFORMED',root => writeFileSync(join(root,'mcpb/lume/manifest.json'),'{')],
    ['MCP_MANIFEST_FORMAT',root => { const manifest=JSON.parse(readFileSync(join(root,'mcpb/lume/manifest.json'))); manifest.manifest_version='0.2'; writeFileSync(join(root,'mcpb/lume/manifest.json'),JSON.stringify(manifest)); }],
    ['MCP_MANIFEST_NAME',root => { const manifest=JSON.parse(readFileSync(join(root,'mcpb/lume/manifest.json'))); manifest.name='outro'; writeFileSync(join(root,'mcpb/lume/manifest.json'),JSON.stringify(manifest)); }],
    ['MCP_MANIFEST_VERSION',root => { const manifest=JSON.parse(readFileSync(join(root,'mcpb/lume/manifest.json'))); manifest.version='3.2.0-beta.4'; writeFileSync(join(root,'mcpb/lume/manifest.json'),JSON.stringify(manifest)); }]
  ]) {
    const root=packageFixture(t),outputDir=join(root,'output');mkdirSync(outputDir);writeFileSync(join(outputDir,'sentinela.txt'),'preservar');mutate(root);
    assert.throws(()=>buildLumeMcpb({root,outputDir}),new RegExp(id));
    assert.equal(readFileSync(join(outputDir,'sentinela.txt'),'utf8'),'preservar');
    assert.deepEqual(readdirSync(outputDir),['sentinela.txt']);
  }
});

test('empacotador rejeita diretório que finge ser app.asar sem arquivo físico', t => {
  const root=packageFixture(t,{packaged:true}),outputDir=join(root,'output');
  assert.throws(()=>buildLumeMcpb({root,outputDir}));
  assert.equal(rmSync(outputDir,{recursive:true,force:true}),undefined);
  assert.throws(()=>buildLumeMcpb({root,outputDir,shape:'packaged'}),/MCPB_ASAR_UNTRUSTED/);
});

test('pacote extraído sem broker não responde initialize offline', async t => {
  const root = temp(t), outputDir = join(root, 'out'), unpacked = join(root, 'unpacked');
  const profileEnv = process.platform === 'darwin' ? { HOME: join(root, 'home') } : { APPDATA: join(root, 'appdata') };
  const data = process.platform === 'darwin' ? join(profileEnv.HOME, 'Library', 'Application Support', 'AssessorDesktop', 'data') : join(profileEnv.APPDATA, 'AssessorDesktop', 'data');
  const result = buildLumeMcpb({ outputDir });
  for (const entry of inspectStoredMcpb(readFileSync(result.artifact))) {
    const target = join(unpacked, ...entry.name.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, entry.data);
  }
  const extractedResolver = await import(pathToFileURL(join(unpacked, 'src', 'perfil-ativo.js')).href);
  assert.equal(typeof extractedResolver.resolverPerfilAtivo, 'function');
  mkdirSync(data, { recursive: true });
  const db = abrirBanco(join(data, 'assessor.db')); new ContextoApp(db); new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('grupo@g.us', 'Equipe');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('grupo@g.us','wa-package','saida','eu',1,'texto','{}','Pacote funcionando','2026-09-19T12:00:00.000Z','2026-09-19','minha')`).run();
  db.close();
  const credential = 'codigo-de-ativacao-com-mais-de-trinta-e-dois-caracteres';
  applyClaudeActivation({ activationPath: join(data, 'mcp', 'claude-desktop.json'), scope: { kind: 'all' }, credential });
  const child = spawn(process.execPath, [join(unpacked, 'server', 'index.js')], {
    cwd: unpacked,
    env: { ...process.env, ...profileEnv, LUME_MCP_CREDENTIAL: credential, LUME_MCP_DATA_DIR: data },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  t.after(() => child.kill());
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'package-test', version: '1' } } }) + '\n');
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Servidor MCP empacotado não encerrou.')), 5000))]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.length > 0 && !stderr.includes(credential) && !stderr.includes(data));
});

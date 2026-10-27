// Native storage uses synthetic secrets in a new Electron profile. No real login or external call.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';
const require = createRequire(import.meta.url);
const {linkChatGPTPermitido} = require('../desktop/chatgpt-links.cjs');
const {criarCofre} = require('../desktop/segredos.cjs');
const authorization = (changes = {}) => {
  const url = new URL('https://auth.openai.com/api/accounts/authorize');
  for (const [key, value] of Object.entries({client_id: 'dynamic_agent_client', response_type: 'code', code_challenge_method: 'S256', code_challenge: 'a'.repeat(43), state: 'b'.repeat(43), redirect_uri: 'http://127.0.0.1:1455/auth/callback', ...changes})) url.searchParams.set(key, value);
  return url.href;
};

test('desktop pessoal: somente autorização PKCE local e URL exata de uso podem abrir externamente', () => {
  assert.equal(linkChatGPTPermitido(authorization()), true);
  assert.equal(linkChatGPTPermitido(authorization({client_id: 'oaiapp_synthetic-123'})), true);
  assert.equal(linkChatGPTPermitido('https://chatgpt.com/settings/usage'), true);
  for (const url of ['https://chatgpt.com/settings/usage?next=evil', 'https://chatgpt.com/settings/usage#fragment', 'https://chatgpt.com/settings/usage/', 'https://chatgpt.com/codex/settings/usage', 'https://evil.invalid/settings/usage', 'javascript:alert(1)', 'not a URL', authorization().replace('auth.openai.com', 'auth.openai.com.evil.invalid'), authorization().replace('https:', 'http:'), authorization().replace('/api/accounts/authorize', '/logout'), authorization().replace('auth.openai.com', 'user:pass@auth.openai.com'), authorization() + '#fragment']) assert.equal(linkChatGPTPermitido(url), false, url);
  for (const changes of [{client_id: 'untrusted'}, {response_type: 'token'}, {code_challenge_method: 'plain'}, {code_challenge: 'short'}, {state: ''}, ...['https://127.0.0.1:1455/auth/callback', 'http://localhost:1455/auth/callback', 'http://127.0.0.1/auth/callback', 'http://evil.invalid:1455/auth/callback', 'http://127.0.0.1:1455/other', 'http://user:pass@127.0.0.1:1455/auth/callback', 'http://127.0.0.1:1455/auth/callback?next=evil', 'http://127.0.0.1:1455/auth/callback#fragment', 'http://[::1]:1455/auth/callback'].map(redirect_uri => ({redirect_uri}))]) assert.equal(linkChatGPTPermitido(authorization(changes)), false, JSON.stringify(changes));
});

test('desktop pessoal: cofre indisponível recusa leitura/gravação sem fallback em texto', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-cofre-recusado-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const vault = criarCofre(dir, {isEncryptionAvailable: () => false, encryptString: () => assert.fail('No plaintext fallback'), decryptString: () => assert.fail('No fallback read')});
  for (const tipo of ['chatgpt', 'github', 'clickup']) {
    assert.deepEqual(vault.executar(tipo + '-estado'), {disponivel: false, configurada: false});
    assert.throws(() => vault.executar(tipo + '-gravar', 'synthetic-secret'));
    assert.throws(() => vault.executar(tipo + '-ler'));
    assert.deepEqual(vault.executar(tipo + '-remover'), {ok: true});
  }
});

test('desktop pessoal: Electron real cifra ChatGPT/GitHub/ClickUp em cofre nativo isolado', {timeout: 60000}, async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'lume-cofre-native-'));
  const profile = join(temporary, 'profile'), entry = join(temporary, 'main.cjs');
  mkdirSync(profile);
  const source = fileURLToPath(new URL('../desktop/segredos.cjs', import.meta.url));
  writeFileSync(entry, `const {app}=require('electron');global.testRequire=require;app.setPath('userData',${JSON.stringify(profile)});app.commandLine.appendSwitch('disable-background-networking');app.commandLine.appendSwitch('disable-component-update');app.whenReady().then(()=>{});`);
  let application;
  try {
    application = await electron.launch({args: [entry], timeout: 30000, env: {...process.env}});
    const proof = await application.evaluate(async ({app, safeStorage, BrowserWindow}, {source, temporary}) => {
      await app.whenReady();
      const {readFileSync, readdirSync} = global.testRequire('node:fs'), {join} = global.testRequire('node:path');
      const {criarCofre} = global.testRequire(source), dir = join(temporary, 'vault');
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text')) return {available: false};
      const vault = criarCofre(dir, safeStorage), secrets = {chatgpt: JSON.stringify({version: 1, accounts: [{id: 'synthetic', accessToken: 'SYNTHETIC_ONLY_ACCESS_TOKEN', refreshToken: 'SYNTHETIC_ONLY_REFRESH_TOKEN'}]}), github: 'SYNTHETIC_ONLY_GITHUB_TOKEN', clickup: 'SYNTHETIC_ONLY_CLICKUP_TOKEN'};
      const results = [];
      for (const [tipo, value] of Object.entries(secrets)) {
        const before = vault.executar(tipo + '-estado'), write = vault.executar(tipo + '-gravar', value), status = vault.executar(tipo + '-estado');
        const bytes = readFileSync(join(dir, 'lume-' + tipo + '.seguro'));
        const reopened = criarCofre(dir, safeStorage);
        results.push({tipo, before, write, status, sameAfterReopen: reopened.executar(tipo + '-ler') === value, plaintextAbsent: !bytes.includes(Buffer.from(value)) && !bytes.includes(Buffer.from('SYNTHETIC_ONLY')), bytes: bytes.length});
      }
      const invalid = [];
      for (const [op, value] of [['github-gravar', 'bad token'], ['clickup-gravar', 'x'.repeat(2049)], ['chatgpt-gravar', '{}'], ['chatgpt-gravar', '{broken'], ['chatgpt-gravar', JSON.stringify({version: 1, accounts: Array(17).fill({})})], ['../outside-gravar', 'synthetic']]) {
        try {vault.executar(op, value); invalid.push(false);} catch {invalid.push(true);}
      }
      const preserved = Object.entries(secrets).every(([tipo, value]) => vault.executar(tipo + '-ler') === value), files = readdirSync(dir);
      vault.executar('github-remover');
      const isolatedRemoval = !vault.executar('github-estado').configurada && vault.executar('clickup-estado').configurada && vault.executar('chatgpt-estado').configurada;
      return {available: true, electron: process.versions.electron, platform: process.platform, userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length, results, invalid, preserved, files, isolatedRemoval};
    }, {source, temporary});
    if (!proof.available && process.platform !== 'win32') {t.skip('Native secure storage unavailable in this runtime; no plaintext substitute'); return;}
    assert.equal(proof.available, true); assert.equal(proof.userData, profile); assert.equal(proof.windows, 0);
    assert.ok(proof.results.every(r => !r.before.configurada && r.status.configurada && r.status.disponivel && r.write.ok && r.sameAfterReopen && r.plaintextAbsent && r.bytes > 0));
    assert.ok(proof.invalid.every(Boolean)); assert.equal(proof.preserved, true); assert.equal(proof.isolatedRemoval, true);
    assert.deepEqual(proof.files.sort(), ['lume-chatgpt.seguro', 'lume-clickup.seguro', 'lume-github.seguro']);
    const output = resolve('work/pessoal-20261026'); mkdirSync(output, {recursive: true});
    writeFileSync(join(output, 'pessoal-desktop-cofre-proof.json'), JSON.stringify({syntheticCredentials: true, nativeEncryption: true, realLogin: false, externalCalls: false, ...proof}, null, 2));
  } finally {
    if (application) await application.close();
    rmSync(temporary, {recursive: true, force: true});
  }
});

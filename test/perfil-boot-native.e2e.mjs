// Gate nativo manual: executar somente após recibo explícito de CPU.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electronPath from 'electron';
import { _electron as electron } from 'playwright';

const parent = mkdtempSync(join(tmpdir(), 'lume-native-boot-'));
const wrapper = resolve('test/fixtures/perfil-boot-dialog.cjs');
const sleep = ms => new Promise(done => setTimeout(done, ms));
let safeToClean = false;

function capture(stream) {
  let buffer = '', pending = '';
  const state = { utilityStarted: 0, utilityExited: 0, dialogCode: null };
  stream?.on('data', chunk => {
    const text = String(chunk);
    buffer = (buffer + text).slice(-16384);
    pending += text;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      if (line === 'LUME_UTILITY_STARTED') state.utilityStarted++;
      if (line === 'LUME_UTILITY_EXITED') state.utilityExited++;
      if (line.startsWith('LUME_BOOT_DIALOG_CODE=')) state.dialogCode = line.slice('LUME_BOOT_DIALOG_CODE='.length);
    }
    pending = pending.slice(-512);
  });
  return { tail: () => buffer, state };
}

async function closed(child, close, timeoutMs = 15000) {
  const result = await Promise.race([close.then(() => 'closed'), sleep(timeoutMs).then(() => 'timeout')]);
  if (result === 'closed') return;
  child.kill();
  const killed = await Promise.race([close.then(() => 'closed'), sleep(5000).then(() => 'timeout')]);
  if (killed !== 'closed') { safeToClean = false; throw new Error('Electron não confirmou encerramento; fixture preservado.'); }
  throw new Error('Electron excedeu o prazo antes de encerrar.');
}

async function refusal(kind, setup, expectedCode, { utility = 0, env = {}, allowCredentials = false } = {}) {
  const userData = join(parent, kind, 'AssessorDesktop');
  mkdirSync(userData, { recursive: true });
  setup(userData);
  const child = spawn(electronPath, [wrapper], { cwd: resolve('.'), env: { ...process.env, ASSESSOR_DESKTOP_TEST_PROFILE: userData, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const close = new Promise(done => child.once('close', done));
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  const stderr = capture(child.stderr); capture(child.stdout);
  await closed(child, close);
  assert.equal(spawnError, null, spawnError?.message);
  assert.equal(stderr.state.dialogCode, expectedCode, stderr.tail());
  assert.equal(stderr.tail().includes(userData), false);
  assert.equal(stderr.state.utilityStarted, utility);
  assert.equal(stderr.state.utilityExited, utility);
  assert.equal(readdirSync(userData).includes('data'), false);
  if (!allowCredentials) assert.equal(readdirSync(userData).includes('credenciais'), false);
}

try {
  const first = join(parent, 'first', 'AssessorDesktop');
  mkdirSync(join(parent, 'first'));
  const legacy = await electron.launch({ args: [wrapper], env: { ...process.env, ASSESSOR_DESKTOP_TEST_PROFILE: first }, timeout: 30000 });
  const legacyProcess = legacy.process();
  const legacyClosed = new Promise(done => legacyProcess.once('close', done));
  const legacyStderr = capture(legacyProcess.stderr); capture(legacyProcess.stdout);
  try {
    const window = await legacy.firstWindow();
    await window.locator('#owner').waitFor({ state: 'visible', timeout: 30000 });
    assert.match(window.url(), /^http:\/\/127\.0\.0\.1:\d+\/app(?:$|[?#])/);
    assert.equal(await window.evaluate(async () => (await fetch('/app')).status), 200);
    assert.equal(existsSync(join(first, 'data', 'assessor.db')), true);
    assert.equal(existsSync(join(first, 'assessor.db')), false);
  } finally {
    const closeResult = await Promise.race([legacy.close().then(() => 'closed', () => 'error'), sleep(15000).then(() => 'timeout')]);
    if (closeResult !== 'closed') {
      legacyProcess.kill();
      const stopped = await Promise.race([legacyClosed.then(() => true), sleep(5000).then(() => false)]);
      if (!stopped) safeToClean = false;
      throw new Error('Electron legado não confirmou encerramento normal.');
    }
    await legacyClosed;
    if (legacyProcess.exitCode === null && legacyProcess.signalCode === null) { safeToClean = false; throw new Error('Electron legado não confirmou encerramento.'); }
  }
  assert.equal(legacyStderr.state.utilityStarted, 1, legacyStderr.tail());
  assert.equal(legacyStderr.state.utilityExited, 1, legacyStderr.tail());

  await refusal('journal', userData => writeFileSync(join(userData, 'perfil-publicacao.json'), '{}'), 'PERFIL_RECUPERACAO_PENDENTE');
  await refusal('corrupt', userData => writeFileSync(join(userData, 'perfil-ativo.json'), '{}'), 'PERFIL_SELETOR_INVALIDO');
  await refusal('profiles', userData => mkdirSync(join(userData, 'profiles')), 'PERFIL_SELECAO_PENDENTE');
  await refusal('managed', userData => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const data = join(userData, 'profiles', id, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'assessor.db'), 'synthetic-db');
    const info = statSync(data, { bigint: true });
    writeFileSync(join(userData, 'perfil-ativo.json'), JSON.stringify({ schema: 1, id, geracao: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', diretorio: { dev: String(info.dev), ino: String(info.ino) } }));
  }, 'PERFIL_GERIDO_AGUARDANDO_BROKER');
  await refusal('changed-between-processes', () => {}, 'PERFIL_RECUPERACAO_PENDENTE', { utility: 1, allowCredentials: true, env: { LUME_TEST_JOURNAL_BEFORE_FORK: '1' } });
  safeToClean = true;
  process.stdout.write('PERFIL_BOOT_NATIVE_OK\n');
} finally {
  if (safeToClean) rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  else process.stderr.write('LUME_NATIVE_FIXTURE_PRESERVED\n');
}

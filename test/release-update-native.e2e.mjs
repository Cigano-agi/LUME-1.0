// Prova pós-publicação entre duas releases assinadas. Só roda em runner nativo
// descartável e nunca usa o perfil vivo nem credenciais de WhatsApp por padrão.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { assertUpdateVersions, UPDATE_OBSERVATION_SCHEMA } from '../scripts/release-update-proof.mjs';

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Argumentos invalidos.');
    const name = key.slice(2).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    if (Object.hasOwn(result, name)) throw new Error('Argumento repetido.');
    result[name] = value;
  }
  return result;
}

const options = args(process.argv.slice(2));
for (const key of ['baselineVersion', 'targetVersion', 'executable', 'output']) if (!options[key]) throw new Error(`--${key} obrigatorio.`);
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.LUME_UPDATE_PROOF !== 'AUTORIZADO') throw new Error('A prova nativa so pode rodar no workflow descartavel autorizado.');
if (process.env.ASSESSOR_DESKTOP_TEST_PROFILE) throw new Error('O perfil de teste explicito desliga o atualizador e nao pode ser usado nesta prova.');
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : null;
if (!platform) throw new Error('A prova exige Windows ou macOS nativo.');
const architecture = process.arch;
if ((platform === 'windows' && architecture !== 'x64') || (platform === 'macos' && !['arm64', 'x64'].includes(architecture))) throw new Error(`Arquitetura nativa nao suportada: ${architecture}.`);
const versions = assertUpdateVersions(options);
const executable = resolve(options.executable), output = resolve(options.output);
if (!existsSync(executable)) throw new Error('Executavel da versao base ausente.');
if (!/^\d+$/.test(String(process.env.GITHUB_RUN_ID || ''))) throw new Error('GITHUB_RUN_ID obrigatorio.');

const sandbox = resolve(process.env.RUNNER_TEMP || tmpdir(), `lume-update-proof-${process.env.GITHUB_RUN_ID}`);
const home = join(sandbox, 'home'), appData = join(sandbox, 'appdata');
mkdirSync(home, { recursive: true }); mkdirSync(appData, { recursive: true }); mkdirSync(dirname(output), { recursive: true });
const launchEnv = { ...process.env };
delete launchEnv.ASSESSOR_DESKTOP_TEST_PROFILE;
if (platform === 'windows') launchEnv.APPDATA = appData;
else launchEnv.HOME = home;
const marker = `prova-update-${process.env.GITHUB_RUN_ID}`;

async function launch() {
  return electron.launch({ executablePath: executable, env: launchEnv, timeout: 60000 });
}

async function runtime(application) {
  return application.evaluate(({ app }) => ({ version: app.getVersion(), profile: app.getPath('userData') }));
}

async function waitExit(child, timeoutMs = 180000) {
  if (child.exitCode !== null) return;
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error('O aplicativo nao encerrou para instalar a atualizacao.')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
}

function stopAutomaticRelaunch() {
  const result = platform === 'windows'
    ? spawnSync('taskkill.exe', ['/F', '/IM', 'Lume.exe'], { windowsHide: true, encoding: 'utf8' })
    : spawnSync('pkill', ['-x', 'Lume'], { encoding: 'utf8' });
  if (![0, 1, 128].includes(result.status)) throw new Error('Nao foi possivel encerrar o relancamento automatico no runner descartavel.');
}

let baselineApp = null, targetApp = null;
try {
  baselineApp = await launch();
  const page = await baselineApp.firstWindow({ timeout: 60000 });
  const before = await runtime(baselineApp);
  assert.equal(before.version, versions.baseline);
  await page.locator('#owner').waitFor({ timeout: 30000 });
  await page.locator('#owner').fill('Prova automatica de atualizacao');
  await page.locator('#consent').check();
  await page.getByRole('button', { name: 'Preparar meu espaço' }).click();
  await page.getByRole('button', { name: 'Explorar meu espaço primeiro' }).click();
  const firstHide = page.locator('#first-hide'); if (await firstHide.isVisible().catch(() => false)) await firstHide.click();
  await page.locator('#note-title').fill('Marcador da prova');
  await page.locator('#note-text').fill(marker);
  await page.getByRole('button', { name: 'Guardar nota' }).click();
  await page.getByRole('status').filter({ hasText: 'Ideia guardada' }).waitFor();
  const database = join(before.profile, 'data', 'assessor.db');
  assert.equal(existsSync(database), true);

  await page.locator('nav [data-view=settings]').click();
   await page.locator('#settings-choice-data').click();
  const panel = page.locator('#atualizacoes-panel');
  await panel.getByText(new RegExp(`Versão instalada: ${versions.baseline.replaceAll('.', '\\.')}`)).waitFor();
  await panel.getByRole('button', { name: 'Verificar agora' }).click();
  await panel.getByText(`Versão ${versions.target} disponível.`).waitFor({ timeout: 120000 });
  await panel.getByRole('button', { name: 'Baixar atualização' }).click();
  await panel.getByText(`Versão ${versions.target} pronta para instalar.`).waitFor({ timeout: 300000 });
  await page.locator('#atualizacao-aviso').getByRole('button', { name: 'Reiniciar agora' }).click();
  const baselineProcess = baselineApp.process(); baselineApp = null;
  await waitExit(baselineProcess);

  // quitAndInstall relanca o app. O runner e descartavel e possui somente este
  // processo Lume; encerramos essa janela para reconectar o Playwright ao alvo.
  await new Promise(resolveWait => setTimeout(resolveWait, 20000));
  stopAutomaticRelaunch();
  let after = null, lastError = null;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try {
      targetApp = await launch();
      const candidate = await runtime(targetApp);
      if (candidate.version !== versions.target) { await targetApp.close(); targetApp = null; throw new Error(`Versao ainda observada: ${candidate.version}`); }
      after = candidate; break;
    } catch (error) {
      lastError = error;
      if (targetApp) { await targetApp.close().catch(() => {}); targetApp = null; }
      await new Promise(resolveWait => setTimeout(resolveWait, 5000));
    }
  }
  if (!after) throw lastError || new Error('A versao alvo nao iniciou.');
  assert.equal(after.profile, before.profile);
  const targetPage = await targetApp.firstWindow({ timeout: 60000 });
  await targetPage.locator('#workspace').waitFor({ timeout: 60000 });
  await targetPage.locator('nav [data-view=memory]').click();
  await targetPage.locator('#memory-mode-search').click();
  await targetPage.locator('#search').fill(marker);
  await targetPage.getByRole('button', { name: 'Buscar', exact: true }).click();
  await targetPage.locator('#results').filter({ hasText: marker }).waitFor();
  assert.equal(existsSync(database), true);
  assert.ok(statSync(database).size > 0);

  const realWhatsapp = process.env.LUME_REAL_WHATSAPP_CONFIRMED === 'VERIFICADO';
  const observation = {
    schema: UPDATE_OBSERVATION_SCHEMA,
    platform, architecture, channel: options.channel === 'estavel' ? 'estavel' : 'beta',
    baselineVersion: versions.baseline, targetVersion: versions.target,
    githubRunId: String(process.env.GITHUB_RUN_ID),
    profile: { samePath: true, isolatedRunnerProfile: true },
    database: { existedBefore: true, existsAfter: true, markerPreserved: true },
    update: { offeredVersion: versions.target, downloadCompleted: true, installRequested: true, runtimeBefore: before.version, runtimeAfter: after.version },
    whatsapp: { testedWithRealAccount: realWhatsapp, preserved: realWhatsapp ? true : null }
  };
  writeFileSync(output, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ updateObserved: true, baselineVersion: before.version, targetVersion: after.version, profilePreserved: true, databaseMarkerPreserved: true, realWhatsappTested: realWhatsapp }));
} finally {
  if (baselineApp) await baselineApp.close().catch(() => {});
  if (targetApp) await targetApp.close().catch(() => {});
}

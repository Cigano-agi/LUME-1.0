// Painel real sobre dados sintéticos. Não toca o perfil instalado.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { criarServidor } from '../src/painel/servidor.js';

const fixture = await criarPerfilRealSintetico();
new Desktop(fixture.db).aceitar({ nome: 'Pessoa sintética', aceito: true, versao: VERSAO_TERMOS });
fixture.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
  VALUES('c','m1','entrada','texto','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run();
const server = criarServidor(fixture.db, { desktop: true, conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const out = path.resolve('work/dados-v10-qa');
await mkdir(out, { recursive: true });
let newProfile;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/app`);
  await page.locator('nav [data-view=settings]').click();
  await page.locator('#settings-choice-data').click();
  await page.locator('#dados-backup-form').evaluate(form => { form.closest('details').open = true; });
  const backup = page.locator('#dados-backup-form');
  await backup.locator('input[type=password]').first().fill('senha sintética maior que doze caracteres');
  await backup.locator('input[type=password]').last().fill('senha sintética maior que doze caracteres');
  const downloadPromise = page.waitForEvent('download');
  await backup.getByRole('button', { name: 'Criar e salvar backup' }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^lume-backup-\d{4}-\d{2}-\d{2}\.lumebak$/);
  const backupPath = path.join(out, 'sintetico.lumebak');
  await download.saveAs(backupPath);
  assert.ok((await stat(backupPath)).size > 100);
  const restore = page.locator('#dados-restore-form');
  await restore.evaluate(form => { form.closest('details').open = true; });
  await restore.locator('input[type=file]').setInputFiles(backupPath);
  await restore.locator('input[type=password]').fill('senha sintética maior que doze caracteres');
  await restore.getByRole('button', { name: 'Conferir backup' }).click();
  await page.locator('#dados-restore-preview').waitFor({ state: 'visible', timeout: 120000 });
  assert.match(await page.locator('#dados-restore-preview').innerText(), /Pessoa sintética/);
  await page.locator('#dados-restore-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, '01-previa-v10.png') });
  await page.getByRole('button', { name: 'Este backup é meu · criar perfil novo' }).click();
  await page.locator('#dados-status').filter({ hasText: 'Perfil novo criado' }).waitFor({ timeout: 120000 });
  const text = await page.locator('#dados-restore-preview').innerText();
  assert.match(text, /ainda não abre perfis restaurados diretamente/);
  await page.locator('#dados-restore-preview').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(out, '02-perfil-novo-v10.png') });
  newProfile = text.match(/Perfil restaurado em: (.+)/)?.[1]?.split('\n')[0];
  assert.ok(newProfile);
  assert.ok((await stat(path.join(newProfile, 'data', 'assessor.db'))).isFile());
  assert.equal(fixture.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 1);
  console.log('PAINEL BACKUP V10 UI PASS:', path.join(out, '01-previa-v10.png'));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  await fixture.close();
  if (newProfile) await rm(newProfile, { recursive: true, force: true });
}

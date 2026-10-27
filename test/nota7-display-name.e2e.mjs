// Synthetic WhatsApp identities only. This test never reads the owner's profile.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright';
import {abrirBanco} from '../src/banco.js';
import {criarServidor} from '../src/painel/servidor.js';
import {perfilBeta05} from './fixtures/beta05-profile.js';

test('Hoje em 390 px mostra nomes legíveis sem JIDs sintéticos', async t => {
  const db = abrirBanco();
  t.after(() => db.close());
  const {contexto, desktop, mensagem, tarefa, negocio} = perfilBeta05(db,
    {vazio: true, agora: new Date('2026-09-23T15:00:00.000Z')});
  const casos = [
    {id: '000000000000@lid', tipo: 'Contato'},
    {id: '000000000000-0000000000@g.us', tipo: 'Grupo'},
    {id: '000000000000000000@newsletter', tipo: 'Canal'},
  ];
  for (const caso of casos) {
    const fonte = mensagem({conversa: caso.id, nome: caso.id,
      texto: `Mensagem sintética de ${caso.tipo.toLowerCase()}`});
    if (caso.tipo === 'Grupo') db.prepare('INSERT INTO grupos_app(id,nome,atualizado_em) VALUES(?,?,?)')
      .run(caso.id, caso.id, '2026-09-23T15:00:00.000Z');
    if (caso.tipo === 'Canal') db.prepare('DELETE FROM conversas_app WHERE id=?').run(caso.id);
    tarefa(fonte, {titulo: `Conferir ${caso.tipo.toLowerCase()}`});
    negocio(fonte, {titulo: `Proposta ${caso.tipo.toLowerCase()}`, valor_centavos: null});
  }
  mensagem({conversa: 'demo-humano', nome: 'Ana Ribeiro · demonstração',
    texto: 'Mensagem sintética com nome confirmado'});

  const server = criarServidor(db, {contexto, desktop: true,
    conexao: {estado: () => ({estado: 'desconectada', qr: null}), parar: async () => {}, iniciar: async () => {}}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 390, height: 850}});
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto(`http://127.0.0.1:${server.address().port}/app`);
  await page.locator('#first-hide').click();
  await page.locator('#clarity-content:not([hidden])').waitFor();
  const output = 'work/nota7-display-name/today-390.png';
  mkdirSync('work/nota7-display-name', {recursive: true});
  await page.screenshot({path: output, fullPage: true});

  const labels = await page.locator('#clarity-conversations .clarity-conversation-title').allInnerTexts();
  assert.equal(labels.length, 4, 'quatro conversas sintéticas aparecem em Hoje');
  assert.ok(labels.includes('Ana Ribeiro · demonstração'), 'nome humano permanece igual');
  const visible = await page.locator('#clarity-content').innerText();
  for (const caso of casos) {
    await t.test(`${caso.tipo} tem rótulo visível sem JID`, () => {
      assert.match(labels.join(' '), new RegExp(caso.tipo, 'i'), `${caso.tipo} recebe rótulo compreensível`);
      assert.equal(visible.includes(caso.id), false, `${caso.tipo} não revela o JID no texto visível`);
    });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    'Hoje não tem rolagem horizontal em 390 px');
});

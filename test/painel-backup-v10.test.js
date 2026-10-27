import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { criarServidor } from '../src/painel/servidor.js';
import { abrirBanco } from '../src/banco.js';
import { BackupPainelV10 } from '../src/painel/backup-v10.js';
import { prepararEsquemaFilaLaya } from '../src/laya/fila.js';
import { ContextoApp } from '../src/contexto-app.js';

const senha = 'senha sintética com mais de doze caracteres';

test('backup v10 prepara tabelas opcionais de perfil novo antes de exportar', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lume-backup-sparse-'));
  const dbPath = path.join(root, 'data', 'assessor.db');
  await mkdir(path.dirname(dbPath));
  const db = abrirBanco(dbPath);
  let bridge, created;
  try {
    new ContextoApp(db);
    new Desktop(db).aceitar({ nome: 'Pessoa sintética', aceito: true, versao: VERSAO_TERMOS });
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='eventos_financeiros'").get(), undefined);
    const evento = db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','m1','entrada','texto','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run().lastInsertRowid;
    prepararEsquemaFilaLaya(db);
    db.prepare(`INSERT INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,estado,criada_em,atualizada_em,tentativa_id)
      VALUES(?,'c','fonte','analisando','2026-09-28','2026-09-28','tentativa-ativa')`).run(evento);
    bridge = new BackupPainelV10(db, () => 'Pessoa sintética');
    created = await bridge.export(senha);
    assert.match(created.id, /^[a-f0-9]{64}$/);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='eventos_financeiros'").get());
    assert.deepEqual({ ...db.prepare('SELECT estado,tentativa_id FROM lume_laya_fila WHERE evento_id=?').get(evento) },
      { estado: 'analisando', tentativa_id: 'tentativa-ativa' });
  } finally {
    if (created) await bridge.discardDownload(created.id);
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('painel v10 transfere em fluxo, valida e restaura só em perfil novo', async t => {
  const f = await criarPerfilRealSintetico();
  new Desktop(f.db).aceitar({ nome: 'Pessoa sintética', aceito: true, versao: VERSAO_TERMOS });
  f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
    VALUES('c','m1','entrada','texto','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run();
  let paradas = 0;
  const server = criarServidor(f.db, { desktop: true, conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => { paradas++; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await f.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + '/api/sessao')).json();
  const post = (route, body) => fetch(base + '/api/v3/dados/' + route, { method: 'POST',
    headers: { 'X-Assessor-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const createdResponse = await post('backup-v10/criar', { senha });
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.match(created.id, /^[a-f0-9]{64}$/);
  const downloaded = await fetch(base + '/api/v3/dados/backup-v10/arquivo?ticket=' + created.id);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition'), /\.lumebak"$/);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(bytes.length, created.bytes);
  assert.equal((await fetch(base + '/api/v3/dados/backup-v10/arquivo?ticket=' + created.id)).status, 400);
  const upload = async password => fetch(base + '/api/v3/dados/backup-v10/importar', { method: 'POST',
    headers: { 'X-Assessor-Token': token, 'X-Lume-Backup-Password': Buffer.from(password).toString('base64'), 'Content-Type': 'application/octet-stream' }, body: bytes });
  const wrong = await upload('wrong password with length');
  assert.equal(wrong.status, 400);
  const importedResponse = await upload(senha);
  assert.equal(importedResponse.status, 200);
  const preview = await importedResponse.json();
  assert.equal(preview.resumo.versao, 10);
  assert.equal(preview.resumo.donoDeclarado, 'Pessoa sintética');
  const unconfirmed = await post('backup-v10/restaurar', { id: preview.id });
  assert.equal(unconfirmed.status, 400);
  const appliedResponse = await post('backup-v10/restaurar', { id: preview.id, confirmarMeuBackup: true });
  assert.equal(appliedResponse.status, 200);
  const applied = await appliedResponse.json();
  assert.equal(applied.versao, 10);
  assert.notEqual(path.dirname(path.dirname(f.dbPath)), applied.destinoNovo);
  assert.equal((await stat(path.join(applied.destinoNovo, 'data', 'assessor.db'))).isFile(), true);
  const restored = new DatabaseSync(path.join(applied.destinoNovo, 'data', 'assessor.db'), { readOnly: true });
  try { assert.equal(restored.prepare('SELECT COUNT(*) n FROM eventos').get().n, 1); }
  finally { restored.close(); }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 1);
  assert.equal(paradas, 0);
  assert.ok((await readFile(f.dbPath)).length > 0);
});

test('desconectar pausa captura e drena mídia antes de parar a conexão', async t => {
  const db = abrirBanco();
  new Desktop(db).aceitar({ nome: 'Teste', aceito: true, versao: VERSAO_TERMOS });
  const ordem = [];
  let liberar, avisar;
  const drenagem = new Promise(resolve => { liberar = resolve; });
  const iniciou = new Promise(resolve => { avisar = resolve; });
  const server = criarServidor(db, { desktop: true, midiaLoop: { parar: async () => { ordem.push('midia'); avisar(); await drenagem; } },
    conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => { ordem.push('conexao'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + '/api/sessao')).json();
  const request = fetch(base + '/api/desconectar', { method: 'POST', headers: { 'X-Assessor-Token': token,
    'Content-Type': 'application/json' }, body: '{}' });
  await iniciou;
  assert.equal(db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get().valor, '1');
  assert.deepEqual(ordem, ['midia']);
  liberar();
  assert.equal((await request).status, 200);
  assert.deepEqual(ordem, ['midia', 'conexao']);
});

test('restauração longa consome prévia e preserva staging até terminar', async () => {
  const f = await criarPerfilRealSintetico();
  try {
    const bridge = new BackupPainelV10(f.db, () => 'Pessoa sintética');
    const root = await mkdtemp(path.join(tmpdir(), 'lume-preview-race-'));
    const id = 'a'.repeat(64);
    bridge.previews.set(id, { root, plano: 'plano-de-teste', expiraEm: new Date(Date.now() + 60_000).toISOString() });
    let liberar, avisar;
    const espera = new Promise(resolve => { liberar = resolve; });
    const iniciou = new Promise(resolve => { avisar = resolve; });
    bridge.apply = async ({ destinoNovo }) => { avisar(); await espera; return { versao: 10, destinoNovo }; };
    const emCurso = bridge.restore(id, true);
    await iniciou;
    assert.equal(bridge.previews.has(id), false);
    await bridge.discardPreview(id); // Simula o timer de cinco minutos durante APPLY.
    assert.equal((await stat(root)).isDirectory(), true);
    await assert.rejects(bridge.restore(id, true), { code: 'BACKUP_OCUPADO' });
    liberar();
    assert.equal((await emCurso).versao, 10);
    await assert.rejects(stat(root), { code: 'ENOENT' });
    await assert.rejects(bridge.restore(id, true), { code: 'BACKUP_EXPIRADO' });
  } finally { await f.close(); }
});

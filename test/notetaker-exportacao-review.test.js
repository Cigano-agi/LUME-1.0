import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync,
  symlinkSync, unlinkSync, lstatSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { NotetakerServico } from '../src/notetaker/servico.js';
import { cabecalhoWav } from '../src/notetaker/contrato.js';
import { exportarSessao } from '../src/notetaker/exportacao.js';
import { selecionarDireitosSessao, validarPublicacaoSessao } from '../src/notetaker/direitos-selecao.js';

const sha = x => createHash('sha256').update(x).digest('hex');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lume-notetaker-review-'));
  const marker = randomUUID(), previous = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = root;
  writeFileSync(join(root, '.lume-notetaker-test'), marker);
  const dbPath = join(root, 'db.sqlite'), db = abrirBanco(dbPath);
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE = previous;
    rmSync(root, { recursive: true, force: true });
  });
  new ContextoApp(db); new Desktop(db);
  const svc = new NotetakerServico(db, { notetakerExperimento: true, testProfileRoot: root,
    testMarker: marker, audioLocal: { async estado() { return { disponivel: false }; } } });
  const sessaoId = svc.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
  svc.consentir(sessaoId, { entradas: ['importacao'], confirmar: true });
  const destinoPai = join(root, 'exportacoes'); mkdirSync(destinoPai);
  const id = randomUUID(), wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000, 7)]);
  writeFileSync(join(root, 'notetaker-audio', id + '.wav'), wav);
  db.prepare(`INSERT INTO notetaker_partes(id,sessao_id,entrada,posicao,inicio_ms,duracao_ms,sha256,caminho,estado)
    VALUES(?,?,'importacao',0,0,1000,?,?,'salva')`).run(id, sessaoId, sha(wav), id + '.wav');
  return { root, db, destinoPai, id, args: { dbPath, sessaoId, destinoPai,
    perfil: { testProfileRoot: root, testMarker: marker }, confirmar: true } };
}

test('revisao: alteração de dados antes do marcador impede publicação', async t => {
  const f = fixture(t);
  await assert.rejects(exportarSessao({ ...f.args, testHooks: { antesMarcador() {
    const pasta = join(f.destinoPai, readdirSync(f.destinoPai)[0]);
    const path = join(pasta, 'dados.ndjson');
    const bytes = readFileSync(path);
    bytes[0] ^= 1;
    writeFileSync(path, bytes);
  } } }), { code: 'INTEGRIDADE' });
  assert.deepEqual(readdirSync(f.destinoPai), []);
});

test('revisao: saída WAV substituída por symlink antes do marcador impede publicação', async t => {
  const f = fixture(t);
  let supported = true, pasta;
  let falha;
  try { await exportarSessao({ ...f.args, testHooks: { antesMarcador() {
    pasta = join(f.destinoPai, readdirSync(f.destinoPai)[0]);
    const out = join(pasta, 'audio', f.id + '.wav');
    unlinkSync(out);
    try { symlinkSync(join(f.root, 'notetaker-audio', f.id + '.wav'), out); }
    catch (e) { if (e.code === 'EPERM') { supported = false; throw e; } throw e; }
  } } }); } catch (e) { falha = e; }
  if (!supported) return t.skip('symlink sem permissão neste host');
  assert.equal(falha?.code, 'INTEGRIDADE');
  assert.equal(falha?.limpezaPendente, true);
  assert.equal(lstatSync(join(pasta, 'audio', f.id + '.wav')).isSymbolicLink(), true);
  assert.equal(readdirSync(pasta).includes('CONCLUIDO.json'), false);
});

test('revisao: original alterado depois da leitura é recusado e libera arquivos', async t => {
  const f = fixture(t);
  let alterou = false;
  await assert.rejects(exportarSessao({ ...f.args, testHooks: { aposChunk() {
    if (alterou) return;
    alterou = true;
    const path = join(f.root, 'notetaker-audio', f.id + '.wav');
    const bytes = readFileSync(path); bytes[44] ^= 1; writeFileSync(path, bytes);
  } } }), { code: 'INTEGRIDADE' });
  assert.equal(alterou, true);
  assert.deepEqual(readdirSync(f.destinoPai), []);
});

test('revisao: subpasta audio substituída antes do marcador é recusada', async t => {
  const f = fixture(t);
  let pasta;
  await assert.rejects(exportarSessao({ ...f.args, testHooks: { antesMarcador() {
    pasta = join(f.destinoPai, readdirSync(f.destinoPai)[0]);
    renameSync(join(pasta, 'audio'), join(pasta, 'audio-movido'));
    mkdirSync(join(pasta, 'audio'));
  } } }), { code: 'IO', limpezaPendente: true });
  assert.equal(readdirSync(join(pasta, 'audio-movido')).includes('CONCLUIDO.json'), false);
  assert.equal(readdirSync(pasta).includes('CONCLUIDO.json'), false);
});

test('revisao: lock SQLite no marcador retorna CONFLITO sem executar callback', t => {
  const f = fixture(t);
  const mapa = selecionarDireitosSessao(f.db, f.args.sessaoId, f.args.perfil);
  const outra = new DatabaseSync(f.args.dbPath);
  outra.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
  let executou = false;
  f.db.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => validarPublicacaoSessao(outra, mapa, f.args.perfil,
      () => { executou = true; }), { code: 'CONFLITO' });
    assert.equal(executou, false);
    assert.equal(outra.isTransaction, false);
  } finally { f.db.exec('ROLLBACK'); outra.close(); }
});

test('revisao: cancelamento por evento durante validação final impede marcador', async t => {
  const f = fixture(t), ac = new AbortController();
  let agendou = false;
  await assert.rejects(exportarSessao({ ...f.args, signal: ac.signal,
    testHooks: { aposCopiarAudio() {
      if (!agendou) { agendou = true; setImmediate(() => ac.abort()); }
    } } }), { code: 'CANCELADO' });
  assert.equal(agendou, true);
  assert.deepEqual(readdirSync(f.destinoPai), []);
});

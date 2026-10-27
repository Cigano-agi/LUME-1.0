import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { Semantica } from '../src/semantica.js';
import { ColetorCaixas } from '../src/caixas.js';
import { prepararEsquemaInventario } from '../src/inventario.js';
import { prepararEsquemaTranscricao } from '../src/transcricao.js';
import { prepararMetadadosAudio } from '../src/audio-desktop-arquivos.js';
import { prepararEsquemaFinanceiro } from '../src/financeiro.js';
import { prepararEsquemaRascunho } from '../src/rascunho.js';
import { prepararEsquemaPrecisao } from '../src/precisao.js';
import { prepararWhatsAppLabels } from '../src/whatsapp-labels.js';
import { prepararAcoesLume } from '../src/acoes-lume.js';
import { prepararExecucoes } from '../src/execucao/esquema.js';
import { prepararHistoricoWhatsApp } from '../src/transporte/historico.js';
import { prepararVendasJev } from '../src/vendas/servico.js';
import { prepararProjetosComerciais } from '../src/projetos-comerciais/esquema.js';
import { prepararProcedenciaCiclo } from '../src/privacidade.js';
import { FilaLaya } from '../src/laya/fila.js';
import { prepararMidiasCiclo } from '../src/ciclo-midia-worker.js';
import { DDL_CONTROLE_EXCLUSAO } from '../src/notetaker/exclusao-controle.js';
import { validarSchemaExclusao } from '../src/notetaker/exclusao-schema.js';
import { NotetakerServico } from '../src/notetaker/servico.js';
import { cabecalhoWav } from '../src/notetaker/contrato.js';
import { importarArquivo } from '../src/notetaker/importacao.js';
import { montarPlanoExclusao } from '../src/notetaker/exclusao-plano.js';

const DATA = '2026-10-01T12:00:00.000Z';
const hash = 'a'.repeat(64);
// DDL histórico de etapas anterior às três colunas de lease (banco.js antes de 49b5763).
const ETAPAS_V9_DDL = `CREATE TABLE etapas (
  evento_id            INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  etapa                TEXT NOT NULL,
  estado               TEXT NOT NULL CHECK (estado IN ('pendente','em_curso','concluida','falha','desistida')),
  tentativas           INTEGER NOT NULL DEFAULT 0,
  ultimo_erro          TEXT,
  resultado            TEXT,
  atualizado_em        TEXT NOT NULL,
  proxima_tentativa_em TEXT,
  PRIMARY KEY (evento_id, etapa)
)`;

async function fixture({ v10 = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'lume-notetaker-schema-'));
  const dbPath = path.join(root, 'fixture.sqlite');
  const db = abrirBanco(dbPath);
  try {
    new ContextoApp(db); new Desktop(db); new DesktopIA(db);
    new Semantica(db, { extrair: async () => [] });
    new ColetorCaixas(db, { diretorioBase: root });
    prepararEsquemaInventario(db); prepararEsquemaTranscricao(db); prepararMetadadosAudio(db);
    prepararEsquemaFinanceiro(db); prepararEsquemaRascunho(db); prepararEsquemaPrecisao(db);
    prepararWhatsAppLabels(db); prepararAcoesLume(db); prepararExecucoes(db); prepararHistoricoWhatsApp(db);
    prepararVendasJev(db); prepararProjetosComerciais(db); prepararProcedenciaCiclo(db);
    new FilaLaya(db, { laya: { classificar: async () => ({}), status: () => ({}) } });
    for (const ddl of DDL_CONTROLE_EXCLUSAO) db.exec(ddl);
    if (v10) prepararMidiasCiclo(db);
    return { dir: root, dbPath, db, async close() { try { db.close(); } catch {} await rm(root, { recursive: true, force: true }); } };
  } catch (error) { try { db.close(); } catch {} await rm(root, { recursive: true, force: true }); throw error; }
}

test('schema histórico v9 de etapas continua aceito sem relaxar o validador', async () => {
  const f=await fixture();
  try {
    f.db.exec(`DROP TABLE etapas; ${ETAPAS_V9_DDL};
      CREATE INDEX idx_etapas_fila ON etapas (etapa, estado, proxima_tentativa_em)`);
    assert.match(validarSchemaExclusao(f.db), /^[a-f0-9]{64}$/);
    for(const column of ['lease_token','lease_ate','fonte_assinatura'])
      f.db.exec(`ALTER TABLE etapas ADD COLUMN ${column} TEXT`);
    assert.match(validarSchemaExclusao(f.db), /^[a-f0-9]{64}$/,
      'o mesmo perfil migrado por ALTER conserva variante fechada');
  } finally { await f.close(); }
});

async function fixtureC0() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lume-notetaker-c0-schema-'));
  const marker = randomUUID();
  await writeFile(path.join(dir, '.lume-notetaker-test'), marker, { flag: 'wx' });
  const db = abrirBanco(path.join(dir, 'fixture.sqlite'));
  new ContextoApp(db); new Desktop(db); new DesktopIA(db);
  new Semantica(db, { extrair: async () => [] });
  new ColetorCaixas(db, { diretorioBase: dir });
  prepararEsquemaInventario(db); prepararEsquemaTranscricao(db); prepararMetadadosAudio(db);
  prepararEsquemaFinanceiro(db); prepararEsquemaRascunho(db); prepararEsquemaPrecisao(db);
  prepararWhatsAppLabels(db); prepararAcoesLume(db); prepararExecucoes(db); prepararHistoricoWhatsApp(db);
  prepararVendasJev(db); prepararProjetosComerciais(db); prepararProcedenciaCiclo(db);
  new FilaLaya(db, { laya: { classificar: async () => ({}), status: () => ({}) } });
  for (const ddl of DDL_CONTROLE_EXCLUSAO) db.exec(ddl);
  prepararMidiasCiclo(db);
  const before = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = dir;
  const service = new NotetakerServico(db, { notetakerExperimento: true, testProfileRoot: dir, testMarker: marker,
    audioLocal: { async estado() { return { disponivel: true }; }, async transcrever(bytes) {
      return { motor: 'whisper.cpp', modeloSha256: hash, audioSha256: createHash('sha256').update(bytes).digest('hex'),
        trechos: [{ inicioMs: 0, fimMs: 500, texto: 'Acordo sintético para teste de schema.' }] };
    } } });
  const sessaoId = service.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
  service.consentir(sessaoId, { entradas: ['importacao'], confirmar: true });
  const wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000)]);
  await importarArquivo({ headers: { 'content-length': String(wav.length), 'content-type': 'audio/wav' }, complete: true,
    async *[Symbol.asyncIterator]() { yield wav; } }, { servico: service, sessaoId });
  const transcribed = await service.transcreverImportacao(sessaoId);
  assert.equal(transcribed.estado, 'concluida', JSON.stringify(transcribed));
  const source = db.prepare('SELECT evento_id FROM notetaker_fontes WHERE sessao_id=?').get(sessaoId);
  assert.ok(source, 'a transcrição sintética deve produzir fonte ligada à sessão');
  const evento = source.evento_id;
  return { dir, db, sessaoId, evento, marker, perfil: { notetakerExperimento: true, testProfileRoot: dir, testMarker: marker },
    async close() { try { db.close(); } catch {} if (before === undefined) delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE; else process.env.ASSESSOR_DESKTOP_TEST_PROFILE = before; await rm(dir, { recursive: true, force: true }); } };
}

function preview(f) {
  f.db.exec('BEGIN');
  try { return montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }); }
  finally { if (f.db.isTransaction) f.db.exec('ROLLBACK'); }
}

function evento(db, origem, tipo = 'audio') {
  return db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',?,'{}',?,'2026-10-01','minha')`).run('notetaker-schema-fixture', origem, tipo, DATA).lastInsertRowid;
}

test('schema legado v10 sem ciclo_midias aceita leases atuais de etapa', async () => {
  const f = await fixture();
  try {
    const id = evento(f.db, 'v9-lease');
    f.db.prepare(`INSERT INTO etapas(evento_id,etapa,estado,tentativas,atualizado_em,lease_token,lease_ate,fonte_assinatura)
      VALUES(?,'midia','em_curso',1,?,?,?,?)`).run(id, DATA, 'lease-sintetica', '2026-10-01T12:01:00.000Z', hash);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ciclo_midias'").get(), undefined);
    assert.match(validarSchemaExclusao(f.db), /^[a-f0-9]{64}$/);
  } finally { await f.close(); }
});

test('schema de exclusão aceita v10 e mantém a tabela de mídia ligada ao evento, inclusive fonte externa', async () => {
  const f = await fixture({ v10: true });
  try {
    const selected = evento(f.db, 'midia-selecionada');
    const external = evento(f.db, 'midia-externa');
    for (const id of [selected, external]) f.db.prepare(`INSERT INTO ciclo_midias
      (evento_id,caminho,sha256,mime,tamanho,criado_em) VALUES(?,?,?,?,?,?)`)
      .run(id, `media-${id}.ogg`, hash, 'audio/ogg', 64, DATA);
    f.db.prepare(`INSERT INTO etapas(evento_id,etapa,estado,tentativas,atualizado_em,lease_token,lease_ate,fonte_assinatura)
      VALUES(?,'midia','em_curso',2,?,?,?,?)`).run(selected, DATA, 'lease-v10', '2026-10-01T12:01:00.000Z', hash);
    assert.deepEqual(f.db.prepare('SELECT evento_id FROM ciclo_midias ORDER BY evento_id').all().map(x => x.evento_id), [selected, external]);
    assert.match(validarSchemaExclusao(f.db), /^[a-f0-9]{64}$/);
  } finally { await f.close(); }
});

test('schema v10 rejeita colunas, chave e vínculo adulterados em etapas ou mídia', async t => {
  const f = await fixture({ v10: true });
  t.after(() => f.close());
  const before = validarSchemaExclusao(f.db);
  f.db.exec('ALTER TABLE etapas ADD COLUMN coluna_injetada TEXT');
  assert.throws(() => validarSchemaExclusao(f.db), { code: 'INTEGRIDADE' });
  f.db.exec('ALTER TABLE etapas DROP COLUMN coluna_injetada');
  assert.equal(validarSchemaExclusao(f.db), before);

  f.db.exec('ALTER TABLE ciclo_midias ADD COLUMN coluna_injetada TEXT');
  assert.throws(() => validarSchemaExclusao(f.db), { code: 'INTEGRIDADE' });
  f.db.exec('ALTER TABLE ciclo_midias DROP COLUMN coluna_injetada');
  assert.equal(validarSchemaExclusao(f.db), before);

  f.db.exec('DROP TABLE ciclo_midias; CREATE TABLE ciclo_midias(evento_id INTEGER PRIMARY KEY,caminho TEXT,sha256 TEXT,mime TEXT,tamanho INTEGER,criado_em TEXT)');
  assert.throws(() => validarSchemaExclusao(f.db), { code: 'INTEGRIDADE' });
});

test('prévia C0 v10 bloqueia mídia selecionada, ignora mídia externa e invalida assinatura quando qualquer lease muda', async () => {
  const f = await fixtureC0();
  try {
    const external = evento(f.db, 'evento-externo');
    const media = (id, name) => f.db.prepare(`INSERT INTO ciclo_midias
      (evento_id,caminho,sha256,mime,tamanho,criado_em) VALUES(?,?,?,?,?,?)`)
      .run(id, name, hash, 'audio/ogg', 64, DATA);
    media(external, 'externa.ogg');

    f.db.prepare(`INSERT INTO etapas(evento_id,etapa,estado,tentativas,atualizado_em,lease_token,lease_ate,fonte_assinatura)
      VALUES(?,'midia','em_curso',1,?,?,?,?)`).run(f.evento, DATA, 'lease-1', '2026-10-01T12:01:00.000Z', hash);
    const original = preview(f);
    assert.equal(original.bloqueios.exclusao.some(x => x.classe === 'familia_externa'), false,
      'mídia ligada somente a evento externo não bloqueia a sessão selecionada');

    const lease = f.db.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='midia'").get(f.evento);
    for (const [field, value] of [['lease_token', 'lease-2'], ['lease_ate', '2026-10-01T12:02:00.000Z'], ['fonte_assinatura', 'b'.repeat(64)]]) {
      f.db.prepare(`UPDATE etapas SET ${field}=? WHERE evento_id=? AND etapa='midia'`).run(value, f.evento);
      assert.notEqual(preview(f).assinatura, original.assinatura, `alterar ${field} deve invalidar a prévia anterior`);
      f.db.prepare(`UPDATE etapas SET ${field}=? WHERE evento_id=? AND etapa='midia'`).run(lease[field], f.evento);
    }

    media(f.evento, 'selecionada.ogg');
    const blocked = preview(f);
    assert.ok(blocked.bloqueios.exclusao.some(x => x.classe === 'familia_externa'),
      'mídia ligada a evento selecionado sem projeção de arquivo bloqueia a exclusão');
    assert.ok(blocked.bloqueios.exportacao.some(x => x.classe === 'familia_externa'));
  } finally { await f.close(); }
});

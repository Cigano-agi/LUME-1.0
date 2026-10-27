import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../../src/banco.js';
import { ContextoApp } from '../../src/contexto-app.js';
import { Desktop } from '../../src/desktop.js';
import { prepararProjetosComerciais } from '../../src/projetos-comerciais/esquema.js';
import { prepararTarefas } from '../../src/tarefas-esquema.js';
import { prepararComandosWhatsapp } from '../../src/comandos-whatsapp.js';
import { prepararProcedenciaCiclo } from '../../src/privacidade.js';
import { NotetakerServico } from '../../src/notetaker/servico.js';
import { cabecalhoWav } from '../../src/notetaker/contrato.js';
import { montarPlanoExclusao } from '../../src/notetaker/exclusao-plano.js';
import { validarSchemaExclusao } from '../../src/notetaker/exclusao-schema.js';
import { validarControleExclusao, DDL_CONTROLE_EXCLUSAO, NOMES_OBJETOS_CONTROLE_EXCLUSAO } from '../../src/notetaker/exclusao-controle.js';
import { criarOrigemV9 } from '../../src/backup-acervo-v9.js';
import { selecionarPerfilBoot } from '../../src/perfil-boot.js';
import * as A from '../../src/perfil-manutencao.js';

const harness = realpathSync(process.argv[2]), step = process.argv[3];
assert.equal(realpathSync(tmpdir()), harness);
const statePath = join(harness, 'review-state.json');
let state, db;
const quote = name => `"${name.replaceAll('"', '""')}"`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const preview = plan => Object.fromEntries(['sessaoId', 'revisao', 'assinatura', 'schemaAssinatura'].map(k => [k, plan[k]]));
function filesSnapshot(root) {
  if (!existsSync(root)) return null;
  return readdirSync(root, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(entry =>
    [entry.name, entry.isDirectory() ? filesSnapshot(join(root, entry.name)) : hash(readFileSync(join(root, entry.name)))]);
}
function killAtBoundary() {
  writeFileSync(1, JSON.stringify({ step }));
  process.exit(73);
}
function contentSnapshot(connection) {
  return connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().filter(({ name }) => !['notetaker_exclusao_controle_v1', 'notetaker_exclusao_recibos_v1'].includes(name))
    .map(({ name }) => [name, connection.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => JSON.stringify(row)).sort()]);
}
async function rejects(call, label) {
  let observed;
  try { await call(); } catch (error) { observed = error; }
  assert.ok(observed, `${label}: chamada aceita`);
  assert.notEqual(observed.name, 'TypeError', `${label}: falha incidental não prova recusa`);
}
try {
  if (step === 'setup' || step === 'setup-wav') {
    const root = realpathSync(mkdtempSync(join(harness, 'lume-notetaker-content-review-')));
    const marker = randomUUID();
    writeFileSync(join(root, '.lume-notetaker-test'), marker, { flag: 'wx' });
    process.env.ASSESSOR_DESKTOP_TEST_PROFILE = root;
    for (const name of ['data', 'credenciais', 'notetaker-audio']) mkdirSync(join(root, name));
    db = abrirBanco(join(root, 'data', 'assessor.db'));
    new ContextoApp(db); new Desktop(db);
    prepararProjetosComerciais(db); prepararTarefas(db); prepararComandosWhatsapp(db);
    const perfil = { notetakerExperimento: true, testProfileRoot: root, testMarker: marker };
    const service = new NotetakerServico(db, perfil);
    const sessaoId = service.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
    service.consentir(sessaoId, { entradas: ['importacao'], confirmar: true });
    if (step === 'setup-wav') {
      // Estado sintético já estável: não usa writer, reconciliação nem remoção de sidecars.
      for (let posicao = 0; posicao < 2; posicao++) {
        const parteId = randomUUID(), nome = `${parteId}.wav`;
        const wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000, posicao + 1)]);
        writeFileSync(join(root, 'notetaker-audio', nome), wav, { flag: 'wx' });
        db.prepare(`INSERT INTO notetaker_partes(id,sessao_id,entrada,posicao,inicio_ms,duracao_ms,sha256,caminho,estado)
          VALUES(?,?,'importacao',?,?,1000,?,?,'salva')`).run(parteId, sessaoId, posicao, posicao * 1000, hash(wav), nome);
      }
      db.prepare("UPDATE notetaker_sessoes SET estado='encerrada',fim_em=? WHERE id=?").run(new Date().toISOString(), sessaoId);
    }
    db.exec('BEGIN IMMEDIATE');
    const plan = montarPlanoExclusao(db, { sessaoId, ...perfil });
    db.exec('ROLLBACK');
    assert.deepEqual(plan.bloqueios.exclusao, []);
    const previa = preview(plan);
    state = { root, perfil, previa, before: contentSnapshot(db), files: plan.arquivos };
    if (step === 'setup-wav') assert.equal(state.files.length, 2);
    writeFileSync(statePath, JSON.stringify(state), { flag: 'wx' });
    db.close(); db = null;
  } else {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
    const { root, perfil, previa } = state;
    process.env.ASSESSOR_DESKTOP_TEST_PROFILE = root;
    const selection = { tipo: 'legado', id: 'legado', geracao: null,
      dataDir: join(root, 'data'), credenciaisDir: join(root, 'credenciais') };
    const begin = () => A.beginContentMaintenance({ userData: root, selection, opId: randomUUID(), perfil, previa });
    if (step === 'authority') {
      for (const name of ['executeContentMaintenance', 'recoverContentMaintenance', 'completeContentMaintenance']) {
        assert.equal(typeof A[name], 'function', `${name} ausente`);
        await rejects(() => A[name](name === 'completeContentMaintenance'
          ? { maintenanceHandle: {}, receipt: { concluida: true } } : { maintenanceHandle: {} }), `${name} JSON`);
      }
      const arbitrary = new DatabaseSync(':memory:');
      arbitrary.exec('CREATE TABLE sentinel(id INTEGER PRIMARY KEY); INSERT INTO sentinel VALUES(1)');
      try {
        await rejects(() => A.executeContentMaintenance({ maintenanceHandle: {}, db: arbitrary,
          binding: { authorized: true } }), 'DB arbitrário');
        await rejects(() => A.executeContentMaintenance({ maintenanceHandle: arbitrary }), 'DB como handle');
        assert.equal(arbitrary.prepare('SELECT count(*) n FROM sentinel').get().n, 1);
      } finally { arbitrary.close(); }
      const b2 = await A.createMaintenanceMarker({ userData: root, selection, opId: randomUUID(), kind: 'notetaker-delete' });
      for (const name of ['executeContentMaintenance', 'recoverContentMaintenance', 'completeContentMaintenance'])
        await rejects(() => A[name](name === 'completeContentMaintenance'
          ? { maintenanceHandle: b2, receipt: b2 } : { maintenanceHandle: b2 }), `${name} B2`);
      await A.releaseUnstartedMarker(b2);
      const handle = await begin();
      const raw = readFileSync(join(root, 'perfil-manutencao.json'), 'utf8');
      const calls = [
        ['acquireExclusiveDb', () => A.acquireExclusiveDb({ selection, maintenanceHandle: handle })],
        ['acquireExclusiveNoMutation', () => A.acquireExclusiveNoMutation({ selection, maintenanceHandle: handle })],
        ['finishMaintenanceWithoutMutation', () => A.finishMaintenanceWithoutMutation({ maintenanceHandle: handle, noMutationToken: {} })],
        ['markMaintenanceStarted', () => A.markMaintenanceStarted(handle)],
        ['releaseUnstartedMarker', () => A.releaseUnstartedMarker(handle)],
        ['clone', () => A.executeContentMaintenance({ maintenanceHandle: { ...handle } })],
        ['serialized', () => A.executeContentMaintenance({ maintenanceHandle: JSON.parse(JSON.stringify(handle)) })],
      ];
      for (const [label, call] of calls) await rejects(call, label);
      assert.equal(readFileSync(join(root, 'perfil-manutencao.json'), 'utf8'), raw);
      assert.equal(existsSync(join(root, 'notetaker-delete-journal')), false);
      db = new DatabaseSync(join(root, 'data', 'assessor.db'));
      assert.deepEqual(contentSnapshot(db), state.before);
      assert.throws(() => A.assertNormalBootAllowed(root));
    } else if (step === 'zero') {
      const handle = await begin();
      const results = await Promise.allSettled([
        A.executeContentMaintenance({ maintenanceHandle: handle }),
        A.executeContentMaintenance({ maintenanceHandle: handle }),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected').length, 1);
      const receipt = results.find(r => r.status === 'fulfilled').value;
      assert.equal(A.isContentMaintenanceComplete(receipt), false);
      await rejects(() => A.completeContentMaintenance({ maintenanceHandle: handle, receipt: { ...receipt } }), 'recibo clonado');
      const terminal = await A.completeContentMaintenance({ maintenanceHandle: handle, receipt });
      assert.equal(A.isContentMaintenanceComplete(terminal), true);
      assert.equal(A.isContentMaintenanceComplete({ ...terminal }), false);
      await rejects(() => A.completeContentMaintenance({ maintenanceHandle: handle, receipt }), 'recibo repetido');
      A.assertNormalBootAllowed(root);
      db = new DatabaseSync(join(root, 'data', 'assessor.db'));
      assert.equal(db.prepare('SELECT count(*) n FROM notetaker_sessoes WHERE id=?').get(previa.sessaoId).n, 0);
      assert.equal(db.prepare('SELECT arquivos_total FROM notetaker_exclusao_recibos_v1').get().arquivos_total, 0);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } else if (step === 'second-cycle' || step === 'prepare-next') {
      await selecionarPerfilBoot(root);
      db = abrirBanco(join(root, 'data', 'assessor.db'));
      const service = new NotetakerServico(db, perfil);
      const sessaoId = service.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
      service.consentir(sessaoId, { entradas: ['importacao'], confirmar: true });
      db.exec('BEGIN IMMEDIATE');
      const plan = montarPlanoExclusao(db, { sessaoId, ...perfil });
      db.exec('ROLLBACK');
      if (step === 'prepare-next') writeFileSync(statePath, JSON.stringify({ ...state, previa: preview(plan), before: contentSnapshot(db), files: [] }));
      db.close(); db = null;
      const handle = await A.beginContentMaintenance({ userData: root, selection, perfil, previa: preview(plan), opId: randomUUID() });
      if (step === 'second-cycle') {
        const receipt = await A.executeContentMaintenance({ maintenanceHandle: handle });
        assert.equal(A.isContentMaintenanceComplete(await A.completeContentMaintenance({ maintenanceHandle: handle, receipt })), true);
        db = new DatabaseSync(join(root, 'data', 'assessor.db'));
        assert.equal(db.prepare("SELECT count(*) n FROM notetaker_exclusao_controle_v1 WHERE fase='concluida'").get().n, 2);
        A.assertNormalBootAllowed(root);
      }
    } else if (step.startsWith('crash-')) {
      const abortRecovery = ['crash-abort', 'crash-abort-cleanup'].includes(step);
      const handle = abortRecovery ? await A.readMaintenanceMarker({ userData: root }) : await begin();
      const originalExec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        const result = originalExec.call(this, sql);
        if (/^\s*COMMIT\s*;?\s*$/i.test(sql) &&
            this.prepare("SELECT 1 FROM sqlite_master WHERE name='notetaker_exclusao_recibos_v1'").get()) {
          if (step === 'crash-abort' && this.prepare('SELECT fase FROM notetaker_exclusao_controle_v1 WHERE sessao_id=?')
            .get(previa.sessaoId)?.fase === 'abortada') killAtBoundary();
          const receipt = this.prepare('SELECT * FROM notetaker_exclusao_recibos_v1 WHERE sessao_id=?').get(previa.sessaoId);
          if (receipt && ((step === 'crash-commit' && receipt.estado === 'conteudo_commitido') ||
              (step === 'crash-progress' && receipt.estado === 'concluida'))) killAtBoundary();
        }
        return result;
      };
      const originalUnlink = fs.unlinkSync;
      fs.unlinkSync = function(path) {
        const result = originalUnlink(path);
        if (step === 'crash-unlink' && String(path).includes('notetaker-delete-journal') && String(path).endsWith('.wav')) killAtBoundary();
        return result;
      };
      const originalRename = fs.renameSync;
      fs.renameSync = function(from, to) {
        const result = originalRename(from, to);
        if (step === 'crash-rename' && String(to).includes('notetaker-delete-journal')) killAtBoundary();
        return result;
      };
      syncBuiltinESMExports();
      if (abortRecovery) await A.recoverContentMaintenance({ maintenanceHandle: handle });
      else await A.executeContentMaintenance({ maintenanceHandle: handle });
      if (step === 'crash-abort-cleanup') {
        assert.equal(existsSync(join(root, 'notetaker-delete-journal')), false);
        assert.equal(existsSync(join(root, 'perfil-manutencao.json')), true);
        killAtBoundary();
      }
      assert.fail(`Barreira ${step} não foi atingida`);
    } else if (['extra', 'later-file', 'resurrect', 'missing-tail'].includes(step)) {
      const marker = JSON.parse(readFileSync(join(root, 'perfil-manutencao.json'), 'utf8'));
      const dir = join(root, 'notetaker-delete-journal', marker.opId);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifesto.json'), 'utf8'));
      if (step === 'extra') writeFileSync(join(dir, 'unexpected'), 'preservar', { flag: 'wx' });
      if (step === 'later-file') {
        const path = join(dir, manifest.arquivos[1].quarentena), bytes = readFileSync(path);
        bytes[44] ^= 1; writeFileSync(path, bytes);
      }
      if (step === 'resurrect') writeFileSync(join(root, 'notetaker-audio', manifest.arquivos[0].nome), 'origem recriada', { flag: 'wx' });
      if (step === 'missing-tail') for (const file of manifest.arquivos) fs.unlinkSync(join(dir, file.quarentena));
    } else if (step === 'move-initial') {
      assert.equal(state.files.length, 2);
      renameSync(join(root, 'notetaker-audio', state.files[0].nome), join(harness, 'moved-initial.wav'));
    } else if (step === 'recover-refuse') {
      const before = [filesSnapshot(join(root, 'notetaker-audio')), filesSnapshot(join(root, 'notetaker-delete-journal'))];
      const handle = await A.readMaintenanceMarker({ userData: root });
      await rejects(() => A.recoverContentMaintenance({ maintenanceHandle: handle }), 'recovery de estado inconsistente');
      assert.deepEqual([filesSnapshot(join(root, 'notetaker-audio')), filesSnapshot(join(root, 'notetaker-delete-journal'))], before,
        'recusa precisa preceder unlink de qualquer WAV');
      assert.throws(() => A.assertNormalBootAllowed(root));
    } else if (step === 'cold-finalize-race') {
      const handle = await A.readMaintenanceMarker({ userData: root });
      const receipt = await A.recoverContentMaintenance({ maintenanceHandle: handle });
      renameSync(join(root, 'notetaker-audio', state.files[0].nome), join(harness, 'moved-after-recovery.wav'));
      await rejects(() => A.completeContentMaintenance({ maintenanceHandle: handle, receipt }), 'origem perdida antes de completar abort inicial');
      assert.throws(() => A.assertNormalBootAllowed(root));
    } else if (step === 'recover-aborted') {
      const handle = await A.readMaintenanceMarker({ userData: root });
      const receipt = await A.recoverContentMaintenance({ maintenanceHandle: handle });
      const terminal = await A.completeContentMaintenance({ maintenanceHandle: handle, receipt });
      assert.equal(A.isContentMaintenanceComplete(terminal), true);
      A.assertNormalBootAllowed(root);
      for (const file of state.files) assert.equal(hash(readFileSync(join(root, 'notetaker-audio', file.nome))), file.sha256);
      db = new DatabaseSync(join(root, 'data', 'assessor.db'));
      assert.deepEqual(contentSnapshot(db), state.before);
      assert.equal(db.prepare('SELECT fase FROM notetaker_exclusao_controle_v1 WHERE sessao_id=?').get(previa.sessaoId).fase, 'abortada');
      assert.equal(db.prepare('SELECT count(*) n FROM notetaker_exclusao_recibos_v1').get().n, 0);
    } else if (step === 'recover-committed') {
      const handle = await A.readMaintenanceMarker({ userData: root });
      const receipt = await A.recoverContentMaintenance({ maintenanceHandle: handle });
      const terminal = await A.completeContentMaintenance({ maintenanceHandle: handle, receipt });
      assert.equal(A.isContentMaintenanceComplete(terminal), true);
      A.assertNormalBootAllowed(root);
      assert.deepEqual(filesSnapshot(join(root, 'notetaker-audio')), []);
      db = new DatabaseSync(join(root, 'data', 'assessor.db'));
      assert.equal(db.prepare('SELECT count(*) n FROM notetaker_sessoes WHERE id=?').get(previa.sessaoId).n, 0);
      const durable = db.prepare('SELECT * FROM notetaker_exclusao_recibos_v1 WHERE sessao_id=?').get(previa.sessaoId);
      assert.equal(durable.arquivos_total, 2);
      assert.equal(durable.arquivos_pendentes, 0);
      assert.equal(durable.estado, 'concluida');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } else if (step === 'schema-family') {
      db = abrirBanco(join(root, 'data', 'assessor.db'));
      prepararProcedenciaCiclo(db);
      const accepted = validarSchemaExclusao(db);
      assert.match(accepted, /^[a-f0-9]{64}$/);
      const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'ciclo_importacao_remove_*' ORDER BY name").all();
      assert.ok(triggers.length > 0);
      for (const trigger of triggers) {
        db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
        assert.throws(() => validarSchemaExclusao(db), { code: 'INTEGRIDADE' }, `ausente: ${trigger.name}`);
        db.exec(trigger.sql.replace(/\bBEGIN\b/i, 'BEGIN SELECT 1;'));
        assert.throws(() => validarSchemaExclusao(db), { code: 'INTEGRIDADE' }, `alterada: ${trigger.name}`);
        db.exec(`DROP TRIGGER ${quote(trigger.name)}`); db.exec(trigger.sql);
      }
      assert.equal(validarSchemaExclusao(db), accepted);
    } else if (step === 'control-negatives') {
      db = new DatabaseSync(join(root, 'data', 'assessor.db'));
      assert.equal(validarControleExclusao(db).ativo, false);
      assert.equal(Object.isFrozen(DDL_CONTROLE_EXCLUSAO), true);
      assert.equal(Object.isFrozen(NOMES_OBJETOS_CONTROLE_EXCLUSAO), true);
      for (const ddl of [
        'CREATE TRIGGER unrelated_trigger AFTER UPDATE ON notetaker_exclusao_controle_v1 BEGIN SELECT 1; END',
        'CREATE INDEX unrelated_index ON notetaker_exclusao_controle_v1(sessao_id)',
      ]) {
        db.exec('SAVEPOINT review_control'); db.exec(ddl);
        assert.throws(() => validarControleExclusao(db), { code: 'INTEGRIDADE' });
        db.exec('ROLLBACK TO review_control; RELEASE review_control');
      }
      const receipt = db.prepare("SELECT sql FROM sqlite_master WHERE name='notetaker_exclusao_recibo_sem_delete_v1'").get();
      db.exec('DROP TRIGGER notetaker_exclusao_recibo_sem_delete_v1');
      db.exec('DELETE FROM notetaker_exclusao_recibos_v1'); db.exec(receipt.sql);
      assert.throws(() => validarControleExclusao(db), { code: 'INTEGRIDADE' });
      db.close(); db = null;
      await assert.rejects(() => criarOrigemV9({ dbPath: join(root, 'data', 'assessor.db'), perfil: { dono: 'Revisão sintética' } }),
        { code: 'INTEGRIDADE' });
    } else if (step === 'prepare') {
      await selecionarPerfilBoot(root);
      await begin();
      assert.throws(() => A.assertNormalBootAllowed(root));
    } else if (step === 'cold') {
      const first = await A.readMaintenanceMarker({ userData: root });
      const second = await A.readMaintenanceMarker({ userData: root });
      assert.notEqual(first, second);
      await rejects(() => A.executeContentMaintenance({ maintenanceHandle: first }), 'handle frio em execução nova');
      const results = await Promise.allSettled([first, second].map(maintenanceHandle =>
        A.recoverContentMaintenance({ maintenanceHandle })));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      const index = results.findIndex(r => r.status === 'fulfilled');
      const terminal = await A.completeContentMaintenance({ maintenanceHandle: [first, second][index], receipt: results[index].value });
      assert.equal(A.isContentMaintenanceComplete(terminal), true);
      A.assertNormalBootAllowed(root);
      db = new DatabaseSync(join(root, 'data', 'assessor.db'));
      assert.deepEqual(contentSnapshot(db), state.before);
    } else throw Error('Etapa de teste desconhecida');
  }
  process.stdout.write(JSON.stringify({ step }));
} finally { if (db) db.close(); }

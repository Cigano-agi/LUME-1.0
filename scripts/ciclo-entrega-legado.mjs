// Revalida a migração contra um banco sintético realmente produzido ANTES do patch.
// Nunca aponta ao perfil pessoal; preserva o banco baseline por cópia e hash.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { Desktop } from '../src/desktop.js';
import { ContextoApp } from '../src/contexto-app.js';
import { ExecucoesLume } from '../src/execucao/servico.js';

const allowed = resolve('work/beta06-ciclo-entrega');
const baseline = resolve(allowed, '2026-09-26T17-12-55.445Z/perfil-sintetico.db');
assert.ok(baseline.startsWith(allowed + sep));
const hashFile = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const originalHash = hashFile(baseline);
const out = join(allowed, 'migracao-' + new Date().toISOString().replaceAll(':', '-'));
mkdirSync(out, { recursive: true });
const copied = join(out, 'copia-sintetica.db');
copyFileSync(baseline, copied);
let db;
const report = { at: new Date().toISOString(), synthetic: true, baseline, originalHash, checks: {} };
report.sourceHashes = Object.fromEntries(['src/execucao/esquema.js', 'src/execucao/servico.js'].map(file => [file, hashFile(file)]));
try {
  db = abrirBanco(copied); new ContextoApp(db); new Desktop(db);
  assert.equal(Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='lume_execucao_contexto_guardas'").get()), false);
  const before = db.prepare('SELECT * FROM lume_execucoes').all();
  assert.equal(before.length, 1);
  const action = db.prepare('SELECT id FROM lume_acoes').get();
  const service = new ExecucoesLume(db);
  const execution = service.listar({ acao_id: action.id }).execucoes[0];
  assert.equal(execution.id, before[0].id);
  assert.equal(execution.contexto_invalidado, true);
  assert.equal(execution.pode_registrar_resultado, false);
  assert.equal(execution.pode_verificar, false);
  const local = service.obter({ id: execution.id });
  assert.match(local.contexto.tarefa, /Preparar roteiro sintético/);
  assert.equal(local.execucao.timeline.filter(x => x.tipo === 'resultado').length, 1);
  assert.throws(() => service.obter({ id: execution.id }, { clientId: 'claude-desktop', scope: { kind: 'all' } }));
  assert.throws(() => service.registrar('progresso', { execucao_id: execution.id,
    chave_idempotencia: 'migracao-retorno-antigo', texto: 'Não aceitar retorno antigo' }));
  report.checks.firstMigration = { sameExecution: true, localHistoricalTaskAndResult: true,
    externalAccessRefused: true, writesRefused: true, motivo: execution.contexto_invalidado_motivo };
  db.close(); db = abrirBanco(copied); new ContextoApp(db); new Desktop(db);
  const resumed = new ExecucoesLume(db).obter({ id: execution.id });
  assert.equal(resumed.execucao.contexto_invalidado, true);
  assert.equal(resumed.execucao.timeline.filter(x => x.tipo === 'resultado').length, 1);
  report.checks.secondMigration = { stillInvalidated: true, oneResult: true };
  assert.equal(hashFile(baseline), originalHash);
  report.checks.baselineUnchanged = true;
  report.passed = true;
} catch (error) {
  report.failed = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  db?.close();
  writeFileSync(join(out, 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }, null, 2));
}

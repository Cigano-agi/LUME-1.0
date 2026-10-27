import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { LumeMcpDesktopService, neutralizarAutoridadeSnapshot } from '../src/mcp/desktop-service.js';
import { criarSnapshot } from '../src/backup-snapshot.js';
import { startLumeAppPresence } from '../src/mcp/presence.js';
import { diaLocal } from '../src/relogio.js';

test('autoteste neutraliza grants no snapshot, não anuncia execução e preserva origem e ativação', async t => {
  const root = mkdtempSync(join(homedir(), 'lume-autoteste-grants-'));
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  const database = join(dataDir, 'assessor.db'), db = abrirBanco(database);
  t.after(() => {
    db.close();
    if (!resolve(root).startsWith(resolve(homedir()) + sep) || !basename(root).startsWith('lume-autoteste-grants-')) throw new Error('UNSAFE_FIXTURE_CLEANUP');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  });
  new ContextoApp(db); new Desktop(db);
  const now = new Date();
  const actions = new AcoesLume(db, { agora: () => now });
  const executions = new ExecucoesLume(db, { agora: () => now, revisaoConector: () => 'revision-original-sintetica' });
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('sintetico@g.us', 'Contato sintético');
  const source = Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
    VALUES(?,?,'entrada','texto','{}',?,?,?,'minha',1)`).run('sintetico@g.us', randomUUID(), 'Preparar proposta sintética para conferência.', now.toISOString(), diaLocal(now)).lastInsertRowid);
  actions.autorizar({ conversa: 'sintetico@g.us', permitida: true });
  actions.registrar({ eventoId: source, candidatas: [{ fonte: 'E' + source, tipo: 'pendencia', resumo: 'Preparar proposta sintética', trecho: 'Preparar proposta sintética para conferência.', prazo_citado: '' }] });
  const action = actions.listar().find(item => item.evento_id === source);
  const { contexto } = executions.preparar({ acao_id: action.id });
  executions.iniciar({ contexto_id: contexto.id, assistente: 'claude', confirmar: true, chave_idempotencia: randomUUID(), manter_contexto: true });
  db.prepare("INSERT INTO autorizacoes(conversa_id,escopo,modo,decidido_em) VALUES('sintetico@g.us','dm','atender',?)").run(now.toISOString());
  const originalGrants = db.prepare('SELECT COUNT(*) total FROM lume_execucao_contexto_grants').get().total;
  assert.equal(originalGrants, 1);
  const copy = join(root, 'independent-snapshot.db');
  await criarSnapshot({ caminhoOrigem: database, caminhoDestino: copy, gerarManifesto: false });
  const copyDb = new DatabaseSync(copy);
  try {
    assert.equal(copyDb.prepare('SELECT COUNT(*) total FROM lume_execucao_contexto_grants').get().total, 1);
    neutralizarAutoridadeSnapshot(copyDb);
    for (const table of ['lume_execucao_contexto_grants', 'lume_execucoes', 'autorizacoes']) {
      assert.equal(copyDb.prepare(`SELECT COUNT(*) total FROM ${table}`).get().total, 0, table);
    }
  } finally { copyDb.close(); }
  const service = new LumeMcpDesktopService({ dataDir, packageRoot: resolve('.'), platform: process.platform, now: () => now });
  service.ativarClaudeHoje({ confirmar: true });
  const activationBefore = readFileSync(service.activationPath);
  const presence = startLumeAppPresence({ dataDir }); t.after(() => presence.stop());
  const result = await service.testarClaudeLocal();
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM lume_execucao_contexto_grants').get().total, originalGrants);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM autorizacoes').get().total, 1);
  assert.deepEqual(readFileSync(service.activationPath), activationBefore);
});

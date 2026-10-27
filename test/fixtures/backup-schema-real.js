import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abrirBanco } from '../../src/banco.js';
import { garantirEsquema } from '../../src/permissao.js';
import { ContextoApp } from '../../src/contexto-app.js';
import { Desktop } from '../../src/desktop.js';
import { DesktopIA } from '../../src/desktop-ia.js';
import { Semantica } from '../../src/semantica.js';
import { ColetorCaixas } from '../../src/caixas.js';
import { prepararEsquemaInventario } from '../../src/inventario.js';
import { prepararEsquemaTranscricao } from '../../src/transcricao.js';
import { prepararMetadadosAudio } from '../../src/audio-desktop-arquivos.js';
import { prepararEsquemaFinanceiro } from '../../src/financeiro.js';
import { prepararEsquemaRascunho } from '../../src/rascunho.js';
import { prepararEsquemaPrecisao } from '../../src/precisao.js';
import { prepararWhatsAppLabels } from '../../src/whatsapp-labels.js';
import { prepararAcoesLume } from '../../src/acoes-lume.js';
import { prepararExecucoes } from '../../src/execucao/esquema.js';
import { prepararHistoricoWhatsApp } from '../../src/transporte/historico.js';
import { prepararVendasJev } from '../../src/vendas/servico.js';
import { prepararProjetosComerciais } from '../../src/projetos-comerciais/esquema.js';
import { prepararProcedenciaCiclo } from '../../src/privacidade.js';
import { FilaLaya } from '../../src/laya/fila.js';

// Reproduz a sequência antiga: eventos do construtor base, permissão, compartilhamento.
// O DDL inicial vem do próprio abrirBanco, sem importar colunas do catálogo v9.
function prepararEventosLegados(dbPath) {
  const probe = abrirBanco();
  let sql;
  try { sql = probe.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='eventos'").get().sql; }
  finally { probe.close(); }
  const base = sql.replace(/,\s*origem_compartilhamento TEXT\b/i, '');
  assert.notEqual(base, sql, 'DDL base de eventos mudou; atualizar a regressão legada');
  const seed = new DatabaseSync(dbPath);
  try { seed.exec(base); garantirEsquema(seed); }
  finally { seed.close(); }
}

export async function criarPerfilRealSintetico({ legado = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lume-v9-real-schema-'));
  const dbPath = path.join(dir, 'fonte.sqlite');
  let db;
  try {
    if (legado) prepararEventosLegados(dbPath);
    db = abrirBanco(dbPath);
    new ContextoApp(db);
    new Desktop(db);
    new DesktopIA(db);
    new Semantica(db, { extrair: async () => [] });
    new ColetorCaixas(db, { diretorioBase: dir });
    prepararEsquemaInventario(db);
    prepararEsquemaTranscricao(db);
    prepararMetadadosAudio(db);
    prepararEsquemaFinanceiro(db);
    prepararEsquemaRascunho(db);
    prepararEsquemaPrecisao(db);
    prepararWhatsAppLabels(db);
    prepararAcoesLume(db);
    prepararExecucoes(db);
    prepararHistoricoWhatsApp(db);
    prepararVendasJev(db);
    prepararProjetosComerciais(db);
    prepararProcedenciaCiclo(db);
    new FilaLaya(db, { laya: { classificar: async () => ({}), status: () => ({}) } });
    return { dir, dbPath, db, async close() { try { db.close(); } catch {} await rm(dir, { recursive: true, force: true }); } };
  } catch (error) {
    try { db?.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

// Módulo financeiro do Assessor 2.0: extrai e gerencia eventos de receita,
// propostas, recorrências e sinais pendentes direto das conversas.

import { diaLocal, agoraIso } from "./relogio.js";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

export const TABELA_FINANCEIRO = `
CREATE TABLE IF NOT EXISTS eventos_financeiros (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  conversa_id   TEXT NOT NULL,
  origem_id     TEXT NOT NULL,
  tipo          TEXT NOT NULL CHECK (tipo IN ('recorrencia', 'proposta', 'sinal_pendente', 'bloqueio_comercial')),
  entidade_slug TEXT,
  cliente_nome  TEXT NOT NULL,
  valor         REAL,
  moeda         TEXT NOT NULL DEFAULT 'BRL',
  status        TEXT NOT NULL CHECK (status IN ('pendente', 'aprovado', 'bloqueado', 'pago', 'cancelado')),
  detalhes      TEXT NOT NULL,
  acao_necessaria TEXT,
  quando        TEXT,
  extraido_em   TEXT NOT NULL,
  modelo        TEXT,
  UNIQUE(conversa_id, origem_id, tipo)
);
CREATE INDEX IF NOT EXISTS idx_financeiro_status ON eventos_financeiros(status, tipo);
CREATE INDEX IF NOT EXISTS idx_financeiro_conversa ON eventos_financeiros(conversa_id);
`;

export function prepararEsquemaFinanceiro(db) {
  db.exec(TABELA_FINANCEIRO);
}

/**
 * Valida eventos financeiros extraídos pelo modelo contra mensagens reais.
 * Garante que nenhum valor ou compromisso seja alucinado sem mensagem de suporte.
 */
export function validarEventosFinanceiros(itens, mensagens) {
  const idsReais = new Set(mensagens.map(m => m.origem_id));
  const porId = new Map(mensagens.map(m => [m.origem_id, m]));
  const aceitos = [];
  const recusados = [];

  for (const item of Array.isArray(itens) ? itens : []) {
    const id = String(item?.origem_id ?? '');
    if (!idsReais.has(id)) {
      recusados.push({ item, motivo: 'origem_id inexistente na conversa' });
      continue;
    }
    if (!item?.tipo || !item?.cliente_nome || !item?.detalhes) {
      recusados.push({ item, motivo: 'campos obrigatorios ausentes' });
      continue;
    }
    aceitos.push({
      origem_id: id,
      tipo: item.tipo,
      entidade_slug: item.entidade_slug ? String(item.entidade_slug) : null,
      cliente_nome: String(item.cliente_nome).slice(0, 150),
      valor: typeof item.valor === 'number' ? item.valor : null,
      moeda: item.moeda || 'BRL',
      status: item.status || 'pendente',
      detalhes: String(item.detalhes).slice(0, 500),
      acao_necessaria: item.acao_necessaria ? String(item.acao_necessaria).slice(0, 300) : null,
      quando: porId.get(id)?.recebido_em ?? null
    });
  }
  return { aceitos, recusados };
}

export function gravarEventosFinanceiros(db, conversaId, eventos, { modelo } = {}) {
  const agora = new Date().toISOString();
  const inserir = db.prepare(`
    INSERT INTO eventos_financeiros
      (conversa_id, origem_id, tipo, entidade_slug, cliente_nome, valor, moeda, status, detalhes, acao_necessaria, quando, extraido_em, modelo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversa_id, origem_id, tipo) DO UPDATE SET
      status=excluded.status,
      valor=excluded.valor,
      detalhes=excluded.detalhes,
      acao_necessaria=excluded.acao_necessaria,
      extraido_em=excluded.extraido_em
  `);

  let gravados = 0;
  db.exec('BEGIN');
  try {
    for (const ev of eventos) {
      inserir.run(
        conversaId,
        ev.origem_id,
        ev.tipo,
        ev.entidade_slug,
        ev.cliente_nome,
        ev.valor,
        ev.moeda,
        ev.status,
        ev.detalhes,
        ev.acao_necessaria,
        ev.quando,
        agora,
        modelo || 'manual'
      );
      gravados++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return gravados;
}

export function listarPendenciasFinanceiras(db) {
  return db.prepare(`
    SELECT * FROM eventos_financeiros
    WHERE status IN ('pendente', 'bloqueado')
    ORDER BY id DESC
  `).all();
}

// Politica de autorizacao por conversa.
//
// Nao reaproveita `src/config.ts:matches` do whatsapp-brain@fd40178, que aceitava
// igualdade OU substring e liberava todos os grupos quando a allowlist estava vazia
// (achado A07). Aqui: identificador exato, ausencia de regra = envio bloqueado.
//
// Regras vindas do mandato:
//  - leitura nao autoriza envio;
//  - autorizacao em DM nao se estende ao grupo (nem o contrario);
//  - silencio nao autoriza;
//  - revogacao invalida saidas pendentes;
//  - intervencao manual do dono pausa a conversa; so comando do dono retoma.

import { agoraIso } from "./relogio.js";

export const MODOS = ["ignorar", "observar", "rascunhar", "atender", "pausado"];

/** Deriva o escopo do identificador do WhatsApp. Grupo termina em @g.us. */
export function escopoDe(conversaId) {
  return String(conversaId).endsWith("@g.us") ? "grupo" : "dm";
}

export class Politica {
  #db;
  constructor(db) {
    this.#db = db;
  }

  regra(conversaId) {
    return this.#db.prepare("SELECT * FROM autorizacoes WHERE conversa_id = ?").get(conversaId) ?? null;
  }

  /**
   * Define o modo de uma conversa. `escopo` e derivado do identificador e nao pode
   * ser informado por quem pede: e o que impede uma decisao de DM valer para grupo.
   */
  definir(conversaId, modo, { decididoPor = null, observacao = null, agora = new Date() } = {}) {
    if (!MODOS.includes(modo)) throw new Error(`modo invalido: ${modo}`);
    if (!decididoPor) throw new Error("autorizacao exige dono identificado; texto encaminhado nao vale");
    this.#db
      .prepare(
        `INSERT INTO autorizacoes (conversa_id, escopo, modo, decidido_por, decidido_em, observacao)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(conversa_id) DO UPDATE SET
           modo=excluded.modo, decidido_por=excluded.decidido_por,
           decidido_em=excluded.decidido_em, observacao=excluded.observacao`,
      )
      .run(conversaId, escopoDe(conversaId), modo, decididoPor, agoraIso(agora), observacao);
    if (modo !== "atender") this.cancelarPendentes(conversaId, `modo passou para ${modo}`, agora);
    return this.regra(conversaId);
  }

  revogar(conversaId, { decididoPor = null, agora = new Date() } = {}) {
    return this.definir(conversaId, "ignorar", { decididoPor, observacao: "revogada", agora });
  }

  /** Ler/observar e sempre permitido para o dono; nunca implica envio. */
  podeLer(conversaId) {
    const r = this.regra(conversaId);
    return Boolean(r) && r.modo !== "ignorar";
  }

  podeRascunhar(conversaId) {
    const r = this.regra(conversaId);
    return Boolean(r) && (r.modo === "rascunhar" || r.modo === "atender");
  }

  /** Unica porta de envio. Sem regra explicita `atender`, responde nao. */
  podeEnviar(conversaId) {
    const r = this.regra(conversaId);
    if (!r) return { permitido: false, motivo: "sem regra cadastrada" };
    if (r.modo !== "atender") return { permitido: false, motivo: `modo ${r.modo}` };
    if (r.escopo !== escopoDe(conversaId)) {
      return { permitido: false, motivo: "escopo da regra nao confere com a conversa" };
    }
    return { permitido: true, motivo: null };
  }

  /**
   * Mensagem humana do Fabricio pausa a conversa. O eco das mensagens do proprio
   * bot nao conta -- por isso `doProprioBot` e um campo do evento, e nao uma
   * heuristica de texto.
   */
  registrarIntervencaoHumana(conversaId, { doProprioBot = false, agora = new Date() } = {}) {
    if (doProprioBot) return { pausou: false, motivo: "eco do proprio bot" };
    const r = this.regra(conversaId);
    if (!r || r.modo !== "atender") return { pausou: false, motivo: "conversa nao estava em atendimento" };
    this.#db
      .prepare("UPDATE autorizacoes SET modo='pausado', decidido_em=?, observacao=? WHERE conversa_id=?")
      .run(agoraIso(agora), "pausado por intervencao humana", conversaId);
    const cancelados = this.cancelarPendentes(conversaId, "dono respondeu manualmente", agora);
    return { pausou: true, saidasCanceladas: cancelados };
  }

  cancelarPendentes(conversaId, motivo, agora = new Date()) {
    const info = this.#db
      .prepare(
        `UPDATE saidas SET estado='cancelada', motivo=?, atualizado_em=?
          WHERE conversa_id=? AND estado='preparada'`,
      )
      .run(motivo, agoraIso(agora), conversaId);
    return Number(info.changes ?? 0);
  }

  /** Conversas vistas sem regra -- viram uma pergunta agrupada ao dono, uma unica vez. */
  listar() {
    return this.#db.prepare("SELECT * FROM autorizacoes ORDER BY conversa_id").all();
  }
}

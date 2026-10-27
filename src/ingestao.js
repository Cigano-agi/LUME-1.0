// Ingestao duravel: grava a entrada crua antes de qualquer trabalho pesado.
//
// Corrige A03 (transcricao aguardada dentro do lote, falha ficando so em log) e
// parte de A02: aqui nao existe filtro por `type === "notify"`. Qualquer lote
// entregue pelo transporte e persistido; a decisao de o que fazer vem depois,
// pelas etapas. O que o transporte nunca entregou continua sem cobertura --
// isso e registrado, nao prometido.

import { diaLocal, agoraIso } from "./relogio.js";
import {eventoExcluido} from './exclusoes.js';

/** Etapas do ciclo. Sincronizacao com CRM nao e uma delas (achado A09). */
export const ETAPAS = ["transcricao", "analise", "memoria", "execucao", "revisao", "envio"];

export class Ingestao {
  #db;
  constructor(db) {
    this.#db = db;
  }

  /**
   * Persiste um evento de entrada. Idempotente por (conversa_id, origem_id).
   * Retorna { id, novo } -- `novo:false` quando o mesmo evento ja estava gravado,
   * o que torna o replay pos-crash seguro (REL-02).
   */
  registrar(evento, etapasIniciais = []) {
    const {
      conversaId,
      origemId,
      direcao = "entrada",
      autorId = null,
      autorEDono = false,
      doProprioBot = false,
      tipo = "desconhecido",
      bruto,
      texto = null,
      recebidoEm = new Date(),
    } = evento;

    if (!conversaId) throw new Error("evento sem conversaId");
    if (!origemId) throw new Error("evento sem origemId");
    if(eventoExcluido(this.#db,conversaId,origemId))return {id:null,novo:false,excluido:true};

    const existente = this.#db
      .prepare("SELECT id FROM eventos WHERE conversa_id = ? AND origem_id = ?")
      .get(conversaId, origemId);
    if (existente) return { id: Number(existente.id), novo: false };

    const iso = agoraIso(recebidoEm);
    const info = this.#db
      .prepare(
        `INSERT INTO eventos
           (conversa_id, origem_id, direcao, autor_id, autor_e_dono, do_proprio_bot, projeto_id,
            tipo, bruto, texto, recebido_em, dia_local)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        conversaId,
        origemId,
        direcao,
        autorId,
        autorEDono ? 1 : 0,
        doProprioBot ? 1 : 0,
        null,
        tipo,
        typeof bruto === "string" ? bruto : JSON.stringify(bruto ?? {}),
        texto,
        iso,
        diaLocal(recebidoEm),
      );

    const id = Number(info.lastInsertRowid);
    for (const etapa of etapasIniciais) this.#agendar(id, etapa, iso);
    return { id, novo: true };
  }

  #agendar(eventoId, etapa, quando) {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO etapas
           (evento_id, etapa, estado, tentativas, atualizado_em, proxima_tentativa_em)
         VALUES (?,?, 'pendente', 0, ?, ?)`,
      )
      .run(eventoId, etapa, quando, quando);
  }

  agendar(eventoId, etapa, quando = new Date()) {
    this.#agendar(eventoId, etapa, agoraIso(quando));
  }

  evento(id) {
    return this.#db.prepare("SELECT * FROM eventos WHERE id = ?").get(id) ?? null;
  }

  /** Eventos de uma conversa, em ordem de chegada. */
  conversa(conversaId, limite = 200) {
    return this.#db
      .prepare("SELECT * FROM eventos WHERE conversa_id = ? ORDER BY id ASC LIMIT ?")
      .all(conversaId, limite);
  }

  contar() {
    return Number(this.#db.prepare("SELECT COUNT(*) AS n FROM eventos").get().n);
  }
}

// Fila de etapas com retentativa duravel e espera crescente.
//
// Cada etapa de cada evento tem estado proprio. Uma falha de transcricao nao
// apaga a mensagem nem some em log: fica `falha` com `proxima_tentativa_em`,
// visivel na saude e reprocessavel (achados A03 e A01).

import { agoraIso, idadeMs } from "./relogio.js";

const ESPERA_MS = [0, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
export const MAX_TENTATIVAS = ESPERA_MS.length;

export class Fila {
  #db;
  constructor(db) {
    this.#db = db;
  }

  /** Itens de uma etapa prontos para rodar agora (pendente ou falha ja vencida). */
  prontos(etapa, { projetoId, agora = new Date(), limite = 50 } = {}) {
    if (!projetoId) throw new Error("consulta da fila exige projetoId");
    const iso = agoraIso(agora);
    return this.#db
      .prepare(
        `SELECT e.*, v.conversa_id, v.projeto_id, v.tipo, v.texto, v.bruto
           FROM etapas e JOIN eventos v ON v.id = e.evento_id
          WHERE e.etapa = ?
            AND v.projeto_id IS NOT NULL
            AND v.projeto_id = ?
            AND e.estado IN ('pendente','falha')
            AND (e.proxima_tentativa_em IS NULL OR e.proxima_tentativa_em <= ?)
          ORDER BY e.evento_id ASC
          LIMIT ?`,
      )
      .all(etapa, projetoId, iso, limite);
  }

  iniciar(eventoId, etapa, agora = new Date()) {
    const updated = this.#db
      .prepare(
        `UPDATE etapas SET estado='em_curso', tentativas = tentativas + 1, atualizado_em=?
          WHERE evento_id=? AND etapa=? AND lease_token IS NULL`,
      )
      .run(agoraIso(agora), eventoId, etapa);
    if (updated.changes !== 1) throw new Error('Etapa ausente ou sob lease');
  }

  concluir(eventoId, etapa, resultado = null, agora = new Date()) {
    const iso = agoraIso(agora);
    const updated = this.#db
      .prepare(
        `UPDATE etapas SET estado='concluida', resultado=?, ultimo_erro=NULL,
                proxima_tentativa_em=NULL, atualizado_em=?
          WHERE evento_id=? AND etapa=? AND lease_token IS NULL`,
      )
      .run(resultado === null ? null : JSON.stringify(resultado), iso, eventoId, etapa);
    if (updated.changes !== 1) throw new Error('Etapa ausente ou sob lease');
    this.#marcarSaude(etapa, { sucessoEm: iso });
  }

  /** Falha nao vira sucesso silencioso: ou reagenda, ou desiste de forma visivel. */
  falhar(eventoId, etapa, erro, agora = new Date()) {
    const iso = agoraIso(agora);
    const linha = this.#db
      .prepare("SELECT tentativas FROM etapas WHERE evento_id=? AND etapa=?")
      .get(eventoId, etapa);
    const tentativas = Number(linha?.tentativas ?? 0);
    const desistiu = tentativas >= MAX_TENTATIVAS;
    const espera = ESPERA_MS[Math.min(tentativas, ESPERA_MS.length - 1)];
    const proxima = desistiu ? null : agoraIso(new Date(agora.getTime() + espera));

    const updated = this.#db
      .prepare(
        `UPDATE etapas SET estado=?, ultimo_erro=?, proxima_tentativa_em=?, atualizado_em=?
          WHERE evento_id=? AND etapa=? AND lease_token IS NULL`,
      )
      .run(desistiu ? "desistida" : "falha", String(erro), proxima, iso, eventoId, etapa);
    if (updated.changes !== 1) throw new Error('Etapa ausente ou sob lease');
    this.#marcarSaude(etapa, { erroEm: iso, erro: String(erro) });
    return { desistiu, tentativas, proximaTentativaEm: proxima };
  }

  #marcarSaude(etapa, { sucessoEm = null, erroEm = null, erro = null }) {
    this.#db
      .prepare("INSERT OR IGNORE INTO saude (etapa) VALUES (?)")
      .run(etapa);
    if (sucessoEm) {
      this.#db.prepare("UPDATE saude SET ultimo_sucesso_em=? WHERE etapa=?").run(sucessoEm, etapa);
    }
    if (erroEm) {
      this.#db
        .prepare("UPDATE saude SET ultimo_erro_em=?, ultimo_erro=? WHERE etapa=?")
        .run(erroEm, erro, etapa);
    }
  }

  /** Tamanho e idade do atraso de uma etapa -- entra na saude (achado A01). */
  atraso(etapa, agora = new Date()) {
    const linha = this.#db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(e.atualizado_em) AS mais_antigo
           FROM etapas e JOIN eventos v ON v.id=e.evento_id
          WHERE e.etapa=? AND v.projeto_id IS NOT NULL
            AND e.estado IN ('pendente','falha','em_curso')`,
      )
      .get(etapa);
    const n = Number(linha?.n ?? 0);
    return {
      pendentes: n,
      idadeMaisAntigoMs: n === 0 ? 0 : idadeMs(linha.mais_antigo, agora),
    };
  }

  /** Entradas persistidas que ainda nao podem chegar a nenhum worker. */
  quarentena(agora = new Date()) {
    const linha = this.#db.prepare(
      `SELECT COUNT(DISTINCT v.id) AS n, MIN(e.atualizado_em) AS mais_antigo
         FROM eventos v JOIN etapas e ON e.evento_id=v.id
        WHERE v.projeto_id IS NULL AND e.estado IN ('pendente','falha','em_curso')`,
    ).get();
    const n = Number(linha?.n ?? 0);
    return {
      pendentes: n,
      idadeMaisAntigoMs: n === 0 ? 0 : idadeMs(linha.mais_antigo, agora),
    };
  }

  desistidas(etapa = null) {
    return etapa
      ? this.#db.prepare("SELECT * FROM etapas WHERE estado='desistida' AND etapa=?").all(etapa)
      : this.#db.prepare("SELECT * FROM etapas WHERE estado='desistida'").all();
  }
}

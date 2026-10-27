// Preparo e envio de saidas, separados de proposito.
//
// Preparar nunca envia. O envio reconfere a politica no instante do disparo, entao
// uma revogacao que aconteceu depois do preparo cancela a saida (regra do mandato).
// Toda saida tem chave de idempotencia; um reinicio no meio do envio deixa a saida
// `incerta` para reconciliacao em vez de reenviar as cegas.

import { agoraIso } from "./relogio.js";

export class Saidas {
  #db;
  #politica;
  constructor(db, politica) {
    this.#db = db;
    this.#politica = politica;
  }

  preparar({ conversaId, corpo, idempotencia }, agora = new Date()) {
    if (!idempotencia) throw new Error("saida sem chave de idempotencia");
    const iso = agoraIso(agora);
    const existente = this.#db.prepare("SELECT * FROM saidas WHERE idempotencia=?").get(idempotencia);
    if (existente) {
      if (existente.conversa_id !== conversaId || existente.corpo !== corpo) throw new Error('Chave de saída já vinculada a outro conteúdo ou destinatário.');
      return existente;
    }
    this.#db
      .prepare(
        `INSERT INTO saidas (conversa_id, idempotencia, corpo, estado, criado_em, atualizado_em)
         VALUES (?,?,?,'preparada',?,?)`,
      )
      .run(conversaId, idempotencia, corpo, iso, iso);
    return this.#db.prepare("SELECT * FROM saidas WHERE idempotencia=?").get(idempotencia);
  }

  /**
   * @param transporte funcao assincrona (conversaId, corpo) => id externo.
   *        Se ela lancar, a saida vira `incerta`: nao sabemos se chegou.
   */
  async enviar(idempotencia, transporte, agora = new Date(), {validar = null, externoId = null} = {}) {
    const saida = this.#db.prepare("SELECT * FROM saidas WHERE idempotencia=?").get(idempotencia);
    if (!saida) return { enviada: false, motivo: "saida inexistente" };
    if (saida.estado === "enviada") return { enviada: true, motivo: "ja enviada", repetida: true };
    if (saida.estado !== "preparada") return { enviada: false, incerta:saida.estado==='incerta', motivo: `estado ${saida.estado}` };

    const veredito = this.#politica.podeEnviar(saida.conversa_id);
    if (!veredito.permitido) {
      this.#atualizar(idempotencia, "cancelada", veredito.motivo, agora);
      return { enviada: false, motivo: veredito.motivo };
    }

    if (validar && validar(saida) !== true) {
      this.#atualizar(idempotencia, 'cancelada', 'Autorização ou fonte mudou.', agora);
      return {enviada:false,motivo:'Autorização ou fonte mudou.'};
    }
    // The existing incerta state is a durable claim BEFORE the transport. A
    // process death or a concurrent call must never leave this row sendable.
    const claim = this.#db.prepare("UPDATE saidas SET estado='incerta',motivo=?,atualizado_em=? WHERE idempotencia=? AND estado='preparada'")
      .run(externoId || 'Despacho iniciado; confirmação pendente.',agoraIso(agora),idempotencia);
    if (Number(claim.changes) !== 1) return {enviada:false,incerta:true,motivo:'Saída já reclamada.'};

    try {
      const externo = await transporte(saida.conversa_id, saida.corpo, externoId);
      if (!externo) return {enviada:false,incerta:true,motivo:'Transporte sem recibo.'};
      this.#atualizar(idempotencia, "enviada", externo ? String(externo) : null, agora);
      return { enviada: true, motivo: null };
    } catch (erro) {
      this.#atualizar(idempotencia, "incerta", externoId || 'Transporte não confirmou o envio.', agora);
      return { enviada: false, motivo: "envio incerto", incerta: true };
    }
  }

  #atualizar(idempotencia, estado, motivo, agora) {
    this.#db
      .prepare("UPDATE saidas SET estado=?, motivo=?, atualizado_em=? WHERE idempotencia=?")
      .run(estado, motivo, agoraIso(agora), idempotencia);
  }

  incertas() {
    return this.#db.prepare("SELECT * FROM saidas WHERE estado='incerta'").all();
  }

  buscar(idempotencia) {
    return this.#db.prepare("SELECT * FROM saidas WHERE idempotencia=?").get(idempotencia) ?? null;
  }
}

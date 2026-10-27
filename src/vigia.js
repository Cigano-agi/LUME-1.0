// Vigia independente.
//
// Corrige A01/REL-03: um monitor dentro do processo principal nao detecta a
// propria morte, e um aviso pelo WhatsApp nao serve para avisar que o WhatsApp
// caiu. Este modulo le o batimento gravado no banco por OUTRO processo e decide
// alarme/recuperacao.
//
// O estado de alarme fica NO BANCO, nao em memoria: o vigia pode ser um processo
// longo ou uma rodada de cron, e nos dois casos o mesmo alarme so sai uma vez.
// (O dedup em memoria passava nos testes unitarios e falhava no teste de queda
// real -- ver docs/07-PROVAS.md.)
//
// O canal externo de aviso e injetado (`avisar`). O vigia nao sabe se e e-mail,
// webhook ou arquivo -- e nunca usa o transporte que ele esta vigiando.

import { idadeMs, agoraIso } from "./relogio.js";
import { LIMITES } from "./saude.js";

export class Vigia {
  #db;
  #avisar;
  #limiteMs;

  constructor(db, { avisar, limiteMs = LIMITES.batimentoMs } = {}) {
    if (typeof avisar !== "function") throw new Error("vigia exige um canal de aviso externo");
    this.#db = db;
    this.#avisar = avisar;
    this.#limiteMs = limiteMs;
  }

  #estado(componente) {
    const linha = this.#db.prepare("SELECT estado FROM vigia_estado WHERE componente=?").get(componente);
    return linha?.estado ?? "vivo";
  }

  #gravarEstado(componente, estado, agora) {
    this.#db
      .prepare(
        `INSERT INTO vigia_estado (componente, estado, atualizado_em) VALUES (?,?,?)
         ON CONFLICT(componente) DO UPDATE SET estado=excluded.estado, atualizado_em=excluded.atualizado_em`,
      )
      .run(componente, estado, agoraIso(agora));
  }

  /** Uma rodada de verificacao. Retorna os avisos emitidos nesta rodada. */
  async verificar(agora = new Date()) {
    const emitidos = [];
    for (const linha of this.#db.prepare("SELECT * FROM batimentos").all()) {
      const idade = idadeMs(linha.visto_em, agora);
      const vivo = idade <= this.#limiteMs;
      const anterior = this.#estado(linha.componente);

      if (!vivo && anterior !== "alarmado") {
        // Grava o estado ANTES de avisar: se o canal de aviso travar, a proxima
        // rodada nao dispara um segundo alarme para a mesma queda.
        this.#gravarEstado(linha.componente, "alarmado", agora);
        const aviso = {
          tipo: "queda",
          componente: linha.componente,
          ultimoBatimentoEm: linha.visto_em,
          idadeMs: idade,
          em: agoraIso(agora),
        };
        await this.#avisar(aviso);
        emitidos.push(aviso);
      } else if (vivo && anterior === "alarmado") {
        this.#gravarEstado(linha.componente, "vivo", agora);
        const aviso = { tipo: "recuperacao", componente: linha.componente, em: agoraIso(agora) };
        await this.#avisar(aviso);
        emitidos.push(aviso);
      }
    }
    return emitidos;
  }
}

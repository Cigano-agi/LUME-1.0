// Saude por etapa. Nao existe um "ok" global.
//
// Corrige A01: processo vivo e socket conectado nao provam nada. Cada etapa
// reporta ultimo sucesso, ultimo erro, atraso e idade do atraso. Silencio em
// conversa quieta nao vira falha: `sem_dados` e um estado proprio, diferente de
// `degradada`.

import { ETAPAS } from "./ingestao.js";
import { Fila } from "./etapas.js";
import { idadeMs, agoraIso } from "./relogio.js";

/** Limites iniciais, revisaveis. Em ms. */
export const LIMITES = {
  batimentoMs: 3 * 60_000,       // vigia alarma depois de 3 batimentos perdidos de 60s
  atrasoMaximoMs: 15 * 60_000,   // item parado ha mais de 15 min e degradacao
};

/**
 * O batimento so pode significar "ingerindo". Enquanto ele significava "processo de pe",
 * uma conexao morta ficava invisivel: em 10/09 o socket caiu as 17h04 e o batimento
 * seguiu ate as 19h34 dizendo que estava tudo bem. A folga de boot existe porque a
 * primeira conexao leva segundos e nao pode ser lida como queda.
 */
export function deveBater(estadoConexao, agoraMs, bootAteMs) {
  return estadoConexao === "conectada" || agoraMs < bootAteMs;
}

export function batimento(db, componente, { pid = process.pid, agora = new Date() } = {}) {
  db.prepare(
    `INSERT INTO batimentos (componente, pid, visto_em) VALUES (?,?,?)
     ON CONFLICT(componente) DO UPDATE SET pid=excluded.pid, visto_em=excluded.visto_em`,
  ).run(componente, pid, agoraIso(agora));
}

export function snapshot(db, agora = new Date(), limites = LIMITES) {
  const fila = new Fila(db);
  const quarentena = fila.quarentena(agora);
  const quarentenaDegradada =
    quarentena.pendentes > 0 && quarentena.idadeMaisAntigoMs > limites.atrasoMaximoMs;
  const etapas = {};
  for (const etapa of ETAPAS) {
    const linha = db.prepare("SELECT * FROM saude WHERE etapa=?").get(etapa) ?? {};
    const atraso = fila.atraso(etapa, agora);
    let estado;
    if (atraso.pendentes > 0 && atraso.idadeMaisAntigoMs > limites.atrasoMaximoMs) estado = "degradada";
    else if (linha.ultimo_erro_em && !linha.ultimo_sucesso_em) estado = "degradada";
    else if (!linha.ultimo_sucesso_em && atraso.pendentes === 0) estado = "sem_dados";
    else estado = "ok";
    etapas[etapa] = {
      estado,
      ultimoSucessoEm: linha.ultimo_sucesso_em ?? null,
      ultimoErroEm: linha.ultimo_erro_em ?? null,
      ultimoErro: linha.ultimo_erro ?? null,
      pendentes: atraso.pendentes,
      idadeMaisAntigoMs: atraso.idadeMaisAntigoMs,
      desistidas: fila.desistidas(etapa).length,
    };
  }

  const ultimoEvento = db
    .prepare("SELECT recebido_em FROM eventos ORDER BY id DESC LIMIT 1")
    .get();
  const batimentos = db.prepare("SELECT * FROM batimentos").all().map((b) => ({
    componente: b.componente,
    pid: b.pid,
    vistoEm: b.visto_em,
    idadeMs: idadeMs(b.visto_em, agora),
    vivo: idadeMs(b.visto_em, agora) <= limites.batimentoMs,
  }));

  const punkFalhas = Number(
    db.prepare("SELECT COUNT(*) AS n FROM entregas_punk WHERE estado='falha'").get().n,
  );
  const saidasIncertas = Number(
    db.prepare("SELECT COUNT(*) AS n FROM saidas WHERE estado='incerta'").get().n,
  );

  const degradadas = Object.entries(etapas).filter(([, v]) => v.estado === "degradada").map(([k]) => k);
  const batimentoMorto = batimentos.filter((b) => !b.vivo).map((b) => b.componente);

  return {
    em: agoraIso(agora),
    etapas,
    quarentena: {
      ...quarentena,
      estado: quarentenaDegradada ? "degradada" : quarentena.pendentes ? "aguardando_roteamento" : "vazia",
    },
    batimentos,
    ultimoEventoEm: ultimoEvento?.recebido_em ?? null,
    entregasPunkComFalha: punkFalhas,
    saidasIncertas,
    // Veredito explicito e conservador: qualquer etapa degradada, batimento morto,
    // falha de memoria ou saida incerta impede declarar saude.
    veredito:
      degradadas.length || quarentenaDegradada || batimentoMorto.length || punkFalhas || saidasIncertas
        ? "degradado"
        : "ok",
    motivos: [
      ...degradadas.map((e) => `etapa ${e} degradada`),
      ...(quarentenaDegradada ? [`${quarentena.pendentes} evento(s) parado(s) na quarentena`] : []),
      ...batimentoMorto.map((c) => `batimento de ${c} parado`),
      ...(punkFalhas ? [`${punkFalhas} entrega(s) ao Punk com falha`] : []),
      ...(saidasIncertas ? [`${saidasIncertas} saida(s) em estado incerto`] : []),
    ],
  };
}

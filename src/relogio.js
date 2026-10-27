// Relogio unico da operacao. Corrige A05: o digest antigo usava data UTC
// (`new Date().toISOString().slice(0,10)`) enquanto a operacao roda em Sao Paulo,
// entao um evento das 23h locais era gravado no dia seguinte.

export const FUSO = "America/Sao_Paulo";

const FORMATADOR_DIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSO,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Data local YYYY-MM-DD em America/Sao_Paulo. */
export function diaLocal(quando = new Date()) {
  return FORMATADOR_DIA.format(quando);
}

/** Carimbo canonico persistido: sempre ISO em UTC, sem ambiguidade. */
export function agoraIso(quando = new Date()) {
  return new Date(quando).toISOString();
}

/** Idade em milissegundos de um carimbo ISO. Negativa vira 0. */
export function idadeMs(iso, agora = new Date()) {
  if (!iso) return Infinity;
  const delta = agora.getTime() - new Date(iso).getTime();
  return delta > 0 ? delta : 0;
}

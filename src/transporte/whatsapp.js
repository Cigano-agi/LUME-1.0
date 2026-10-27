// Adaptador de eventos do WhatsApp (formato Baileys) para a ingestao.
//
// Puro de proposito: recebe o objeto do evento e um `Ingestao`, e nao conhece
// socket, sessao nem credencial. Isso permite testar com mensagens de formato
// real sem conectar nada -- e permite trocar o transporte depois sem reescrever
// a ingestao.
//
// Procedencia: os campos e o `textoDe` seguem
// whatsapp-brain@fd40178 `src/modules/wa.ts` (linhas 65-98, 118-160).
//
// A DIFERENCA deliberada esta em `aplicarUpsert`: o listener antigo fazia
//   if (type !== "notify") return;   // ignore history/append bulk syncs
// e por isso descartava lotes de historico (achado A02). Aqui todo lote e
// persistido. O tipo do lote fica gravado, entao da para distinguir depois o
// que chegou ao vivo do que chegou por sincronizacao -- sem jogar fora.

/** Tipo de midia a partir do formato da mensagem. Identificar nao e compreender (A10). */
export function tipoDe(mensagem) {
  const m = mensagem?.message ?? {};
  if (m.conversation || m.extendedTextMessage) return "texto";
  if (m.audioMessage) return "audio";
  if (m.imageMessage) return "imagem";
  if (m.videoMessage) return "video";
  if (m.documentMessage) return "documento";
  if (m.stickerMessage) return "figurinha";
  return "desconhecido";
}

/** Texto ja disponivel na chegada. Nao transcreve nem chama modelo. */
export function textoDe(mensagem) {
  const m = mensagem?.message ?? {};
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

/** Normaliza uma WAMessage para o formato do evento persistido. */
export function normalizar(mensagem, { tipoLote = "desconhecido", donoJid = null } = {}) {
  const chave = mensagem?.key ?? {};
  const conversaId = chave.remoteJid ?? "";
  const origemId = chave.id ?? "";
  const daMinhaConta = Boolean(chave.fromMe);
  const ehGrupo = conversaId.endsWith("@g.us");

  // Em grupo o autor vem em `participant`. Em DM, `fromMe` indica o dono.
  const autorId = ehGrupo
    ? (chave.participant ?? chave.participantLid ?? null)
    : daMinhaConta
      ? donoJid
      : conversaId;

  const tipo = tipoDe(mensagem);
  return {
    conversaId,
    origemId,
    direcao: daMinhaConta ? "saida" : "entrada",
    autorId,
    // Mensagem do Fabricio pelo celular dele TAMBEM chega com fromMe. Quem separa
    // "o dono digitou" de "eco do proprio bot" e o registro de saidas enviadas
    // (ver `classificarFromMe`), nunca o texto. Por isso sao dois campos.
    autorEDono: daMinhaConta,
    doProprioBot: false,
    tipo,
    // Audio nunca traz texto na chegada: a transcricao e uma etapa posterior.
    texto: tipo === "audio" ? null : textoDe(mensagem),
    bruto: { tipoLote, mensagem },
    recebidoEm: mensagem?.messageTimestamp
      ? new Date(Number(mensagem.messageTimestamp) * 1000)
      : new Date(),
  };
}

/** Etapas agendadas na chegada, por tipo. Nada pesado roda aqui. */
export function etapasPara(tipo) {
  const base = ["analise", "memoria"];
  if (tipo === "audio") return ["transcricao", ...base];
  if (tipo === "imagem" || tipo === "documento" || tipo === "video") return ["leitura_midia", ...base];
  return base;
}

/**
 * Processa um lote `messages.upsert`. Persiste TODAS as mensagens do lote,
 * inclusive os de historico e append (achado A02), e devolve o que aconteceu.
 *
 * Nao transcreve, nao analisa, nao responde. So grava e enfileira.
 */
export function aplicarUpsert(ingestao, { messages = [], type = "desconhecido" } = {}, opcoes = {}) {
  const resultado = {
    tipoLote: type,
    recebidas: messages.length,
    novas: 0,
    repetidas: 0,
    ignoradas: 0,
    ids: [],
  };

  for (const mensagem of messages) {
    const evento = normalizar(mensagem, { tipoLote: type, ...opcoes });
    if (!evento.conversaId || !evento.origemId) {
      resultado.ignoradas++;
      continue;
    }
    const { id, novo } = ingestao.registrar(evento, etapasPara(evento.tipo));
    resultado.ids.push(id);
    if (novo) resultado.novas++;
    else resultado.repetidas++;
  }
  return resultado;
}

/**
 * Decide o efeito de uma mensagem com `fromMe` sobre a politica.
 * Se o id externo da mensagem consta como saida ja enviada pelo assessor, e eco
 * do bot. Caso contrario, o dono digitou -- e a conversa pausa.
 */
export function classificarFromMe(db, mensagem) {
  const idExterno = mensagem?.key?.id ?? "";
  if (!idExterno) return { doProprioBot: false };
  const linha = db
    .prepare("SELECT id FROM saidas WHERE estado IN ('enviada','incerta') AND motivo = ? AND conversa_id = ?")
    .get(idExterno,mensagem?.key?.remoteJid??'');
  return { doProprioBot: Boolean(linha) };
}

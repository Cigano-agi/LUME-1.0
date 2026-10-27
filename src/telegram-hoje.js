/**
 * Optional, read-only Telegram /hoje command. This module does not connect to
 * Telegram or store a token. Feed it only updates received by a trusted poller.
 * The caller is responsible for sending the returned message to Telegram.
 */
const MAX_MESSAGE = 1500;

function id(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? value : null;
}

function command(text, botUsername) {
  if (typeof text !== 'string') return false;
  const match = /^\/hoje(?:@([A-Za-z][A-Za-z0-9_]{4,31}))?\s*$/i.exec(text);
  if (!match) return false;
  return !match[1] || Boolean(botUsername && match[1].toLowerCase() === botUsername.toLowerCase());
}

function safeLine(value, limit = 110) {
  const clean = String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Deliberately excludes source bodies, excerpts, people, links and money. */
export function formatarHojeTelegram(snapshot, {shareTitles = false} = {}) {
  const lines = [
    `Lume · Hoje ${safeLine(snapshot?.dia, 20)}`,
    `${count(snapshot?.prioridades?.total)} ações · ${count(snapshot?.revisao?.total)} para revisar · ${count(snapshot?.oportunidades?.total)} oportunidades`,
  ];
  if (snapshot?.cobertura?.estado === 'sem-dados') {
    lines.push('Ainda não há mensagens permitidas neste resumo.');
  } else if (snapshot?.cobertura?.estado === 'antiga') {
    lines.push('As mensagens salvas podem estar desatualizadas; confira a captura no Lume.');
  }
  if (shareTitles) {
    const items = Array.isArray(snapshot?.prioridades?.itens) ? snapshot.prioridades.itens.slice(0, 3) : [];
    for (const [index, item] of items.entries()) {
      const title = safeLine(item?.titulo, 110);
      if (title) lines.push(`${index + 1}. ${title}`);
    }
  }
  lines.push('Abra o Lume para conferir as fontes e os próximos passos.');
  return lines.join('\n').slice(0, MAX_MESSAGE);
}

export class TelegramHoje {
  constructor({clareza, perfil, enabled = false, allowedChatIds = [], shareTitles = false, botUsername = null} = {}) {
    if (!clareza || typeof clareza.resumo !== 'function' || typeof perfil !== 'function') {
      throw new TypeError('TelegramHoje precisa da projeção ClarezaDia e do perfil.');
    }
    this.clareza = clareza;
    this.perfil = perfil;
    this.enabled = enabled === true;
    this.allowedChatIds = new Set(Array.isArray(allowedChatIds) ? allowedChatIds.map(id).filter(Boolean) : []);
    this.shareTitles = shareTitles === true;
    this.botUsername = typeof botUsername === 'string' ? botUsername.replace(/^@/, '') : null;
  }

  /** Returns null for every unauthorized or unsupported update. Never sends. */
  handleUpdate(update) {
    if (!this.enabled || !this.perfil()?.aceito) return null;
    const message = update?.message;
    const chatId = id(message?.chat?.id);
    const senderId = id(message?.from?.id);
    if (message?.chat?.type !== 'private' || !chatId || senderId !== chatId || !this.allowedChatIds.has(chatId)) return null;
    if (!command(message.text, this.botUsername)) return null;
    // Recompute on every authorized request so revocation and source changes are honored.
    return {chatId, text: formatarHojeTelegram(this.clareza.resumo(), {shareTitles: this.shareTitles})};
  }
}

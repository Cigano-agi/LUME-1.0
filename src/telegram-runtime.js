/**
 * Opt-in Telegram transport for TelegramHoje. Keep the token supplier backed by
 * a native secret store; this transport never persists or logs its value.
 */
const API = 'https://api.telegram.org';
const TOKEN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

function validToken(value) {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('Credencial do Telegram indisponível.');
  return value;
}

function abortableDelay(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, {once: true});
  });
}

export class TelegramHojeRuntime {
  constructor({hoje, token, fetchImpl, enabled = false, pollTimeoutSeconds = 20,
    requestTimeoutMs = 25_000, backoffMinMs = 1_000, backoffMaxMs = 30_000,
    initialOffset = 0, claimUpdate = null, diario = null} = {}) {
    if (!hoje || typeof hoje.handleUpdate !== 'function' || typeof token !== 'function' || typeof fetchImpl !== 'function') {
      throw new TypeError('TelegramHojeRuntime precisa do comando, fornecedor de token e fetch.');
    }
    if (!Number.isInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 1 || pollTimeoutSeconds > 25 ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30_000 ||
      !Number.isInteger(backoffMinMs) || backoffMinMs < 1 || backoffMinMs > 30_000 ||
      !Number.isInteger(backoffMaxMs) || backoffMaxMs < backoffMinMs || backoffMaxMs > 60_000 ||
      !Number.isSafeInteger(initialOffset) || initialOffset < 0 ||
      claimUpdate !== null && typeof claimUpdate !== 'function') {
      throw new RangeError('Limites de polling inválidos.');
    }
    this.hoje = hoje;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.enabled = enabled === true;
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.requestTimeoutMs = requestTimeoutMs;
    this.backoffMinMs = backoffMinMs;
    this.backoffMaxMs = backoffMaxMs;
    this.offset = initialOffset;
    this.claimUpdate = claimUpdate;
    this.diario = diario;
    this.controller = null;
    this.running = null;
  }

  start() {
    if (!this.enabled) return false;
    if (this.running) return true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.running = this.#loop(signal).finally(() => {
      if (this.controller?.signal === signal) { this.controller = null; this.running = null; }
    });
    return true;
  }

  async stop() {
    this.controller?.abort();
    await this.running;
  }

  async #request(method, body, signal) {
    const secret = validToken(await this.token());
    signal.throwIfAborted();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]);
    const response = await this.fetchImpl(`${API}/bot${secret}/${method}`, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: requestSignal,
    });
    if (!response?.ok) throw new Error('Telegram indisponível.');
    const data = await response.json();
    if (data?.ok !== true) throw new Error('Telegram recusou a operação.');
    return data.result;
  }

  async #loop(signal) {
    let backoff = this.backoffMinMs;
    while (!signal.aborted) {
      try {
        if (this.diario) await this.#drenar(signal);
        const updates = await this.#request('getUpdates', {
          offset: this.offset, timeout: this.pollTimeoutSeconds, limit: 25,
          allowed_updates: ['message'],
        }, signal);
        if (!Array.isArray(updates) || updates.length > 25) throw new Error('Resposta inválida do Telegram.');
        const previousOffset = this.offset;
        for (const update of updates) {
          if (signal.aborted) break;
          const updateId = update?.update_id;
          if (!Number.isSafeInteger(updateId) || updateId < 0) throw new Error('Atualização inválida do Telegram.');
          if (updateId < this.offset) continue;
          if (this.diario) {
            this.diario.aceitar(update);
            this.offset = this.diario.offset();
            continue;
          }
          if (this.claimUpdate) {
            // Durable claim precedes processing and sending: at most one attempt
            // even if the process restarts or Telegram loses the send ACK.
            const claimed = await this.claimUpdate(updateId);
            this.offset = updateId + 1;
            if (!claimed) continue;
          }
          const reply = await this.hoje.handleUpdate(update, {signal});
          if (reply) {
            // Plain text only. A failed send does not advance the cursor.
            await this.#request('sendMessage', {chat_id: reply.chatId, text: reply.text,
              disable_web_page_preview: true}, signal);
          }
          this.offset = updateId + 1;
        }
        if (this.diario) await this.#drenar(signal);
        backoff = this.backoffMinMs;
        // A mock or a fast empty server must not turn polling into a busy loop.
        if (this.offset === previousOffset) await abortableDelay(100, signal);
      } catch {
        if (signal.aborted) break;
        await abortableDelay(backoff, signal);
        backoff = Math.min(this.backoffMaxMs, backoff * 2);
      }
    }
  }

  async #drenar(signal) {
    for (let i=0;i<25&&!signal.aborted;i++) {
      const update=this.diario.proxima();if(!update)break;
      try {
        const reply=await this.hoje.handleUpdate(update,{signal});
        if(signal.aborted)break;
        this.diario.concluir(update,reply);
      }catch{if(!signal.aborted)this.diario.falhar(update);}
    }
    for(let i=0;i<25&&!signal.aborted;i++) {
      const row=this.diario.proximaSaida();if(!row)break;
      try {
        const receipt=await this.#request('sendMessage',{chat_id:row.dono_id,text:row.texto,disable_web_page_preview:true},signal);
        this.diario.enviada(row,receipt);
      }catch { /* the durable incerta row intentionally has no automatic retry */ }
    }
  }
}

import {ClarezaDia} from './clareza-dia.js';
import {TelegramHoje} from './telegram-hoje.js';
import {TelegramHojeRuntime} from './telegram-runtime.js';
import {TelegramDiario,identidadeTelegram} from './pessoal/telegram-diario.js';

const KEY = 'telegram-hoje';
const CURSOR_KEY = 'telegram-hoje-offset';
const DEFAULT = Object.freeze({enabled: false, chatId: null, shareTitles: false, botUsername: null});

function chatId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? value : null;
}

function username(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Nome do bot inválido.');
  const clean = value.replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(clean)) throw new TypeError('Nome do bot inválido.');
  return clean;
}

export class TelegramHojeIntegracao {
  constructor(db, {desktop, clareza, segredos, fetchImpl} = {}) {
    if (!db?.prepare || !desktop?.perfil || !segredos || typeof fetchImpl !== 'function') {
      throw new TypeError('Integração Telegram precisa do banco, Desktop, cofre e fetch.');
    }
    this.db = db;
    this.desktop = desktop;
    this.clareza = clareza ?? new ClarezaDia(db, {desktop});
    this.segredos = segredos;
    this.fetchImpl = fetchImpl;
    this.runtime = null;
    this.diario = null;
    this.pessoal = null;
  }

  #config() {
    try {
      const raw = JSON.parse(this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(KEY)?.valor ?? 'null');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {...DEFAULT};
      const id = chatId(raw.chatId);
      return {enabled: raw.enabled === true && Boolean(id), chatId: id,
        shareTitles: raw.shareTitles === true, botUsername: username(raw.botUsername)};
    } catch { return {...DEFAULT}; }
  }

  #save(config) {
    // Project a fixed allowlist; credentials and unknown keys can never enter the DB.
    const safe = {enabled: config.enabled, chatId: config.chatId,
      shareTitles: config.shareTitles, botUsername: config.botUsername};
    this.db.prepare('INSERT INTO desktop_config(chave,valor) VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor')
      .run(KEY, JSON.stringify(safe));
  }

  #cursor() {
    const value = this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(CURSOR_KEY)?.valor;
    if (!/^(0|[1-9]\d*)$/.test(value ?? '')) return -1;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : -1;
  }

  #claimUpdate(updateId) {
    if (!Number.isSafeInteger(updateId) || updateId < 0) throw new TypeError('Atualização inválida.');
    const result = this.db.prepare(`INSERT INTO desktop_config(chave,valor) VALUES(?,?)
      ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor
      WHERE CAST(desktop_config.valor AS INTEGER) < CAST(excluded.valor AS INTEGER)`)
      .run(CURSOR_KEY, String(updateId));
    return result.changes === 1;
  }

  async #vault({needToken = false} = {}) {
    if (typeof this.segredos.estado !== 'function' || typeof this.segredos.ler !== 'function' ||
      typeof this.segredos.gravar !== 'function' || typeof this.segredos.remover !== 'function') {
      throw new Error('Cofre do Telegram indisponível.');
    }
    const state = await this.segredos.estado();
    if (state?.disponivel !== true || needToken && state.configurada !== true) {
      throw new Error('Cofre do Telegram indisponível ou sem token.');
    }
    return state;
  }

  async estado() {
    const config = this.#config();
    let vault = {disponivel: false, configurada: false};
    try { vault = await this.#vault(); } catch { /* state remains closed */ }
    let identidade=null;
    try{identidade=JSON.parse(this.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-telegram-identidade'").get()?.valor||'null');}catch{}
    return {...config, identityConfirmed:Boolean(this.diario&&identidade?.botId===this.diario.botId&&identidade?.donoId===config.chatId),tokenConfigured: vault.configurada === true,
      secureStorageAvailable: vault.disponivel === true, running: Boolean(this.runtime?.running)};
  }

  async configurar({token, chatId: requestedId, shareTitles, botUsername, enabled} = {}) {
    const current = this.#config();
    const next = {
      enabled: enabled === undefined ? current.enabled : enabled === true,
      chatId: requestedId === undefined ? current.chatId : chatId(requestedId),
      shareTitles: shareTitles === undefined ? current.shareTitles : shareTitles === true,
      botUsername: botUsername === undefined ? current.botUsername : username(botUsername),
    };
    if (enabled !== undefined && typeof enabled !== 'boolean' ||
      shareTitles !== undefined && typeof shareTitles !== 'boolean' ||
      requestedId !== undefined && requestedId !== null && !next.chatId) {
      throw new TypeError('Configuração do Telegram inválida.');
    }
    if (token !== undefined && (typeof token !== 'string' || !/^\d{6,12}:[A-Za-z0-9_-]{30,100}$/.test(token))) {
      throw new TypeError('Token do Telegram inválido.');
    }
    if (next.enabled && (!next.chatId || !this.desktop.perfil().aceito)) {
      throw new Error('Conclua o primeiro acesso e informe a DM autorizada.');
    }
    if (next.enabled || token !== undefined) await this.#vault({needToken: next.enabled && token === undefined});
    await this.encerrar();
    if (token !== undefined) await this.segredos.gravar(token);
    this.#save(next);
    return this.estado();
  }

  async desativar() {
    // Stop network activity before changing/removing the credential.
    await this.encerrar();
    this.#save({...this.#config(), enabled: false});
    if (typeof this.segredos.remover !== 'function') throw new Error('Cofre do Telegram indisponível para remover token.');
    await this.segredos.remover();
    return this.estado();
  }

  async iniciar() {
    if (this.runtime?.running) return this.estado();
    const config = this.#config();
    if (!config.enabled || !config.chatId || !this.desktop.perfil().aceito) return this.estado();
    await this.#vault({needToken: true});
    // Validate availability now; runtime gets a fresh token from the cofre per request.
    const tokenAtual=await this.segredos.ler();
    const hoje = new TelegramHoje({clareza: this.clareza, perfil: () => this.desktop.perfil(),
      enabled: true, allowedChatIds: [config.chatId], shareTitles: config.shareTitles,
      botUsername: config.botUsername});
    const diario=new TelegramDiario(this.db,{botId:tokenAtual.split(':')[0],donoId:config.chatId,
      ativo:()=>{const c=this.#config();return c.enabled&&c.chatId===config.chatId&&this.desktop.perfil().aceito;},
      validarSaida:v=>this.pessoal?.validarAviso(v)===true});
    this.diario=diario;
    const handler={handleUpdate:(update,options)=>{
      if(!identidadeTelegram(update,config.chatId))return null;
      return this.pessoal?.ativa()?this.pessoal.conversar(update,{...options,diario}):hoje.handleUpdate(update);
    }};
    this.runtime = new TelegramHojeRuntime({hoje:handler, token: () => this.segredos.ler(),
      fetchImpl: this.fetchImpl, enabled: true, initialOffset: diario.offset(),diario});
    this.runtime.start();
    return this.estado();
  }

  async encerrar() {
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.stop();
    this.diario=null;
  }

  agendar(id,texto,vinculo=null){return this.diario?.agendar(id,texto,vinculo)===true;}
}

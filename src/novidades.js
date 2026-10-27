import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compararVersoes } from './operacao-central.js';
import origemLume from '../desktop/origem-lume.cjs';

const SCHEMA = 'lume-comunicados-v1';
const CANAIS = new Set(['beta', 'estavel']);
const PLATAFORMAS = new Set(['win32', 'darwin']);
const ACOES = new Set(['nenhuma', 'ver_atualizacoes']);
const VERSAO = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ID = /^[A-Za-z0-9_-]{3,80}$/;
const MAX_RESPOSTA_BYTES = 64 * 1024;
const INTERVALO_GLOBAL_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORICO = 50;

const politicaDesligada = () => ({ schema: 'lume-comunicados-policy-v1', enabled: false, channel: 'beta', feedUrl: null, publicKey: null });
const data = valor => typeof valor === 'string' && Number.isFinite(Date.parse(valor)) ? new Date(valor).toISOString() : null;
const objetoExato = (valor, chaves) => Boolean(valor && typeof valor === 'object' && !Array.isArray(valor) && Object.keys(valor).sort().join(',') === [...chaves].sort().join(','));

export function validarPoliticaComunicados(valor) {
  if (!objetoExato(valor, ['schema', 'enabled', 'channel', 'feedUrl', 'publicKey']) || valor.schema !== 'lume-comunicados-policy-v1' || typeof valor.enabled !== 'boolean' || !CANAIS.has(valor.channel)) return politicaDesligada();
  if (!valor.enabled) return politicaDesligada();
  try {
    const url = new URL(valor.feedUrl);
    const chave = Buffer.from(valor.publicKey, 'base64');
    const objetoChave = createPublicKey({ key: chave, format: 'der', type: 'spki' });
    if (!origemLume.origemPermitida(url) || url.search || url.hash || url.pathname !== `/api/v1/comunicados/${valor.channel}.json`) return politicaDesligada();
    if (objetoChave.asymmetricKeyType !== 'ed25519' || chave.length < 32 || chave.length > 256) return politicaDesligada();
    return { ...valor, feedUrl: url.href };
  } catch { return politicaDesligada(); }
}

export function carregarPoliticaComunicados(arquivo) {
  try { return validarPoliticaComunicados(JSON.parse(readFileSync(arquivo, 'utf8'))); }
  catch { return politicaDesligada(); }
}

export function validarCampanha(valor) {
  const chaves = ['id', 'titulo', 'texto', 'inicioEm', 'expiraEm', 'canais', 'plataformas', 'versaoMin', 'versaoMax', 'repetirAposHoras', 'acao'];
  if (!objetoExato(valor, chaves) || !ID.test(String(valor.id || ''))) throw new Error('CAMPANHA_INVALIDA');
  const titulo = typeof valor.titulo === 'string' ? valor.titulo.trim() : '';
  const texto = typeof valor.texto === 'string' ? valor.texto.trim() : '';
  const inicioEm = data(valor.inicioEm), expiraEm = data(valor.expiraEm);
  if (!titulo || titulo.length > 80 || !texto || texto.length > 280 || !inicioEm || !expiraEm || Date.parse(inicioEm) >= Date.parse(expiraEm)) throw new Error('CAMPANHA_INVALIDA');
  if (!Array.isArray(valor.canais) || valor.canais.length < 1 || valor.canais.length > CANAIS.size || valor.canais.some(item => !CANAIS.has(item)) || new Set(valor.canais).size !== valor.canais.length) throw new Error('CAMPANHA_INVALIDA');
  if (!Array.isArray(valor.plataformas) || valor.plataformas.length < 1 || valor.plataformas.length > PLATAFORMAS.size || valor.plataformas.some(item => !PLATAFORMAS.has(item)) || new Set(valor.plataformas).size !== valor.plataformas.length) throw new Error('CAMPANHA_INVALIDA');
  if (!VERSAO.test(String(valor.versaoMin || '')) || !VERSAO.test(String(valor.versaoMax || '')) || compararVersoes(valor.versaoMin, valor.versaoMax) > 0) throw new Error('CAMPANHA_INVALIDA');
  if (!Number.isInteger(valor.repetirAposHoras) || (valor.repetirAposHoras !== 0 && (valor.repetirAposHoras < 24 || valor.repetirAposHoras > 720)) || !ACOES.has(valor.acao)) throw new Error('CAMPANHA_INVALIDA');
  return { id: valor.id, titulo, texto, inicioEm, expiraEm, canais: [...valor.canais], plataformas: [...valor.plataformas], versaoMin: valor.versaoMin, versaoMax: valor.versaoMax, repetirAposHoras: valor.repetirAposHoras, acao: valor.acao };
}

export function validarEnvelopeComunicados(valor, publicKey) {
  if (!objetoExato(valor, ['schema', 'geradoEm', 'campanhas', 'assinatura']) || valor.schema !== SCHEMA || !data(valor.geradoEm) || !Array.isArray(valor.campanhas) || valor.campanhas.length > 20 || typeof valor.assinatura !== 'string' || valor.assinatura.length > 512) throw new Error('COMUNICADOS_INVALIDOS');
  const assinado = { schema: valor.schema, geradoEm: valor.geradoEm, campanhas: valor.campanhas };
  let chave, assinatura;
  try {
    chave = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    assinatura = Buffer.from(valor.assinatura, 'base64');
  } catch { throw new Error('ASSINATURA_INVALIDA'); }
  if (!assinatura.length || !verify(null, Buffer.from(JSON.stringify(assinado)), chave, assinatura)) throw new Error('ASSINATURA_INVALIDA');
  const campanhas = valor.campanhas.map(validarCampanha);
  if (new Set(campanhas.map(item => item.id)).size !== campanhas.length) throw new Error('CAMPANHA_INVALIDA');
  return { schema: SCHEMA, geradoEm: data(valor.geradoEm), campanhas };
}

async function lerRespostaLimitada(resposta, limite, abortar) {
  const declarado = Number(resposta.headers?.get?.('content-length'));
  if (Number.isFinite(declarado) && declarado > limite) throw new Error('RESPOSTA_EXCESSIVA');
  if (!resposta.body || typeof resposta.body.getReader !== 'function') {
    const texto = await resposta.text();
    if (Buffer.byteLength(texto, 'utf8') > limite) throw new Error('RESPOSTA_EXCESSIVA');
    return texto;
  }
  const leitor = resposta.body.getReader(), partes = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.byteLength;
      if (total > limite) { abortar(); throw new Error('RESPOSTA_EXCESSIVA'); }
      partes.push(Buffer.from(value));
    }
    return Buffer.concat(partes, total).toString('utf8');
  } finally { leitor.releaseLock?.(); }
}

export function criarTransporteComunicados({ feedUrl, fetchImpl = globalThis.fetch, timeoutMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const url = new URL(feedUrl);
  if (typeof fetchImpl !== 'function' || !origemLume.origemPermitida(url) || url.search || url.hash || !/^\/api\/v1\/comunicados\/(beta|estavel)\.json$/.test(url.pathname)) throw new TypeError('transporte invalido');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new TypeError('timeout invalido');
  return async () => {
    const controlador = new AbortController();
    let expirou = false;
    const timer = setTimer(() => { expirou = true; controlador.abort(); }, timeoutMs);
    timer?.unref?.();
    try {
      const resposta = await fetchImpl(url.href, { method: 'GET', headers: { accept: 'application/json' }, signal: controlador.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!resposta?.ok) throw new Error('COMUNICADOS_INDISPONIVEIS');
      const texto = await lerRespostaLimitada(resposta, MAX_RESPOSTA_BYTES, () => controlador.abort());
      return JSON.parse(texto);
    } catch (error) {
      if (expirou || error?.name === 'AbortError') throw new Error('COMUNICADOS_INDISPONIVEIS');
      if (error?.message === 'RESPOSTA_EXCESSIVA') throw error;
      throw new Error('COMUNICADOS_INDISPONIVEIS');
    } finally { clearTimer(timer); }
  };
}

export class Novidades {
  constructor(db, { politica = politicaDesligada(), versao, plataforma = process.platform, agora = () => Date.now(), buscar } = {}) {
    this.db = db;
    this.politica = validarPoliticaComunicados(politica);
    this.versao = VERSAO.test(String(versao || '')) ? versao : '0.0.0';
    this.plataforma = PLATAFORMAS.has(plataforma) ? plataforma : null;
    this.agora = agora;
    this.buscar = buscar || (this.politica.enabled ? criarTransporteComunicados({ feedUrl: this.politica.feedUrl }) : null);
    this.operacao = null;
    db.exec('CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL)');
  }

  ler(chave, fallback) {
    try { const row = this.db.prepare('SELECT valor FROM desktop_config WHERE chave=?').get(`novidades-${chave}`); return row ? JSON.parse(row.valor) : fallback; }
    catch { return fallback; }
  }

  gravar(chave, valor) {
    this.db.prepare('INSERT INTO desktop_config VALUES(?,?) ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor').run(`novidades-${chave}`, JSON.stringify(valor));
  }

  consentido() { return this.ler('consentido', false) === true; }

  estado(situacao) {
    const consentido = this.consentido();
    return {
      disponivel: this.politica.enabled && Boolean(this.plataforma),
      consentido,
      situacao: situacao || (consentido ? (this.politica.enabled ? 'ativo' : 'indisponivel') : 'desligado'),
      comunicado: null
    };
  }

  ativar() { this.gravar('consentido', true); return this.estado(); }
  desativar() { this.gravar('consentido', false); return this.estado('desligado'); }

  historico() {
    const valor = this.ler('historico', { ultimoExibidoEm: null, vistos: {} });
    const vistos = {};
    if (valor?.vistos && typeof valor.vistos === 'object' && !Array.isArray(valor.vistos)) {
      for (const [id, quando] of Object.entries(valor.vistos).slice(-MAX_HISTORICO)) if (ID.test(id) && data(quando)) vistos[id] = data(quando);
    }
    return { ultimoExibidoEm: data(valor?.ultimoExibidoEm), vistos };
  }

  escolher(campanhas, historico) {
    const agora = this.agora();
    const ultimo = historico.ultimoExibidoEm ? Date.parse(historico.ultimoExibidoEm) : null;
    if (ultimo !== null && agora - ultimo < INTERVALO_GLOBAL_MS) return null;
    return campanhas
      .filter(item => Date.parse(item.inicioEm) <= agora && agora < Date.parse(item.expiraEm))
      .filter(item => item.canais.includes(this.politica.channel) && item.plataformas.includes(this.plataforma))
      .filter(item => compararVersoes(this.versao, item.versaoMin) >= 0 && compararVersoes(this.versao, item.versaoMax) <= 0)
      .filter(item => {
        const visto = historico.vistos[item.id] ? Date.parse(historico.vistos[item.id]) : null;
        return visto === null || (item.repetirAposHoras > 0 && agora - visto >= item.repetirAposHoras * 60 * 60 * 1000);
      })
      .sort((a, b) => Date.parse(b.inicioEm) - Date.parse(a.inicioEm) || a.id.localeCompare(b.id))[0] || null;
  }

  async verificar() {
    if (this.operacao) return this.operacao;
    this.operacao = this._verificar().finally(() => { this.operacao = null; });
    return this.operacao;
  }

  async _verificar() {
    if (!this.consentido()) return this.estado('desligado');
    if (!this.politica.enabled || !this.plataforma || !this.buscar) return this.estado('indisponivel');
    try {
      const envelope = validarEnvelopeComunicados(await this.buscar(), this.politica.publicKey);
      const historico = this.historico();
      const comunicado = this.escolher(envelope.campanhas, historico);
      if (!comunicado) return this.estado('sem_novidades');
      const horario = new Date(this.agora()).toISOString();
      const vistos = { ...historico.vistos, [comunicado.id]: horario };
      const reduzido = Object.fromEntries(Object.entries(vistos).sort((a, b) => Date.parse(a[1]) - Date.parse(b[1])).slice(-MAX_HISTORICO));
      this.gravar('historico', { ultimoExibidoEm: horario, vistos: reduzido });
      return { ...this.estado('comunicado'), comunicado: { id: comunicado.id, titulo: comunicado.titulo, texto: comunicado.texto, acao: comunicado.acao } };
    } catch { return this.estado('indisponivel'); }
  }
}

export { politicaDesligada as politicaComunicadosDesligada, INTERVALO_GLOBAL_MS };

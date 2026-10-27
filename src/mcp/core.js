import { randomBytes } from 'node:crypto';
import { diaLocal } from '../relogio.js';
import { McpError, respostaErro } from './errors.js';
import { MCP_TOOL_DEFINITIONS, validarEntrada } from './schemas.js';
import { digest, McpTokens } from './tokens.js';
import { LumeMcpReadService } from './read-service.js';
import { EXECUCAO_TOOL_DEFINITIONS, executarExecucao } from './execucao.js';

const MAX_DIAS = 90;
const CURSOR_TTL = 15 * 60 * 1000;

const esperado = value => value && typeof value === 'object' && !Array.isArray(value);
const limite = input => input.limit || 10;

function normalizarScope(scope, hoje) {
  if (!esperado(scope)) throw new McpError('SCOPE_REVOKED');
  if (scope.kind === 'today') return { kind: 'today', date: hoje };
  if (scope.kind === 'projects' || scope.kind === 'conversations') {
    if (!Array.isArray(scope.ids) || scope.ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new McpError('SCOPE_REVOKED');
    return { kind: scope.kind, ids: [...new Set(scope.ids)].sort() };
  }
  if (scope.kind === 'all') return { kind: 'all' };
  throw new McpError('SCOPE_REVOKED');
}

function periodo(input, agora) {
  let start = input.start, end = input.end;
  if (!start && !end) {
    const hoje = diaLocal(agora);
    start = hoje + 'T00:00:00-03:00';
    const next = new Date(start); next.setDate(next.getDate() + 1); end = next.toISOString();
  } else if (!start || !end) throw new McpError('INVALID_INPUT');
  const a = Date.parse(start), b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new McpError('INVALID_INPUT');
  if (b - a > MAX_DIAS * 86400000) throw new McpError('TOO_BROAD');
  return { start: new Date(a).toISOString(), end: new Date(b).toISOString() };
}

function estadoDigest(auth, scope) {
  return digest({ client: auth.clientId, revision: auth.revision, scope });
}

function respostaBase(agora, items, nextCursor = null, warnings = []) {
  return { ok: true, scope: { policy: 'current-local-policy', generated_at: agora.toISOString() }, items, next_cursor: nextCursor, warnings };
}

export class LumeMcpCore {
  constructor({ db, authorize, secret = randomBytes(32), agora = () => new Date(), readService, execucoes } = {}) {
    if (!db || typeof authorize !== 'function') throw new TypeError('db e authorize são obrigatórios');
    this.authorize = authorize; this.agora = agora;
    this.tokens = new McpTokens(secret, { agora: () => this.agora().getTime() });
    this.read = readService || new LumeMcpReadService(db);
    this.execucoes = execucoes;
  }

  tools() { return [...MCP_TOOL_DEFINITIONS, ...(this.execucoes ? EXECUCAO_TOOL_DEFINITIONS : [])].map(tool => structuredClone(tool)); }

  async autenticar(context) {
    if (!esperado(context) || typeof context.clientId !== 'string' || !context.clientId || typeof context.credential !== 'string' || !context.credential) throw new McpError('NOT_ENABLED');
    let auth;
    try { auth = await this.authorize({ clientId: context.clientId, credential: context.credential }); }
    catch (error) { if (error?.code === 'LUME_CLOSED') throw new McpError('LUME_CLOSED'); throw new McpError('NOT_ENABLED'); }
    if (!auth?.enabled) throw new McpError(auth?.revoked ? 'SCOPE_REVOKED' : 'NOT_ENABLED');
    const scope = normalizarScope(auth.scope, diaLocal(this.agora()));
    return { clientId: context.clientId, revision: String(auth.revision || ''), scope, digest: estadoDigest({ clientId: context.clientId, revision: String(auth.revision || '') }, scope) };
  }

  cursor(token, auth, query) {
    if (!token) return null;
    const data = this.tokens.abrir(token, 'cur');
    if (data.scope !== auth.digest || data.query !== digest(query) || !Number.isSafeInteger(data.id) || typeof data.at !== 'string') throw new McpError('INVALID_CURSOR');
    if (data.ref !== undefined && (typeof data.ref !== 'string' || data.ref.length > 200)) throw new McpError('INVALID_CURSOR');
    return { id: data.id, at: data.at, ...(data.ref ? { ref: data.ref } : {}) };
  }

  sourceId(row, auth) {
    return this.tokens.criar('src', { id: row._id, hash: row._hash, scope: auth.digest, offset: row.excerpt_start || 0 }, null);
  }

  async finalizar(auth, context, query, result, agora) {
    await Promise.resolve();
    const atual = await this.autenticar(context);
    if (atual.digest !== auth.digest) throw new McpError('SCOPE_REVOKED');
    for (const row of result.rows) {
      if (!this.read.revalidar(row, auth.scope)) throw new McpError('SOURCE_CHANGED');
    }
    const sources = new Map();
    const items = result.rows.map(row => {
      const { _id, _hash, _kind, _ref, _integrity, _cursor_ref, excerpt, ...item } = row;
      const key = `${_id}:${_hash}:${row.excerpt_start || 0}`;
      if (!sources.has(key)) sources.set(key, this.sourceId(row, auth));
      return { ...item, source_ids: [sources.get(key)] };
    });
    const last = result.rows.at(-1);
    const next = result.more && last ? this.tokens.criar('cur', { id: last._id, at: last.occurred_at, ...(last._cursor_ref ? { ref: last._cursor_ref } : {}), scope: auth.digest, query: digest(query) }, CURSOR_TTL) : null;
    const warnings = items.length ? [] : ['Nenhum resultado permitido neste recorte.'];
    if (result.rows.some(row => row.excerpt_truncated)) warnings.push('Há fontes longas: os trechos são parciais e podem omitir mudanças ou condições. Confira a mensagem completa no Lume antes de decidir.');
    return respostaBase(agora, items, next, warnings);
  }

  async executar(nome, input = {}, context = {}) {
    try {
      if (this.execucoes && EXECUCAO_TOOL_DEFINITIONS.some(tool => tool.name === nome)) {
        const auth = await this.autenticar(context);
        // A segunda leitura ocorre antes da transação: revogação durante a
        // autenticação nunca deixa uma escrita órfã no histórico.
        const atual = await this.autenticar(context);
        if (auth.digest !== atual.digest) throw new McpError('SCOPE_REVOKED');
        return executarExecucao(this.execucoes, nome, input, atual, row => this.tokens.criar('src', {
          id: row._id, hash: row._hash, scope: atual.digest, offset: row.excerpt_start || 0, execucao: input.execucao_id
        }, null));
      }
      if (!MCP_TOOL_DEFINITIONS.some(tool => tool.name === nome)) throw new McpError('UNKNOWN_TOOL');
      if (!validarEntrada(nome, input)) throw new McpError('INVALID_INPUT');
      const auth = await this.autenticar(context), now = this.agora();
      if (nome === 'lume_abrir_fonte') return await this.abrirFonte(input, context, auth, now);
      let query, result;
      if (nome === 'lume_resumo_do_dia') {
        query = { name: nome, date: input.date || diaLocal(now), timezone: input.timezone || 'America/Sao_Paulo', limit: limite(input) };
        result = this.read.fontes({ scope: auth.scope, date: query.date, cursor: this.cursor(input.cursor, auth, query), limit: query.limit });
      } else if (nome === 'lume_buscar_contexto') {
        if (!input.question.trim()) throw new McpError('INVALID_INPUT');
        const range = periodo(input, now);
        query = { name: nome, question: input.question.trim(), ...range, projectNames: input.project_names || [], conversationNames: input.conversation_names || [], limit: limite(input) };
        result = this.read.fontes({ scope: auth.scope, ...range, question: query.question, projectNames: query.projectNames, conversationNames: query.conversationNames, cursor: this.cursor(input.cursor, auth, query), limit: query.limit });
      } else if (nome === 'lume_listar_pendencias') {
        const range = periodo(input, now);
        query = { name: nome, state: input.state || 'aberto', ...range, limit: limite(input) };
        result = this.read.pendencias({ scope: auth.scope, state: query.state, ...range, cursor: this.cursor(input.cursor, auth, query), limit: query.limit });
      } else {
        query = { name: nome, stage: input.stage || '', nextContactBefore: input.next_contact_before || '', limit: limite(input) };
        result = this.read.negocios({ scope: auth.scope, stage: query.stage, nextContactBefore: query.nextContactBefore, cursor: this.cursor(input.cursor, auth, query), limit: query.limit });
      }
      return await this.finalizar(auth, context, query, result, now);
    } catch (error) { return respostaErro(error); }
  }

  async abrirFonte(input, context, auth, now) {
    const token = this.tokens.abrir(input.source_id, 'src', 'SOURCE_CHANGED');
    if (token.scope !== auth.digest || !Number.isSafeInteger(token.id) || typeof token.hash !== 'string') throw new McpError('SOURCE_CHANGED');
    const lerFonte = () => {
      if (token.execucao === undefined) return this.read.fonte(token.id, auth.scope, { offset: token.offset || 0 });
      try {
        // A task token can resolve only the exact source excerpt authorized for
        // that execution. It never widens generic search or source pagination.
        const fonte = this.execucoes?.fonteAutorizada(token.execucao, { clientId: auth.clientId, scope: auth.scope, revision: auth.revision });
        if (!fonte || fonte._id !== token.id || fonte._hash !== token.hash || (fonte.excerpt_start || 0) !== (token.offset || 0)) throw new Error('source');
        return fonte;
      } catch { throw new McpError('SOURCE_CHANGED'); }
    };
    if (token.offset !== undefined && (!Number.isSafeInteger(token.offset) || token.offset < 0)) throw new McpError('SOURCE_CHANGED');
    let row = lerFonte();
    if (!row || row._hash !== token.hash) throw new McpError('SOURCE_CHANGED');
    await Promise.resolve();
    const atual = await this.autenticar(context);
    if (atual.digest !== auth.digest) throw new McpError('SCOPE_REVOKED');
    row = lerFonte();
    if (!row || row._hash !== token.hash) throw new McpError('SOURCE_CHANGED');
    return { ok: true, scope: { policy: 'current-local-policy', generated_at: now.toISOString() }, source: { source_id: input.source_id, excerpt: row.excerpt, excerpt_start: row.excerpt_start, excerpt_truncated: row.excerpt_truncated, author: row.author, conversation: row.conversation, occurred_at: row.occurred_at }, warnings: row.excerpt_truncated ? ['Trecho parcial de uma fonte longa. Confira a mensagem completa no Lume antes de decidir.'] : [] };
  }
}

export function createLumeMcpCore(options) { return new LumeMcpCore(options); }

export { MCP_TOOL_DEFINITIONS } from './schemas.js';

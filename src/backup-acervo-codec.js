import { createHash } from 'node:crypto';

const MAGIC_V9 = Buffer.from('LUMEAC09');
const MAGIC_V10 = Buffer.from('LUMEAC10');
const MiB = 1024 * 1024;
const MAX_HEADER = 4096;
const MAX_BUFFER = 4 * MiB;
const MAX_TOTAL = 16 * 1024 * MiB;
const MAX_ROWS = 0xffffffff;
const MAX_TABLES = 1024;
const MAX_FILES = 1000000;
const MAX_CHUNKS = 16777216;
const fields = {
  inicio: ['tipo', 'versao', 'catalogoSha256', 'criadoEm', 'dono'],
  tabela: ['tipo', 'indice', 'nome'], row: ['tipo', 'chave'],
  fimTabela: ['tipo', 'linhas', 'sha256'],
  arquivo: ['tipo', 'id', 'classe', 'bytes', 'sha256', 'nome'],
  chunk: ['tipo', 'id', 'indice', 'offset'],
  fimArquivo: ['tipo', 'id', 'bytes', 'sha256'],
  fim: ['tipo', 'tabelas', 'linhas', 'arquivos', 'chunks', 'bytesArquivos', 'bytesAnteriores', 'sha256'],
};
const utf8 = new TextDecoder('utf-8', { fatal: true });

function fail(message) { throw new Error(`Acervo v9: ${message}`); }
function abort(signal) { if (signal?.aborted) { const e = new Error('Operação abortada'); e.name = 'AbortError'; throw e; } }
function nat(n, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(n) || n < 0 || n > max) fail('inteiro inválido ou limite excedido'); }
function hash(s) { if (typeof s !== 'string' || !/^[0-9a-f]{64}$/.test(s)) fail('SHA-256 inválido'); }
function str(s, maxBytes = 512, allowEmpty = false) {
  if (typeof s !== 'string' || (!allowEmpty && !s) || s.includes('\0') || Buffer.byteLength(s, 'utf8') > maxBytes ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)) fail('texto inválido');
}
function ownDescriptors(value, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} inválido`);
  return Object.getOwnPropertyDescriptors(value);
}
function snapshotFields(descriptors, keys, label) {
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k))) fail(`${label}: campos ausentes ou extras`);
  const entries = keys.map(k => {
    const descriptor = descriptors[k];
    if (!Object.hasOwn(descriptor, 'value')) fail(`${label}: acessor inválido`);
    return [k, descriptor.value];
  });
  return Object.freeze(Object.fromEntries(entries));
}
function canonical(header) {
  const descriptors = ownDescriptors(header, 'cabeçalho');
  const type = descriptors.tipo;
  if (!type || !Object.hasOwn(type, 'value')) fail('cabeçalho: acessor de tipo inválido');
  if (typeof type.value !== 'string' || !Object.hasOwn(fields, type.value)) fail('tipo inválido');
  const ordered = snapshotFields(descriptors, fields[type.value], 'cabeçalho');
  if (Object.values(ordered).some(v => typeof v !== 'string' && typeof v !== 'number')) fail('campo de cabeçalho inválido');
  const encoded = Buffer.from(JSON.stringify(ordered), 'utf8');
  if (encoded.length < 1 || encoded.length > MAX_HEADER) fail('cabeçalho grande');
  return { header: ordered, encoded };
}
function eqUtf8Order(a, b) { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }
function u32(n) { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n); return b; }

class State {
  constructor(version = 9) {
    this.version = version;
    this.phase = 'inicio'; this.global = createHash('sha256'); this.before = 0;
    this.tables = 0; this.rows = 0; this.files = 0; this.chunks = 0; this.bytesFiles = 0;
    this.lastKey = null; this.rowCount = 0;
    this.fileBytes = 0; this.fileChunks = 0; this.expectedFile = null;
  }
  update(parts) { for (const p of parts) { this.before += p.length; if (this.before > MAX_TOTAL) fail('total excedido'); this.global.update(p); } }
  finishHeader() { return { tipo: 'fim', tabelas: this.tables, linhas: this.rows, arquivos: this.files,
    chunks: this.chunks, bytesArquivos: this.bytesFiles, bytesAnteriores: this.before,
    sha256: this.global.copy().digest('hex') }; }
  accept(h, payload) {
    if (!Buffer.isBuffer(payload) || payload.length > MAX_BUFFER) fail('payload inválido');
    if (h.tipo === 'row') { if (!payload.length || payload.length > MAX_BUFFER) fail('row inválida'); }
    else if (h.tipo === 'chunk') { if (!payload.length || payload.length > MiB) fail('chunk inválido'); }
    else if (payload.length) fail('payload inesperado');
    switch (h.tipo) {
      case 'inicio':
        if (this.phase !== 'inicio' || h.versao !== this.version) fail('início ou versão inválida');
        hash(h.catalogoSha256); str(h.dono, 320, true);
        if ([...h.dono].length > 80 || typeof h.criadoEm !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(h.criadoEm) ||
          Number.isNaN(Date.parse(h.criadoEm)) || new Date(h.criadoEm).toISOString() !== h.criadoEm) fail('metadados iniciais inválidos');
        this.phase = 'tabelas'; break;
      case 'tabela':
        if (this.phase !== 'tabelas') fail('tabela fora de ordem');
        str(h.nome, 256); nat(h.indice, MAX_TABLES - 1);
        if (h.indice !== this.tables) fail('índice de tabela fora de ordem');
        this.tables++; nat(this.tables, MAX_TABLES); this.lastKey = null;
        this.rowCount = 0; this.rowHash = createHash('sha256'); this.phase = 'rows'; break;
      case 'row':
        if (this.phase !== 'rows') fail('row fora de tabela');
        str(h.chave); if (this.lastKey !== null && eqUtf8Order(h.chave, this.lastKey) <= 0) fail('chave duplicada ou fora de ordem');
        this.lastKey = h.chave; this.rows++; this.rowCount++; nat(this.rows, MAX_ROWS); nat(this.rowCount, MAX_ROWS);
        this.rowHash.update(u32(payload.length)).update(payload); break;
      case 'fimTabela':
        if (this.phase !== 'rows') fail('fimTabela fora de ordem');
        nat(h.linhas, MAX_ROWS); hash(h.sha256);
        if (h.linhas !== this.rowCount || h.sha256 !== this.rowHash.digest('hex')) fail('contagem/hash de tabela');
        this.phase = 'tabelas'; this.rowHash = null; break;
      case 'arquivo':
        if (this.phase !== 'tabelas' && this.phase !== 'arquivos') fail('arquivo fora de ordem');
        nat(h.id, MAX_FILES); nat(h.bytes, MAX_TOTAL); hash(h.sha256); str(h.nome, 256);
        if (h.id !== this.files + 1 || !['transcricao', 'notetaker'].includes(h.classe) &&
          !(this.version === 10 && h.classe === 'ciclo_midia')) fail('ID/classe de arquivo');
        this.files++; nat(this.files, MAX_FILES); this.expectedFile = h; this.fileBytes = 0; this.fileChunks = 0;
        this.fileHash = createHash('sha256'); this.phase = 'chunks'; break;
      case 'chunk':
        if (this.phase !== 'chunks') fail('chunk fora de arquivo');
        nat(h.id, MAX_FILES); nat(h.indice, MAX_CHUNKS); nat(h.offset, MAX_TOTAL);
        if (h.id !== this.files || h.indice !== this.fileChunks || h.offset !== this.fileBytes) fail('índice/offset de chunk');
        this.fileBytes += payload.length; this.bytesFiles += payload.length; this.fileChunks++; this.chunks++;
        nat(this.fileBytes, this.expectedFile.bytes); nat(this.bytesFiles, MAX_TOTAL); nat(this.chunks, MAX_CHUNKS);
        this.fileHash.update(payload); break;
      case 'fimArquivo':
        if (this.phase !== 'chunks') fail('fimArquivo fora de ordem');
        nat(h.id, MAX_FILES); nat(h.bytes, MAX_TOTAL); hash(h.sha256);
        if (h.id !== this.files || h.bytes !== this.fileBytes || h.bytes !== this.expectedFile.bytes ||
          h.sha256 !== this.expectedFile.sha256 || h.sha256 !== this.fileHash.digest('hex')) fail('contagem/hash de arquivo');
        this.expectedFile = null; this.fileHash = null; this.phase = 'arquivos'; break;
      case 'fim': {
        if (this.phase !== 'tabelas' && this.phase !== 'arquivos') fail('fim fora de ordem');
        const expected = this.finishHeader();
        for (const k of fields.fim.slice(1)) { if (k === 'sha256') hash(h[k]); else nat(h[k], k === 'bytesAnteriores' || k === 'bytesArquivos' ? MAX_TOTAL : Number.MAX_SAFE_INTEGER);
          if (h[k] !== expected[k]) fail(`fim: ${k} diverge`); }
        this.phase = 'done'; break;
      }
      default: fail('tipo desconhecido');
    }
  }
}

function frameParts(encoded, payload) {
  // Um prefixo por quadro reduz as emissões assíncronas sem mudar os bytes.
  // O payload continua separado e já copiado pelo encoder antes do primeiro yield.
  const prefix = Buffer.allocUnsafe(8 + encoded.length);
  prefix.writeUInt32BE(encoded.length, 0);
  encoded.copy(prefix, 4);
  prefix.writeUInt32BE(payload.length, 4 + encoded.length);
  return [prefix, payload];
}

async function* codificarAcervo(quadros, { signal, version = 9 } = {}) {
  abort(signal);
  const state = new State(version); const magic = Buffer.from(version === 10 ? MAGIC_V10 : MAGIC_V9); state.update([magic]); yield magic;
  for await (const frame of quadros) {
    abort(signal);
    const { cabecalho, payload } = snapshotFields(ownDescriptors(frame, 'quadro'), ['cabecalho', 'payload'], 'quadro');
    const { header, encoded } = canonical(cabecalho);
    if (header.tipo === 'fim') fail('fim é gerado pelo codec');
    if (!Buffer.isBuffer(payload) || payload.length > MAX_BUFFER) fail('payload inválido');
    const ownedPayload = Buffer.from(payload);
    const parts = frameParts(encoded, ownedPayload);
    state.accept(header, ownedPayload);
    state.update(parts);
    for (const part of parts) { abort(signal); if (part.length) yield part; }
  }
  abort(signal);
  const { header: end, encoded } = canonical(state.finishHeader());
  const empty = Buffer.alloc(0);
  const parts = frameParts(encoded, empty); state.accept(end, empty);
  if (state.before + parts.reduce((n, p) => n + p.length, 0) > MAX_TOTAL) fail('total excedido');
  for (const part of parts) { abort(signal); if (part.length) yield part; }
}

class Reader {
  constructor(origin, signal) { this.it = origin[Symbol.asyncIterator](); this.signal = signal; this.buf = Buffer.alloc(0); this.pos = 0; this.bytes = 0; }
  async read(n) {
    nat(n, MAX_BUFFER); const out = Buffer.allocUnsafe(n); let at = 0;
    while (at < n) {
      abort(this.signal);
      if (this.pos === this.buf.length) {
        const next = await this.it.next(); abort(this.signal);
        if (next.done) fail('truncagem');
        if (!Buffer.isBuffer(next.value) || !next.value.length || next.value.length > MAX_BUFFER) fail('buffer de origem inválido');
        this.buf = next.value; this.pos = 0; continue;
      }
      const take = Math.min(n - at, this.buf.length - this.pos);
      this.buf.copy(out, at, this.pos, this.pos + take); this.pos += take; at += take;
      this.bytes += take; if (this.bytes > MAX_TOTAL) fail('total excedido');
    }
    return out;
  }
  async eof() {
    if (this.pos < this.buf.length) fail('bytes após fim');
    while (true) { abort(this.signal); const n = await this.it.next(); abort(this.signal);
      if (n.done) return; fail('buffer após fim'); }
  }
  async close() { if (typeof this.it.return === 'function') await this.it.return(); }
}

async function* decodificarAcervo(origem, { signal, version = 9 } = {}) {
  const reader = new Reader(origem, signal); const state = new State(version);
  try {
    abort(signal);
    const magic = await reader.read(8); if (!magic.equals(version === 10 ? MAGIC_V10 : MAGIC_V9)) fail('magic inválido'); state.update([magic]);
    while (true) {
      abort(signal);
      const hlen = await reader.read(4); const size = hlen.readUInt32BE(0);
      if (!size || size > MAX_HEADER) fail('comprimento de cabeçalho inválido');
      const hbytes = await reader.read(size);
      let h; try { h = JSON.parse(utf8.decode(hbytes)); } catch { fail('JSON/UTF-8 inválido'); }
      const parsed = canonical(h);
      if (!parsed.encoded.equals(hbytes)) fail('JSON não canônico');
      h = parsed.header;
      const plen = await reader.read(4); const length = plen.readUInt32BE(0);
      const max = h.tipo === 'chunk' ? MiB : h.tipo === 'row' ? MAX_BUFFER : 0;
      if (length > max) fail('comprimento de payload inválido');
      const payload = await reader.read(length);
      state.accept(h, payload);
      if (h.tipo === 'fim') { await reader.eof(); yield { cabecalho: h, payload }; return; }
      state.update([hlen, hbytes, plen, payload]);
      yield { cabecalho: h, payload };
    }
  } finally { await reader.close(); }
}

export async function* codificarAcervoV9(quadros, options = {}) { yield* codificarAcervo(quadros, {...options, version:9}); }
export async function* decodificarAcervoV9(origem, options = {}) { yield* decodificarAcervo(origem, {...options, version:9}); }
export async function* codificarAcervoV10(quadros, options = {}) { yield* codificarAcervo(quadros, {...options, version:10}); }
export async function* decodificarAcervoV10(origem, options = {}) { yield* decodificarAcervo(origem, {...options, version:10}); }

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CATALOGO_V9, TABELAS_I_V9, CATALOGO_SHA256_V9 } from '../src/backup-acervo-catalogo.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { decodificarAcervoV9 } from '../src/backup-acervo-codec.js';
import { gravarPacote, verificarPacote } from '../src/backup-stream.js';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';

const ident = s => `"${s.replaceAll('"', '""')}"`;
async function fileHash(file) { const hash = createHash('sha256'); for await (const b of createReadStream(file)) hash.update(b); return hash.digest('hex'); }
function untyped(v) {
  if (v[0] === 'n') return null;
  if (v[0] === 'i') return BigInt(v[1]);
  if (v[0] === 'r' || v[0] === 't') return v[1];
  if (v[0] === 'b') return Buffer.from(v[1], 'base64');
  throw new Error('Tipo de row inesperado');
}
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lume-v9-fixture-'));
  const dbPath = path.join(dir, 'fonte.sqlite');
  const db = new DatabaseSync(dbPath);
  for (const t of TABELAS_I_V9) db.exec(`CREATE TABLE ${ident(t.nome)} (${t.colunas.map(ident).join(',')}, PRIMARY KEY (${t.pk.map(ident).join(',')}))`);
  return { dir, dbPath, db, async close() { try { db.close(); } catch {} await rm(dir, { recursive: true, force: true }); } };
}

test('catálogo I/X/G compilado, com PK e colunas explícitas', () => {
  // 03B2 adiciona histórico local como G: backup deve recusar linhas, sem omiti-las.
  assert.equal(CATALOGO_V9.length, 87);
  assert.deepEqual(CATALOGO_V9.reduce((a, t) => (a[t.decisao]++, a), { I: 0, X: 0, G: 0 }), { I: 53, X: 26, G: 8 });
  assert.deepEqual(CATALOGO_V9.find(t => t.nome === 'eventos').colunas.slice(0, 4), ['id', 'conversa_id', 'origem_id', 'direcao']);
  assert.deepEqual(CATALOGO_V9.find(t => t.nome === 'f10_procedencias').pk, ['evento_id', 'fingerprint', 'pacote_id', 'projeto_id']);
  assert.equal(CATALOGO_V9.find(t => t.nome === 'lume_execucao_contexto_grants').decisao, 'X');
  assert.equal(CATALOGO_V9.find(t => t.nome === 'notetaker_correcoes').decisao, 'G');
  assert.match(CATALOGO_SHA256_V9, /^[0-9a-f]{64}$/);
});

test('perfil rejeita accessor sem executar getter', async () => {
  const f = await fixture();
  try {
    f.db.close();
    let reads = 0;
    const perfil = {};
    Object.defineProperty(perfil, 'dono', { enumerable: true, get() { reads++; return ''; } });
    await assert.rejects(criarOrigemV9({ dbPath: f.dbPath, perfil }), { code: 'PERFIL_INVALIDO' });
    assert.equal(reads, 0);
  } finally { await f.close(); }
});

test('origem mínima gera quadros v9 sem modificar a fonte', async () => {
  const f = await fixture();
  try {
    f.db.close();
    const source = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } });
    const parts = [];
    for await (const b of source.origem) parts.push(b);
    assert.equal(Buffer.concat(parts).subarray(0, 8).toString(), 'LUMEAC09');
    await source.fechar();
    const db = new DatabaseSync(f.dbPath, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 53);
    db.close();
  } finally { await f.close(); }
});

test('perfis novo e legado dos construtores reais projetam o mesmo payload na ordem do catálogo', async () => {
  const payloads = [];
  for (const legado of [false, true]) {
    const f = await criarPerfilRealSintetico({ legado });
    try {
      const physical = f.db.prepare('PRAGMA table_info(eventos)').all().map(c => c.name);
      const last = physical.slice(-2);
      assert.deepEqual(last, legado ? ['permissao', 'origem_compartilhamento'] : ['origem_compartilhamento', 'permissao']);
      f.db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao,origem_compartilhamento)
        VALUES(1,'conversa-sintetica','origem-sintetica','entrada','texto','bruto-sintetico','2026-09-27T12:00:00.000Z','2026-09-27','minha','pacote-sintetico')`).run();
      f.db.close();
      const before = await fileHash(f.dbPath);
      const source = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } });
      let current = '';
      let payload;
      for await (const q of decodificarAcervoV9(source.origem)) {
        if (q.cabecalho.tipo === 'tabela') current = q.cabecalho.nome;
        if (current === 'eventos' && q.cabecalho.tipo === 'row') {
          assert.equal(q.cabecalho.chave.slice(0, 11), '0000000001:');
          assert.equal(payload, undefined);
          payload = q.payload;
        }
      }
      assert.ok(payload, 'evento sintético presente no fluxo');
      assert.equal(await fileHash(f.dbPath), before, 'fonte intacta');
      payloads.push(payload);
    } finally { await f.close(); }
  }
  assert.deepEqual(payloads[0], payloads[1], 'ordem física não altera payload canônico');
  const cols = CATALOGO_V9.find(t => t.nome === 'eventos').colunas;
  const values = JSON.parse(payloads[0].toString()).v;
  assert.deepEqual(values[cols.indexOf('id')], ['i', '1']);
  assert.deepEqual(values[cols.indexOf('permissao')], ['t', 'minha']);
  assert.deepEqual(values[cols.indexOf('origem_compartilhamento')], ['t', 'pacote-sintetico']);
});

test('transcrição sem arquivo preserva metadata JSON e string vazia', async () => {
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO transcricoes(id,arquivo,audio_metadados_json) VALUES(?,?,?)').run(1, '', '{"origem":"teste"}');
    f.db.close();
    const source = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } });
    async function* bytes() { for await (const b of source.origem) yield b; }
    let current = ''; let found = false;
    for await (const q of decodificarAcervoV9(bytes())) {
      if (q.cabecalho.tipo === 'tabela') current = q.cabecalho.nome;
      if (current === 'transcricoes' && q.cabecalho.tipo === 'row') {
        const values = JSON.parse(q.payload.toString()).v;
        const cols = CATALOGO_V9.find(t => t.nome === 'transcricoes').colunas;
        assert.deepEqual(values[cols.indexOf('arquivo')], ['t', '']);
        assert.deepEqual(values[cols.indexOf('audio_metadados_json')], ['t', '{"origem":"teste"}']);
        found = true;
      }
    }
    assert.equal(found, true);
  } finally { await f.close(); }
});

test('recusa extras, ausências, PK divergente e tabela G povoada', async () => {
  for (const [change, code] of [
    [db => db.exec('ALTER TABLE eventos ADD COLUMN extra TEXT'), 'SCHEMA_NAO_MAPEADO'],
    [db => db.exec('ALTER TABLE eventos DROP COLUMN permissao'), 'SCHEMA_NAO_MAPEADO'],
    [db => db.exec('DROP TABLE eventos'), 'SCHEMA_INCOMPLETO'],
    [db => {
      const t = CATALOGO_V9.find(row => row.nome === 'eventos');
      db.exec('DROP TABLE eventos');
      db.exec(`CREATE TABLE eventos (${t.colunas.map(ident).join(',')}, PRIMARY KEY (origem_id))`);
    }, 'PK_DIVERGENTE'],
    [db => {
      const g = CATALOGO_V9.find(t => t.nome === 'projetos');
      db.exec(`CREATE TABLE projetos (${g.colunas.map(ident).join(',')})`);
      db.prepare('INSERT INTO projetos(id) VALUES(?)').run('p');
    }, 'TABELA_G_POVOADA'],
    [db => {
      const g = CATALOGO_V9.find(t => t.nome === 'projetos');
      db.exec(`CREATE TABLE projetos (${g.colunas.slice(0, -1).map(ident).join(',')})`);
    }, 'SCHEMA_NAO_MAPEADO'],
    [db => db.exec('CREATE TABLE tabela_nova(id TEXT)'), 'SCHEMA_NAO_MAPEADO'],
    [db => db.exec('CREATE TABLE desktop_fontes_fts_data(id TEXT)'), 'SCHEMA_NAO_MAPEADO'],
  ]) {
    const f = await fixture();
    try {
      change(f.db); f.db.close();
      await assert.rejects(criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } }), { code });
    } finally { await f.close(); }
  }
});

test('recusa anexo presente e lista sem prova de lock', async () => {
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO transcricoes(id,arquivo) VALUES(?,?)').run(1, 'audio.opus');
    f.db.close();
    await assert.rejects(criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } }), { code: 'ANEXOS_SEM_LOCK' });
    await assert.rejects(criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' }, arquivos: ['audio.opus'] }), { code: 'ANEXOS_SEM_LOCK' });
  } finally { await f.close(); }
});

test('row acima de 4 MiB falha e fecha origem', async () => {
  const f = await fixture();
  try {
    f.db.prepare('INSERT INTO eventos(id,bruto) VALUES(?,?)').run(1, Buffer.alloc(4 * 1024 * 1024));
    f.db.close();
    const source = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } });
    await assert.rejects(async () => { for await (const _ of source.origem) {} }, { code: 'ROW_MAIOR_4MIB' });
    await source.fechar();
  } finally { await f.close(); }
});

test('cancelamento e retorno antecipado fecham a origem', async () => {
  const f = await fixture();
  try {
    f.db.close();
    const signal = new AbortController();
    const source = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' }, signal: signal.signal });
    const it = source.origem[Symbol.asyncIterator]();
    assert.equal((await it.next()).value.toString(), 'LUMEAC09');
    signal.abort();
    await assert.rejects(it.next(), /cancel|abort/i);
    await source.fechar();
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    const second = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } });
    for await (const _ of second.origem) break;
    await second.fechar();
  } finally { await f.close(); }
});

test('250001 rows passam por pacote cifrado e staging sintético incremental', { timeout: 180000 }, async () => {
  const perf = process.env.LUME_BACKUP_V9_PERF === '1';
  let markAt = process.hrtime.bigint();
  let cpuAt = process.cpuUsage();
  const mark = label => {
    if (!perf) return;
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(cpuAt);
    const usage = process.resourceUsage();
    console.log(`PERF ${label}: wall=${(Number(now - markAt) / 1e9).toFixed(3)}s cpu=${((cpu.user + cpu.system) / 1e6).toFixed(3)}s rss=${(process.memoryUsage().rss / 1048576).toFixed(1)}MiB fsRead=${usage.fsRead} fsWrite=${usage.fsWrite}`);
    markAt = now; cpuAt = process.cpuUsage();
  };
  const f = await fixture();
  let stage;
  try {
    const insert = f.db.prepare('INSERT INTO eventos(id,conversa_id,bruto,texto,do_proprio_bot) VALUES(?,?,?,?,?)');
    f.db.exec('BEGIN');
    for (let i = 1; i <= 250001; i++) insert.run(BigInt(i), 'c', i === 1 ? Buffer.from([0, 1, 255]) : `bruto ${i}`, `linha ${i} á`, BigInt(i % 2));
    f.db.exec('COMMIT');
    f.db.prepare('INSERT INTO transcricoes(id,arquivo,duracao_ms,audio_metadados_json) VALUES(?,?,?,?)').run(1, '', 1.25, '{"origem":"teste"}');
    const grant = CATALOGO_V9.find(t => t.nome === 'lume_execucao_contexto_grants');
    f.db.exec(`CREATE TABLE ${ident(grant.nome)} (${grant.colunas.map(ident).join(',')})`);
    f.db.prepare('INSERT INTO lume_execucao_contexto_grants(execucao_id) VALUES(?)').run('grant-local');
    f.db.close();
    mark('fixture');
    const beforeHash = await fileHash(f.dbPath);
    const before = process.memoryUsage().rss; let peak = before;
    const source = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: '' } });
    mark('snapshot+schema');
    async function* measuredOrigin() { for await (const b of source.origem) { peak = Math.max(peak, process.memoryUsage().rss); yield b; } }
    const pacote = path.join(f.dir, 'acervo.lumebak');
    await gravarPacote({ origem: measuredOrigin(), destino: pacote, senha: 'senha sintética do teste' });
    mark('encode+encrypt+write');
    await source.fechar();
    const stagingDir = path.join(f.dir, 'staging'); await mkdir(stagingDir);
    const verified = await verificarPacote({ pacote, pastaStaging: stagingDir, senha: 'senha sintética do teste' });
    mark('verify+decrypt+write');
    stage = new DatabaseSync(path.join(f.dir, 'reconstruido.sqlite'));
    stage.exec('CREATE TABLE eventos(id INTEGER PRIMARY KEY, bruto, texto, do_proprio_bot)');
    const store = stage.prepare('INSERT INTO eventos(id,bruto,texto,do_proprio_bot) VALUES(?,?,?,?)');
    const cols = CATALOGO_V9.find(t => t.nome === 'eventos').colunas;
    const index = Object.fromEntries(['id', 'bruto', 'texto', 'do_proprio_bot'].map(k => [k, cols.indexOf(k)]));
    let current = ''; let rows = 0; let transcricoes = 0; let tables = 0; let ended = false;
    stage.exec('BEGIN');
    for await (const q of decodificarAcervoV9(createReadStream(verified.caminhoStaging))) {
      peak = Math.max(peak, process.memoryUsage().rss);
      if (q.cabecalho.tipo === 'inicio') assert.equal(q.cabecalho.catalogoSha256, CATALOGO_SHA256_V9);
      if (q.cabecalho.tipo === 'tabela') { current = q.cabecalho.nome; assert.notEqual(current, grant.nome); tables++; }
      if (q.cabecalho.tipo === 'row' && current === 'eventos') {
        const values = JSON.parse(q.payload.toString()).v;
        const id = untyped(values[index.id]); rows++;
        assert.equal(id, BigInt(rows));
        const bruto = untyped(values[index.bruto]);
        if (rows === 1) assert.deepEqual(bruto, Buffer.from([0, 1, 255]));
        else assert.equal(bruto, `bruto ${rows}`);
        const texto = untyped(values[index.texto]); assert.equal(texto, `linha ${rows} á`);
        const bot = untyped(values[index.do_proprio_bot]); assert.equal(bot, BigInt(rows % 2));
        assert.equal(q.cabecalho.chave.slice(0, 11), `${String(rows).padStart(10, '0')}:`);
        if (rows === 1 || rows === 250001) {
          assert.equal(q.cabecalho.chave.slice(11), createHash('sha256').update(JSON.stringify([['i', id.toString()]])).digest('hex'));
        }
        store.run(id, bruto, texto, bot);
      }
      if (q.cabecalho.tipo === 'row' && current === 'transcricoes') {
        const values = JSON.parse(q.payload.toString()).v;
        const tcols = CATALOGO_V9.find(t => t.nome === 'transcricoes').colunas;
        assert.deepEqual(values[tcols.indexOf('duracao_ms')], ['r', 1.25]);
        transcricoes++;
      }
      if (q.cabecalho.tipo === 'fim') { assert.equal(q.cabecalho.linhas, 250002); ended = true; }
    }
    stage.exec('COMMIT');
    mark('decode+stage');
    assert.equal(tables, TABELAS_I_V9.length); assert.equal(rows, 250001); assert.equal(transcricoes, 1); assert.equal(ended, true);
    assert.equal(stage.prepare('SELECT COUNT(*) n FROM eventos').get().n, 250001);
    assert.equal(stage.prepare('SELECT texto FROM eventos WHERE id=250001').get().texto, 'linha 250001 á');
    assert.deepEqual({ ...stage.prepare('SELECT typeof(id) id,typeof(bruto) bruto,typeof(texto) texto,typeof(do_proprio_bot) bot FROM eventos WHERE id=1').get() },
      { id: 'integer', bruto: 'blob', texto: 'text', bot: 'integer' });
    assert.equal(await fileHash(f.dbPath), beforeHash);
    console.log(`RSS local origem+staging: inicial ${(before/1048576).toFixed(1)} MiB; pico ${(peak/1048576).toFixed(1)} MiB; adicional ${((peak-before)/1048576).toFixed(1)} MiB`);
    assert.ok(peak - before < 512 * 1024 * 1024, 'RSS local adicional acima de 512 MiB');
  } finally { stage?.close(); await f.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { abrirOraculoStagingV9 } from './fixtures/backup-restore-oraculo.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { codificarAcervoV9, decodificarAcervoV9 } from '../src/backup-acervo-codec.js';
import { gravarPacote, verificarPacote } from '../src/backup-stream.js';
import { TABELAS_I_V9 } from '../src/backup-acervo-catalogo.js';
import { validarAcervoV9, descartarPlanoV9 } from '../src/backup-acervo-restore-v9.js';

const senha = 'senha sintética de validação';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function perfilComEventos(total = 1, financeiro = false) {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'original.lumebak');
  try {
    const insert = f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c',?,'entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha')`);
    f.db.exec('BEGIN');
    for (let i = 0; i < total; i++) insert.run(`origem-${i}`);
    if (financeiro) f.db.prepare(`INSERT INTO eventos_financeiros
      (conversa_id,origem_id,tipo,cliente_nome,valor,moeda,status,detalhes,extraido_em)
      VALUES('c','origem-0','proposta','Cliente',1.25,'BRL','pendente','Detalhe','2026-09-27T12:00:00.000Z')`).run();
    f.db.exec('COMMIT');
    f.db.close();
    await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Pessoa fictícia' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    return { ...f, raizStaging, pacote };
  } catch (error) { await f.close(); throw error; }
}

async function quadrosAutenticados(f) {
  const temporary = path.join(f.dir, 'decifrado');
  await mkdir(temporary);
  try {
    const verified = await verificarPacote({ pacote: f.pacote, pastaStaging: temporary, senha });
    const frames = [];
    for await (const frame of decodificarAcervoV9(createReadStream(verified.caminhoStaging))) {
      if (frame.cabecalho.tipo !== 'fim') frames.push(frame);
    }
    return frames;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function pacoteMutado(f, frames, index, change, table = 'eventos') {
  const copy = frames.map(frame => ({ cabecalho: { ...frame.cabecalho }, payload: Buffer.from(frame.payload) }));
  const start = copy.findIndex(frame => frame.cabecalho.tipo === 'tabela' && frame.cabecalho.nome === table);
  assert.ok(start >= 0, `tabela ${table} presente`);
  const endIndex = copy.findIndex((frame, at) => at > start && frame.cabecalho.tipo === 'fimTabela');
  const rows = copy.slice(start + 1, endIndex).filter(frame => frame.cabecalho.tipo === 'row');
  const row = rows[0];
  assert.ok(row, 'fixture precisa conter linha');
  const obj = JSON.parse(row.payload.toString('utf8'));
  change(obj, row.cabecalho, index);
  row.payload = Buffer.from(JSON.stringify(obj));
  const tableHash = createHash('sha256');
  for (const item of rows) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(item.payload.length);
    tableHash.update(length).update(item.payload);
  }
  copy[endIndex].cabecalho.sha256 = tableHash.digest('hex');
  const pacote = path.join(f.dir, `mutado-${index}.lumebak`);
  await gravarPacote({ origem: codificarAcervoV9(copy), destino: pacote, senha });
  return pacote;
}

test('payload tipado adulterado passa por AEAD e codec, mas é recusado na fase row', async () => {
  const f = await perfilComEventos();
  try {
    const frames = await quadrosAutenticados(f);
    const cols = TABELAS_I_V9.find(t => t.nome === 'eventos').colunas;
    const at = name => cols.indexOf(name);
    const cases = [
      ['JSON sem v', (o) => { delete o.v; }, 'ROW_INVALIDA'],
      ['JSON com campo extra', (o) => { o.extra = true; }, 'ROW_INVALIDA'],
      ['linha com coluna ausente', (o) => { o.v.pop(); }, 'ROW_INVALIDA'],
      ['linha com coluna extra', (o) => { o.v.push(['n']); }, 'ROW_INVALIDA'],
      ['tag falsa', (o) => { o.v[at('bruto')] = ['z', 'bruto']; }, 'TIPO_INVALIDO'],
      ['int64 abaixo do mínimo', (o) => { o.v[at('id')] = ['i', '-9223372036854775809']; }, 'TIPO_INVALIDO'],
      ['int64 acima do máximo', (o) => { o.v[at('id')] = ['i', '9223372036854775808']; }, 'TIPO_INVALIDO'],
      ['REAL integral no lugar de INTEGER', (o, h) => { o.v[at('id')] = ['r', 1]; h.chave = `0000000001:${digest([o.v[at('id')]])}`; }, 'TIPO_SQL_DIVERGENTE'],
      ['INTEGER em coluna TEXT com afinidade', (o) => { o.v[at('bruto')] = ['i', '12']; }, 'TIPO_SQL_DIVERGENTE'],
      ['base64 inválido', (o) => { o.v[at('texto')] = ['b', '@@@']; }, 'TIPO_INVALIDO'],
      ['base64 não canônico', (o) => { o.v[at('texto')] = ['b', 'Zh==']; }, 'TIPO_INVALIDO'],
      ['NULL na PK', (o) => { o.v[at('id')] = ['n']; }, 'PK_INVALIDA'],
      ['NULL em NOT NULL', (o) => { o.v[at('bruto')] = ['n']; }, 'SQL_INVALIDO'],
      ['hash da PK adulterado', (_o, h) => { h.chave = `0000000001:${'0'.repeat(64)}`; }, 'PK_INVALIDA'],
      ['ordinal da PK adulterado', (_o, h) => { h.chave = h.chave.replace(/^0000000001:/, '0000000002:'); }, 'PK_INVALIDA'],
    ];
    for (const [index, [name, change, code]] of cases.entries()) {
      const pacote = await pacoteMutado(f, frames, index, change);
      await assert.rejects(
        validarAcervoV9({ pacote, senha, raizStaging: f.raizStaging }),
        error => error.code === code && error.fase === 'row',
        name,
      );
      assert.deepEqual(await readdir(f.raizStaging), [], `${name}: staging limpo`);
    }
    const positive = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
    assert.equal(positive.resumo.linhas, 1);
    await descartarPlanoV9(positive.plano);
    assert.deepEqual(await readdir(f.raizStaging), []);
    const blobPackage = await pacoteMutado(f, frames, 'blob-valido', (o) => { o.v[at('texto')] = ['b', Buffer.from('abc').toString('base64')]; });
    const blob = await validarAcervoV9({ pacote: blobPackage, senha, raizStaging: f.raizStaging });
    assert.equal(blob.resumo.linhas, 1);
    const stagingDb = await abrirOraculoStagingV9({ raizStaging: f.raizStaging, raizFixture: f.dir });
    try {
      assert.equal(stagingDb.prepare("SELECT typeof(texto) AS tipo FROM eventos").get().tipo, 'blob');
      assert.ok(Buffer.from(stagingDb.prepare('SELECT texto FROM eventos').get().texto).equals(Buffer.from('abc')));
      assert.equal(stagingDb.prepare("PRAGMA table_info(eventos)").all().find(c => c.name === 'texto').type, 'TEXT');
    } finally { stagingDb.close(); }
    await descartarPlanoV9(blob.plano);
    assert.deepEqual(await readdir(f.raizStaging), []);
    const rejectedBlob = await pacoteMutado(f, frames, 'blob-dominio', (o) => {
      o.v[at('permissao')] = ['b', Buffer.from('minha').toString('base64')];
    });
    await assert.rejects(validarAcervoV9({ pacote: rejectedBlob, senha, raizStaging: f.raizStaging }),
      { code: 'SEMANTICA_INVALIDA', fase: 'eventos' });
    assert.deepEqual(await readdir(f.raizStaging), []);
  } finally { await f.close(); }
});

test('INTEGER em REAL é recusado e REAL integral preserva storage class', async () => {
  const f = await perfilComEventos(1, true);
  try {
    const frames = await quadrosAutenticados(f);
    const cols = TABELAS_I_V9.find(t => t.nome === 'eventos_financeiros').colunas;
    const value = cols.indexOf('valor');
    const rejected = await pacoteMutado(f, frames, 'financeiro-integer', o => { o.v[value] = ['i', '1']; }, 'eventos_financeiros');
    await assert.rejects(validarAcervoV9({ pacote: rejected, senha, raizStaging: f.raizStaging }),
      { code: 'TIPO_SQL_DIVERGENTE', fase: 'row' });
    assert.deepEqual(await readdir(f.raizStaging), []);
    const accepted = await pacoteMutado(f, frames, 'financeiro-real', o => { o.v[value] = ['r', 1]; }, 'eventos_financeiros');
    const plan = await validarAcervoV9({ pacote: accepted, senha, raizStaging: f.raizStaging });
    const db = await abrirOraculoStagingV9({ raizStaging: f.raizStaging, raizFixture: f.dir });
    try {
      assert.deepEqual({ ...db.prepare('SELECT typeof(valor) AS tipo, valor FROM eventos_financeiros').get() }, { tipo: 'real', valor: 1 });
    } finally { db.close(); }
    await descartarPlanoV9(plan.plano);
    assert.deepEqual(await readdir(f.raizStaging), []);
  } finally { await f.close(); }
});

test('timer real aborta após trabalho parcial do cursor semântico e limpa staging', { timeout: 120000 }, async () => {
  const f = await perfilComEventos(2048);
  const controller = new AbortController();
  const originalPrepare = DatabaseSync.prototype.prepare;
  const watched = new WeakSet();
  const sample = new DatabaseSync(':memory:');
  const statementPrototype = Object.getPrototypeOf(sample.prepare('SELECT 1'));
  sample.close();
  const originalIterate = statementPrototype.iterate;
  let reads = 0; let readsAtTimer = 0; let timerFired = false; let timerFiredAt; let timer;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql.startsWith('SELECT id,conversa_id,origem_id,permissao,tipo,projeto_id FROM eventos')) watched.add(statement);
    return statement;
  };
  statementPrototype.iterate = function (...args) {
    const iterator = originalIterate.apply(this, args);
    if (!watched.has(this)) return iterator;
    return {
      next() {
        const result = iterator.next();
        if (!result.done && ++reads === 512) {
          timer = setTimeout(() => { readsAtTimer = reads; timerFiredAt = performance.now(); timerFired = true; controller.abort(); }, 0);
        }
        return result;
      },
      return: value => iterator.return?.(value) ?? { done: true, value },
      [Symbol.iterator]() { return this; },
    };
  };
  try {
    const start = performance.now();
    await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging, signal: controller.signal }),
      { code: 'RESTORE_CANCELADO', fase: 'cancelamento' });
    const elapsed = Math.round(performance.now() - start);
    const responseLatency = Math.round(performance.now() - timerFiredAt);
    assert.equal(timerFired, true, 'event loop executou o timer');
    assert.ok(readsAtTimer >= 512 && readsAtTimer < 2048, `trabalho parcial observado: ${readsAtTimer}`);
    assert.ok(responseLatency < 5000, `resposta após timer: ${responseLatency} ms`);
    assert.deepEqual(await readdir(f.raizStaging), []);
    console.log(`cursor semântico: ${readsAtTimer} linhas antes do timer; ${responseLatency} ms após timer; ${elapsed} ms total`);
  } finally {
    clearTimeout(timer);
    DatabaseSync.prototype.prepare = originalPrepare;
    statementPrototype.iterate = originalIterate;
    await f.close();
  }
});

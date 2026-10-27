import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepararEsquemaRestoreV9, auditarEsquemaRestoreV9 } from '../src/backup-acervo-schema-v9.js';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { prepararNotetaker } from '../src/notetaker/esquema.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';

async function comBanco(alterar) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lume-v9-ddl-'));
  let db;
  try {
    db = prepararEsquemaRestoreV9(path.join(dir, 'staging.sqlite'), dir);
    return await alterar(db);
  } finally {
    db?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('DDL dos construtores reais passa; ordem física legada não altera o contrato', async () => {
  await comBanco(db => assert.equal(auditarEsquemaRestoreV9(db), true));
  const legado = await criarPerfilRealSintetico({ legado: true });
  try {
    const colunas = legado.db.prepare('PRAGMA table_info(eventos)').all().map(row => row.name);
    assert.ok(colunas.indexOf('origem_compartilhamento') > colunas.indexOf('permissao'));
    assert.equal(auditarEsquemaRestoreV9(legado.db), true);
  } finally { await legado.close(); }
});

test('coluna de PK/UNIQUE em outra posição física preserva o contrato lógico', async () => {
  await comBanco(db => {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='pessoa_identificadores'").get().sql;
    const indexSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_pessoa_ident_pessoa'").get().sql;
    const alterado = sql.replace(
      /(\n\s*identificador\s+TEXT PRIMARY KEY,)(\n\s*pessoa_id\s+INTEGER NOT NULL REFERENCES pessoas\(id\),)/,
      '$2$1',
    );
    assert.notEqual(alterado, sql);
    db.exec('PRAGMA foreign_keys=OFF; DROP TABLE pessoa_identificadores');
    db.exec(alterado);
    db.exec(indexSql);
    const colunas = db.prepare('PRAGMA table_info(pessoa_identificadores)').all();
    assert.equal(colunas[0].name, 'pessoa_id');
    assert.equal(colunas[1].name, 'identificador');
    assert.equal(colunas[1].pk, 1);
    const indice = db.prepare('PRAGMA index_xinfo(sqlite_autoindex_pessoa_identificadores_1)').all();
    assert.equal(indice[0].name, 'identificador');
    assert.equal(indice[0].cid, 1);
    assert.equal(auditarEsquemaRestoreV9(db), true);
  });
});

test('FK alterada em ação ou alvo é recusada sem mudar colunas e PK', async () => {
  for (const alteracao of [
    sql => sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT'),
    sql => sql.replace('REFERENCES lume_execucoes(id)', 'REFERENCES lume_execucoes(contexto_id)'),
  ]) {
    await comBanco(db => {
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='lume_execucao_eventos'").get().sql;
      assert.notEqual(alteracao(sql), sql);
      db.exec('PRAGMA foreign_keys=OFF; DROP TABLE lume_execucao_eventos');
      db.exec(alteracao(sql));
      assert.throws(() => auditarEsquemaRestoreV9(db), { code: 'FK_DIVERGENTE' });
    });
  }
});

test('UNIQUE alterado em unicidade, ordem, collation ou predicado é recusado', async () => {
  for (const sql of [
    'CREATE INDEX notetaker_uma_ativa ON notetaker_sessoes((1)) WHERE estado IN (\'gravando\',\'pausada\')',
    'CREATE UNIQUE INDEX notetaker_uma_ativa ON notetaker_sessoes((1)) WHERE estado = \'gravando\'',
  ]) {
    await comBanco(db => {
      db.exec('DROP INDEX notetaker_uma_ativa');
      db.exec(sql);
      assert.throws(() => auditarEsquemaRestoreV9(db), { code: 'UNIQUE_DIVERGENTE' });
    });
  }
  for (const unique of [
    'UNIQUE(chave,execucao_id)',
    'UNIQUE(execucao_id COLLATE NOCASE,chave)',
  ]) {
    await comBanco(db => {
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='lume_execucao_eventos'").get().sql;
      assert.ok(sql.includes('UNIQUE(execucao_id,chave)'));
      db.exec('PRAGMA foreign_keys=OFF; DROP TABLE lume_execucao_eventos');
      db.exec(sql.replace('UNIQUE(execucao_id,chave)', unique));
      assert.throws(() => auditarEsquemaRestoreV9(db), { code: 'UNIQUE_DIVERGENTE' });
    });
  }
});

test('FTS falso, sombra com tipo errado e objeto extra são recusados', async () => {
  await comBanco(db => {
    db.exec('DROP TABLE desktop_fontes_fts');
    db.exec("CREATE VIRTUAL TABLE desktop_fontes_fts USING fts5(texto, tokenize='porter')");
    assert.throws(() => auditarEsquemaRestoreV9(db), { code: 'SCHEMA_NAO_MAPEADO' });
  });
  await comBanco(db => {
    db.exec('DROP TABLE desktop_fontes_fts');
    db.exec('CREATE TABLE desktop_fontes_fts_config(k PRIMARY KEY, v)');
    assert.throws(() => auditarEsquemaRestoreV9(db), { code: 'SCHEMA_NAO_MAPEADO' });
  });
  await comBanco(db => {
    db.exec('CREATE TABLE objeto_extra(id INTEGER)');
    assert.throws(() => auditarEsquemaRestoreV9(db), { code: 'SCHEMA_NAO_MAPEADO' });
  });
  await comBanco(db => {
    db.exec('CREATE VIRTUAL TABLE fts_intruso USING fts5(texto)');
    assert.throws(() => auditarEsquemaRestoreV9(db), { code: 'SCHEMA_NAO_MAPEADO' });
  });
});

test('migração de correções repete e catálogo G vazio aceita origem sem reunião', async () => {
  await comBanco(async db => {
    prepararNotetaker(db);prepararNotetaker(db);
    assert.equal(auditarEsquemaRestoreV9(db),true);
    const arquivo=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main').file;
    const origem=await criarOrigemV9({dbPath:arquivo,perfil:{dono:'Teste sintético'}});
    try{assert.ok(origem.resumo.catalogoSha256);}finally{await origem.fechar();}
  });
});

test('histórico de correções povoado recusa backup como G, sem omissão silenciosa', async () => {
  await comBanco(async db => {
    const sessao='11111111-1111-4111-8111-111111111111',parte='22222222-2222-4222-8222-222222222222';
    const trecho='33333333-3333-4333-8333-333333333333';
    db.prepare("INSERT INTO notetaker_sessoes(id,estado,origem,entradas,inicio_em) VALUES(?,'preparada','importacao','[\"importacao\"]','2026-09-27T00:00:00Z')").run(sessao);
    db.prepare("INSERT INTO notetaker_partes(id,sessao_id,entrada,posicao,inicio_ms,duracao_ms,sha256,caminho,estado) VALUES(?,?,'importacao',0,0,1000,?,?,'indisponivel')")
      .run(parte,sessao,'a'.repeat(64),parte+'.wav');
    db.prepare('INSERT INTO notetaker_trechos(id,parte_id,ordinal,inicio_ms,fim_ms,texto_gerado) VALUES(?,?,0,0,100,?)').run(trecho,parte,'Texto A');
    db.prepare('INSERT INTO notetaker_correcoes(trecho_id,revisao,texto_anterior,texto_novo,ator,corrigido_em) VALUES(?,1,?,?,?,?)')
      .run(trecho,'Texto A','Texto B','local:owner','2026-09-27T00:00:00Z');
    assert.equal(auditarEsquemaRestoreV9(db),true);
    const arquivo=db.prepare('PRAGMA database_list').all().find(x=>x.name==='main').file;
    await assert.rejects(criarOrigemV9({dbPath:arquivo,perfil:{dono:'Teste sintético'}}),{code:'TABELA_G_POVOADA'});
  });
});

test('manifesto compilado recusa FK e UNIQUE adulterados em notetaker_correcoes', async () => {
  for(const sql of [
    "CREATE TABLE notetaker_correcoes(id INTEGER PRIMARY KEY,trecho_id TEXT NOT NULL REFERENCES notetaker_trechos(id) ON DELETE RESTRICT,revisao INTEGER NOT NULL,texto_anterior TEXT NOT NULL,texto_novo TEXT NOT NULL,ator TEXT NOT NULL,corrigido_em TEXT NOT NULL,UNIQUE(trecho_id,revisao))",
    "CREATE TABLE notetaker_correcoes(id INTEGER PRIMARY KEY,trecho_id TEXT NOT NULL REFERENCES notetaker_trechos(id) ON DELETE CASCADE,revisao INTEGER NOT NULL,texto_anterior TEXT NOT NULL,texto_novo TEXT NOT NULL,ator TEXT NOT NULL,corrigido_em TEXT NOT NULL,UNIQUE(revisao,trecho_id))"
  ]) await comBanco(db => {
    db.exec('DROP TABLE notetaker_correcoes');db.exec(sql);
    assert.throws(()=>auditarEsquemaRestoreV9(db),{code:sql.includes('RESTRICT')?'FK_DIVERGENTE':'UNIQUE_DIVERGENTE'});
  });
});

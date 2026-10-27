import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  prepararEsquemaTranscricao, limparTranscricao, dataDoNomeDeArquivo, gravarTranscricao
} from '../src/transcricao.js';

test('preambulo do modelo nao entra na busca como se fosse fala do contato', () => {
  assert.equal(limparTranscricao('Aqui está a transcrição do áudio: Bom dia, tudo bem?'), 'Bom dia, tudo bem?');
  assert.equal(limparTranscricao('Transcrição: preciso do orçamento'), 'preciso do orçamento');
  assert.equal(limparTranscricao('"fala solta entre aspas"'), 'fala solta entre aspas');
  assert.equal(limparTranscricao('  texto com espaco  '), 'texto com espaco');
});

test('audio sem fala vira nulo, nao string vazia nem placeholder indexavel', () => {
  assert.equal(limparTranscricao('(sem fala)'), null);
  assert.equal(limparTranscricao('sem fala'), null);
  assert.equal(limparTranscricao('   '), null);
  assert.equal(limparTranscricao(''), null);
  assert.equal(limparTranscricao(null), null);
});

test('fala que comeca parecida com preambulo nao e mutilada', () => {
  assert.equal(limparTranscricao('Transcrevi tudo que ele pediu ontem'), 'Transcrevi tudo que ele pediu ontem');
});

test('data sai do nome do arquivo exportado pelo WhatsApp', () => {
  assert.equal(dataDoNomeDeArquivo('00000021-AUDIO-2026-09-01-13-07-21.opus'), '2026-09-01T13:07:21.000Z');
  assert.equal(dataDoNomeDeArquivo('PTT-2025-12-05-09-39-00.opus'), '2025-12-05T09:39:00.000Z');
  assert.equal(dataDoNomeDeArquivo('audio-sem-data.opus'), null,
    'sem data no nome devolve nulo em vez de chutar hoje');
  assert.equal(dataDoNomeDeArquivo(null), null);
});

test('transcricao guarda a data da fala, nao a data de hoje', () => {
  const db = new DatabaseSync(':memory:');
  try {
    prepararEsquemaTranscricao(db);
    gravarTranscricao(db, {
      conversaId: 'zip:x', origemId: 'zip:abc', arquivo: 'a.opus',
      quando: '2026-09-01T13:07:21.000Z', texto: 'preciso da integracao bancaria',
      modelo: 'flash', duracaoMs: 15000
    });
    const r = db.prepare('SELECT * FROM transcricoes').get();
    assert.equal(r.quando, '2026-09-01T13:07:21.000Z');
    assert.equal(r.estado, 'transcrito');
    assert.notEqual(r.quando.slice(0, 10), r.criado_em.slice(0, 10),
      'a data da fala e independente da data em que transcrevemos');
  } finally {
    db.close();
  }
});

test('regravar o mesmo audio atualiza em vez de duplicar', () => {
  const db = new DatabaseSync(':memory:');
  try {
    prepararEsquemaTranscricao(db);
    const base = { conversaId: 'zip:x', origemId: 'zip:abc', arquivo: 'a.opus', modelo: 'flash' };
    gravarTranscricao(db, { ...base, texto: 'primeira tentativa' });
    gravarTranscricao(db, { ...base, texto: 'segunda, melhor' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM transcricoes').get().c, 1);
    assert.equal(db.prepare('SELECT texto FROM transcricoes').get().texto, 'segunda, melhor');
  } finally {
    db.close();
  }
});

test('falha de transcricao fica registrada como erro, com motivo', () => {
  const db = new DatabaseSync(':memory:');
  try {
    prepararEsquemaTranscricao(db);
    gravarTranscricao(db, {
      conversaId: 'zip:x', origemId: 'zip:err', arquivo: 'b.opus', erro: 'timeout na transcricao'
    });
    const r = db.prepare('SELECT * FROM transcricoes').get();
    assert.equal(r.estado, 'erro');
    assert.match(r.motivo, /timeout/);
    assert.equal(r.texto, null, 'erro nunca deixa texto pela metade no lugar da fala');
  } finally {
    db.close();
  }
});

test('tabela antiga sem a coluna quando e migrada em vez de quebrar', () => {
  const db = new DatabaseSync(':memory:');
  try {
    // Reproduz o schema como estava quando os primeiros audios foram transcritos.
    db.exec(`CREATE TABLE transcricoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT NOT NULL, origem_id TEXT NOT NULL,
      arquivo TEXT, texto TEXT, estado TEXT NOT NULL, motivo TEXT, modelo TEXT,
      duracao_ms INTEGER, criado_em TEXT NOT NULL, UNIQUE(conversa_id, origem_id))`);
    prepararEsquemaTranscricao(db);
    assert.ok(db.prepare('PRAGMA table_info(transcricoes)').all().map(c => c.name).includes('quando'));
    gravarTranscricao(db, {
      conversaId: 'z', origemId: 'o', quando: '2026-09-01T00:00:00.000Z', texto: 'ok', modelo: 'flash'
    });
    assert.equal(db.prepare('SELECT quando FROM transcricoes').get().quando, '2026-09-01T00:00:00.000Z');
  } finally {
    db.close();
  }
});

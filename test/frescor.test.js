import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepararEsquemaCrm } from '../src/crm.js';
import { classificar, avaliar, aplicar, itensAbertos } from '../src/frescor.js';

const AGORA = Date.parse('2026-09-11T12:00:00.000Z');
const haDias = d => new Date(AGORA - d * 86400000).toISOString();

function banco() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE eventos (id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT, origem_id TEXT,
      autor_e_dono INTEGER DEFAULT 0, texto TEXT, recebido_em TEXT);
    CREATE TABLE grupos_app (id TEXT PRIMARY KEY, nome TEXT);
    CREATE TABLE conversas_app (id TEXT PRIMARY KEY, nome TEXT);
  `);
  prepararEsquemaCrm(db);
  return db;
}

const msg = (db, conversa, origem, dono, quando, texto = 'oi') =>
  db.prepare('INSERT INTO eventos (conversa_id,origem_id,autor_e_dono,texto,recebido_em) VALUES (?,?,?,?,?)')
    .run(conversa, origem, dono, texto, quando);

const item = (db, { conversa, origem, tipo, quando, resumo = 'x' }) =>
  db.prepare(`INSERT INTO itens_crm (conversa_id,origem_id,tipo,resumo,quando,extraido_em)
              VALUES (?,?,?,?,?,?)`).run(conversa, origem, tipo, resumo, quando, quando);

test('item novo continua aberto', () => {
  assert.equal(classificar({ tipo: 'compromisso', quando: haDias(3), grupo: 1 }, { agora: AGORA }), null);
});

test('item velho expira, e nao vira "descartado" -- erro de extracao e outra coisa', () => {
  const v = classificar({ tipo: 'compromisso', quando: haDias(40), grupo: 1 }, { agora: AGORA });
  assert.equal(v.estado, 'expirado');
  assert.match(v.motivo, /40 dias/);
});

test('pendencia em DM respondida pelo outro lado vira resolvido', () => {
  const v = classificar(
    { tipo: 'pendencia', quando: haDias(2), grupo: 0, resposta_em: new Date(AGORA - 2 * 86400000 + 1800000).toISOString() },
    { agora: AGORA });
  assert.equal(v.estado, 'resolvido');
});

test('resposta em GRUPO nunca resolve: la o outro lado e todo mundo', () => {
  // Foi o que a medicao de 11/09 mostrou: a regra solta em grupo fecharia 93 de 152
  // itens sem que nenhum tivesse sido respondido de verdade.
  const v = classificar(
    { tipo: 'pendencia', quando: haDias(2), grupo: 1, resposta_em: new Date(AGORA - 2 * 86400000 + 1800000).toISOString() },
    { agora: AGORA });
  assert.equal(v, null);
});

test('resposta tardia demais nao resolve nada', () => {
  const v = classificar(
    { tipo: 'pendencia', quando: haDias(3), grupo: 0, resposta_em: new Date(AGORA - 3 * 86400000 + 40 * 3600000).toISOString() },
    { agora: AGORA });
  assert.equal(v, null);
});

test('respondido ha muito tempo conta como resolvido, nao como expirado', () => {
  const v = classificar(
    { tipo: 'pendencia', quando: haDias(90), grupo: 0, resposta_em: new Date(AGORA - 90 * 86400000 + 3600000).toISOString() },
    { agora: AGORA });
  assert.equal(v.estado, 'resolvido', 'resolvido e a metrica do produto; expirado e so limpeza');
});

test('item sem data resolvivel nao e fechado por palpite', () => {
  assert.equal(classificar({ tipo: 'compromisso', quando: null, grupo: 1 }, { agora: AGORA }), null);
});

test('a resposta tem que ser do OUTRO autor, nao um eco de quem perguntou', () => {
  const db = banco();
  const dm = '5511999@s.whatsapp.net';
  msg(db, dm, 'P1', 0, haDias(2));            // o outro lado pergunta
  msg(db, dm, 'P2', 0, haDias(2 - 1 / 24));   // e ele mesmo fala de novo 1h depois
  item(db, { conversa: dm, origem: 'P1', tipo: 'pendencia', quando: haDias(2) });
  assert.equal(itensAbertos(db)[0].resposta_em, null, 'so a fala do outro autor conta como resposta');
  assert.equal(avaliar(db, { agora: AGORA }).decisoes.length, 0);
});

test('aplicar move so os decididos e deixa rastro de quando e por que', () => {
  const db = banco();
  const g = '123@g.us';
  msg(db, g, 'A', 0, haDias(40));
  msg(db, g, 'B', 0, haDias(2));
  item(db, { conversa: g, origem: 'A', tipo: 'compromisso', quando: haDias(40) });
  item(db, { conversa: g, origem: 'B', tipo: 'compromisso', quando: haDias(2) });

  const { decisoes, restantes } = avaliar(db, { agora: AGORA });
  assert.equal(restantes, 1);
  assert.equal(aplicar(db, decisoes), 1);

  const linhas = db.prepare('SELECT origem_id,estado,estado_em,estado_motivo FROM itens_crm ORDER BY origem_id').all();
  assert.equal(linhas[0].estado, 'expirado');
  assert.ok(linhas[0].estado_em, 'sem data de mudanca nao da para medir falso positivo depois');
  assert.match(linhas[0].estado_motivo, /dias/);
  assert.equal(linhas[1].estado, 'aberto');
  assert.equal(linhas[1].estado_em, null);
});

test('rodar duas vezes nao mexe em item que ja saiu de aberto', () => {
  const db = banco();
  const g = '123@g.us';
  msg(db, g, 'A', 0, haDias(40));
  item(db, { conversa: g, origem: 'A', tipo: 'compromisso', quando: haDias(40) });
  const primeira = avaliar(db, { agora: AGORA });
  aplicar(db, primeira.decisoes);
  db.prepare("UPDATE itens_crm SET estado='resolvido' WHERE origem_id='A'").run(); // o dono discordou
  assert.equal(avaliar(db, { agora: AGORA }).decisoes.length, 0);
  assert.equal(db.prepare('SELECT estado FROM itens_crm').get().estado, 'resolvido');
});

test('migracao do esquema antigo preserva os itens e libera o estado novo', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE itens_crm (
    id INTEGER PRIMARY KEY AUTOINCREMENT, conversa_id TEXT NOT NULL, origem_id TEXT NOT NULL,
    tipo TEXT NOT NULL, resumo TEXT NOT NULL, responsavel TEXT, quando TEXT,
    estado TEXT NOT NULL DEFAULT 'aberto' CHECK (estado IN ('aberto','resolvido','descartado')),
    extraido_em TEXT NOT NULL, modelo TEXT, UNIQUE(conversa_id, origem_id, tipo));`);
  db.prepare(`INSERT INTO itens_crm (conversa_id,origem_id,tipo,resumo,quando,extraido_em)
              VALUES ('c','O','compromisso','antigo','2026-01-01','2026-01-01')`).run();
  assert.throws(() => db.prepare("UPDATE itens_crm SET estado='expirado'").run());

  prepararEsquemaCrm(db);

  assert.equal(db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c, 1);
  assert.equal(db.prepare('SELECT resumo FROM itens_crm').get().resumo, 'antigo');
  db.prepare("UPDATE itens_crm SET estado='expirado'").run();
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sqlite_master WHERE name=?').get('itens_crm_antigo').c, 0);
  prepararEsquemaCrm(db); // idempotente
  assert.equal(db.prepare('SELECT COUNT(*) c FROM itens_crm').get().c, 1);
});

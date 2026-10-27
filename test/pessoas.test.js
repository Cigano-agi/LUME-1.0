import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  prepararEsquemaPessoas, registrarPessoa, nomeExibicao, mapaDePessoas,
  fundirPessoas, backfillDoBruto
} from '../src/pessoas.js';
import { nomeDe } from '../src/crm.js';

function banco() {
  const db = new DatabaseSync(':memory:');
  prepararEsquemaPessoas(db);
  return db;
}

// --------------------------------------------------------------- nome de exibicao

test('sufixo comercial sai, nome da pessoa fica', () => {
  assert.equal(nomeExibicao('Fabricio Feitosa | Cigano.agi'), 'Fabricio Feitosa');
  assert.equal(nomeExibicao('  João  Vitor  - Head Webi '), 'João Vitor');
});

test('emoji sai sem levar o nome junto', () => {
  assert.equal(nomeExibicao('NegoPlay 👨🏾‍💻'), 'NegoPlay');
});

test('apelido que ja e limpo passa intacto', () => {
  // `Sr.Primus` nao vira `Sr`: cortar aqui destruiria a unica forma de reconhece-lo.
  assert.equal(nomeExibicao('Sr.Primus'), 'Sr.Primus');
});

test('quando a limpeza comeria o nome, devolve o apelido original', () => {
  // Medido: `≈≈K¥0≈≈ @hype_vilarinho` derivava para "K" — um fragmento que parece nome
  // e nao identifica ninguem. Pior que mostrar o apelido inteiro.
  assert.equal(nomeExibicao('≈≈K¥0≈≈ @hype_vilarinho'), '≈≈K¥0≈≈ @hype_vilarinho');
  assert.equal(nomeExibicao('@hype_vilarinho'), '@hype_vilarinho');
  assert.equal(nomeExibicao('🔥🔥🔥'), '🔥🔥🔥');
});

test('nome com tres ou mais palavras vira nome e sobrenome', () => {
  assert.equal(nomeExibicao('Gabriel Oliveira Stoco'), 'Gabriel Oliveira');
  assert.equal(nomeExibicao('Victor Mendes Ribeiro'), 'Victor Mendes');
});

test('vazio e nulo nao viram nome', () => {
  assert.equal(nomeExibicao(''), null);
  assert.equal(nomeExibicao(null), null);
  assert.equal(nomeExibicao('   '), null);
});

// -------------------------------------------------------------------- gravacao

test('registrar guarda o cru e o derivado em colunas diferentes', () => {
  const db = banco();
  const { pessoaId, criada } = registrarPessoa(db, {
    identificador: '123@lid', nomeCru: 'Fabricio Feitosa | Cigano.agi'
  });
  assert.equal(criada, true);
  const p = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(pessoaId);
  assert.equal(p.nome_cru, 'Fabricio Feitosa | Cigano.agi',
    'o cru e a prova: se a regra de limpeza errar, da para refazer a partir dele');
  assert.equal(p.nome_exibicao, 'Fabricio Feitosa');
});

test('registrar de novo com o mesmo nome nao muda nada', () => {
  const db = banco();
  registrarPessoa(db, { identificador: '123@lid', nomeCru: 'Victor' });
  const r = registrarPessoa(db, { identificador: '123@lid', nomeCru: 'Victor' });
  assert.equal(r.criada, false);
  assert.equal(r.atualizada, false);
});

test('origem mais fraca nao derruba nome de origem mais forte', () => {
  // Sem esta regra, o pushName da semana ("🔥 PROMOCAO 🔥") apagaria o nome que alguem
  // digitou a mao — e o nome bom nao voltaria.
  const db = banco();
  registrarPessoa(db, { identificador: '9@lid', nomeCru: 'Maria Silva', origem: 'manual' });
  const r = registrarPessoa(db, { identificador: '9@lid', nomeCru: '🔥 PROMOCAO 🔥', origem: 'pushName' });
  assert.equal(r.atualizada, false);
  assert.equal(mapaDePessoas(db).get('9@lid'), 'Maria Silva');
});

test('origem mais forte atualiza o nome', () => {
  const db = banco();
  registrarPessoa(db, { identificador: '9@lid', nomeCru: 'apelido', origem: 'pushName' });
  const r = registrarPessoa(db, { identificador: '9@lid', nomeCru: 'Maria Silva', origem: 'manual' });
  assert.equal(r.atualizada, true);
  assert.equal(mapaDePessoas(db).get('9@lid'), 'Maria Silva');
});

test('identificador ou nome vazio nao cria pessoa fantasma', () => {
  const db = banco();
  assert.equal(registrarPessoa(db, { identificador: '', nomeCru: 'X' }).pessoaId, null);
  assert.equal(registrarPessoa(db, { identificador: '1@lid', nomeCru: '  ' }).pessoaId, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pessoas').get().n, 0);
});

test('origem desconhecida e recusada, para nao furar a precedencia', () => {
  const db = banco();
  assert.throws(() => registrarPessoa(db, { identificador: '1@lid', nomeCru: 'X', origem: 'chute' }), TypeError);
});

// ----------------------------------------------------------------------- fusao

test('fundir aponta para o canonico sem apagar linha, e e reversivel', () => {
  const db = banco();
  const a = registrarPessoa(db, { identificador: 'v1@lid', nomeCru: 'Victor Mendes' }).pessoaId;
  const b = registrarPessoa(db, { identificador: 'v2@lid', nomeCru: 'Victor M' }).pessoaId;
  fundirPessoas(db, { deId: b, paraId: a });

  const mapa = mapaDePessoas(db);
  assert.equal(mapa.get('v1@lid'), 'Victor Mendes');
  assert.equal(mapa.get('v2@lid'), 'Victor Mendes', 'o identificador fundido devolve o nome do canonico');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pessoas').get().n, 2, 'nenhuma linha foi apagada');

  db.prepare('UPDATE pessoas SET fundida_em = NULL WHERE id = ?').run(b);
  assert.equal(mapaDePessoas(db).get('v2@lid'), 'Victor M', 'desfazer e limpar um ponteiro');
});

test('nao da para fundir alguem nele mesmo nem numa pessoa ja fundida', () => {
  const db = banco();
  const a = registrarPessoa(db, { identificador: 'a@lid', nomeCru: 'A' }).pessoaId;
  const b = registrarPessoa(db, { identificador: 'b@lid', nomeCru: 'B' }).pessoaId;
  const c = registrarPessoa(db, { identificador: 'c@lid', nomeCru: 'C' }).pessoaId;
  assert.throws(() => fundirPessoas(db, { deId: a, paraId: a }), TypeError);
  fundirPessoas(db, { deId: b, paraId: a });
  assert.throws(() => fundirPessoas(db, { deId: c, paraId: b }), /ja foi fundida/);
});

// -------------------------------------------------------------------- backfill

function bancoComEventos(linhas) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE eventos (
    id INTEGER PRIMARY KEY, conversa_id TEXT, autor_id TEXT, autor_e_dono INTEGER,
    bruto TEXT, recebido_em TEXT)`);
  const ins = db.prepare('INSERT INTO eventos (conversa_id,autor_id,autor_e_dono,bruto,recebido_em) VALUES (?,?,?,?,?)');
  for (const l of linhas) {
    ins.run(l.conversa ?? 'g@g.us', l.autor, l.dono ?? 0,
      JSON.stringify({ mensagem: { pushName: l.push ?? null } }), l.em ?? '2026-09-01T00:00:00.000Z');
  }
  return db;
}

test('backfill recupera do bruto o nome que a ingestao descartou em grupo', () => {
  const db = bancoComEventos([
    { autor: '276020418605124@lid', push: 'Gabriel Oliveira Stoco' },
    { autor: '77223847555205@lid', push: 'Sr.Primus' },
    { autor: '999@lid', push: null }
  ]);
  const r = backfillDoBruto(db);
  assert.equal(r.examinadas, 2, 'evento sem pushName nao entra');
  assert.equal(r.criadas, 2);
  const mapa = mapaDePessoas(db);
  assert.equal(mapa.get('276020418605124@lid'), 'Gabriel Oliveira');
  assert.equal(mapa.get('77223847555205@lid'), 'Sr.Primus');
});

test('backfill ignora as proprias mensagens do dono', () => {
  const db = bancoComEventos([{ autor: 'eu@lid', push: 'Fabricio', dono: 1 }]);
  assert.equal(backfillDoBruto(db).criadas, 0);
});

test('o nome mais recente ganha quando a pessoa trocou de pushName', () => {
  const db = bancoComEventos([
    { autor: 'x@lid', push: 'Nome Antigo', em: '2024-01-01T00:00:00.000Z' },
    { autor: 'x@lid', push: 'Nome Novo', em: '2026-09-01T00:00:00.000Z' }
  ]);
  backfillDoBruto(db);
  assert.equal(mapaDePessoas(db).get('x@lid'), 'Nome Novo');
});

test('rodar o backfill duas vezes nao duplica pessoa', () => {
  const db = bancoComEventos([{ autor: 'x@lid', push: 'Victor Mendes' }]);
  backfillDoBruto(db);
  const segundo = backfillDoBruto(db);
  assert.equal(segundo.criadas, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pessoas').get().n, 1);
});

// ------------------------------------------------------- resolucao por variante

test('identificador sem sufixo acha a pessoa gravada com @lid', () => {
  // Medido em 12/09: 8 dos 13 identificadores crus nos itens de CRM JA estavam no mapa,
  // so que com `@lid`, enquanto o item guardava o numero pelado. Sem normalizar, o
  // trabalho de recuperar 766 nomes nao chegava na tela.
  const mapa = new Map([['11630838558759@lid', 'Guilherme Aroxo']]);
  assert.equal(nomeDe('11630838558759', mapa), 'Guilherme Aroxo');
  assert.equal(nomeDe('11630838558759@lid', mapa), 'Guilherme Aroxo');
});

test('identificador desconhecido vira o numero pelado, nunca some', () => {
  assert.equal(nomeDe('5511999@s.whatsapp.net', new Map()), '5511999');
  assert.equal(nomeDe(null, new Map()), 'contato');
});

// ------------------------------------------- a correcao na raiz (contexto-app.js)

test('mensagem nova de grupo cria pessoa, que era o caso que se perdia', async () => {
  const { ContextoApp } = await import('../src/contexto-app.js');
  const { abrirBanco } = await import('../src/banco.js');
  const db = abrirBanco();
  const ctx = new ContextoApp(db);
  ctx.receber({ type: 'notify', messages: [{
    key: { remoteJid: '123@g.us', id: 'M1', fromMe: false, participant: '999@lid' },
    pushName: 'Gabriel Oliveira Stoco',
    message: { conversation: 'bom dia' },
    messageTimestamp: 1757600000
  }]});
  assert.equal(mapaDePessoas(db).get('999@lid'), 'Gabriel Oliveira',
    'em grupo o nome do remetente era descartado; agora vira pessoa');
});

test('mensagem sem pushName nao apaga o nome que ja existia', () => {
  const db = banco();
  registrarPessoa(db, { identificador: '999@lid', nomeCru: 'Gabriel Oliveira' });
  registrarPessoa(db, { identificador: '999@lid', nomeCru: null });
  assert.equal(mapaDePessoas(db).get('999@lid'), 'Gabriel Oliveira');
});

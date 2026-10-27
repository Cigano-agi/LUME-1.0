import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  donoDoItem,
  baldeDoItem,
  idDeExibicao,
  idadeEmDias,
  montarBacklog,
  renderizarMarkdown,
} from '../src/backlog.js';

const AGORA = new Date('2026-09-14T15:00:00.000Z'); // 12:00 em Sao Paulo
const mapa = new Map([
  ['5511999@lid', 'Fabricio Feitosa'],
  ['5511888', 'Giusepe'],
  ['grupo@g.us', 'WAVES'],
]);
const base = { id: 1, conversa_id: 'grupo@g.us', tipo: 'compromisso', resumo: 'x', quando: '2026-09-10T12:00:00.000Z' };

test('sem responsavel o item e indefinido, nunca meu por padrao', () => {
  assert.equal(donoDoItem({ ...base, responsavel: null }, { mapa }), 'indefinido');
  assert.equal(donoDoItem({ ...base, responsavel: '  ' }, { mapa }), 'indefinido');
  assert.equal(donoDoItem({ ...base }, { mapa }), 'indefinido');
});

test('reconhece o dono pelo nome resolvido, com e sem acento', () => {
  assert.equal(donoDoItem({ ...base, responsavel: '5511999@lid' }, { mapa }), 'meu');
  assert.equal(donoDoItem({ ...base, responsavel: 'Fabrício' }, { mapa }), 'meu');
  assert.equal(donoDoItem({ ...base, responsavel: 'Fabricio' }, { mapa }), 'meu');
});

test('outra pessoa e terceiro', () => {
  assert.equal(donoDoItem({ ...base, responsavel: '5511888' }, { mapa }), 'terceiro');
});

test('caixa ganha do balde de dono: item meu que fala de dinheiro vai pra caixa', () => {
  const i = { ...base, responsavel: '5511999@lid', resumo: 'Enviar orçamento para o advogado' };
  assert.equal(donoDoItem(i, { mapa }), 'meu');
  assert.equal(baldeDoItem(i, { mapa }), 'caixa');
});

test('decisao nunca vira tarefa, mesmo citando dinheiro', () => {
  const i = { ...base, tipo: 'decisao', responsavel: '5511999@lid', resumo: 'Comissão definida em 40%' };
  assert.equal(baldeDoItem(i, { mapa }), 'decisao');
});

test('lead sem sinal de caixa fica em lead', () => {
  const i = { ...base, tipo: 'lead', responsavel: '5511888', resumo: 'Amigo quer comprar BM' };
  assert.equal(baldeDoItem(i, { mapa }), 'lead');
});

test('o numero do ID e o id do banco e sobrevive a troca de balde', () => {
  const i = { ...base, id: 173, responsavel: '5511999@lid' };
  assert.equal(idDeExibicao(i, 'meu'), 'F-173');
  assert.equal(idDeExibicao(i, 'terceiro'), 'T-173');
  assert.equal(idDeExibicao(i, 'caixa'), '$-173');
});

test('idade em dias inteiros, e nunca negativa', () => {
  assert.equal(idadeEmDias(base, AGORA), 4);
  assert.equal(idadeEmDias({ ...base, quando: '2026-12-01T00:00:00.000Z' }, AGORA), 0);
  assert.equal(idadeEmDias({ ...base, quando: 'nao-e-data' }, AGORA), null);
});

test('montarBacklog separa os baldes e conta o total', () => {
  const itens = [
    { ...base, id: 1, responsavel: '5511999@lid', resumo: 'Gravar o reels' },
    { ...base, id: 2, responsavel: '5511888', resumo: 'Mandar o manual de SDR' },
    { ...base, id: 3, responsavel: '5511999@lid', resumo: 'Enviar proposta de R$ 20 mil' },
    { ...base, id: 4, tipo: 'lead', responsavel: '5511888', resumo: 'Interesse em comprar BM' },
    { ...base, id: 5, tipo: 'decisao', responsavel: null, resumo: 'Escopo definido' },
    { ...base, id: 6, responsavel: null, resumo: 'Pedido sem dono' },
  ];
  const r = montarBacklog(itens, { agora: AGORA, mapa });
  assert.equal(r.total, 6);
  assert.equal(r.baldes.meu.length, 1);
  assert.equal(r.baldes.terceiro.length, 1);
  assert.equal(r.baldes.caixa.length, 1);
  assert.equal(r.baldes.lead.length, 1);
  assert.equal(r.baldes.decisao.length, 1);
  assert.equal(r.baldes.indefinido.length, 1);
  assert.equal(r.baldes.caixa[0].id_exibicao, '$-3');
});

test('o markdown sai com todas as secoes mesmo com balde vazio', () => {
  const md = renderizarMarkdown(montarBacklog([], { agora: AGORA, mapa }), { dia: '2026-09-14' });
  for (const secao of ['💰 Caixa', '🔴 Devo eu', '⏳ Devem a mim', '🌱 Leads', '⚖️ Decisões', '❓ Sem dono']) {
    assert.ok(md.includes(secao), `faltou a seção ${secao}`);
  }
  assert.ok(md.includes('_Nada aqui hoje._'));
});

test('pipe no resumo nao quebra a tabela', () => {
  const itens = [{ ...base, id: 9, responsavel: '5511888', resumo: 'a | b | c' }];
  const md = renderizarMarkdown(montarBacklog(itens, { agora: AGORA, mapa }), { dia: '2026-09-14' });
  const linha = md.split('\n').find((l) => l.includes('T-9'));
  // Conta só os pipes NÃO escapados — o `\|` do resumo é texto, não separador de coluna.
  assert.equal(linha.split(/(?<!\\)\|/).length, 6, 'o pipe do resumo virou coluna nova');
  assert.ok(linha.includes(String.raw`a \| b \| c`), 'o resumo deveria sair com pipes escapados');
});

// A regex de caixa daqui espelha SINAL_COMERCIAL de src/valor.js de propósito: lá ela
// pontua, aqui ela escolhe a seção. Se uma mudar sem a outra, o item soma pontos de
// dinheiro mas some da seção de dinheiro — exatamente o bug que este teste impede.
test('o sinal de caixa continua alinhado com o de valor.js', () => {
  const aqui = dirname(fileURLToPath(import.meta.url));
  const fonteValor = readFileSync(resolve(aqui, '..', 'src', 'valor.js'), 'utf8');
  const termos = ['orçamento', 'proposta', 'pix', 'pagamento', 'cobrança', 'contrato', 'mensalidade'];
  for (const t of termos) {
    assert.equal(
      baldeDoItem({ ...base, responsavel: '5511888', resumo: `algo sobre ${t}` }, { mapa }),
      'caixa',
      `"${t}" deveria cair em caixa`,
    );
  }
  assert.ok(fonteValor.includes('SINAL_COMERCIAL'), 'valor.js perdeu SINAL_COMERCIAL');
});

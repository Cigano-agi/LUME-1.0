import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  prepararEsquemaFinanceiro,
  validarEventosFinanceiros,
  gravarEventosFinanceiros,
  listarPendenciasFinanceiras
} from '../src/financeiro.js';

test('esquema financeiro cria tabela e indices', () => {
  const db = new DatabaseSync(':memory:');
  prepararEsquemaFinanceiro(db);
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert.ok(tabelas.some(t => t.name === 'eventos_financeiros'));
});

test('valida eventos contra mensagens reais e rejeita alucinacao', () => {
  const msgs = [
    { origem_id: 'msg_01', recebido_em: '2026-09-10T17:14:00Z', texto: 'manda bala' },
    { origem_id: 'msg_02', recebido_em: '2026-09-01T11:20:00Z', texto: 'temos 2 clientes' }
  ];

  const itens = [
    {
      origem_id: 'msg_01',
      tipo: 'sinal_pendente',
      cliente_nome: 'Malu Zarro',
      valor: 2000.0,
      detalhes: 'Sinal aprovado aguardando Pix'
    },
    {
      origem_id: 'msg_fake',
      tipo: 'proposta',
      cliente_nome: 'Cliente Fantasma',
      detalhes: 'Nao existe'
    }
  ];

  const { aceitos, recusados } = validarEventosFinanceiros(itens, msgs);
  assert.equal(aceitos.length, 1);
  assert.equal(recusados.length, 1);
  assert.equal(aceitos[0].origem_id, 'msg_01');
  assert.equal(aceitos[0].valor, 2000.0);
});

test('persiste e lista eventos financeiros pendentes', () => {
  const db = new DatabaseSync(':memory:');
  prepararEsquemaFinanceiro(db);

  const eventos = [
    {
      origem_id: 'm1',
      tipo: 'recorrencia',
      entidade_slug: 'webi',
      cliente_nome: 'WEBi',
      valor: 800.0,
      moeda: 'BRL',
      status: 'pendente',
      detalhes: 'NFS-e pendente de emissao para financeiro@webi.com.br',
      acao_necessaria: 'Emitir nota fiscal',
      quando: '2026-09-01'
    }
  ];

  const gravados = gravarEventosFinanceiros(db, 'conversa_webi', eventos);
  assert.equal(gravados, 1);

  const pendencias = listarPendenciasFinanceiras(db);
  assert.equal(pendencias.length, 1);
  assert.equal(pendencias[0].cliente_nome, 'WEBi');
  assert.equal(pendencias[0].valor, 800.0);
});

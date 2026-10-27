import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { perfilBeta05 } from './fixtures/beta05-profile.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';

// Auditoria independente: apenas memória e conteúdo fictício, sem modelo ou credencial.
function fixture(t, manter = false) {
  const db = abrirBanco(':memory:');
  t.after(() => db.close());
  const now = new Date('2026-09-26T15:00:00Z');
  const { mensagem } = perfilBeta05(db, { agora: now, vazio: true });
  const texto = 'Combinado: preparar o roteiro da reunião de demonstração.';
  const source = mensagem({ texto });
  const actions = new AcoesLume(db, { agora: () => now });
  actions.autorizar({ conversa: source.conversa, permitida: true });
  actions.registrar({ eventoId: source.id, candidatas: [{ fonte: 'E' + source.id,
    tipo: 'compromisso', resumo: 'Preparar roteiro sintético', trecho: texto, prazo_citado: '' }] });
  const action = actions.listar()[0];
  actions.revisar({ id: action.id, acao: 'confirmar' });
  const service = new ExecucoesLume(db, { agora: () => now });
  const { contexto } = service.preparar({ acao_id: action.id });
  const { execucao } = service.iniciar({ contexto_id: contexto.id, assistente: 'claude',
    confirmar: true, chave_idempotencia: 'ciclo-entrega-inicio', manter_contexto: manter });
  const access = { clientId: 'claude-desktop', scope: { kind: 'all' }, revision: 'sintetico-revisao-1' };
  return { db, service, actions, action, execucao, access, source, texto };
}

test('CYCLE-07: corrigir e desfazer descrição não ressuscita autorização padrão do executor', t => {
  const f = fixture(t);
  assert.equal(f.service.obter({ id: f.execucao.id }, f.access).execucao.id, f.execucao.id);
  f.actions.corrigir({ id: f.action.id, resumo: 'Preparar somente perguntas, sem roteiro' });
  assert.throws(() => f.service.obter({ id: f.execucao.id }, f.access));
  f.actions.corrigir({ id: f.action.id, resumo: f.action.resumo });
  assert.throws(() => f.service.registrar('resultado', { execucao_id: f.execucao.id,
    chave_idempotencia: 'ciclo-entrega-retorno', resumo: 'Retorno tardio após correção desfeita', artefatos: [] }, f.access),
  'A autorização anterior deve permanecer invalidada mesmo sem manter_contexto');
});

test('CYCLE-07: controle de sete dias permanece invalidado após corrigir e desfazer descrição', t => {
  const f = fixture(t, true);
  f.service.obter({ id: f.execucao.id }, f.access);
  f.actions.corrigir({ id: f.action.id, resumo: 'Preparar somente perguntas, sem roteiro' });
  f.actions.corrigir({ id: f.action.id, resumo: f.action.resumo });
  assert.throws(() => f.service.registrar('resultado', { execucao_id: f.execucao.id,
    chave_idempotencia: 'ciclo-entrega-retorno', resumo: 'Retorno tardio após correção desfeita', artefatos: [] }, f.access));
});

test('CYCLE-01/07: corrigir descrição preserva execução no histórico local da tarefa', t => {
  const f = fixture(t);
  f.service.registrar('resultado', { execucao_id: f.execucao.id, chave_idempotencia: 'ciclo-entrega-pronto',
    resumo: 'Roteiro fictício recebido para conferência', artefatos: ['roteiro-sintetico.md'] }, f.access);
  assert.equal(f.service.listar({ acao_id: f.action.id }).execucoes.length, 1);
  f.actions.corrigir({ id: f.action.id, resumo: 'Conferir roteiro e preparar perguntas' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 1);
  assert.equal(f.service.listar({ acao_id: f.action.id }).execucoes.length, 1,
    'O titular precisa ver o histórico invalidado, sem autorizar novo retorno');
});

test('CYCLE-07: editar e repor texto da fonte não ressuscita execução padrão', t => {
  const f = fixture(t);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Fonte corrigida temporariamente.', f.source.id);
  assert.throws(() => f.service.obter({ id: f.execucao.id }, f.access));
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(f.texto, f.source.id);
  assert.throws(() => f.service.registrar('progresso', { execucao_id: f.execucao.id,
    chave_idempotencia: 'ciclo-entrega-fonte', texto: 'Retorno baseado na fonte anterior.' }, f.access));
});

test('CYCLE-07: revogar e repor leitura não ressuscita execução padrão', t => {
  const f = fixture(t);
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(f.source.id);
  assert.throws(() => f.service.obter({ id: f.execucao.id }, f.access));
  f.db.prepare("UPDATE eventos SET permissao='dirigida' WHERE id=?").run(f.source.id);
  assert.throws(() => f.service.registrar('progresso', { execucao_id: f.execucao.id,
    chave_idempotencia: 'ciclo-entrega-leitura', texto: 'Retorno depois de revogar leitura.' }, f.access));
});

test('CYCLE-06/07: corrigir e desfazer tarefa invalida prévia ainda não autorizada', t => {
  const f = fixture(t);
  const { contexto } = f.service.preparar({ acao_id: f.action.id });
  f.actions.corrigir({ id: f.action.id, resumo: 'Preparar somente perguntas, sem roteiro' });
  f.actions.corrigir({ id: f.action.id, resumo: f.action.resumo });
  assert.throws(() => f.service.iniciar({ contexto_id: contexto.id, assistente: 'claude',
    confirmar: true, chave_idempotencia: 'ciclo-entrega-previa-obsoleta' }));
});

test('CYCLE-01/07: histórico local preservado não amplia acesso quando fonte perde leitura', t => {
  const f = fixture(t);
  f.service.registrar('resultado', { execucao_id: f.execucao.id, chave_idempotencia: 'ciclo-entrega-historico',
    resumo: 'Retorno sintético antes de perder leitura', artefatos: [] }, f.access);
  f.actions.corrigir({ id: f.action.id, resumo: 'Conferir roteiro corrigido' });
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(f.source.id);
  assert.throws(() => f.service.listar({ acao_id: f.action.id }));
  assert.throws(() => f.service.obter({ id: f.execucao.id }));
  assert.throws(() => f.service.historico({ id: f.execucao.id }));
});

test('CYCLE-07: tarefa corrigida permite nova autorização e mantém a antiga sem escrita', t => {
  const f = fixture(t);
  f.actions.corrigir({ id: f.action.id, resumo: 'Conferir roteiro corrigido' });
  assert.throws(() => f.service.registrar('resultado', { execucao_id: f.execucao.id,
    chave_idempotencia: 'ciclo-entrega-antigo', resumo: 'Retorno para tarefa antiga', artefatos: [] }));
  const { contexto } = f.service.preparar({ acao_id: f.action.id });
  const { execucao } = f.service.iniciar({ contexto_id: contexto.id, assistente: 'claude',
    confirmar: true, chave_idempotencia: 'ciclo-entrega-reautorizar' });
  assert.equal(f.service.registrar('resultado', { execucao_id: execucao.id,
    chave_idempotencia: 'ciclo-entrega-novo', resumo: 'Retorno para tarefa corrigida', artefatos: [] }, f.access)
    .execucao.estado, 'resultado_informado');
});

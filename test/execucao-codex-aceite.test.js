import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';

function fixture(t) {
  const dir = mkdtempSync(join(homedir(), 'lume-codex-aceite-sintetico-'));
  mkdirSync(join(dir, 'data'));
  const db = abrirBanco(join(dir, 'data', 'lume.sqlite'));
  t.after(() => {
    db.close();
    if (!resolve(dir).startsWith(resolve(homedir()) + sep)) throw Error('Pasta temporária inválida');
    rmSync(dir, { recursive: true, force: true });
  });
  new ContextoApp(db); new Desktop(db);
  const acoes = new AcoesLume(db, { agora: () => new Date('2026-09-25T15:00:00Z') });
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('codex-fixture', 'Projeto sintético');
  const fonte = Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
    VALUES(?,'codex-fonte','entrada','texto','{}',?,'2026-09-25T14:00:00Z','2026-09-25','minha',1)`).run('codex-fixture', 'Preparar relatório do projeto sintético.').lastInsertRowid);
  acoes.autorizar({ conversa: 'codex-fixture', permitida: true });
  acoes.registrar({ eventoId: fonte, candidatas: [{ fonte: `E${fonte}`, tipo: 'pendencia', resumo: 'Preparar relatório sintético', trecho: 'Preparar relatório do projeto sintético.', prazo_citado: '' }] });
  const acao = acoes.listar().find(x => x.evento_id === fonte);
  return { db, acao, svc: new ExecucoesLume(db, { agora: () => new Date('2026-09-25T15:00:00Z'),
    resolverProjeto: id => id === 'projeto-sintetico-01' ? { id, origem: dir, arquivosPermitidos: ['README.md', 'src/relatorio.md'] } : null }) };
}

const solicitacao = acao_id => ({
  acao_id,
  projeto_id: 'projeto-sintetico-01',
  escopo: { arquivos: ['README.md', 'src/relatorio.md'], permissoes: { leitura: ['README.md'], escrita: ['src/relatorio.md'], ferramentas: [] } }
});

test('prévia Codex fixa projeto, arquivos incluídos e diferença de permissões antes do aceite', t => {
  const f = fixture(t);
  const { contexto } = f.svc.preparar(solicitacao(f.acao.id));

  assert.equal(contexto.projeto.id, 'projeto-sintetico-01');
  assert.deepEqual(contexto.escopo.arquivos, ['README.md', 'src/relatorio.md']);
  assert.deepEqual(contexto.escopo.permissoes, { leitura: ['README.md'], escrita: ['src/relatorio.md'], ferramentas: [] });
  assert.deepEqual(contexto.diferenca_permissoes, { leitura: ['README.md'], escrita: ['src/relatorio.md'], ferramentas: [] });
  assert.match(contexto.digest, /^[a-f0-9]{64}$/);
});

test('aceite Codex de projeto é recusado pela biblioteca antes de criar execução ou grant', t => {
  const f = fixture(t);
  const { contexto } = f.svc.preparar(solicitacao(f.acao.id));
  const aceite = { digest: contexto.digest, projeto_id: contexto.projeto.id, fonte_id: f.acao.evento_id, escopo: contexto.escopo };
  assert.throws(() => f.svc.iniciar({ contexto_id: contexto.id, assistente: 'codex', confirmar: true,
    chave_idempotencia: 'aceite-codex-valido-01', aceite }), { code: 'CODEX_NATIVE_NOT_READY' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM lume_execucoes').get().total, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM lume_execucao_contexto_grants').get().total, 0);
});

test('retry, aceite alterado e projeto sem aceite continuam bloqueados sem efeitos', t => {
  const f = fixture(t);
  const { contexto } = f.svc.preparar(solicitacao(f.acao.id));
  const aceite = { digest: contexto.digest, projeto_id: contexto.projeto.id, fonte_id: f.acao.evento_id, escopo: contexto.escopo };
  for (const [chave_idempotencia, dados] of [
    ['aceite-codex-retry-0001', { aceite }],
    ['aceite-codex-retry-0001', { aceite }],
    ['aceite-codex-retry-0002', { aceite: { ...aceite, digest: '0'.repeat(64) } }],
    ['aceite-codex-sem-aceite', {}]
  ]) {
    assert.throws(() => f.svc.iniciar({ contexto_id: contexto.id, assistente: 'codex', confirmar: true,
      chave_idempotencia, ...dados }), { code: 'CODEX_NATIVE_NOT_READY' });
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM lume_execucoes').get().total, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM lume_execucao_contexto_grants').get().total, 0);
});

test('prazo da prévia não excede o prazo do projeto selecionado', t => {
  const f = fixture(t);
  const cincoMinutos = Date.parse('2026-09-25T15:05:00Z');
  const svc = new ExecucoesLume(f.db, { agora: () => new Date('2026-09-25T15:00:00Z'),
    resolverProjeto: id => id === 'projeto-sintetico-01' ? { id, expira: cincoMinutos, arquivosPermitidos: ['README.md', 'src/relatorio.md'] } : null });
  assert.equal(svc.preparar(solicitacao(f.acao.id)).contexto.expira_em, '2026-09-25T15:05:00.000Z');
});

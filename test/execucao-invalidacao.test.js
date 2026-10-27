import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { perfilBeta05 } from './fixtures/beta05-profile.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { prepararExecucoes } from '../src/execucao/esquema.js';
import { HASH_FONTE_SQL } from '../src/tarefas-esquema.js';
import { prepararEsquemaTranscricao } from '../src/transcricao.js';
import { Backup } from '../src/backup.js';
import { Privacidade } from '../src/privacidade.js';
import { fingerprint } from '../src/compartilhamento.js';

const GUARDAS = 'lume_execucao_contexto_guardas';
const NOW = new Date('2026-09-26T15:00:00.000Z');
const access = { clientId: 'claude-desktop', scope: { kind: 'all' }, revision: 'teste-revisao-1' };
const negado = fn => assert.throws(fn, e => ['SOURCE_CHANGED', 'SCOPE_REVOKED', 'NOT_FOUND', 'CONTEXT_EXPIRED'].includes(e.code));

function fixture(t, { disco = false, semear = true } = {}) {
  const dir = disco ? mkdtempSync(join(tmpdir(), 'lume-invalidacao-')) : null;
  const f = { dir, caminho: dir ? join(dir, 'teste.db') : ':memory:' };
  f.db = abrirBanco(f.caminho);
  const perfil = perfilBeta05(f.db, { agora: NOW, vazio: true });
  new DesktopIA(f.db);
  prepararEsquemaTranscricao(f.db);
  f.servicos = () => {
    f.acoes = new AcoesLume(f.db, { agora: () => NOW });
    f.svc = new ExecucoesLume(f.db, { agora: () => NOW });
  };
  f.servicos();
  f.add = (conversa = 'invalidacao-sintetica', texto = 'Preparar roteiro sintético para sexta-feira.') => {
    const fonte = perfil.mensagem({ conversa, texto });
    f.acoes.autorizar({ conversa, permitida: true });
    f.acoes.registrar({ eventoId: fonte.id, candidatas: [{ fonte: 'E' + fonte.id, tipo: 'pendencia', resumo: 'Preparar roteiro sintético', trecho: texto, prazo_citado: 'sexta-feira' }] });
    return { fonte, acao: f.acoes.listar().find(a => a.evento_id === fonte.id), texto };
  };
  if (semear) Object.assign(f, f.add());
  f.start = (manter = false) => {
    const { contexto } = f.svc.preparar({ acao_id: f.acao.id });
    const input = { contexto_id: contexto.id, assistente: 'claude', confirmar: true, chave_idempotencia: randomUUID(), manter_contexto: manter };
    return { ...f.svc.iniciar(input), input };
  };
  f.resultado = id => f.svc.registrar('resultado', { execucao_id: id, chave_idempotencia: 'resultado-sintetico', resumo: 'Roteiro original recebido.', artefatos: ['roteiro-sintetico.md'] }, access);
  f.restart = () => { f.db.close(); f.db = abrirBanco(f.caminho); new ContextoApp(f.db); new Desktop(f.db); f.servicos(); };
  t.after(() => {
    f.db.close();
    if (dir) {
      if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error('Pasta temporária inválida');
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return f;
}

function negarOperacoes(f, r, previa) {
  const id = r.execucao.id, antes = f.db.prepare('SELECT * FROM lume_execucao_eventos WHERE execucao_id=?').all(id);
  negado(() => f.svc.obter({ id }, access));
  negado(() => f.svc.historico({ id }, access));
  negado(() => f.svc.fonteAutorizada(id, access));
  negado(() => f.svc.registrar('inicio', { execucao_id: id, chave_idempotencia: 'inicio-tardio-1' }, access));
  negado(() => f.svc.registrar('progresso', { execucao_id: id, chave_idempotencia: 'progresso-tardio-1', texto: 'Não persistir.' }, access));
  negado(() => f.svc.registrar('resultado', { execucao_id: id, chave_idempotencia: 'resultado-tardio-1', resumo: 'Não persistir.', artefatos: [] }, access));
  negado(() => f.svc.registrar('resultado', { execucao_id: id, chave_idempotencia: 'resultado-local-1', resumo: 'Não persistir.', artefatos: [] }));
  negado(() => f.svc.registrar('verificacao', { execucao_id: id, chave_idempotencia: 'verificacao-tardia-1', confirmar: true, nota: 'Não persistir.' }));
  negado(() => f.svc.iniciar(r.input));
  negado(() => f.svc.iniciar({ ...r.input, contexto_id: previa.id, chave_idempotencia: randomUUID() }));
  assert.deepEqual(f.db.prepare('SELECT * FROM lume_execucao_eventos WHERE execucao_id=?').all(id), antes);
}

test('invalidação: campos da ação A-B-A bloqueiam prévia, execução, replay e conferência sem observação intermediária', async t => {
  const mudancas = { resumo: 'Resumo alterado', trecho: 'Preparar roteiro', trecho_inicio: 1, tipo: 'compromisso', prazo_citado: '', fonte_assinatura: '0'.repeat(64) };
  for (const manter of [false, true]) for (const [campo, novo] of Object.entries(mudancas)) await t.test(`${campo}, grant=${manter}`, t => {
    const f = fixture(t), r = f.start(manter), { contexto } = f.svc.preparar({ acao_id: f.acao.id });
    const original = f.db.prepare(`SELECT ${campo} valor FROM lume_acoes WHERE id=?`).get(f.acao.id).valor;
    f.db.prepare(`UPDATE lume_acoes SET ${campo}=? WHERE id=?`).run(novo, f.acao.id);
    f.db.prepare(`UPDATE lume_acoes SET ${campo}=? WHERE id=?`).run(original, f.acao.id);
    negarOperacoes(f, r, contexto);
    const local = f.svc.obter({ id: r.execucao.id });
    assert.equal(local.execucao.contexto_invalidado, true);
    assert.equal(local.execucao.contexto_invalidado_motivo, 'acao_alterada');
    assert.equal(local.contexto.autorizacao.estado, 'invalidada');
    assert.equal(local.execucao.contexto_prazo_estado, 'invalidado');
    assert.equal(local.execucao.pode_registrar_resultado, false);
    assert.equal(local.execucao.pode_verificar, false);
    assert.equal(f.start(manter).execucao.contexto_invalidado, false);
  });
});

test('invalidação: resultado e verificação originais ficam legíveis, sem fabricar revogação ou conferir contexto obsoleto', async t => {
  for (const verificar of [false, true]) await t.test(`já verificado=${verificar}`, t => {
    const f = fixture(t), r = f.start(); f.resultado(r.execucao.id);
    if (verificar) f.svc.registrar('verificacao', { execucao_id: r.execucao.id, chave_idempotencia: 'verificacao-original', confirmar: true, nota: 'Conferido antes de corrigir.' });
    const row = f.db.prepare('SELECT * FROM lume_execucoes WHERE id=?').get(r.execucao.id);
    const historico = f.svc.historico({ id: r.execucao.id });
    f.acoes.corrigir({ id: f.acao.id, resumo: 'Preparar outro material' });
    assert.deepEqual(f.db.prepare('SELECT * FROM lume_execucoes WHERE id=?').get(r.execucao.id), row);
    assert.deepEqual(f.svc.historico({ id: r.execucao.id }), historico);
    const local = f.svc.obter({ id: r.execucao.id });
    assert.equal(local.contexto.tarefa, 'Preparar roteiro sintético');
    assert.equal(local.execucao.estado, verificar ? 'verificado' : 'resultado_informado');
    assert.equal(local.execucao.verificacao, verificar ? 'verificado_pelo_usuario' : 'nao_verificado');
    assert.equal(local.execucao.timeline.find(e => e.tipo === 'resultado').verificacao, 'informado');
    assert.equal(f.svc.listar({ acao_id: f.acao.id }).execucoes.length, 1);
    assert.equal(local.execucao.pode_verificar, false);
    negado(() => f.resultado(r.execucao.id));
  });
});

test('invalidação: estado, responsabilidade, lembrete e atualização sem mudança não revogam', t => {
  const f = fixture(t), r = f.start(true);
  f.db.prepare("UPDATE lume_acoes SET estado='confirmado',responsavel_id='local:owner',resumo=resumo,atualizada_em=? WHERE id=?").run(NOW.toISOString(), f.acao.id);
  f.db.prepare('UPDATE lume_acoes_conversas SET autorizada_em=autorizada_em WHERE conversa_id=?').run(f.fonte.conversa);
  f.db.prepare("UPDATE lume_acoes SET estado='estacionado',lembrar_em='2026-09-28T10:00:00Z',fuso='America/Sao_Paulo' WHERE id=?").run(f.acao.id);
  assert.equal(f.svc.obter({ id: r.execucao.id }, access).execucao.contexto_invalidado, false);
  f.resultado(r.execucao.id);
  assert.equal(f.svc.obter({ id: r.execucao.id }).execucao.pode_verificar, true);
});

test('invalidação: fonte, leitura, política e consentimento A-B-A persistem após reinício real', async t => {
  const mudancas = {
    fonte: f => { f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto temporário.', f.fonte.id); f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(f.texto, f.fonte.id); },
    leitura: f => { f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(f.fonte.id); f.db.prepare("UPDATE eventos SET permissao='dirigida' WHERE id=?").run(f.fonte.id); },
    politica: f => { f.db.prepare("INSERT INTO politicas_conversa VALUES(?,'tudo',?)").run(f.fonte.conversa, NOW.toISOString()); f.db.prepare('DELETE FROM politicas_conversa WHERE conversa_id=?').run(f.fonte.conversa); },
    consentimento: f => { f.db.prepare('UPDATE lume_acoes_conversas SET inicio_evento_id=inicio_evento_id+1 WHERE conversa_id=?').run(f.fonte.conversa); f.db.prepare('UPDATE lume_acoes_conversas SET inicio_evento_id=inicio_evento_id-1 WHERE conversa_id=?').run(f.fonte.conversa); }
  };
  for (const [nome, mudar] of Object.entries(mudancas)) await t.test(nome, t => {
    const f = fixture(t, { disco: true }), r = f.start(), { contexto } = f.svc.preparar({ acao_id: f.acao.id });
    mudar(f); const guarda = f.svc.guarda(contexto.id); f.restart(); prepararExecucoes(f.db);
    assert.deepEqual(f.svc.guarda(contexto.id), guarda);
    negarOperacoes(f, r, contexto);
    assert.equal(f.svc.obter({ id: r.execucao.id }).execucao.contexto_invalidado, true);
  });
});

test('invalidação: alteração da fonte bloqueia todas as leituras locais e outra fonte legível não substitui a original', t => {
  const f = fixture(t), outro = f.add('outra-sintetica', 'Preparar outro roteiro para sexta-feira.'), r = f.start();
  f.resultado(r.execucao.id);
  const assinatura = f.db.prepare(`SELECT ${HASH_FONTE_SQL} assinatura FROM desktop_fontes e WHERE id=?`).get(outro.fonte.id).assinatura;
  f.db.prepare('UPDATE lume_acoes SET evento_id=?,fonte_assinatura=? WHERE id=?').run(outro.fonte.id, assinatura, f.acao.id);
  assert.equal(f.svc.obter({ id: r.execucao.id }).contexto.fontes[0].trecho, f.texto);
  // Mesmo restringir a fonte atual da ação não expõe nada dela no histórico anterior.
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(outro.fonte.id);
  assert.equal(f.svc.listar({ acao_id: f.acao.id }).execucoes.length, 1);
  f.db.prepare("UPDATE eventos SET texto='Fonte original corrigida.' WHERE id=?").run(f.fonte.id);
  negado(() => f.svc.obter({ id: r.execucao.id }));
  negado(() => f.svc.historico({ id: r.execucao.id }));
  negado(() => f.svc.listar({ acao_id: f.acao.id }));
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(f.texto, f.fonte.id);
  assert.equal(f.svc.obter({ id: r.execucao.id }).execucao.contexto_invalidado, true);
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(f.fonte.id);
  negado(() => f.svc.obter({ id: r.execucao.id }));
});

test('invalidação: remoção/reinserção de procedência F10 não restaura autorização nem burla ACL', t => {
  const f = fixture(t), key = generateKeyPairSync('ed25519'), fp = fingerprint(key.publicKey), projeto = randomUUID(), pacote = randomUUID();
  f.db.prepare('INSERT INTO f10_projetos VALUES(?,?,?)').run(projeto, 'Projeto sintético', NOW.toISOString());
  f.db.prepare('INSERT INTO f10_origens VALUES(?,?,?,?)').run(fp, 'Pessoa sintética', 'Máquina sintética', key.publicKey.export({ type: 'spki', format: 'pem' }));
  const inserir = () => f.db.prepare('INSERT INTO f10_procedencias VALUES(?,?,?,?,?,?,?,?)').run(f.fonte.id, fp, pacote, projeto, NOW.toISOString(), NOW.toISOString(), null, null);
  inserir();
  f.db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE id=?").run(f.fonte.id);
  const assinatura = f.db.prepare(`SELECT ${HASH_FONTE_SQL} assinatura FROM desktop_fontes e WHERE id=?`).get(f.fonte.id).assinatura;
  f.db.prepare('UPDATE lume_acoes SET fonte_assinatura=? WHERE id=?').run(assinatura, f.acao.id);
  const r = f.start(), { contexto } = f.svc.preparar({ acao_id: f.acao.id }); f.resultado(r.execucao.id);
  f.db.prepare('DELETE FROM f10_procedencias WHERE evento_id=?').run(f.fonte.id);
  negado(() => f.svc.obter({ id: r.execucao.id }));
  inserir(); negarOperacoes(f, r, contexto);
  assert.equal(f.svc.obter({ id: r.execucao.id }).execucao.contexto_invalidado_motivo, 'procedencia_alterada');
});

test('invalidação: transcrição e snapshot A-B-A invalidam autorizações sem grant', async t => {
  for (const alvo of ['transcricao', 'snapshot']) await t.test(alvo, t => {
    const f = fixture(t), r = f.start(), { contexto } = f.svc.preparar({ acao_id: f.acao.id });
    if (alvo === 'transcricao') {
      f.db.prepare("INSERT INTO transcricoes(conversa_id,origem_id,texto,estado,criado_em) VALUES(?,?,'Texto temporário.','transcrito',?)").run(f.fonte.conversa, f.fonte.origem, NOW.toISOString());
      f.db.prepare('DELETE FROM transcricoes WHERE conversa_id=?').run(f.fonte.conversa);
    } else {
      for (const id of [r.input.contexto_id, contexto.id]) {
        const salvo = f.db.prepare('SELECT pacote FROM lume_execucao_contextos WHERE id=?').get(id).pacote;
        const alterado = JSON.parse(salvo); alterado.tarefa = 'Snapshot adulterado.';
        f.db.prepare('UPDATE lume_execucao_contextos SET pacote=? WHERE id=?').run(JSON.stringify(alterado), id);
        if (id === r.input.contexto_id) negado(() => f.svc.obter({ id: r.execucao.id }));
        f.db.prepare('UPDATE lume_execucao_contextos SET pacote=? WHERE id=?').run(salvo, id);
      }
    }
    negarOperacoes(f, r, contexto);
  });
});

test('invalidação: guarda legada migra sem autoridade, inicialização repete sem alterar evidência e falha é atômica', t => {
  const f = fixture(t), r = f.start(); f.resultado(r.execucao.id);
  const dados = f.db.prepare('SELECT * FROM lume_execucoes').all();
  f.db.exec(`DROP TABLE ${GUARDAS}`);
  // Simula falha após CREATE e durante o backfill: toda DDL deve voltar.
  const proxy = new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return sql => { if (sql.includes('WHERE g.contexto_id IS NULL')) throw Error('falha sintética de migração'); return target.prepare(sql); };
    const v = Reflect.get(target, key); return typeof v === 'function' ? v.bind(target) : v;
  } });
  assert.throws(() => prepararExecucoes(proxy), /falha sintética/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(GUARDAS), undefined);
  prepararExecucoes(f.db);
  const guarda = f.svc.guarda(r.input.contexto_id); prepararExecucoes(f.db);
  assert.deepEqual(f.svc.guarda(r.input.contexto_id), guarda);
  assert.deepEqual(f.db.prepare('SELECT * FROM lume_execucoes').all(), dados);
  assert.equal(guarda.motivo, 'migracao_sem_rastreio');
  assert.equal(f.svc.obter({ id: r.execucao.id }).execucao.estado, 'resultado_informado');
  negado(() => f.svc.obter({ id: r.execucao.id }, access));
  assert.equal(f.start().execucao.contexto_invalidado, false);
});

test('invalidação: guarda não amplia scope e titular pode conferir depois de vencer só o prazo', t => {
  const f = fixture(t), r = f.start();
  negado(() => f.svc.obter({ id: r.execucao.id }, { ...access, scope: { kind: 'conversations', ids: ['outra'] } }));
  negado(() => f.svc.obter({ id: r.execucao.id }, { ...access, clientId: 'codex' }));
  assert.equal(f.svc.obter({ id: r.execucao.id }, access).execucao.contexto_invalidado, false);
  const kept = f.start(true); f.svc.agora = () => new Date('2026-10-05T15:00:00Z');
  f.svc.registrar('resultado', { execucao_id: kept.execucao.id, chave_idempotencia: 'resultado-local-expirado', resumo: 'Recebido localmente.', artefatos: [] });
  assert.equal(f.svc.obter({ id: kept.execucao.id }).execucao.pode_verificar, true);
});

test('invalidação: duas restaurações preservam resultado corrigido e nunca transferem guarda ou grant', async t => {
  let f = fixture(t); const r = f.start(true); f.resultado(r.execucao.id);
  f.acoes.corrigir({ id: f.acao.id, resumo: 'Tarefa corrigida depois do retorno' });
  const outro = f.add('outra-importacao', 'Preparar outro roteiro para sexta-feira.');
  const assinatura = f.db.prepare(`SELECT ${HASH_FONTE_SQL} assinatura FROM desktop_fontes e WHERE id=?`).get(outro.fonte.id).assinatura;
  f.db.prepare('UPDATE lume_acoes SET evento_id=?,fonte_assinatura=? WHERE id=?').run(outro.fonte.id, assinatura, f.acao.id);
  const fonteOriginal = f.fonte.id;
  const senha = 'senha-somente-sintetica';
  for (let i = 0; i < 2; i++) {
    const backup = new Backup(f.db), raw = backup.capturar(); backup.validar(raw);
    assert.equal(Object.hasOwn(raw.tabelas, GUARDAS), false);
    assert.equal(Object.hasOwn(raw.tabelas, 'lume_execucao_contexto_grants'), false);
    const criado = await backup.criar({ senha, confirmar: true });
    const destino = fixture(t, { semear: false }), receptor = new Backup(destino.db);
    const previa = await receptor.preparar({ arquivo: JSON.stringify(criado.pacote), senha });
    receptor.restaurar({ id: previa.id, confirmarMeuBackup: true });
    destino.acoes.autorizar({ conversa: 'invalidacao-sintetica', permitida: true });
    destino.acoes.autorizar({ conversa: 'outra-importacao', permitida: true });
    const local = destino.svc.obter({ id: r.execucao.id });
    assert.equal(local.execucao.historico_importado, true);
    assert.equal(local.execucao.contexto_invalidado_em, destino.db.prepare("SELECT importado_em FROM lume_ciclo_importacoes WHERE tabela='lume_execucao_contextos' AND registro_id=?").get(r.input.contexto_id).importado_em);
    assert.ok(local.execucao.timeline.some(e => e.tipo === 'resultado' && e.resumo === 'Roteiro original recebido.'));
    assert.equal(local.execucao.pode_verificar, false);
    assert.equal(local.execucao.pode_registrar_resultado, false);
    assert.equal(new Privacidade(destino.db).preparar({ fonte: fonteOriginal }).contagens.lume_execucoes, 1);
    negado(() => destino.svc.obter({ id: r.execucao.id }, access));
    negado(() => destino.svc.iniciar({ ...r.input, chave_idempotencia: randomUUID() }));
    prepararExecucoes(destino.db);
    for (const [tabela, registro] of [['lume_execucoes', r.execucao.id], ['lume_execucao_contextos', r.input.contexto_id]]) {
      const recibo = destino.db.prepare('SELECT * FROM lume_ciclo_importacoes WHERE tabela=? AND registro_id=?').get(tabela, registro);
      destino.db.prepare('DELETE FROM lume_ciclo_importacoes WHERE tabela=? AND registro_id=?').run(tabela, registro);
      negado(() => destino.svc.obter({ id: r.execucao.id }));
      negado(() => destino.svc.historico({ id: r.execucao.id }));
      assert.equal(destino.svc.listar({ acao_id: r.execucao.acao_id }).execucoes.length, 0);
      destino.db.prepare('INSERT INTO lume_ciclo_importacoes VALUES(?,?,?,?,?)')
        .run(recibo.tabela, recibo.registro_id, '0'.repeat(64), recibo.importado_em, recibo.estado_original);
      negado(() => destino.svc.obter({ id: r.execucao.id }));
      destino.db.prepare('UPDATE lume_ciclo_importacoes SET backup_sha256=? WHERE tabela=? AND registro_id=?')
        .run(recibo.backup_sha256, tabela, registro);
      assert.equal(destino.svc.obter({ id: r.execucao.id }).execucao.historico_importado, true);
    }
    f = destino;
  }
});

test('invalidação: direitos de dados alcançam a fonte original depois de trocar vínculo da ação', t => {
  const f = fixture(t), outro = f.add('outra-privacidade', 'Preparar outro roteiro para sexta-feira.'), r = f.start();
  f.resultado(r.execucao.id);
  const assinatura = f.db.prepare(`SELECT ${HASH_FONTE_SQL} assinatura FROM desktop_fontes e WHERE id=?`).get(outro.fonte.id).assinatura;
  f.db.prepare('UPDATE lume_acoes SET evento_id=?,fonte_assinatura=? WHERE id=?').run(outro.fonte.id, assinatura, f.acao.id);
  const p = new Privacidade(f.db); assert.doesNotThrow(() => p.schemaConhecido());
  assert.equal(p.exportar({ conversa: outro.fonte.conversa, confirmar: true }).conteudo.derivados.lume_execucoes.length, 0);
  const previa = p.preparar({ fonte: f.fonte.id });
  assert.equal(previa.contagens.lume_execucoes, 1);
  p.excluir({ id: previa.id, confirmar: 'APAGAR' });
  assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${GUARDAS}`).get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 0);
  assert.ok(f.db.prepare('SELECT 1 FROM eventos WHERE id=?').get(outro.fonte.id));
});

test('privacidade: histórico legado sem fonte rastreável não é apagado pela exclusão de outra conversa', t => {
  const f = fixture(t), r = f.start(); f.resultado(r.execucao.id);
  f.db.prepare("UPDATE eventos SET texto='Fonte corrigida antes da migração.' WHERE id=?").run(f.fonte.id);
  f.db.exec(`DROP TABLE ${GUARDAS}`); prepararExecucoes(f.db);
  assert.equal(f.svc.guarda(r.input.contexto_id).evento_id, null);
  const outro = f.add('conversa-independente', 'Preparar outra atividade na sexta-feira.');
  const p = new Privacidade(f.db), previa = p.preparar({ fonte: outro.fonte.id });
  assert.equal(previa.contagens.lume_execucoes, 0);
  p.excluir({ id: previa.id, confirmar: 'APAGAR' });
  assert.ok(f.db.prepare('SELECT 1 FROM lume_execucoes WHERE id=?').get(r.execucao.id));
  const propria = p.preparar({ fonte: f.fonte.id });
  assert.equal(propria.contagens.lume_execucoes, 1);
  p.excluir({ id: propria.id, confirmar: 'APAGAR' });
  assert.equal(f.db.prepare('SELECT 1 FROM lume_execucoes WHERE id=?').get(r.execucao.id), undefined);
});

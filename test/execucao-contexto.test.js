import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { createLumeMcpCore } from '../src/mcp/core.js';
import { criarServidor } from '../src/painel/servidor.js';
import { HistoricoWhatsApp } from '../src/transporte/historico.js';
import { startFromEnvironment } from '../src/mcp/stdio-entry.js';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';
import { lumePresencePath, startLumeAppPresence } from '../src/mcp/presence.js';
import { startBrokerApp } from './fixtures/mcp-broker-app.js';

function fixture(t) {
  const dir = mkdtempSync(join(homedir(), 'lume-execucao-sintetica-')), caminho = join(dir, 'data', 'assessor.db');
  mkdirSync(join(dir, 'data'));
  const f = { dir, caminho, db: abrirBanco(caminho), now: new Date('2026-09-25T15:00:00Z') };
  t.after(async () => {
    if (f.server) await new Promise(resolve => f.server.close(resolve));
    f.db.close();
    if (!resolve(dir).startsWith(resolve(homedir()) + sep)) throw Error('Pasta temporária inválida');
    rmSync(dir, { recursive: true, force: true });
  });
  new ContextoApp(f.db); f.desktop = new Desktop(f.db);
  f.acoes = new AcoesLume(f.db, { agora: () => f.now });
  f.add = (conversa = 'sintetico@g.us', texto = 'Preparar proposta para a reunião de teste.') => {
    f.db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(conversa, conversa === 'sintetico@g.us' ? 'Cliente sintético' : 'Outro cliente sintético');
    const fonte = Number(f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
      VALUES(?,?,'entrada','texto','{}',?,'2026-09-25T14:00:00Z','2026-09-25','minha',1)`).run(conversa, 'origem-' + Math.random(), texto).lastInsertRowid);
    f.acoes.autorizar({ conversa, permitida: true });
    f.acoes.registrar({ eventoId: fonte, candidatas: [{ fonte: 'E' + fonte, tipo: 'pendencia', resumo: 'Preparar proposta sintética', trecho: texto, prazo_citado: '' }] });
    const acao = f.acoes.listar().find(x => x.evento_id === fonte);
    return { acao, fonte };
  };
  Object.assign(f, f.add());
  f.svc = new ExecucoesLume(f.db, { agora: () => f.now });
  f.start = (assistente = 'claude', acao_id = f.acao.id, key = 'inicio-teste-0001') => {
    const { contexto } = f.svc.preparar({ acao_id });
    return f.svc.iniciar({ contexto_id: contexto.id, assistente, confirmar: true, chave_idempotencia: key });
  };
  return f;
}

test('Resolver: contexto limitado e migração aditiva preservam os dados legados', t => {
  const f = fixture(t);
  f.add('outro@g.us', 'SEGREDO SINTETICO FORA DO RECORTE.');
  const antes = f.db.prepare('SELECT * FROM eventos ORDER BY id').all();
  new ExecucoesLume(f.db); new ExecucoesLume(f.db);
  assert.deepEqual(f.db.prepare('SELECT * FROM eventos ORDER BY id').all(), antes);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucao_migracoes').get().n, 1);
  const { contexto } = f.svc.preparar({ acao_id: f.acao.id });
  assert.equal(contexto.fontes.length, 1);
  assert.equal(contexto.autorizacao.estado, 'pendente');
  assert.equal(contexto.autorizacao.envio, false);
  assert.ok(!JSON.stringify(contexto).includes('SEGREDO SINTETICO'));
  assert.ok(!JSON.stringify(contexto).includes('@g.us'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 0);
});

test('Resolver: início e retornos são idempotentes, com conflitos explícitos e resultado separado de verificação', t => {
  const f = fixture(t), { contexto } = f.svc.preparar({ acao_id: f.acao.id });
  const input = { contexto_id: contexto.id, assistente: 'claude', confirmar: true, chave_idempotencia: 'inicio-teste-0001' };
  const first = f.svc.iniciar(input), again = f.svc.iniciar(input);
  assert.equal(first.execucao.id, again.execucao.id); assert.equal(again.repetido, true);
  assert.equal(first.execucao.estado, 'aguardando_assistente');
  assert.throws(() => f.svc.iniciar({ ...input, assistente: 'codex' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const execucao_id = first.execucao.id;
  const progress = { execucao_id, chave_idempotencia: 'progresso-0001', texto: 'Relatório em preparação.' };
  f.svc.registrar('progresso', progress);
  assert.equal(f.svc.registrar('progresso', progress).repetido, true);
  assert.throws(() => f.svc.registrar('progresso', { ...progress, texto: 'Outro relato.' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const result = { execucao_id, chave_idempotencia: 'resultado-0001', resumo: 'Documento preparado.', artefatos: ['proposta-sintetica.md'] };
  let r = f.svc.registrar('resultado', result);
  assert.equal(r.execucao.estado, 'resultado_informado'); assert.equal(r.execucao.verificacao, 'nao_verificado');
  assert.equal(f.svc.registrar('resultado', result).repetido, true);
  assert.equal(f.acoes.obter(f.acao.id).estado, 'sugerido');
  assert.throws(() => f.svc.registrar('progresso', { ...progress, chave_idempotencia: 'depois-resultado' }), { code: 'INVALID_STATE' });
  r = f.svc.registrar('verificacao', { execucao_id, chave_idempotencia: 'verificar-0001', confirmar: true, nota: 'Conferi o documento sintético.' });
  assert.equal(r.execucao.verificacao, 'verificado_pelo_usuario');
  assert.equal(r.execucao.timeline.find(x => x.tipo === 'resultado').verificacao, 'informado');
  assert.equal(f.acoes.obter(f.acao.id).estado, 'sugerido');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucao_eventos').get().n, 4);
  f.db.prepare("UPDATE lume_acoes SET estado='resolvido' WHERE id=?").run(f.acao.id);
  assert.equal(f.svc.obter({ id: execucao_id }).execucao.estado, 'verificado');
  assert.throws(() => f.svc.iniciar({ ...input, chave_idempotencia: 'inicio-depois-resolvido' }), { code: 'INVALID_STATE' });
});

test('Resolver: confirma autorização, campos fechados, limites e transições antes de persistir', t => {
  const f = fixture(t), { contexto } = f.svc.preparar({ acao_id: f.acao.id });
  const input = { contexto_id: contexto.id, assistente: 'claude', confirmar: true, chave_idempotencia: 'inicio-teste-0001' };
  for (const x of [{ ...input, confirmar: false }, { ...input, assistente: 'desconhecido' }, { ...input, enviar: true }, { ...input, chave_idempotencia: '' }]) assert.throws(() => f.svc.iniciar(x), { code: 'INVALID_INPUT' });
  const { execucao } = f.svc.iniciar(input);
  assert.throws(() => f.svc.registrar('verificacao', { execucao_id: execucao.id, chave_idempotencia: 'verificar-0001', confirmar: true, nota: 'Não houve resultado.' }), { code: 'INVALID_STATE' });
  assert.throws(() => f.svc.registrar('progresso', { execucao_id: execucao.id, chave_idempotencia: 'progresso-0001', texto: 'x'.repeat(1001) }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.svc.registrar('resultado', { execucao_id: execucao.id, chave_idempotencia: 'resultado-0001', resumo: 'Declarado', artefatos: [], verificado: true }), { code: 'INVALID_INPUT' });
  assert.equal(f.svc.obter({ id: execucao.id }).execucao.timeline.length, 1);
});

test('Resolver: prévia expira e edição da ação invalida contexto', t => {
  const f = fixture(t), { contexto } = f.svc.preparar({ acao_id: f.acao.id });
  const input = { contexto_id: contexto.id, assistente: 'claude', confirmar: true, chave_idempotencia: 'inicio-teste-0001' };
  f.now = new Date(f.now.getTime() + 16 * 60000);
  assert.throws(() => f.svc.iniciar(input), { code: 'CONTEXT_EXPIRED' });
  f.db.prepare("UPDATE lume_acoes SET resumo='Tarefa foi alterada' WHERE id=?").run(f.acao.id);
  assert.throws(() => f.svc.iniciar(input), { code: 'SOURCE_CHANGED' });
});

test('Resolver: fonte alterada, política restrita e revogação impedem acesso e retorno, inclusive replay', t => {
  const f = fixture(t), r = f.start(), execucao_id = r.execucao.id;
  const progress = { execucao_id, chave_idempotencia: 'progresso-0001', texto: 'Em preparação.' };
  f.svc.registrar('progresso', progress);
  f.db.prepare("UPDATE eventos SET texto='Fonte corrigida.' WHERE id=?").run(f.fonte);
  assert.throws(() => f.svc.obter({ id: execucao_id }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => f.svc.registrar('progresso', progress), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(f.svc.revogar({ execucao_id, confirmar: true }).execucao.estado, 'revogada');
  assert.throws(() => f.svc.registrar('progresso', progress), { code: 'SCOPE_REVOKED' });
  assert.equal(f.svc.revogar({ execucao_id, confirmar: true }).execucao.estado, 'revogada');
});

test('Resolver: revogar organização e excluir fonte removem contextos derivados por cascata', t => {
  const f = fixture(t); f.start();
  f.acoes.autorizar({ conversa: 'sintetico@g.us', permitida: false });
  for (const table of ['lume_execucao_contextos', 'lume_execucoes', 'lume_execucao_eventos']) assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  const outro = f.add('novo@g.us', 'Preparar outro material sintético.');
  f.start('hermes', outro.acao.id, 'inicio-outro-0001');
  f.db.prepare('DELETE FROM eventos WHERE id=?').run(outro.fonte);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 0);
});

test('Resolver: titular consulta resultado após revogar assistente, sem permitir novo retorno ou fonte revogada', t => {
  const f=fixture(t),{execucao}=f.start('codex'),execucao_id=execucao.id;
  const acesso={clientId:'codex',scope:{kind:'all'}};
  f.svc.registrar('resultado',{execucao_id,chave_idempotencia:'resultado-audit-0001',resumo:'Material sintético entregue.',artefatos:['revisao.md']},acesso);
  f.svc.revogar({execucao_id,confirmar:true});
  const lido=f.svc.obter({id:execucao_id});
  assert.equal(lido.contexto.autorizacao.estado,'revogada');
  assert.match(JSON.stringify(lido.execucao.timeline),/Material sintético entregue/);
  assert.ok(f.svc.historico({id:execucao_id}).timeline.some(x=>x.tipo==='resultado'));
  assert.ok(f.svc.listar({acao_id:f.acao.id}).execucoes[0].timeline.some(x=>x.tipo==='revogacao'));
  for(const clientId of ['codex','claude-desktop','hermes']){
    assert.throws(()=>f.svc.obter({id:execucao_id},{clientId,scope:{kind:'all'}}),{code:'SCOPE_REVOKED'});
    assert.throws(()=>f.svc.historico({id:execucao_id},{clientId,scope:{kind:'all'}}),{code:'SCOPE_REVOKED'});
  }
  assert.throws(()=>f.svc.registrar('verificacao',{execucao_id,chave_idempotencia:'verificar-revogada',confirmar:true,nota:'Não autorizado.'}),{code:'SCOPE_REVOKED'});
  f.db.prepare("UPDATE eventos SET texto='Fonte alterada após revogação.' WHERE id=?").run(f.fonte);
  assert.throws(()=>f.svc.obter({id:execucao_id}),{code:'SOURCE_CHANGED'});
  assert.throws(()=>f.svc.historico({id:execucao_id}),{code:'SOURCE_CHANGED'});
  assert.throws(()=>f.svc.listar({acao_id:f.acao.id}),{code:'SOURCE_CHANGED'});
});

test('Resolver: execução persiste ao reabrir perfil, com replay depois do prazo da prévia', t => {
  const f = fixture(t), r = f.start();
  const input = { execucao_id: r.execucao.id, chave_idempotencia: 'resultado-0001', resumo: 'Preparado em teste.', artefatos: [] };
  f.svc.registrar('resultado', input);
  f.db.close(); f.db = abrirBanco(f.caminho); new ContextoApp(f.db); new Desktop(f.db);
  f.now = new Date(f.now.getTime() + 86400000);
  f.svc = new ExecucoesLume(f.db, { agora: () => f.now });
  const loaded = f.svc.obter({ id: r.execucao.id });
  assert.equal(loaded.execucao.estado, 'resultado_informado');
  assert.equal(f.svc.registrar('resultado', input).repetido, true);
});

test('Resolver: timeline paginável, limitada e revalidada em cada página', t => {
  const f = fixture(t), { execucao } = f.start();
  for (let i = 0; i < 25; i++) f.svc.registrar('progresso', { execucao_id: execucao.id, chave_idempotencia: 'progresso-' + i, texto: 'Etapa sintética ' + i });
  assert.equal(f.svc.obter({ id: execucao.id }).execucao.timeline.length, 20);
  const first = f.svc.historico({ id: execucao.id, limite: 20 });
  const second = f.svc.historico({ id: execucao.id, antes: first.antes });
  assert.equal(first.timeline.length, 20); assert.equal(second.timeline.length, 6); assert.equal(second.antes, null);
  assert.equal(new Set([...first.timeline, ...second.timeline].map(x => x.id)).size, 26);
  f.db.prepare("UPDATE politicas_conversa SET politica='so-minhas',atualizado_em='2026-09-25T16:00:00Z' WHERE conversa_id='sintetico@g.us'").run();
  // Mudar a política invalida a autoridade, sem apagar a auditoria local de uma fonte ainda legível.
  f.db.prepare("INSERT OR REPLACE INTO politicas_conversa VALUES('sintetico@g.us','so-minhas','2026-09-25T16:00:00Z')").run();
  assert.deepEqual(f.svc.historico({ id: execucao.id, antes: first.antes }), second);
  const historico = f.svc.obter({ id: execucao.id });
  assert.equal(historico.execucao.contexto_invalidado, true);
  assert.equal(historico.contexto.autorizacao.estado, 'invalidada');
  assert.equal(historico.execucao.pode_registrar_resultado, false);
  assert.equal(historico.execucao.pode_verificar, false);
  assert.throws(() => f.svc.historico({ id: execucao.id, antes: first.antes }, { clientId: 'claude-desktop', scope: { kind: 'all' } }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => f.svc.registrar('progresso', { execucao_id: execucao.id, chave_idempotencia: 'progresso-obsoleto', texto: 'Não pode continuar.' }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => f.svc.registrar('verificacao', { execucao_id: execucao.id, chave_idempotencia: 'verificacao-obsoleta', confirmar: true, nota: 'Não pode confirmar.' }), { code: 'SOURCE_CHANGED' });
  // Acesso local também é fechado quando a própria fonte deixa de estar autorizada.
  f.db.prepare("UPDATE eventos SET permissao='terceiro',autor_e_dono=0 WHERE id=?").run(f.fonte);
  assert.throws(() => f.svc.historico({ id: execucao.id, antes: first.antes }), { code: 'SOURCE_CHANGED' });
});

test('MCP: ações atuais entram nas pendências com paginação de múltiplas ações da mesma fonte', async t => {
  const f = fixture(t);
  f.acoes.registrar({ eventoId: f.fonte, candidatas: [
    { fonte: 'E' + f.fonte, tipo: 'pendencia', resumo: 'Uma segunda ação sintética', trecho: 'Preparar proposta', prazo_citado: '' },
    { fonte: 'E' + f.fonte, tipo: 'compromisso', resumo: 'Uma terceira ação sintética', trecho: 'reunião de teste.', prazo_citado: '' }
  ] });
  const origem = f.db.prepare('SELECT origem_id FROM eventos WHERE id=?').get(f.fonte).origem_id;
  f.db.prepare("INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,estado,extraido_em) VALUES('sintetico@g.us',?,'pendencia','Pendência CRM sintética','aberto','2026-09-25T15:00:00Z')").run(origem);
  const core = createLumeMcpCore({ db: f.db, agora: () => f.now, authorize: async () => ({ enabled: true, revision: '1', scope: { kind: 'all' } }) });
  const context = { clientId: 'claude-desktop', credential: 'sintetica' }, items = []; let cursor;
  do {
    const r = await core.executar('lume_listar_pendencias', { limit: 1, ...(cursor ? { cursor } : {}) }, context);
    assert.equal(r.ok, true, JSON.stringify(r)); items.push(...r.items); cursor = r.next_cursor;
    assert.ok(items.length <= 4);
  } while (cursor);
  assert.equal(items.length, 4); assert.equal(new Set(items.map(x => x.summary)).size, 4);
  assert.equal(items.filter(x => x.action_id).length, 3);
  const original = core.read.revalidar.bind(core.read); let mudou = false;
  core.read.revalidar = (row, scope) => {
    if (!mudou && row._kind === 'action') { mudou = true; f.db.prepare("UPDATE lume_acoes SET estado='resolvido' WHERE id=?").run(row._ref); }
    return original(row, scope);
  };
  assert.equal((await core.executar('lume_listar_pendencias', {}, context)).error.code, 'SOURCE_CHANGED');
});

test('MCP: busca preserva termo no fim da fonte longa e avisa sobre trecho parcial', async t => {
  const f = fixture(t), text = 'Introdução sintética. '.repeat(100) + 'DECISAOX: cancelar o compromisso anterior.';
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(text, f.fonte);
  const core = createLumeMcpCore({ db: f.db, agora: () => f.now, authorize: async () => ({ enabled: true, revision: '1', scope: { kind: 'all' } }) });
  const context = { clientId: 'claude-desktop', credential: 'sintetica' };
  const r = await core.executar('lume_buscar_contexto', { question: 'DECISAOX' }, context);
  assert.equal(r.ok, true); assert.match(r.items[0].summary, /DECISAOX: cancelar/); assert.equal(r.items[0].excerpt_truncated, true); assert.equal(r.warnings.length, 1);
  const source = await core.executar('lume_abrir_fonte', { source_id: r.items[0].source_ids[0] }, context);
  assert.match(source.source.excerpt, /DECISAOX: cancelar/); assert.equal(source.warnings.length, 1);
  assert.ok(source.source.excerpt.length <= 1200);
});

test('Resolver MCP: somente o cliente e recorte autorizados recebem contexto e podem relatar', async t => {
  const f = fixture(t), { execucao } = f.start();
  let state = { enabled: true, revision: '1', scope: { kind: 'all' } }, authCalls = 0;
  const core = createLumeMcpCore({ db: f.db, execucoes: f.svc, agora: () => f.now, authorize: async () => { authCalls++; return structuredClone(state); } });
  const context = { clientId: 'claude-desktop', credential: 'sintetica' };
  assert.equal(core.tools().length, 9);
  assert.ok(!core.tools().some(x => /verificar|autorizar/.test(x.name)));
  let r = await core.executar('lume_obter_contexto_execucao', { execucao_id: execucao.id }, context);
  assert.equal(r.ok, true); assert.equal(r.contexto.execucao_id, execucao.id);
  const sourceId = r.contexto.fontes[0].source_id;
  assert.ok(sourceId.startsWith('src_'));
  assert.equal((await core.executar('lume_abrir_fonte', { source_id: sourceId }, context)).ok, true);
  r = await core.executar('lume_obter_contexto_execucao', { execucao_id: execucao.id }, { ...context, clientId: 'hermes' });
  assert.equal(r.error.code, 'SCOPE_REVOKED');
  state.scope = { kind: 'conversations', ids: ['outro@g.us'] };
  r = await core.executar('lume_obter_contexto_execucao', { execucao_id: execucao.id }, context);
  assert.equal(r.error.code, 'SOURCE_CHANGED'); assert.ok(!JSON.stringify(r).includes('Preparar proposta'));
  state.scope = { kind: 'all' };
  r = await core.executar('lume_iniciar_execucao', { execucao_id: execucao.id, chave_idempotencia: 'inicio-mcp-0001' }, context);
  assert.equal(r.execucao.estado, 'em_andamento');
  const result = { execucao_id: execucao.id, chave_idempotencia: 'resultado-mcp-0001', resumo: 'Preparado no assistente sintético.', artefatos: [] };
  r = await core.executar('lume_registrar_resultado', result, context);
  assert.equal(r.execucao.estado, 'resultado_informado');
  assert.equal(r.execucao.timeline.at(-1).ator, 'claude-desktop');
  assert.equal((await core.executar('lume_registrar_resultado', result, context)).repetido, true);
  state.enabled = false; state.revoked = true;
  r = await core.executar('lume_registrar_resultado', result, context);
  assert.equal(r.error.code, 'SCOPE_REVOKED'); assert.ok(authCalls >= 10);
  state.enabled = true; state.revoked = false;
  f.svc.revogar({ execucao_id: execucao.id, confirmar: true });
  assert.equal((await core.executar('lume_abrir_fonte', { source_id: sourceId }, context)).error.code, 'SOURCE_CHANGED');
});

test('Resolver MCP: revogação entre autenticações impede qualquer escrita', async t => {
  const f = fixture(t), { execucao } = f.start(); let calls = 0;
  const core = createLumeMcpCore({ db: f.db, execucoes: f.svc, authorize: async () => ({ enabled: ++calls === 1, revoked: calls > 1, revision: '1', scope: { kind: 'all' } }) });
  const r = await core.executar('lume_registrar_progresso', { execucao_id: execucao.id, chave_idempotencia: 'progresso-mcp-0001', texto: 'Não persistir.' }, { clientId: 'claude-desktop', credential: 'sintetica' });
  assert.equal(r.error.code, 'SCOPE_REVOKED');
  assert.equal(f.svc.obter({ id: execucao.id }).execucao.timeline.length, 1);
});

test('Resolver HTTP: percorre contexto, execução, retorno e verificação com sessão local e erros fechados', async t => {
  const f = fixture(t);
  const server = criarServidor(f.db, { desktop: true, agoraIA: () => f.now, conexao: { estado: () => ({ estado: 'desconectada' }), parar: async () => {} } });
  f.server = server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, { token } = await (await fetch(base + '/api/sessao')).json();
  const headers = { 'x-assessor-token': token, 'content-type': 'application/json' };
  const post = (route, body, extra = {}) => fetch(base + '/api/v3/execucoes/' + route, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('contexto', { acao_id: f.acao.id })).status, 403);
  f.desktop.aceitar({ nome: 'Perfil sintético', aceito: true, versao: VERSAO_TERMOS });
  assert.equal((await fetch(base + '/api/v3/execucoes?acao_id=' + f.acao.id)).status, 403);
  assert.equal((await post('contexto', { acao_id: f.acao.id }, { origin: 'https://externo.invalid' })).status, 403);
  for (const body of [null, [], {}, { acao_id: f.acao.id, enviar: true }]) assert.equal((await post('contexto', body)).status, 400);
  const { contexto } = await (await post('contexto', { acao_id: f.acao.id })).json();
  const { execucao } = await (await post('iniciar', { contexto_id: contexto.id, assistente: 'codex', confirmar: true, chave_idempotencia: 'inicio-http-0001' })).json();
  assert.equal(execucao.estado, 'aguardando_assistente');
  let r = await (await post('resultado', { execucao_id: execucao.id, chave_idempotencia: 'resultado-http-0001', resumo: 'Documento sintético.', artefatos: [] })).json();
  assert.equal(r.execucao.verificacao, 'nao_verificado');
  r = await (await post('verificar', { execucao_id: execucao.id, chave_idempotencia: 'verificar-http-0001', confirmar: true, nota: 'Conferido em teste.' })).json();
  assert.equal(r.execucao.estado, 'verificado');
  r = await (await fetch(base + '/api/v3/execucoes?acao_id=' + f.acao.id, { headers })).json();
  assert.equal(r.execucoes.length, 1);
  assert.equal((await fetch(base + '/api/v3/execucoes/item?id=' + execucao.id, { headers })).status, 200);
  assert.equal((await fetch(base + '/api/v3/execucoes/timeline?id=' + execucao.id + '&limite=1', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/v3/execucoes/item?id=' + execucao.id + '&id=outro', { headers })).status, 400);
  await post('revogar', { execucao_id: execucao.id, confirmar: true });
  const preserved=await fetch(base + '/api/v3/execucoes/item?id=' + execucao.id, { headers });
  assert.equal(preserved.status,200);
  assert.match(JSON.stringify(await preserved.json()),/Documento sintético/);
  assert.equal((await post('resultado',{execucao_id:execucao.id,chave_idempotencia:'apos-revogacao-0001',resumo:'Não permitido.',artefatos:[]})).status,403);
});

test('Histórico HTTP: sessão, pausa, recibo parcial e falhas seguras com serviço real e transporte sintético', async t => {
  const f = fixture(t), chamadas = [];
  const origem = f.db.prepare('SELECT origem_id FROM eventos WHERE id=?').get(f.fonte).origem_id;
  f.db.prepare('UPDATE eventos SET bruto=? WHERE id=?').run(JSON.stringify({ mensagem: { key: { remoteJid: 'sintetico@g.us', id: origem, fromMe: true }, messageTimestamp: 1790344800 } }), f.fonte);
  const conexao = { estado: () => ({ estado: 'conectada' }), parar: async () => {}, solicitarHistorico: async x => { chamadas.push(x); } };
  conexao.historico = new HistoricoWhatsApp(f.db, { agora: () => f.now });
  f.server = criarServidor(f.db, { desktop: true, conexao });
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${f.server.address().port}`, { token } = await (await fetch(base + '/api/sessao')).json();
  const headers = { 'x-assessor-token': token, 'content-type': 'application/json' };
  const post = data => fetch(base + '/api/v3/historico/recuperar', { method: 'POST', headers, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/v3/historico', { headers })).status, 403);
  f.desktop.aceitar({ nome: 'Perfil sintético', aceito: true, versao: VERSAO_TERMOS });
  assert.equal((await fetch(base + '/api/v3/historico')).status, 403);
  assert.equal((await fetch(base + '/api/v3/historico?injetar=1', { headers })).status, 400);
  let r = await (await fetch(base + '/api/v3/historico?conversa_id=sintetico%40g.us', { headers })).json();
  assert.equal(r.historico.cobertura, 'desconhecida');
  assert.equal((await post({ conversa_id: 'sintetico@g.us', modo: 'desconhecido' })).status, 400);
  f.db.prepare("INSERT OR REPLACE INTO desktop_config VALUES('captura_pausada','1')").run();
  assert.equal((await post({ conversa_id: 'sintetico@g.us', modo: 'retomar' })).status, 409); assert.equal(chamadas.length, 0);
  f.db.prepare("UPDATE desktop_config SET valor='0' WHERE chave='captura_pausada'").run();
  r = await (await post({ conversa_id: 'sintetico@g.us', modo: 'retomar' })).json();
  assert.equal(r.recuperacao.estado, 'aguardando_historico'); assert.equal(r.recuperacao.cobertura, 'desconhecida'); assert.equal(chamadas.length, 1);
  assert.equal((await post({ conversa_id: 'sintetico@g.us', modo: 'retomar' })).status, 429);
  conexao.historico.recuperar = async () => { throw Error('SEGREDO_INTERNO_SINTETICO'); };
  const failed = await post({ conversa_id: 'sintetico@g.us', modo: 'retomar' }); assert.equal(failed.status, 502); assert.ok(!(await failed.text()).includes('SEGREDO_INTERNO'));
  conexao.historico = null;
  assert.equal((await fetch(base + '/api/v3/historico', { headers })).status, 503);
});

test('Resolver stdio real: perfil migrado registra retorno e persiste timeline sem verificar automaticamente', async t => {
  const f = fixture(t), { execucao } = f.start();
  const credential = 'credencial-sintetica-para-teste-local', activation = join(f.dir, 'data', 'mcp', 'claude-desktop.json');
  mkdirSync(join(f.dir, 'data', 'mcp'), { recursive: true });
  writeFileSync(activation, JSON.stringify({ client_id: 'claude-desktop', credential_hash: createHash('sha256').update(credential).digest('hex'), revision: '11111111-1111-4111-8111-111111111111', enabled: true, scope: { kind: 'all' }, token_secret: Buffer.alloc(32, 7).toString('base64url') }));
  const presence = startLumeAppPresence({ dataDir: join(f.dir, 'data') });
  await startBrokerApp(t, { userData: f.dir, credential, activate: false });
  const env = { LUME_MCP_DATABASE: f.caminho, LUME_MCP_ACTIVATION_FILE: activation, LUME_MCP_PRESENCE_FILE: lumePresencePath(join(f.dir, 'data')), LUME_MCP_CLIENT_ID: 'claude-desktop', LUME_MCP_CREDENTIAL: credential };
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const input = new PassThrough(), output = new PassThrough(); let buffer = '', serial = 0; const pending = new Map();
  output.on('data', chunk => {
    buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const selected = await selecionarPerfilBoot(f.dir);
  const server = await startFromEnvironment({ input, output, version: '3.2.0-beta.6', userData: f.dir, expectedSelection: { tipo: selected.tipo, id: selected.id, geracao: selected.geracao } });
  const send = (method, params = {}) => new Promise(resolve => { const id = ++serial; pending.set(id, resolve); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  try {
    await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'teste-sintetico', version: '1' } });
    assert.equal((await send('tools/list')).result.tools.length, 9);
    const chamada = { name: 'lume_registrar_resultado', arguments: { execucao_id: execucao.id, chave_idempotencia: 'retorno-stdio-0001', resumo: 'Material preparado no teste de transporte.', artefatos: [] } };
    let r = (await send('tools/call', chamada)).result.structuredContent;
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.execucao.estado, 'resultado_informado');
    assert.equal((await send('tools/call', chamada)).result.structuredContent.repetido, true);
    assert.equal(f.svc.obter({ id: execucao.id }).execucao.timeline.at(-1).ator, 'claude-desktop');
    f.svc.revogar({ execucao_id: execucao.id, confirmar: true });
    r = (await send('tools/call', chamada)).result.structuredContent; assert.equal(r.error.code, 'SCOPE_REVOKED');
  } finally {
    await new Promise(resolve => setImmediate(resolve));
    await server.stop(); presence.stop();
    for (const name of Object.keys(env)) old[name] === undefined ? delete process.env[name] : process.env[name] = old[name];
  }
});

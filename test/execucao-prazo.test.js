import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume, CONTEXTO_TTL_MS } from '../src/execucao/servico.js';
import { createLumeMcpCore } from '../src/mcp/core.js';
import { Backup } from '../src/backup.js';
import { Privacidade } from '../src/privacidade.js';
import { diaLocal } from '../src/relogio.js';
import { startFromEnvironment } from '../src/mcp/stdio-entry.js';
import { selecionarPerfilBoot } from '../src/perfil-boot.js';
import { lumePresencePath, startLumeAppPresence } from '../src/mcp/presence.js';
import { startBrokerApp } from './fixtures/mcp-broker-app.js';

const GRANTS = 'lume_execucao_contexto_grants';
const INICIO = '2026-09-25T15:00:00.000Z';
const context = { clientId: 'claude-desktop', credential: 'credencial-sintetica-com-mais-de-32-caracteres' };
const access = { clientId: 'claude-desktop', revision: '1', scope: { kind: 'today', date: '2026-09-26' } };

function perfil(t, { semear = true, revisaoLocal = null, longa = false, secureRoot = false } = {}) {
  const root = secureRoot ? homedir() : tmpdir();
  const dir = mkdtempSync(join(root, 'lume-execucao-prazo-'));
  mkdirSync(join(dir, 'data'));
  const f = { dir, path: join(dir, 'data', 'assessor.db'), now: new Date(INICIO), auth: { enabled: true, revision: '1', scope: { kind: 'today' } } };
  f.db = abrirBanco(f.path);
  new ContextoApp(f.db); new Desktop(f.db); new DesktopIA(f.db);
  f.servicos = () => {
    f.acoes = new AcoesLume(f.db, { agora: () => f.now });
    f.svc = new ExecucoesLume(f.db, { agora: () => f.now, revisaoConector: revisaoLocal });
    f.core = createLumeMcpCore({ db: f.db, execucoes: f.svc, agora: () => f.now, secret: Buffer.alloc(32, 9),
      authorize: async ({ credential }) => credential === context.credential ? f.auth : { enabled: false } });
  };
  f.servicos();
  f.add = (conversa = 'prazo-sintetico@g.us', texto = 'Preparar proposta sintética para conferência.', quando = new Date(f.now.getTime() - 3600000)) => {
    f.db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(conversa, 'Contato sintético');
    const fonte = Number(f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
      VALUES(?,?,'entrada','texto','{}',?,?,?,'minha',1)`).run(conversa, randomUUID(), texto, quando.toISOString(), diaLocal(quando)).lastInsertRowid);
    f.acoes.autorizar({ conversa, permitida: true });
    f.acoes.registrar({ eventoId: fonte, candidatas: [{ fonte: 'E' + fonte, tipo: 'pendencia', resumo: 'Preparar proposta sintética', trecho: 'Preparar proposta sintética para conferência.', prazo_citado: '' }] });
    return { fonte, conversa, acao: f.acoes.listar().find(a => a.evento_id === fonte) };
  };
  if (semear) Object.assign(f, f.add(undefined, longa ? 'INICIO_FORA_DO_SNAPSHOT '.repeat(130) + 'Preparar proposta sintética para conferência. ' + 'FIM_FORA_DO_SNAPSHOT '.repeat(100) : undefined));
  f.start = (manter_contexto = true, { acao = f.acao, assistente = 'claude', chave = randomUUID() } = {}) => {
    const { contexto } = f.svc.preparar({ acao_id: acao.id });
    const input = { contexto_id: contexto.id, assistente, confirmar: true, chave_idempotencia: chave,
      ...(manter_contexto === 'omitido' ? {} : { manter_contexto }) };
    return { ...f.svc.iniciar(input), input };
  };
  f.call = (name, input, cliente = context) => f.core.executar(name, input, cliente);
  f.obter = id => f.call('lume_obter_contexto_execucao', { execucao_id: id });
  f.restart = () => { f.db.close(); f.db = abrirBanco(f.path); new ContextoApp(f.db); new Desktop(f.db); f.servicos(); };
  t.after(() => {
    f.db.close();
    if (!resolve(dir).startsWith(resolve(root) + sep)) throw Error('Destino temporário inválido');
    rmSync(dir, { recursive: true, force: true });
  });
  return f;
}

test('prazo: opt-in estrito, TTL fixo, replay sem renovação e consentimento não alterável por idempotência', t => {
  const f = perfil(t), r = f.start();
  assert.equal(r.execucao.manter_contexto, true);
  assert.equal(r.execucao.contexto_expira_em, '2026-10-02T15:00:00.000Z');
  assert.equal(r.contexto.autorizacao.contexto_expira_em, r.execucao.contexto_expira_em);
  assert.equal(f.svc.grant(r.execucao.id).consentida_em, INICIO);
  f.now = new Date('2026-09-26T15:00:00Z');
  const repeated = f.svc.iniciar(r.input);
  assert.equal(repeated.repetido, true);
  assert.equal(repeated.execucao.contexto_expira_em, r.execucao.contexto_expira_em);
  for (const value of [null, 1, 'true', {}, []]) assert.throws(() => f.svc.iniciar({ ...r.input, manter_contexto: value }), { code: 'INVALID_INPUT' });
  assert.throws(() => f.svc.iniciar({ ...r.input, manter_contexto: false }), { code: 'IDEMPOTENCY_CONFLICT' });
  const legacy = f.start(false);
  assert.throws(() => f.svc.iniciar({ ...legacy.input, manter_contexto: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${GRANTS}`).get().n, 1);
});

test('prazo: virada do dia e restart preservam somente snapshot e fonte exatos; busca genérica segue Hoje', async t => {
  const f = perfil(t, { longa: true }), r = f.start(), id = r.execucao.id;
  const unrelated = f.add('outro-sintetico@g.us', 'SEGREDO_OUTRA_FONTE. Preparar proposta sintética para conferência.');
  const dayOne = await f.obter(id);
  assert.equal(dayOne.ok, true, JSON.stringify(dayOne));
  const oldSource = dayOne.contexto.fontes[0].source_id;
  f.now = new Date('2026-09-26T15:00:00Z');
  f.restart();
  const result = await f.obter(id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.contexto.fontes[0].trecho, r.contexto.fontes[0].trecho);
  assert.equal(result.contexto.fontes[0].parcial, true);
  assert.ok(!JSON.stringify(result).includes('SEGREDO_OUTRA_FONTE'));
  const source = await f.call('lume_abrir_fonte', { source_id: result.contexto.fontes[0].source_id });
  assert.equal(source.ok, true, JSON.stringify(source));
  assert.equal(source.source.excerpt, r.contexto.fontes[0].trecho);
  assert.ok(source.source.excerpt_start > 0);
  assert.equal((await f.call('lume_abrir_fonte', { source_id: oldSource })).error.code, 'SOURCE_CHANGED');
  const generic = await f.call('lume_buscar_contexto', { question: 'proposta', start: '2026-09-25T00:00:00Z', end: '2026-09-27T00:00:00Z' });
  assert.equal(generic.ok, true); assert.deepEqual(generic.items, []);
  const genericRow = f.svc.read.fonte(unrelated.fonte, { kind: 'all' });
  const auth = await f.core.autenticar(context);
  const forged = f.core.tokens.criar('src', { id: genericRow._id, hash: genericRow._hash, scope: auth.digest, offset: 0, execucao: id }, null);
  assert.equal((await f.call('lume_abrir_fonte', { source_id: forged })).error.code, 'SOURCE_CHANGED');
  const exact = f.svc.fonteAutorizada(id, access);
  const offset = f.core.tokens.criar('src', { id: exact._id, hash: exact._hash, scope: auth.digest, offset: 0, execucao: id }, null);
  assert.equal((await f.call('lume_abrir_fonte', { source_id: offset })).error.code, 'SOURCE_CHANGED');
  const report = { execucao_id: id, chave_idempotencia: 'resultado-depois-restart', resumo: 'Proposta sintética preparada.', artefatos: [] };
  assert.equal((await f.call('lume_registrar_resultado', report)).execucao.verificacao, 'nao_verificado');
  f.restart();
  assert.equal((await f.call('lume_registrar_resultado', report)).repetido, true);
  assert.equal(f.svc.historico({ id }).timeline.filter(x => x.tipo === 'resultado').length, 1);
});

test('prazo: limite de 7 dias bloqueia assistente e replay; titular pode registrar e verificar localmente', async t => {
  const f = perfil(t), r = f.start(), id = r.execucao.id;
  const progress = { execucao_id: id, chave_idempotencia: 'progresso-primeiro', texto: 'Em preparação.' };
  assert.equal((await f.call('lume_registrar_progresso', progress)).ok, true);
  f.now = new Date(Date.parse(INICIO) + CONTEXTO_TTL_MS - 1);
  const before = await f.obter(id);
  assert.equal(before.ok, true);
  f.now = new Date(f.now.getTime() + 1);
  f.restart();
  assert.equal((await f.obter(id)).error.code, 'EXECUTION_CONTEXT_EXPIRED');
  assert.equal((await f.call('lume_abrir_fonte', { source_id: before.contexto.fontes[0].source_id })).error.code, 'SOURCE_CHANGED');
  assert.equal((await f.call('lume_registrar_progresso', progress)).error.code, 'EXECUTION_CONTEXT_EXPIRED');
  assert.equal((await f.call('lume_registrar_resultado', { execucao_id: id, chave_idempotencia: 'resultado-expirado', resumo: 'Tarde.', artefatos: [] })).error.code, 'EXECUTION_CONTEXT_EXPIRED');
  const local = f.svc.registrar('resultado', { execucao_id: id, chave_idempotencia: 'resultado-local-apos-prazo', resumo: 'Recebi e registrei o documento localmente.', artefatos: [] });
  assert.equal(local.execucao.estado, 'resultado_informado');
  const verified = f.svc.registrar('verificacao', { execucao_id: id, chave_idempotencia: 'verificar-local-apos-prazo', confirmar: true, nota: 'Conferido pelo titular.' });
  assert.equal(verified.execucao.verificacao, 'verificado_pelo_usuario');
  assert.equal((await f.obter(id)).error.code, 'EXECUTION_CONTEXT_EXPIRED');
  assert.equal(f.svc.obter({ id }).execucao.contexto_prazo_estado, 'expirado');
  assert.equal(f.svc.obter({ id }).contexto.autorizacao.estado, 'expirada');
  assert.equal(f.svc.iniciar(r.input).execucao.contexto_expira_em, r.execucao.contexto_expira_em);
});

test('prazo: cliente errado, outra execução e token sem vínculo não recebem autoridade do grant', async t => {
  const f = perfil(t), kept = f.start(), legacy = f.start(false), other = f.start(true, { assistente: 'codex' });
  f.now = new Date('2026-09-26T15:00:00Z');
  assert.equal((await f.obter(kept.execucao.id)).ok, true);
  assert.equal((await f.obter(legacy.execucao.id)).error.code, 'SOURCE_CHANGED');
  assert.equal((await f.obter(other.execucao.id)).error.code, 'SCOPE_REVOKED');
  assert.equal((await f.call('lume_obter_contexto_execucao', { execucao_id: kept.execucao.id }, { ...context, clientId: 'codex' })).error.code, 'SCOPE_REVOKED');
  assert.equal((await f.call('lume_obter_contexto_execucao', { execucao_id: kept.execucao.id, manter_contexto: true })).error.code, 'INVALID_INPUT');
  const auth = await f.core.autenticar(context), fonte = f.svc.fonteAutorizada(kept.execucao.id, access);
  const unbound = f.core.tokens.criar('src', { id: fonte._id, hash: fonte._hash, scope: auth.digest, offset: fonte.excerpt_start }, null);
  assert.equal((await f.call('lume_abrir_fonte', { source_id: unbound })).error.code, 'SOURCE_CHANGED');
});

test('prazo: false/omitido e migração de perfil anterior conservam o comportamento legado sem grant', async t => {
  const f = perfil(t), omitted = f.start('omitido'), off = f.start(false);
  assert.equal(omitted.execucao.manter_contexto, false);
  assert.equal(off.execucao.contexto_expira_em, null);
  assert.equal(f.svc.iniciar({ ...omitted.input, manter_contexto: false }).repetido, true);
  for (const { name } of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'lume_execucao_grant_%'").all()) f.db.exec(`DROP TRIGGER "${name}"`);
  f.db.exec(`DROP TABLE ${GRANTS}`);
  const oldService = new ExecucoesLume(f.db, { migrar: false, agora: () => f.now });
  assert.equal(oldService.obter({ id: omitted.execucao.id }).execucao.manter_contexto, false);
  f.servicos(); f.servicos();
  assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${GRANTS}`).get().n, 0);
  f.now = new Date('2026-09-26T15:00:00Z');
  for (const x of [omitted, off]) assert.equal((await f.obter(x.execucao.id)).error.code, 'SOURCE_CHANGED');
  f.auth.scope = { kind: 'all' };
  assert.equal((await f.obter(omitted.execucao.id)).ok, true);
});

test('prazo: revogação local bloqueia chamadas e fonte, sem apagar resultado auditável', async t => {
  const f = perfil(t), r = f.start(), id = r.execucao.id;
  const before = await f.obter(id);
  const result = { execucao_id: id, chave_idempotencia: 'resultado-antes-revogar', resumo: 'Resultado sintético.', artefatos: [] };
  await f.call('lume_registrar_resultado', result);
  f.svc.revogar({ execucao_id: id, confirmar: true }); f.restart();
  assert.equal((await f.obter(id)).error.code, 'SCOPE_REVOKED');
  assert.equal((await f.call('lume_registrar_resultado', result)).error.code, 'SCOPE_REVOKED');
  assert.equal((await f.call('lume_abrir_fonte', { source_id: before.contexto.fontes[0].source_id })).error.code, 'SOURCE_CHANGED');
  assert.equal(f.svc.obter({ id }).execucao.contexto_prazo_estado, 'revogado');
  assert.equal(f.svc.obter({ id }).contexto.autorizacao.estado, 'revogada');
  assert.equal(f.svc.historico({ id }).timeline.filter(x => x.tipo === 'resultado').length, 1);
});

test('prazo: autenticação continua obrigatória e revision fixada não reativa após revogar/recriar conector', async t => {
  const f = perfil(t), r = f.start(), id = r.execucao.id;
  assert.equal((await f.call('lume_obter_contexto_execucao', { execucao_id: id }, { ...context, credential: 'errada' })).error.code, 'NOT_ENABLED');
  assert.equal(f.svc.grant(id).revisao_conector, null);
  assert.equal((await f.obter(id)).ok, true);
  assert.equal(f.svc.grant(id).revisao_conector, '1');
  f.auth = { ...f.auth, enabled: false, revoked: true, revision: '2' };
  assert.equal((await f.obter(id)).error.code, 'SCOPE_REVOKED');
  f.auth = { ...f.auth, enabled: true, revoked: false, revision: '3' };
  f.restart();
  assert.equal((await f.obter(id)).error.code, 'SCOPE_REVOKED');
  const progress = { execucao_id: id, chave_idempotencia: 'conector-recriado', texto: 'Negado.' };
  assert.equal((await f.call('lume_registrar_progresso', progress)).error.code, 'SCOPE_REVOKED');
  assert.equal(f.svc.timeline(id).length, 1);
});

test('prazo: revision local confiável vincula o conector antes da primeira consulta', async t => {
  const f = perfil(t, { revisaoLocal: clientId => clientId === 'claude-desktop' ? '1' : null }), r = f.start();
  assert.equal(f.svc.grant(r.execucao.id).revisao_conector, '1');
  f.auth.revision = '2';
  assert.equal((await f.obter(r.execucao.id)).error.code, 'SCOPE_REVOKED');
  assert.throws(() => f.svc.iniciar({ ...r.input, revisao_conector: '2' }), { code: 'INVALID_INPUT' });
});

test('prazo: disponibilidade é efêmera e desktop sem conector ativo recusa consentimento adicional', t => {
  const f = perfil(t, { revisaoLocal: clientId => clientId === 'claude-desktop' ? '1' : null });
  const preview = f.svc.preparar({ acao_id: f.acao.id });
  assert.deepEqual(preview.prazo_disponivel, { claude: true, codex: false, hermes: false });
  assert.equal(Object.hasOwn(JSON.parse(f.db.prepare('SELECT pacote FROM lume_execucao_contextos WHERE id=?').get(preview.contexto.id).pacote), 'prazo_disponivel'), false);
  assert.throws(() => f.start(true, { assistente: 'codex' }), { code: 'CONNECTOR_REQUIRED' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 0);
  assert.equal(f.start(false, { assistente: 'codex' }).execucao.manter_contexto, false);
  f.svc.revisaoConector = () => { throw Error('Erro local sintético'); };
  assert.deepEqual(f.svc.preparar({ acao_id: f.acao.id }).prazo_disponivel, { claude: false, codex: false, hermes: false });
  assert.throws(() => f.start(), { code: 'CONNECTOR_REQUIRED' });
});

test('prazo: revogação entre autenticações não escreve nem fixa revision', async t => {
  const f = perfil(t), r = f.start(); let calls = 0;
  f.core.authorize = async () => ++calls === 1 ? f.auth : { enabled: false, revoked: true };
  const result = await f.call('lume_registrar_progresso', { execucao_id: r.execucao.id, chave_idempotencia: 'revogado-entre-auth', texto: 'Negado.' });
  assert.equal(result.error.code, 'SCOPE_REVOKED');
  assert.equal(f.svc.grant(r.execucao.id).revisao_conector, null);
  assert.equal(f.svc.timeline(r.execucao.id).length, 1);
});

test('prazo: alterações e revogações de fonte/política/Organizar invalidam de forma durável', async t => {
  const alteracoes = {
    fonte: f => { const texto = f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(f.fonte).texto; f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Conteúdo alterado.', f.fonte); f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run(texto, f.fonte); },
    acao: f => { f.db.prepare("UPDATE lume_acoes SET resumo='Resumo editado' WHERE id=?").run(f.acao.id); f.db.prepare('UPDATE lume_acoes SET resumo=? WHERE id=?').run(f.acao.resumo, f.acao.id); },
    politica: f => { f.db.prepare("INSERT INTO politicas_conversa(conversa_id,politica,atualizado_em) VALUES(?,'tudo',?)").run(f.conversa, INICIO); f.db.prepare('DELETE FROM politicas_conversa WHERE conversa_id=?').run(f.conversa); },
    organizarEditado: f => { f.db.prepare('UPDATE lume_acoes_conversas SET inicio_evento_id=inicio_evento_id+1 WHERE conversa_id=?').run(f.conversa); },
    organizarRevogado: f => f.acoes.autorizar({ conversa: f.conversa, permitida: false }),
    fonteExcluida: f => f.db.prepare('DELETE FROM eventos WHERE id=?').run(f.fonte),
    snapshot: f => { const c = f.db.prepare('SELECT * FROM lume_execucao_contextos').get(); const p = JSON.parse(c.pacote); p.fontes[0].trecho = 'Snapshot adulterado.'; f.db.prepare('UPDATE lume_execucao_contextos SET pacote=? WHERE id=?').run(JSON.stringify(p), c.id); }
  };
  for (const [nome, alterar] of Object.entries(alteracoes)) await t.test(nome, async t => {
    const f = perfil(t), r = f.start(), id = r.execucao.id;
    const before = await f.obter(id);
    alterar(f); f.restart();
    const after = await f.obter(id);
    assert.equal(after.ok, false, JSON.stringify(after));
    assert.ok(['NOT_FOUND', 'SOURCE_CHANGED', 'SCOPE_REVOKED'].includes(after.error.code));
    assert.equal((await f.call('lume_abrir_fonte', { source_id: before.contexto.fontes[0].source_id })).error.code, 'SOURCE_CHANGED');
    assert.equal((await f.call('lume_registrar_progresso', { execucao_id: id, chave_idempotencia: 'progresso-invalidado', texto: 'Negado.' })).ok, false);
  });
});

test('prazo: backup criptografado/exportação excluem grant e duas restaurações não restauram consentimento', async t => {
  const f = perfil(t), r = f.start(), b = new Backup(f.db), senha = 'senha-sintetica-backup';
  const raw = b.capturar(); b.validar(raw);
  assert.equal(raw.versao, 'assessor-acervo-v8');
  assert.equal(Object.hasOwn(raw.tabelas, GRANTS), false);
  const p = new Privacidade(f.db);
  assert.doesNotThrow(() => p.schemaConhecido());
  assert.ok(!JSON.stringify(p.dadosCiclo([f.fonte], { exportacao: true, tudo: true })).includes(GRANTS));
  const encrypted = await b.criar({ senha, confirmar: true });
  for (let i = 0; i < 2; i++) {
    const destino = perfil(t, { semear: false }), backup = new Backup(destino.db);
    const preview = await backup.preparar({ arquivo: JSON.stringify(encrypted.pacote), senha });
    backup.restaurar({ id: preview.id, confirmarMeuBackup: true });
    assert.equal(destino.db.prepare(`SELECT COUNT(*) n FROM ${GRANTS}`).get().n, 0);
    assert.equal((await destino.obter(r.execucao.id)).error.code, 'SCOPE_REVOKED');
    destino.acoes.autorizar({ conversa: f.conversa, permitida: true });
    assert.throws(() => destino.svc.iniciar({ ...r.input, chave_idempotencia: randomUUID() }), { code: 'CONTEXT_EXPIRED' });
    const exportedAgain = backup.capturar(); backup.validar(exportedAgain);
    assert.equal(Object.hasOwn(exportedAgain.tabelas, GRANTS), false);
    destino.db.prepare('UPDATE lume_execucao_contextos SET expira_em=? WHERE id=?').run('2026-10-02T15:00:00.000Z', r.input.contexto_id);
    assert.throws(() => destino.svc.iniciar({ ...r.input, chave_idempotencia: randomUUID() }), { code: 'SCOPE_REVOKED' });
  }
  const deletion = p.preparar({ fonte: f.fonte });
  p.excluir({ id: deletion.id, confirmar: 'APAGAR' });
  assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${GRANTS}`).get().n, 0);
});

test('prazo: transporte stdio e autenticação em arquivo real consultam fonte de ontem e bloqueiam conector recriado', { timeout: 15000 }, async t => {
  const originalRevision = '11111111-1111-4111-8111-111111111111';
  const revokedRevision = '22222222-2222-4222-8222-222222222222';
  const recreatedRevision = '33333333-3333-4333-8333-333333333333';
  const f = perfil(t, { semear: false, revisaoLocal: () => originalRevision, secureRoot: true });
  f.now = new Date();
  const ontem = new Date(f.now.getTime() - 86400000);
  Object.assign(f, f.add(undefined, undefined, ontem));
  const r = f.start(), activation = join(f.dir, 'data', 'mcp', 'claude-desktop.json');
  mkdirSync(join(f.dir, 'data', 'mcp'), { recursive: true });
  const descriptor = { client_id: 'claude-desktop', credential_hash: createHash('sha256').update(context.credential).digest('hex'), revision: originalRevision, enabled: true, scope: { kind: 'today', date: '2026-09-25' }, token_secret: Buffer.alloc(32, 9).toString('base64url') };
  writeFileSync(activation, JSON.stringify(descriptor));
  const presence = startLumeAppPresence({ dataDir: join(f.dir, 'data') });
  await startBrokerApp(t, { userData: f.dir, credential: context.credential, activate: false });
  const env = { LUME_MCP_DATABASE: f.path, LUME_MCP_ACTIVATION_FILE: activation, LUME_MCP_PRESENCE_FILE: lumePresencePath(join(f.dir, 'data')), LUME_MCP_CLIENT_ID: context.clientId, LUME_MCP_CREDENTIAL: context.credential };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  const input = new PassThrough(), output = new PassThrough(); let buffer = '', serial = 0; const pending = new Map();
  output.on('data', chunk => {
    buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  let server;
  try {
    const selected = await selecionarPerfilBoot(f.dir);
    server = await startFromEnvironment({ input, output, version: '3.2.0-beta.6', userData: f.dir, expectedSelection: { tipo: selected.tipo, id: selected.id, geracao: selected.geracao } });
    const send = (method, params = {}) => new Promise(resolve => { const id = ++serial; pending.set(id, resolve); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const call = async (name, args) => (await send('tools/call', { name, arguments: args })).result.structuredContent;
    await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'teste-prazo-sintetico', version: '1' } });
    const opened = await call('lume_obter_contexto_execucao', { execucao_id: r.execucao.id });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const source = await call('lume_abrir_fonte', { source_id: opened.contexto.fontes[0].source_id });
    assert.equal(source.ok, true, JSON.stringify(source));
    assert.equal(source.source.excerpt, r.contexto.fontes[0].trecho);
    assert.deepEqual((await call('lume_resumo_do_dia', {})).items, []);
    writeFileSync(activation, JSON.stringify({ ...descriptor, enabled: false, revision: revokedRevision }));
    input.write(JSON.stringify({ jsonrpc: '2.0', id: ++serial, method: 'tools/call', params: { name: 'lume_obter_contexto_execucao', arguments: { execucao_id: r.execucao.id } } }) + '\n');
    await assert.rejects(server.closed, { code: 'MCP_DRAIN_UNCONFIRMED' });
    writeFileSync(activation, JSON.stringify({ ...descriptor, revision: recreatedRevision }));
    const nextInput = new PassThrough(), nextOutput = new PassThrough();
    let nextBuffer = ''; const nextPending = new Map(); let nextSerial = 0;
    nextOutput.on('data', chunk => { nextBuffer += chunk; const lines = nextBuffer.split('\n'); nextBuffer = lines.pop(); for (const line of lines.filter(Boolean)) { const message = JSON.parse(line); nextPending.get(message.id)?.(message); nextPending.delete(message.id); } });
    const nextServer = await startFromEnvironment({ input: nextInput, output: nextOutput, version: '3.2.0-beta.6', userData: f.dir, expectedSelection: { tipo: selected.tipo, id: selected.id, geracao: selected.geracao } });
    const nextSend = (method, params = {}) => new Promise(resolve => { const id = ++nextSerial; nextPending.set(id, resolve); nextInput.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    await nextSend('initialize', { protocolVersion: '2025-11-25' });
    assert.equal((await nextSend('tools/call', { name: 'lume_obter_contexto_execucao', arguments: { execucao_id: r.execucao.id } })).result.structuredContent.error.code, 'SCOPE_REVOKED');
    await new Promise(resolve => setImmediate(resolve));
    await nextServer.stop();
  } finally {
    await server?.stop().catch(() => {}); presence.stop();
    for (const name of Object.keys(env)) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name];
  }
});

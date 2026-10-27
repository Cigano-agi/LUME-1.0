import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { HistoricoWhatsApp } from '../src/transporte/historico.js';
import { VendasJev } from '../src/vendas/servico.js';
import { interpretarJev, CRITERIOS_TEMPERATURA, CRITERIOS_ETAPA } from '../src/vendas/jev.js';
import { ProjetosComerciais } from '../src/projetos-comerciais/index.js';
import { Backup, cifrarBackup, abrirBackup } from '../src/backup.js';
import { Privacidade, CICLO_TABELAS, CICLO_COLUNAS } from '../src/privacidade.js';
import { fingerprint } from '../src/compartilhamento.js';
import { prepararEsquemaTranscricao, gravarTranscricao } from '../src/transcricao.js';
import { prepararMetadadosAudio } from '../src/audio-desktop-arquivos.js';

const NOW = new Date('2026-09-25T16:00:00.000Z'), senha = 'senha apenas sintetica no teste';
const A = 'sintetico-a@g.us', B = 'sintetico-b@g.us';
function perfil(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lume-dados-ciclo-')), db = abrirBanco(join(dir, 'teste.db'));
  new ContextoApp(db); new Desktop(db); new DesktopIA(db);
  const b = new Backup(db, { perfil: () => ({ nome: 'Perfil sintético' }) }), p = new Privacidade(db);
  t.after(() => { db.close(); if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error('Destino temporário inválido'); rmSync(dir, { recursive: true, force: true }); });
  return { db, b, p };
}
async function semear(f) {
  const { db } = f, inserir = (conversa, texto, permissao = 'minha') => {
    db.prepare('INSERT OR IGNORE INTO conversas_app VALUES(?,?)').run(conversa, conversa === A ? 'Contato A sintético' : 'Contato B sintético');
    const origem = randomUUID(), bruto = JSON.stringify({ mensagem: { key: { remoteJid: conversa, id: origem, fromMe: true }, messageTimestamp: 1790344800 } });
    return Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
      VALUES(?,?,'saida','texto',?,?,'2026-09-25T15:00:00.000Z','2026-09-25',?,1)`).run(conversa, origem, bruto, texto, permissao).lastInsertRowid);
  };
  f.a = inserir(A, 'Preparar contrato ALFA_PRIVADO para conferência.');
  f.z = inserir(B, 'Preparar contrato BETA_PRIVADO para conferência.');
  f.oculta = inserir(A, 'OCULTO_TERCEIRO fora da permissão.', 'terceiro');
  f.acoes = new AcoesLume(db, { agora: () => NOW }); f.exec = new ExecucoesLume(db, { agora: () => NOW });
  const criar = (evento, conversa, key) => {
    f.acoes.autorizar({ conversa, permitida: true });
    const texto = db.prepare('SELECT texto FROM eventos WHERE id=?').get(evento).texto;
    f.acoes.registrar({ eventoId: evento, candidatas: [{ fonte: 'E' + evento, tipo: 'pendencia', resumo: texto, trecho: texto, prazo_citado: '' }] });
    const acao = f.acoes.listar().find(x => x.evento_id === evento), { contexto } = f.exec.preparar({ acao_id: acao.id });
    const inicio = { contexto_id: contexto.id, assistente: 'claude', confirmar: true, chave_idempotencia: key };
    const { execucao } = f.exec.iniciar(inicio);
    f.exec.registrar('resultado', { execucao_id: execucao.id, chave_idempotencia: 'resultado-' + key, resumo: 'Documento: ' + texto, artefatos: ['contrato-sintetico.md'] });
    f.exec.registrar('verificacao', { execucao_id: execucao.id, chave_idempotencia: 'verificar-' + key, confirmar: true, nota: 'Conferência sintética.' });
    return { acao, contexto, execucao, inicio };
  };
  f.ea = criar(f.a, A, 'inicio-alfa-0001'); f.eb = criar(f.z, B, 'inicio-beta-0001');
  f.projetos = new ProjetosComerciais(db, { agora: () => NOW });
  f.pa = f.projetos.criarRascunho({ nome: 'Nome derivado ALFA_PRIVADO', fontes: [{ eventoId: f.a }], chave: 'projeto-a' });
  f.projetos.confirmar({ id: f.pa.id, confirmar: true }); f.projetos.vincularFonte({ id: f.pa.id, eventoId: f.z });
  f.pab = f.projetos.criarRascunho({ nome: 'Nome conjunto BETA_PRIVADO', fontes: [{ eventoId: f.a }, { eventoId: f.z }], chave: 'projeto-ab' });
  let calls = 0;
  const answer = (keys, value) => ({ type: 'choice', choice: value, confidence: .9, probabilities: Object.fromEntries(Object.keys(keys).map(k => [k, k === value ? 1 : 0])) });
  f.vendas = new VendasJev(db, { agora: () => NOW, segredos: { ler: async () => 'SEGREDO_SINTETICO_NAO_EXPORTAR' }, avaliar: async () => {
    calls++; return interpretarJev({ model: 'typesafe/jev-1.14', id: 'gen-dec-sintetico', answers: { temperatura: answer(CRITERIOS_TEMPERATURA, 'quente'), etapa: answer(CRITERIOS_ETAPA, 'proposta') }, usage: { cost: 0 } });
  } });
  f.vendas.corrigir({ conversa_id: A, temperatura: 'morno', etapa: 'interesse', confirmar: true });
  const previa = f.vendas.preparar({ conversa_id: A }); await f.vendas.avaliar({ previa_id: previa.id, confirmar: true }); assert.equal(calls, 1);
  f.historico = new HistoricoWhatsApp(db, { agora: () => NOW });
  f.historico.observarEstado({ estado: 'conectada' }); f.historico.observarEstado({ estado: 'desconectada' }); f.historico.observarEstado({ estado: 'conectada' });
  await f.historico.recuperar({ solicitarHistorico: async () => {} }, { conversaId: A });
  const interrupcao = db.prepare('SELECT id FROM wa_interrupcoes').get().id;
  db.prepare('INSERT INTO wa_retomadas VALUES(?,?)').run(interrupcao, A);
  db.prepare("INSERT INTO desktop_config VALUES('segredo_sintetico','SEGREDO_SINTETICO_NAO_EXPORTAR')").run();
  return f;
}
async function restaurar(origem, destino) {
  const criado = await origem.b.criar({ senha, confirmar: true });
  const previa = await destino.b.preparar({ arquivo: JSON.stringify(criado.pacote), senha });
  destino.b.restaurar({ id: previa.id, confirmarMeuBackup: true });
  return criado;
}

test('dados 0.6: backup v8 passa por dois perfis novos sem transferir autoridade, credencial ou conexão', async t => {
  const a = await semear(perfil(t)), b = perfil(t), c = perfil(t);
  new HistoricoWhatsApp(b.db).observarEstado({ estado: 'desconectada' });
  const conteudo = a.b.capturar(); a.b.validar(conteudo);
  assert.equal(conteudo.versao, 'assessor-acervo-v8');
  assert.ok(!JSON.stringify(conteudo).includes('SEGREDO_SINTETICO_NAO_EXPORTAR'));
  const estadosAntes = a.db.prepare('SELECT * FROM wa_interrupcoes').all(); a.b.capturar();
  assert.deepEqual(a.db.prepare('SELECT * FROM wa_interrupcoes').all(), estadosAntes);
  const criado = await restaurar(a, b);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 3);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 2);
  assert.ok(b.db.prepare('SELECT estado FROM lume_execucoes').all().every(x => x.estado === 'revogada'));
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE tipo='resultado'").get().n, 2);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE ator='backup:importacao'").get().n, 2);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n, 0);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM desktop_ia_conversas').get().n, 0);
  assert.equal(b.db.prepare("SELECT valor FROM desktop_config WHERE chave='captura_pausada'").get().valor, '1');
  assert.equal(b.db.prepare('SELECT estado FROM wa_cobertura').get().estado, 'desconectada');
  assert.equal(b.db.prepare('SELECT estado FROM wa_recuperacoes').get().estado, 'interrompida');
  assert.ok(b.db.prepare('SELECT invalidada FROM lume_projetos_fontes').all().every(f => f.invalidada === 1));
  assert.equal(new ProjetosComerciais(b.db).listar().length, 0);
  const jev = new VendasJev(b.db).obter({ conversa_id: A });
  assert.equal(jev.desatualizada, true); assert.equal(jev.importacao.consentimento_transferido, false);
  assert.equal(jev.consentimento.provedor, 'OpenRouter / TypeSafe');
  assert.ok(b.db.prepare('SELECT COUNT(*) n FROM lume_ciclo_importacoes').get().n > 10);
  const repetida = await b.b.preparar({ arquivo: JSON.stringify(criado.pacote), senha });
  assert.throws(() => b.b.restaurar({ id: repetida.id, confirmarMeuBackup: true }), /vazio/);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 2);
  assert.throws(() => new ExecucoesLume(b.db).obter({ id: a.ea.execucao.id }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => new ExecucoesLume(b.db).obter({ id: a.ea.execucao.id },{clientId:'claude-desktop'}), { code: 'SCOPE_REVOKED' });
  // Mesmo reproduzir a antiga permissão local não torna uma prévia importada executável.
  const grant = a.db.prepare('SELECT * FROM lume_acoes_conversas WHERE conversa_id=?').get(A);
  b.db.prepare('INSERT INTO lume_acoes_conversas VALUES(?,?,?)').run(grant.conversa_id, grant.autorizada_em, grant.inicio_evento_id);
  assert.throws(() => new ExecucoesLume(b.db).iniciar({ ...a.ea.inicio, chave_idempotencia: 'outro-inicio-importado' }), { code: 'CONTEXT_EXPIRED' });
  await restaurar(b, c);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 2);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM lume_execucao_eventos WHERE ator='backup:importacao'").get().n, 4);
  assert.ok(c.db.prepare('SELECT estado FROM lume_execucoes').all().every(x => x.estado === 'revogada'));
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n, 0);
  assert.equal(a.db.prepare('SELECT estado FROM lume_execucoes WHERE id=?').get(a.ea.execucao.id).estado, 'verificado');
});

test('dados 0.6: exportação pessoal limita fontes, projetos compostos, classificações e metadados globais', async t => {
  const f = await semear(perfil(t));
  let c = f.p.exportar({ conversa: A, confirmar: true }).conteudo;
  assert.equal(c.derivados.lume_execucoes.length, 1);
  assert.equal(c.derivados.lume_vendas_avaliacoes.length, 2);
  assert.deepEqual(c.derivados.lume_projetos_comerciais.map(p => p.id), [f.pa.id]);
  assert.equal(c.derivados.lume_projetos_fontes.length, 1);
  assert.deepEqual(c.derivados.wa_cobertura, []); assert.deepEqual(c.derivados.wa_interrupcoes, []);
  for (const texto of ['BETA_PRIVADO', 'OCULTO_TERCEIRO', 'SEGREDO_SINTETICO_NAO_EXPORTAR', 'messageTimestamp']) assert.ok(!JSON.stringify(c).includes(texto));
  c = f.p.exportar({ incluirOcultas: true, confirmar: true }).conteudo;
  assert.equal(c.derivados.wa_cobertura.length, 1); assert.equal(c.derivados.lume_projetos_comerciais.length, 2);
  f.db.prepare("UPDATE eventos SET permissao='terceiro' WHERE id=?").run(f.a);
  c = f.p.exportar({ conversa: A, confirmar: true }).conteudo;
  assert.equal(c.derivados.lume_execucoes.length, 0); assert.equal(c.derivados.lume_vendas_avaliacoes.length, 0); assert.equal(c.derivados.lume_projetos_comerciais.length, 0);
  assert.ok(!JSON.stringify(c).includes('ALFA_PRIVADO'));
});

test('dados 0.6: exclusão por fonte remove todo derivado atingido e procedência, preservando outra conversa', async t => {
  const a = await semear(perfil(t)), b = perfil(t); await restaurar(a, b);
  const p = b.p.preparar({ fonte: a.a });
  assert.equal(p.contagens.lume_execucoes, 1); assert.equal(p.contagens.lume_projetos_comerciais, 2);
  b.p.excluir({ id: p.id, confirmar: 'APAGAR' });
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 2);
  assert.deepEqual(b.db.prepare('SELECT id FROM lume_execucoes').all().map(x => x.id), [a.eb.execucao.id]);
  for (const table of ['lume_projetos_comerciais', 'lume_projetos_fontes', 'lume_projetos_historico', 'lume_vendas_avaliacoes', 'wa_cobertura', 'wa_interrupcoes', 'wa_recuperacoes', 'wa_retomadas']) assert.equal(b.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  for (const table of CICLO_TABELAS) assert.ok(!JSON.stringify(b.db.prepare(`SELECT * FROM ${table}`).all()).includes('ALFA_PRIVADO'), table);
  assert.equal(b.db.prepare("SELECT COUNT(*) n FROM lume_ciclo_importacoes WHERE tabela='lume_execucoes' AND registro_id=?").get(a.ea.execucao.id).n, 0);
  const total = b.p.preparar({ tudo: true }); b.p.excluir({ id: total.id, confirmar: 'APAGAR' });
  for (const table of CICLO_TABELAS) assert.equal(b.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
});

test('dados 0.6: retorno novo invalida a prévia de exclusão antes de qualquer mutação', async t => {
  const f = await semear(perfil(t)), p = f.p.preparar({ fonte: f.a });
  const { contexto } = f.exec.preparar({ acao_id: f.ea.acao.id });
  f.exec.iniciar({ contexto_id: contexto.id, assistente: 'hermes', confirmar: true, chave_idempotencia: 'nova-execucao-0001' });
  assert.throws(() => f.p.excluir({ id: p.id, confirmar: 'APAGAR' }), /mudaram/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 3);
});

test('dados 0.6: apagar fonte adicional preserva projeto baseado apenas em fonte ainda permitida', async t => {
  const f = await semear(perfil(t)), adicional = f.db.prepare('SELECT id FROM lume_projetos_fontes WHERE projeto_id=? AND evento_id=?').get(f.pa.id, f.z).id, p = f.p.preparar({ fonte: f.z });
  f.p.excluir({ id: p.id, confirmar: 'APAGAR' });
  assert.equal(f.projetos.obter(f.pa.id).fontes.length, 1);
  assert.equal(f.projetos.obter(f.pab.id), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_historico WHERE fonte_id=?').get(adicional).n, 0);
});

test('dados 0.6: revogar origem preserva fonte nativa e elimina derivados que dependiam da procedência', async t => {
  const f = await semear(perfil(t)), key = generateKeyPairSync('ed25519'), fp = fingerprint(key.publicKey), projeto = randomUUID();
  f.db.prepare('INSERT INTO f10_projetos VALUES(?,?,?)').run(projeto, 'Compartilhamento sintético', NOW.toISOString());
  f.db.prepare('INSERT INTO f10_origens VALUES(?,?,?,?)').run(fp, 'Pessoa sintética', 'Máquina sintética', key.publicKey.export({ type: 'spki', format: 'pem' }));
  f.db.prepare('INSERT INTO f10_procedencias VALUES(?,?,?,?,?,?,?,?)').run(f.a, fp, randomUUID(), projeto, NOW.toISOString(), NOW.toISOString(), null, null);
  const p = f.p.preparar({ origem: fp }); assert.equal(p.contagens.originaisPreservados, 1);
  f.p.excluir({ id: p.id, confirmar: 'REMOVER' });
  assert.ok(f.db.prepare('SELECT 1 FROM eventos WHERE id=?').get(f.a));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes WHERE id=?').get(f.ea.execucao.id).n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_vendas_avaliacoes').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_projetos_comerciais').get().n, 0);
  assert.ok(f.db.prepare('SELECT 1 FROM f10_revogadas WHERE fingerprint=?').get(fp));
});

test('dados 0.6: allowlist de tabelas/colunas/JSON e referências recusa arquivos hostis antes do restauro', async t => {
  const f = await semear(perfil(t)), dest = perfil(t), base = f.b.capturar();
  const mutations = [
    x => { x.tabelas['lume_execucoes;DROP TABLE eventos'] = []; },
    x => { x.tabelas.lume_execucoes[0]['estado) VALUES(1);--'] = 'revogada'; },
    x => { x.tabelas.lume_execucoes[0].cliente_id = 'outro-assistente'; },
    x => { x.tabelas.lume_execucao_eventos[0].dados = '{"texto":"falso"}'; },
    x => { const p = JSON.parse(x.tabelas.lume_execucao_contextos[0].pacote); p.autorizacao.envio = true; x.tabelas.lume_execucao_contextos[0].pacote = JSON.stringify(p); },
    x => { x.tabelas.wa_recuperacoes[0].evento_id = 9999; },
    x => { const r = JSON.parse(x.tabelas.lume_vendas_avaliacoes[0].resultado); r.fontes = [f.z]; x.tabelas.lume_vendas_avaliacoes[0].resultado = JSON.stringify(r); },
    x => { x.tabelas.lume_projetos_fontes[0].evento_id = 9999; },
    x => { x.tabelas.lume_projetos_comerciais[0].bases_total = 32; },
    x => { x.tabelas.lume_ciclo_importacoes = [{ tabela: 'desktop_ia_config', registro_id: '1', backup_sha256: 'a'.repeat(64), importado_em: NOW.toISOString(), estado_original: 'habilitada' }]; }
  ];
  for (const mutate of mutations) {
    const c = structuredClone(base); mutate(c);
    await assert.rejects(dest.b.preparar({ arquivo: JSON.stringify(await cifrarBackup(c, senha)), senha }), /inválido|incompatív/);
    assert.equal(dest.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, 0);
  }
  for (const [table, columns] of Object.entries(CICLO_COLUNAS)) assert.deepEqual(dest.db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name).sort(), [...columns].sort());
});

test('dados 0.6: metadados locais de áudio sobrevivem ao backup, exportação e exclusão sem transportar capacidade', async t => {
  const a = perfil(t), b = perfil(t);
  const id = new ContextoApp(a.db).nota({ texto: 'Fonte sintética para áudio' }).id;
  const fonte = a.db.prepare('SELECT * FROM eventos WHERE id=?').get(id);
  prepararEsquemaTranscricao(a.db); prepararMetadadosAudio(a.db);
  const metadados = { versao: 1, motor: 'whisper.cpp', versaoMotor: '1.0-teste', origem: 'local', idioma: 'pt', qualidade: 'nao_validada',
    audioSha256: 'a'.repeat(64), modeloSha256: 'b'.repeat(64), manifestoSha256: 'c'.repeat(64), duracaoAudioMs: 1000,
    trechos: [{ inicioMs: 0, fimMs: 900, texto: 'Áudio local sintético' }],
    fonte: { conversaId: fonte.conversa_id, origemId: fonte.origem_id, assinatura: 'd'.repeat(64) },
    consentimento: { tipo: 'processamento_local', confirmadoEm: NOW.toISOString(), vinculoConfirmado: true } };
  gravarTranscricao(a.db, { conversaId: fonte.conversa_id, origemId: fonte.origem_id, textoOriginal: 'Áudio local sintético', modelo: 'whisper.cpp/1.0-teste' });
  a.db.prepare('UPDATE transcricoes SET audio_metadados_json=?').run(JSON.stringify(metadados));
  const conteudo = a.b.capturar(); assert.equal(conteudo.versao, 'assessor-acervo-v8'); a.b.validar(conteudo);
  const motorDivergente=structuredClone(conteudo);motorDivergente.tabelas.transcricoes[0].modelo='outro-motor';
  assert.throws(()=>a.b.validar(motorDivergente),/Motor ou hash/);
  const anexoDivergente=structuredClone(conteudo),bytes=Buffer.from('anexo sintético adulterado');
  anexoDivergente.arquivos=[{id:0,dados:bytes.toString('base64'),hash:createHash('sha256').update(bytes).digest('hex')}];
  anexoDivergente.tabelas.transcricoes[0].arquivo='anexo:0';assert.throws(()=>a.b.validar(anexoDivergente),/Motor ou hash/);
  await restaurar(a, b);
  assert.deepEqual(JSON.parse(b.db.prepare('SELECT audio_metadados_json FROM transcricoes').get().audio_metadados_json), metadados);
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM desktop_ia_conversas').get().n, 0);
  const exportado = b.p.exportar({ confirmar: true }).conteudo.derivados.transcricoes[0];
  assert.deepEqual(JSON.parse(exportado.audio_metadados_json), metadados); assert.equal(Object.hasOwn(exportado, 'arquivo'), false);
  for (const mutate of [m => { m.caminho = 'C:/segredo'; }, m => { m.fonte.conversaId = 'outra'; }, m => { m.trechos[0].texto = 'outro texto'; }, m => { m.consentimento.tipo = 'envio_externo'; }]) {
    const hostil = structuredClone(conteudo), m = structuredClone(metadados); mutate(m); hostil.tabelas.transcricoes[0].audio_metadados_json = JSON.stringify(m);
    assert.throws(() => a.b.validar(hostil), /incompatíveis/);
  }
  const semFala = structuredClone(conteudo), row = semFala.tabelas.transcricoes[0], m = structuredClone(metadados); m.trechos = [];
  row.audio_metadados_json = JSON.stringify(m); row.texto_original = '(sem fala)'; row.texto = null; row.estado = 'vazio'; row.respostas_json = JSON.stringify([{ textoOriginal: '(sem fala)', duracaoMs: null }]);
  a.b.validar(semFala);
  const p = b.p.preparar({ fonte: id }); b.p.excluir({ id: p.id, confirmar: 'APAGAR' });
  assert.equal(b.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n, 0);
});

test('dados 0.6: transcrição v7 anterior migra a coluna local para NULL sem aceitar campo ausente arbitrário', async t => {
  const a = perfil(t), b = perfil(t), id = new ContextoApp(a.db).nota({ texto: 'Fonte de transcrição legada' }).id;
  const fonte = a.db.prepare('SELECT * FROM eventos WHERE id=?').get(id);
  prepararEsquemaTranscricao(a.db); gravarTranscricao(a.db, { conversaId: fonte.conversa_id, origemId: fonte.origem_id, textoOriginal: 'Original legado' });
  const criado = await a.b.criar({ senha, confirmar: true }), conteudo = await abrirBackup(JSON.stringify(criado.pacote), senha);
  assert.equal(conteudo.versao, 'assessor-acervo-v7'); assert.equal(Object.hasOwn(conteudo.tabelas.transcricoes[0], 'audio_metadados_json'), false);
  const incompleto = structuredClone(conteudo); delete incompleto.tabelas.transcricoes[0].quando;
  assert.throws(() => b.b.validar(incompleto), /incompatíveis/);
  const previa = await b.b.preparar({ arquivo: JSON.stringify(criado.pacote), senha }); b.b.restaurar({ id: previa.id, confirmarMeuBackup: true });
  assert.equal(b.db.prepare('SELECT audio_metadados_json FROM transcricoes').get().audio_metadados_json, null);
});

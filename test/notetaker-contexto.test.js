import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { NotetakerServico } from '../src/notetaker/servico.js';
import { cabecalhoWav } from '../src/notetaker/contrato.js';
import { importarArquivo } from '../src/notetaker/importacao.js';
import { AcoesLume, resumoAcoesLume, contarAcoesLumePorConversa } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { LumeMcpReadService } from '../src/mcp/read-service.js';
import { prepararIndiceFontes } from '../src/fontes-desktop.js';
import { Semantica } from '../src/semantica.js';

const TRECHO = 'Enviar o resumo sintético da reunião amanhã.';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lume-notetaker-contexto-'));
  const marker = randomUUID(), old = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = root;
  writeFileSync(join(root, '.lume-notetaker-test'), marker);
  const path = join(root, 'db.sqlite');
  let db = abrirBanco(path);
  t.after(() => {
    db?.close();
    if (old === undefined) delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE = old;
    rmSync(root, { recursive: true, force: true });
  });
  new ContextoApp(db); new Desktop(db);
  const fakeAsr = { async estado() { return { disponivel: true }; }, async transcrever(bytes) {
    return { motor: 'whisper.cpp', modeloSha256: 'a'.repeat(64), audioSha256: sha(bytes),
      trechos: [{ inicioMs: 500, fimMs: 900, texto: TRECHO }] };
  } };
  const notetaker = new NotetakerServico(db, { notetakerExperimento: true,
    testProfileRoot: root, testMarker: marker, audioLocal: fakeAsr });
  const sessao = notetaker.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
  notetaker.consentir(sessao, { entradas: ['importacao'], confirmar: true });
  const wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000)]);
  const req = { headers: { 'content-length': String(wav.length) }, complete: true,
    async *[Symbol.asyncIterator]() { yield wav; } };
  await importarArquivo(req, { servico: notetaker, sessaoId: sessao });
  assert.equal((await notetaker.transcreverImportacao(sessao)).estado, 'concluida');
  const fonteId = db.prepare('SELECT evento_id FROM notetaker_fontes').get().evento_id;
  const parte = db.prepare('SELECT id FROM notetaker_partes').get().id;
  const audioPath = join(root, 'notetaker-audio', parte + '.wav');
  const abrir = () => { db.close(); db = abrirBanco(path); new ContextoApp(db); new Desktop(db); return db; };
  return { get db() { return db; }, root, marker, sessao, fonteId, audioPath, wav, abrir,
    acoes: () => new AcoesLume(db), execucoes: () => new ExecucoesLume(db, { agora: () => new Date('2026-09-27T15:00:00Z') }) };
}

function registrar(f) {
  const acoes = f.acoes();
  const candidato = { fonte: 'E' + f.fonteId, tipo: 'pendencia', resumo: 'Enviar resumo de teste',
    trecho: TRECHO, prazo_citado: '' };
  const criado = acoes.registrar({ eventoId: f.fonteId, candidatas: [candidato] });
  return { acoes, candidato, criado, acao: acoes.listar().find(x => x.evento_id === f.fonteId) };
}

test('WAV e ASR sintéticos ligam trecho literal à ação, Resolver e retorno ao tempo da fonte', async t => {
  const f = await fixture(t);
  const lido = new LumeMcpReadService(f.db).fonte(f.fonteId, { kind: 'all' });
  assert.equal(lido.source_type, 'reuniao_local');
  assert.equal(lido.source_time_ms, 500);
  const { acoes, candidato, criado, acao } = registrar(f);
  assert.equal(criado.novos, 1);
  assert.equal(acao.autor_id, null);
  assert.equal(acao.source_time_ms, 500);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes_conversas').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM conversas_app').get().n, 0);
  assert.equal(acoes.registrar({ eventoId: f.fonteId, candidatas: [candidato] }).novos, 0);
  const svc = f.execucoes();
  const { contexto } = svc.preparar({ acao_id: acao.id });
  assert.equal(contexto.fontes[0].source_time_ms, 500);
  assert.equal(contexto.fontes[0].autor, 'Autoria não identificada');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 0, 'copiar prévia não inicia execução');
  const inicio = { contexto_id: contexto.id, assistente: 'codex', confirmar: true,
    chave_idempotencia: 'inicio-local-0001', manter_contexto: false };
  const primeira = svc.iniciar(inicio);
  assert.equal(svc.iniciar(inicio).execucao.id, primeira.execucao.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucao_contexto_grants').get().n, 0);
  assert.throws(() => svc.obter({ id: primeira.execucao.id },
    { clientId: 'codex', scope: { kind: 'all' } }), { code: 'SCOPE_REVOKED' });
  const resultado = { execucao_id: primeira.execucao.id, chave_idempotencia: 'resultado-local-0001',
    resumo: 'Resumo sintético preparado.', artefatos: [] };
  assert.equal(svc.registrar('resultado', resultado).execucao.estado, 'resultado_informado');
  assert.equal(svc.obter({ id: primeira.execucao.id }).execucao.fonte_retorno.source_time_ms, 500);
  assert.equal(svc.obter({ id: primeira.execucao.id }).execucao.verificacao, 'nao_verificado');
  assert.equal(svc.listar({ acao_id: acao.id }).execucoes[0].fonte_retorno.source_time_ms, 500);
  f.abrir();
  const depois = f.acoes();
  assert.equal(depois.registrar({ eventoId: f.fonteId, candidatas: [candidato] }).novos, 0);
  assert.equal(depois.listar().filter(x => x.evento_id === f.fonteId).length, 1);
  assert.equal(f.execucoes().obter({ id: primeira.execucao.id }).execucao.fonte_retorno.source_time_ms, 500);
});

test('listas, prévia e resultado fecham ao mudar bytes, revisão ou direitos', async t => {
  const f = await fixture(t), { acoes, acao } = registrar(f), svc = f.execucoes();
  const { contexto } = svc.preparar({ acao_id: acao.id });
  const execucao = svc.iniciar({ contexto_id: contexto.id, assistente: 'codex', confirmar: true,
    chave_idempotencia: 'inicio-local-0002' }).execucao;
  const original = readFileSync(f.audioPath), alterado = Buffer.from(original); alterado[44] = 1;
  writeFileSync(f.audioPath, alterado);
  assert.equal(acoes.listar().length, 0);
  assert.equal(resumoAcoesLume(f.db).total, 0);
  assert.deepEqual(contarAcoesLumePorConversa(f.db), []);
  assert.equal(acoes.obter(acao.id), null);
  assert.throws(() => svc.preparar({ acao_id: acao.id }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => svc.obter({ id: execucao.id }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => svc.listar({ acao_id: acao.id }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => svc.registrar('resultado', { execucao_id: execucao.id,
    chave_idempotencia: 'resultado-local-0002', resumo: 'Não autorizado.', artefatos: [] }), { code: 'SOURCE_CHANGED' });
  writeFileSync(f.audioPath, original);
  f.db.prepare('UPDATE notetaker_trechos SET revisao=revisao+1').run();
  assert.equal(acoes.listar().length, 0);
  assert.throws(() => svc.iniciar({ contexto_id: contexto.id, assistente: 'codex', confirmar: true,
    chave_idempotencia: 'inicio-local-0003' }), { code: 'SOURCE_CHANGED' });
  f.db.prepare('UPDATE notetaker_trechos SET revisao=revisao-1').run();
  f.db.prepare("UPDATE notetaker_trechos SET texto_gerado='Texto revisto sem publicar evento.'").run();
  assert.equal(acoes.listar().length, 0);
  f.db.prepare('UPDATE notetaker_trechos SET texto_gerado=?').run(TRECHO);
  unlinkSync(f.audioPath);
  assert.equal(acoes.listar().length, 0);
  assert.throws(() => svc.obter({ id: execucao.id }), { code: 'SOURCE_CHANGED' });
  writeFileSync(f.audioPath, original);
  f.db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run('2026-09-27T16:00:00Z', f.sessao);
  assert.equal(acoes.listar().length, 0);
  assert.throws(() => svc.obter({ id: execucao.id }), { code: 'SOURCE_CHANGED' });
});

test('grant textual exige confirmação, revisão de conector e mantém áudio fora do retorno', async t => {
  const f = await fixture(t), { acao } = registrar(f);
  const semRevisao = f.execucoes(), previa = semRevisao.preparar({ acao_id: acao.id }).contexto;
  assert.throws(() => semRevisao.iniciar({ contexto_id: previa.id, assistente: 'codex',
    confirmar: true, chave_idempotencia: 'grant-local-0001', manter_contexto: true }), { code: 'CONNECTOR_REQUIRED' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_execucoes').get().n, 0);
  const svc = new ExecucoesLume(f.db, { agora: () => new Date('2026-09-27T15:00:00Z'),
    revisaoConector: () => 'rev-sintetica-1' });
  const inicio = svc.iniciar({ contexto_id: previa.id, assistente: 'codex', confirmar: true,
    chave_idempotencia: 'grant-local-0001', manter_contexto: true });
  const acesso = { clientId: 'codex', revision: 'rev-sintetica-1', scope: { kind: 'all' } };
  const texto = svc.fonteAutorizada(inicio.execucao.id, acesso);
  assert.equal(texto.excerpt, TRECHO);
  assert.equal(JSON.stringify(texto).includes('.wav'), false);
  assert.equal(JSON.stringify(texto).includes('audio_sha256'), false);
  assert.equal(svc.registrar('resultado', { execucao_id: inicio.execucao.id,
    chave_idempotencia: 'grant-resultado-0001', resumo: 'Texto sintético entregue.', artefatos: [] }, acesso).execucao.estado, 'resultado_informado');
  assert.equal(svc.obter({ id: inicio.execucao.id }).execucao.verificacao, 'nao_verificado');
  assert.throws(() => svc.obter({ id: inicio.execucao.id },
    { ...acesso, revision: 'rev-divergente' }), { code: 'SCOPE_REVOKED' });
  const original = readFileSync(f.audioPath), alterado = Buffer.from(original);
  alterado[44] = 1; writeFileSync(f.audioPath, alterado);
  assert.throws(() => svc.fonteAutorizada(inicio.execucao.id, acesso), { code: 'SOURCE_CHANGED' });
  assert.throws(() => svc.registrar('resultado', { execucao_id: inicio.execucao.id,
    chave_idempotencia: 'grant-resultado-0002', resumo: 'Tardio', artefatos: [] }, acesso), { code: 'SOURCE_CHANGED' });
});

test('trocar o vínculo do trecho com texto e áudio iguais invalida ação e prévia anteriores', async t => {
  const f = await fixture(t), { acoes, acao } = registrar(f), svc = f.execucoes();
  const previa = svc.preparar({ acao_id: acao.id }).contexto;
  const parte = f.db.prepare('SELECT parte_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).parte_id;
  const novoTrecho = randomUUID();
  f.db.prepare(`INSERT INTO notetaker_trechos(id,parte_id,ordinal,inicio_ms,fim_ms,texto_gerado)
    VALUES(?,?,1,500,900,?)`).run(novoTrecho, parte, TRECHO);
  f.db.prepare('UPDATE notetaker_fontes SET trecho_id=? WHERE evento_id=?').run(novoTrecho, f.fonteId);
  assert.equal(new LumeMcpReadService(f.db).fonte(f.fonteId, { kind: 'all' }).source_time_ms, 500);
  assert.equal(acoes.listar().length, 0);
  assert.equal(acoes.obter(acao.id), null);
  assert.throws(() => svc.iniciar({ contexto_id: previa.id, assistente: 'codex',
    confirmar: true, chave_idempotencia: 'vinculo-local-0001' }), { code: 'SOURCE_CHANGED' });
});

test('hash de ação WhatsApp conserva shape anterior e contexto segue legível após restart', async t => {
  const f = await fixture(t), acoes = f.acoes(), conversa = 'wa-sintetico@g.us';
  f.db.prepare('INSERT INTO conversas_app(id,nome) VALUES(?,?)').run(conversa, 'Contato de teste');
  const eventoId = Number(f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono)
    VALUES(?,?,'entrada','texto','{}',?,'2026-09-27T14:00:00Z','2026-09-27','minha',1)`)
    .run(conversa, 'wa-1', 'Enviar proposta WhatsApp sintética.').lastInsertRowid);
  acoes.autorizar({ conversa, permitida: true });
  acoes.registrar({ eventoId, candidatas: [{ fonte: 'E' + eventoId, tipo: 'pendencia',
    resumo: 'Enviar proposta', trecho: 'Enviar proposta WhatsApp sintética.', prazo_citado: '' }] });
  const acao = acoes.listar().find(x => x.evento_id === eventoId), svc = f.execucoes();
  const previa = svc.preparar({ acao_id: acao.id }).contexto;
  const { estado, responsavel_id, fonte_tipo, ...shapeAnterior } = svc.acao(acao.id);
  const guardado = JSON.parse(f.db.prepare('SELECT integridade FROM lume_execucao_contextos WHERE id=?').get(previa.id).integridade);
  assert.equal(guardado.acao, sha(Buffer.from(JSON.stringify(shapeAnterior))));
  assert.equal(fonte_tipo, 'texto');
  f.abrir();
  assert.equal(f.execucoes().iniciar({ contexto_id: previa.id, assistente: 'codex',
    confirmar: true, chave_idempotencia: 'wa-legado-0001' }).execucao.estado, 'aguardando_assistente');
});

test('sem prova de perfil de teste, reunião não vira ação nem execução', async t => {
  const f = await fixture(t);
  const old = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = '';
  try {
    assert.throws(() => f.acoes().registrar({ eventoId: f.fonteId, candidatas: [{ fonte: 'E' + f.fonteId,
      tipo: 'pendencia', resumo: 'Teste', trecho: TRECHO, prazo_citado: '' }] }));
    assert.equal(f.acoes().listar().length, 0);
  } finally { process.env.ASSESSOR_DESKTOP_TEST_PROFILE = old; }
});

test('perfil legado readonly sem tabela de guardas falha com erro de domínio', async t => {
  const f = await fixture(t), { acao } = registrar(f), svc = f.execucoes();
  const previa = svc.preparar({ acao_id: acao.id }).contexto;
  const execucao = svc.iniciar({ contexto_id: previa.id, assistente: 'codex',
    confirmar: true, chave_idempotencia: 'legado-sem-guardas-0001' }).execucao;
  f.db.exec('DROP TABLE lume_execucao_contexto_guardas');
  const ro = new DatabaseSync(join(f.root, 'db.sqlite'), { readOnly: true });
  try {
    const leitor = new ExecucoesLume(ro, { migrar: false });
    assert.throws(() => leitor.obter({ id: execucao.id }), { code: 'SOURCE_CHANGED' });
  } finally { ro.close(); }
});

test('correção preserva original, invalida execução e ancora auditoria na primeira versão', async t => {
  const f = await fixture(t), { acao } = registrar(f), svc = f.execucoes();
  const previa = svc.preparar({ acao_id: acao.id }).contexto;
  const inicio = svc.iniciar({ contexto_id: previa.id, assistente: 'codex', confirmar: true,
    chave_idempotencia: 'correcao-local-0001' }).execucao;
  svc.registrar('resultado', { execucao_id: inicio.id, chave_idempotencia: 'correcao-resultado-0001',
    resumo: 'Relato sintético da fonte anterior.', artefatos: [] });
  const trechoId = f.db.prepare('SELECT trecho_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).trecho_id;
  const antes = f.db.prepare('SELECT * FROM notetaker_trechos WHERE id=?').get(trechoId);
  const brutoAntes=f.db.prepare('SELECT bruto,recebido_em,autor_id FROM eventos WHERE id=?').get(f.fonteId);
  const audioAntes=readFileSync(f.audioPath);
  assert.equal(f.execucoes().obter({ id: inicio.id }).execucao.estado, 'resultado_informado');
  const corrigido = new NotetakerServico(f.db, { notetakerExperimento: true,
    testProfileRoot: f.root, testMarker: f.marker, audioLocal: { estado: async () => ({ disponivel: false }) } })
    .corrigirTrecho(trechoId, { texto: 'Enviar a ata sintética na terça-feira.', revisaoEsperada: 0, confirmar: true });
  assert.equal(corrigido.textoGerado, TRECHO);
  assert.equal(corrigido.textoExibido, 'Enviar a ata sintética na terça-feira.');
  assert.equal(corrigido.revisao, 1);
  assert.equal(f.db.prepare('SELECT texto_gerado FROM notetaker_trechos WHERE id=?').get(trechoId).texto_gerado, antes.texto_gerado);
  assert.equal(f.db.prepare('SELECT inicio_ms,fim_ms FROM notetaker_trechos WHERE id=?').get(trechoId).inicio_ms,antes.inicio_ms);
  assert.equal(f.db.prepare('SELECT inicio_ms,fim_ms FROM notetaker_trechos WHERE id=?').get(trechoId).fim_ms,antes.fim_ms);
  assert.deepEqual(f.db.prepare('SELECT bruto,recebido_em,autor_id FROM eventos WHERE id=?').get(f.fonteId),brutoAntes);
  assert.deepEqual(readFileSync(f.audioPath),audioAntes);
  assert.equal(f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(f.fonteId).texto, corrigido.textoExibido);
  assert.equal(f.db.prepare('SELECT invalidada FROM lume_execucao_contexto_grants WHERE execucao_id=?').get(inicio.id), undefined);
  assert.equal(f.acoes().listar().length, 0);
  assert.throws(() => svc.iniciar({ contexto_id: previa.id, assistente: 'codex', confirmar: true,
    chave_idempotencia: 'correcao-local-0002' }), { code: 'SOURCE_CHANGED' });
  const local = svc.obter({ id: inicio.id });
  assert.equal(local.execucao.estado, 'resultado_informado');
  assert.equal(local.execucao.contexto_invalidado, true);
  assert.equal(local.execucao.pode_verificar, false);
  assert.match(JSON.stringify(local), /fonte anterior/i);
  assert.equal(svc.historico({id:inicio.id}).contexto_invalidado,true);
  assert.match(svc.historico({id:inicio.id}).fonte_rotulo,/fonte anterior/i);
  assert.throws(() => svc.obter({ id: inicio.id }, { clientId: 'codex', scope: { kind: 'all' } }));
  assert.throws(() => svc.registrar('verificacao', { execucao_id: inicio.id,
    chave_idempotencia: 'correcao-verificar-1', confirmar: true, nota: 'Não conferir.' }), { code: 'SOURCE_CHANGED' });
  const historia = new NotetakerServico(f.db, { notetakerExperimento: true,
    testProfileRoot: f.root, testMarker: f.marker, audioLocal: { estado: async () => ({ disponivel: false }) } })
    .historicoCorrecoes(trechoId);
  assert.equal(historia.correcoes.length, 1);
  assert.equal(historia.correcoes[0].textoAnterior, TRECHO);
  assert.equal(historia.correcoes[0].ator, 'local:owner');
  assert.ok(historia.correcoes[0].corrigidoEm);
  f.db.prepare('UPDATE notetaker_correcoes SET texto_anterior=? WHERE trecho_id=?').run('Texto forjado.', trechoId);
  assert.throws(() => svc.obter({ id: inicio.id }), { code: 'SOURCE_CHANGED' });
  assert.throws(() => svc.historico({ id: inicio.id }), { code: 'SOURCE_CHANGED' });
});

test('correção A–B–A preserva revisão, busca, vetor e direitos locais sem áudio', async t => {
  const f=await fixture(t), {acao}=registrar(f);
  prepararIndiceFontes(f.db);new Semantica(f.db,{extrair:async()=>[]});
  f.db.prepare('INSERT INTO desktop_vetores(evento_id,pedaco,inicio,fim,hash,modelo,vetor) VALUES(?,0,0,5,?,?,?)')
    .run(f.fonteId,'hash-antigo','teste',Buffer.alloc(4));
  const s=new NotetakerServico(f.db,{notetakerExperimento:true,testProfileRoot:f.root,testMarker:f.marker,
    audioLocal:{estado:async()=>({disponivel:false})}});
  const id=f.db.prepare('SELECT trecho_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).trecho_id;
  const base=s.trecho(id),antes=f.db.prepare('SELECT revisao FROM notetaker_sessoes WHERE id=?').get(f.sessao).revisao;
  assert.equal(base.ultimaCorrecao,null);
  assert.equal(s.corrigirTrecho(id,{texto:TRECHO,revisaoEsperada:0,confirmar:true}).repetida,true);
  assert.equal(s.historicoCorrecoes(id).correcoes.length,0);
  assert.equal(f.db.prepare('SELECT revisao FROM notetaker_sessoes WHERE id=?').get(f.sessao).revisao,antes);
  const novo='Enviar ata sintética na terça-feira 📝';
  assert.equal(s.corrigirTrecho(id,{texto:`  ${novo}  `,revisaoEsperada:0,confirmar:true}).textoExibido,novo);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'terça'").get().n,1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM desktop_fontes_fts WHERE desktop_fontes_fts MATCH 'amanhã'").get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desktop_vetores WHERE evento_id=?').get(f.fonteId).n,0);
  assert.throws(()=>s.corrigirTrecho(id,{texto:novo,revisaoEsperada:0,confirmar:true}),{code:'CONFLITO'});
  assert.equal(s.corrigirTrecho(id,{texto:TRECHO,revisaoEsperada:1,confirmar:true}).revisao,2);
  assert.equal(s.trecho(id).textoCorrigido,TRECHO);
  const h=s.historicoCorrecoes(id,{limite:1});
  assert.equal(h.correcoes[0].textoNovo,TRECHO);
  assert.ok(h.antes);
  assert.equal(s.historicoCorrecoes(id,{antes:h.antes,limite:1}).correcoes[0].textoNovo,novo);
  assert.equal(f.acoes().listar().some(x=>x.id===acao.id),false);
  const candidato={fonte:'E'+f.fonteId,tipo:'pendencia',resumo:'Enviar ata corrigida',trecho:TRECHO,prazo_citado:''};
  assert.equal(f.acoes().registrar({eventoId:f.fonteId,candidatas:[candidato]}).novos,1);
  assert.notEqual(f.acoes().listar()[0].id,acao.id);
  unlinkSync(f.audioPath);
  assert.equal(s.trecho(id).evidencia.estado,'original_indisponivel');
  assert.equal(f.acoes().listar().length,0);
  assert.equal(s.corrigirTrecho(id,{texto:'Ata final sintética.',revisaoEsperada:2,confirmar:true}).evidencia.estado,'original_indisponivel');
  assert.throws(()=>s.fonte(f.fonteId),{code:'INTEGRIDADE'});
  f.db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run('2026-09-27T18:00:00Z',f.sessao);
  assert.throws(()=>s.trecho(id),{code:'DIREITO'});
  assert.throws(()=>s.historicoCorrecoes(id),{code:'DIREITO'});
  assert.throws(()=>s.corrigirTrecho(id,{texto:'Negado',revisaoEsperada:3,confirmar:true}),{code:'DIREITO'});
});

test('falha no espelho da revisão reverte histórico, evento e trecho; marca ausente fecha auditoria', async t => {
  const f=await fixture(t), {acao}=registrar(f),svc=f.execucoes();
  const previa=svc.preparar({acao_id:acao.id}).contexto;
  const execucao=svc.iniciar({contexto_id:previa.id,assistente:'codex',confirmar:true,
    chave_idempotencia:'rollback-correcao-0001'}).execucao;
  const s=new NotetakerServico(f.db,{notetakerExperimento:true,testProfileRoot:f.root,testMarker:f.marker,
    audioLocal:{estado:async()=>({disponivel:false})}});
  const id=f.db.prepare('SELECT trecho_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).trecho_id;
  f.db.exec("CREATE TEMP TRIGGER falha_correcao BEFORE UPDATE OF revisao ON notetaker_fontes BEGIN SELECT RAISE(ABORT,'falha sintética'); END");
  assert.throws(()=>s.corrigirTrecho(id,{texto:'Texto novo.',revisaoEsperada:0,confirmar:true}),/falha sintética/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_correcoes').get().n,0);
  assert.equal(s.trecho(id).revisao,0);
  assert.equal(f.db.prepare('SELECT texto FROM eventos WHERE id=?').get(f.fonteId).texto,TRECHO);
  assert.equal(svc.guarda(previa.id).invalidada_em,null);
  f.db.exec('DROP TRIGGER falha_correcao');
  s.corrigirTrecho(id,{texto:'Texto novo.',revisaoEsperada:0,confirmar:true});
  unlinkSync(join(f.root,'.lume-notetaker-test'));
  assert.throws(()=>svc.obter({id:execucao.id}),{code:'SOURCE_CHANGED'});
  assert.throws(()=>s.trecho(id),{code:'FECHADO'});
});

test('auditoria de correção recusa lacuna, vínculo trocado, pacote adulterado e direitos revogados', async t => {
  for(const caso of ['lacuna','vinculo','pacote','direitos','audio_ausente']) await t.test(caso,async sub=>{
    const f=await fixture(sub),{acao}=registrar(f),svc=f.execucoes();
    const previa=svc.preparar({acao_id:acao.id}).contexto;
    const inicio=svc.iniciar({contexto_id:previa.id,assistente:'codex',confirmar:true,
      chave_idempotencia:`auditoria-${caso}-0001`}).execucao;
    svc.registrar('resultado',{execucao_id:inicio.id,chave_idempotencia:`resultado-${caso}-0001`,
      resumo:'Relato anterior.',artefatos:[]});
    const s=new NotetakerServico(f.db,{notetakerExperimento:true,testProfileRoot:f.root,testMarker:f.marker,
      audioLocal:{estado:async()=>({disponivel:false})}});
    const id=f.db.prepare('SELECT trecho_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).trecho_id;
    s.corrigirTrecho(id,{texto:'Versão B sintética.',revisaoEsperada:0,confirmar:true});
    s.corrigirTrecho(id,{texto:'Versão C sintética.',revisaoEsperada:1,confirmar:true});
    if(caso==='lacuna')f.db.prepare('DELETE FROM notetaker_correcoes WHERE trecho_id=? AND revisao=1').run(id);
    if(caso==='vinculo'){
      const parte=f.db.prepare('SELECT parte_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).parte_id;
      const outro=randomUUID();
      f.db.prepare('INSERT INTO notetaker_trechos(id,parte_id,ordinal,inicio_ms,fim_ms,texto_gerado,texto_corrigido,revisao) VALUES(?,?,1,500,900,?,?,2)')
        .run(outro,parte,TRECHO,'Versão C sintética.');
      f.db.prepare('UPDATE notetaker_fontes SET trecho_id=? WHERE evento_id=?').run(outro,f.fonteId);
    }
    if(caso==='pacote'){
      const salvo=f.db.prepare('SELECT pacote FROM lume_execucao_contextos WHERE id=?').get(previa.id).pacote;
      f.db.prepare('UPDATE lume_execucao_contextos SET pacote=? WHERE id=?').run(salvo.replace('Enviar resumo de teste','Tarefa forjada'),previa.id);
    }
    if(caso==='direitos')f.db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run('2026-09-27T20:00:00Z',f.sessao);
    if(caso==='audio_ausente')unlinkSync(f.audioPath);
    if(caso==='audio_ausente'){
      const local=svc.obter({id:inicio.id});
      assert.equal(local.execucao.estado,'resultado_informado');
      assert.equal(local.execucao.contexto_invalidado,true);
      assert.throws(()=>svc.fonteAutorizada(inicio.id),{code:'SOURCE_CHANGED'});
    }else{
      assert.throws(()=>svc.obter({id:inicio.id}),{code:'SOURCE_CHANGED'});
      assert.throws(()=>svc.historico({id:inicio.id}),{code:'SOURCE_CHANGED'});
    }
  });
});

test('correção revoga grant textual e mantém somente auditoria do titular', async t => {
  const f=await fixture(t),{acao}=registrar(f);
  const svc=new ExecucoesLume(f.db,{agora:()=>new Date('2026-09-27T15:00:00Z'),
    revisaoConector:()=> 'rev-sintetica-1'});
  const previa=svc.preparar({acao_id:acao.id}).contexto;
  const inicio=svc.iniciar({contexto_id:previa.id,assistente:'codex',confirmar:true,
    chave_idempotencia:'grant-correcao-0001',manter_contexto:true}).execucao;
  const acesso={clientId:'codex',revision:'rev-sintetica-1',scope:{kind:'all'}};
  svc.registrar('resultado',{execucao_id:inicio.id,chave_idempotencia:'grant-resultado-0001',
    resumo:'Resultado da fonte A.',artefatos:[]},acesso);
  const id=f.db.prepare('SELECT trecho_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).trecho_id;
  const s=new NotetakerServico(f.db,{notetakerExperimento:true,testProfileRoot:f.root,testMarker:f.marker,
    audioLocal:{estado:async()=>({disponivel:false})}});
  s.corrigirTrecho(id,{texto:'Fonte B sintética.',revisaoEsperada:0,confirmar:true});
  assert.equal(f.db.prepare('SELECT invalidada FROM lume_execucao_contexto_grants WHERE execucao_id=?').get(inicio.id).invalidada,1);
  assert.equal(svc.obter({id:inicio.id}).execucao.estado,'resultado_informado');
  assert.throws(()=>svc.obter({id:inicio.id},acesso),{code:'SCOPE_REVOKED'});
  assert.throws(()=>svc.fonteAutorizada(inicio.id,acesso));
  assert.throws(()=>svc.registrar('resultado',{execucao_id:inicio.id,chave_idempotencia:'grant-tardio-0001',
    resumo:'Não persistir.',artefatos:[]},acesso));
  assert.throws(()=>svc.registrar('verificacao',{execucao_id:inicio.id,chave_idempotencia:'grant-verificar-0001',
    confirmar:true,nota:'Não conferir.'}),{code:'SOURCE_CHANGED'});
});

test('contexto legado sem vínculo congelado não recebe autoridade histórica após correção',async t=>{
  const f=await fixture(t),{acao}=registrar(f),svc=f.execucoes();
  const previa=svc.preparar({acao_id:acao.id}).contexto;
  const salvo=f.db.prepare('SELECT pacote,integridade FROM lume_execucao_contextos WHERE id=?').get(previa.id);
  const integridade=JSON.parse(salvo.integridade);delete integridade.vinculo_notetaker;
  const antigo=JSON.stringify(integridade);
  f.db.prepare('UPDATE lume_execucao_contextos SET integridade=? WHERE id=?').run(antigo,previa.id);
  const assinatura=sha(Buffer.from(JSON.stringify([previa.id,salvo.pacote,antigo])));
  f.db.prepare('UPDATE lume_execucao_contexto_guardas SET assinatura_contexto=?,invalidada_em=NULL,motivo=NULL WHERE contexto_id=?')
    .run(assinatura,previa.id);
  const inicio=svc.iniciar({contexto_id:previa.id,assistente:'codex',confirmar:true,
    chave_idempotencia:'legado-correcao-0001'}).execucao;
  const id=f.db.prepare('SELECT trecho_id FROM notetaker_fontes WHERE evento_id=?').get(f.fonteId).trecho_id;
  const s=new NotetakerServico(f.db,{notetakerExperimento:true,testProfileRoot:f.root,testMarker:f.marker,
    audioLocal:{estado:async()=>({disponivel:false})}});
  s.corrigirTrecho(id,{texto:'Fonte corrigida.',revisaoEsperada:0,confirmar:true});
  assert.throws(()=>svc.obter({id:inicio.id}),{code:'SOURCE_CHANGED'});
});

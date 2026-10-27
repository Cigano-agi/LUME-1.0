import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { NotetakerServico } from '../src/notetaker/servico.js';
import { cabecalhoWav } from '../src/notetaker/contrato.js';
import { importarArquivo } from '../src/notetaker/importacao.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { prepararProjetosComerciais } from '../src/projetos-comerciais/esquema.js';
import { prepararTarefas, assinaturaFonte } from '../src/tarefas-esquema.js';
import { prepararComandosWhatsapp } from '../src/comandos-whatsapp.js';
import { selecionarDireitosSessao, iterarExportacaoSessao } from '../src/notetaker/direitos-selecao.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const COLUNAS_FONTE = 'texto,permissao,conversa_id,origem_id,recebido_em,projeto_id,origem_compartilhamento,autor_id,autor_e_dono,transcricao_meta';
const TEXTO = 'Enviar o resumo sintético da reunião amanhã.';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lume-notetaker-selecao-'));
  const marker = randomUUID(), anterior = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = root;
  writeFileSync(join(root, '.lume-notetaker-test'), marker);
  const path = join(root, 'db.sqlite'), db = abrirBanco(path);
  t.after(() => {
    db.close();
    if (anterior === undefined) delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE = anterior;
    rmSync(root, { recursive: true, force: true });
  });
  new ContextoApp(db); new Desktop(db);
  const svc = new NotetakerServico(db, { notetakerExperimento: true, testProfileRoot: root, testMarker: marker,
    audioLocal: { async estado() { return { disponivel: true }; }, async transcrever(bytes) {
      return { motor: 'whisper.cpp', modeloSha256: 'a'.repeat(64), audioSha256: sha(bytes),
        trechos: [{ inicioMs: 0, fimMs: 500, texto: TEXTO }] };
    } } });
  const sessao = svc.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
  svc.consentir(sessao, { entradas: ['importacao'], confirmar: true });
  const wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000)]);
  await importarArquivo({ headers: { 'content-length': String(wav.length) }, complete: true,
    async *[Symbol.asyncIterator]() { yield wav; } }, { servico: svc, sessaoId: sessao });
  assert.equal((await svc.transcreverImportacao(sessao)).estado, 'concluida');
  const evento = db.prepare('SELECT evento_id FROM notetaker_fontes').get().evento_id;
  return { db, svc, sessao, evento, root, marker, path,
    perfil: { testProfileRoot: root, testMarker: marker } };
}

function nota(db, texto = 'Nota sintética da sessão.') {
  return db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',NULL,1,'nota','{}',?,'2026-09-27T12:01:00.000Z','2026-09-27','minha') RETURNING id`)
    .get('nota:' + randomUUID(), randomUUID(), texto).id;
}

function eventoExterno(db, texto = 'Original externo sintético.') {
  return db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',NULL,0,'texto','{}',?,'2026-09-27T12:00:00.000Z','2026-09-27','minha') RETURNING id`)
    .get('externa:' + randomUUID(), randomUUID(), texto).id;
}

test('nota mista e rebind preservam origem histórica sem selecionar original externo', async t => {
  const f = await fixture(t);
  const ac = new AcoesLume(f.db);
  ac.registrar({ eventoId: f.evento, candidatas: [{ fonte: 'E' + f.evento, tipo: 'pendencia',
    resumo: 'Enviar resumo', trecho: TEXTO, prazo_citado: '' }] });
  const acao = f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(f.evento).id;
  const contexto = new ExecucoesLume(f.db).preparar({ acao_id: acao }).contexto;
  const trecho = f.db.prepare('SELECT id FROM notetaker_trechos').get().id;
  f.svc.corrigirTrecho(trecho, { texto: 'Texto sintético revisado da reunião.', revisaoEsperada: 0, confirmar: true });
  const externo = eventoExterno(f.db);
  const nota = f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',NULL,1,'nota','{}','Nota mista sintética.','2026-09-27T12:01:00.000Z','2026-09-27','minha') RETURNING id`)
    .get('nota:' + randomUUID(), randomUUID()).id;
  f.db.prepare('INSERT INTO priv_vinculos(fonte_id,derivado_id) VALUES(?,?)').run(f.evento, nota);
  f.db.prepare('INSERT INTO priv_vinculos(fonte_id,derivado_id) VALUES(?,?)').run(externo, nota);
  f.db.prepare('UPDATE lume_acoes SET evento_id=? WHERE id=?').run(externo, acao);
  const mapa = selecionarDireitosSessao(f.db, f.sessao, f.perfil);
  assert.ok(mapa.ids.eventos.includes(f.evento));
  assert.ok(mapa.ids.eventos.includes(nota));
  assert.ok(!mapa.ids.eventos.includes(externo));
  assert.ok(mapa.ids.contextos.includes(contexto.id));
  assert.ok(!mapa.ids.acoes.includes(acao));
  assert.ok(mapa.bloqueios.exportacao.some(b => b.classe === 'derivado_misto'));
  assert.ok(!mapa.bloqueios.exclusao.some(b => b.classe === 'contexto_ambiguo'));
  assert.throws(() => [...iterarExportacaoSessao(f.db, mapa, f.perfil)], { code: 'INTEGRIDADE' });
});

test('projeção pura mantém correção e contexto como relato sem grant ou instruções', async t => {
  const f = await fixture(t);
  const acoes = new AcoesLume(f.db);
  acoes.registrar({ eventoId: f.evento, candidatas: [{ fonte: 'E' + f.evento, tipo: 'pendencia',
    resumo: 'Enviar resumo', trecho: TEXTO, prazo_citado: '' }] });
  const acao = f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(f.evento).id;
  const contexto = new ExecucoesLume(f.db).preparar({ acao_id: acao }).contexto;
  const trecho = f.db.prepare('SELECT id FROM notetaker_trechos').get().id;
  f.svc.corrigirTrecho(trecho, { texto: 'Texto sintético revisado da reunião.', revisaoEsperada: 0, confirmar: true });
  const mapa = selecionarDireitosSessao(f.db, f.sessao, f.perfil);
  assert.deepEqual(mapa.bloqueios.exportacao, []);
  const linhas = [...iterarExportacaoSessao(f.db, mapa, f.perfil)];
  assert.equal(linhas.filter(x => x.tabela === 'notetaker_correcoes').length, 1);
  const ctx = linhas.find(x => x.tabela === 'lume_execucao_contextos' && x.registro.id === contexto.id).registro;
  assert.equal(ctx.rotulo, 'historico_sem_autorizacao');
  assert.equal(ctx.pacote.autorizacao, undefined);
  assert.equal(ctx.pacote.instrucoes, undefined);
  assert.equal(linhas.some(x => /grant|guardas/.test(x.tabela)), false);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(), undefined);
  const abandonado = iterarExportacaoSessao(f.db, mapa, f.perfil);
  assert.equal(abandonado.next().done, false); abandonado.return();
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(), undefined);
});

test('fecho termina em ciclo de notas e a assinatura muda em outra conexão', async t => {
  const f = await fixture(t), a = nota(f.db), b = nota(f.db);
  for (const [origem, destino] of [[f.evento, a], [a, b], [b, a]])
    f.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(origem, destino);
  const mapa = selecionarDireitosSessao(f.db, f.sessao, f.perfil);
  assert.deepEqual(mapa.ids.eventos, [f.evento, a, b]);
  assert.equal(mapa.bloqueios.exportacao.length, 0);
  const iter = iterarExportacaoSessao(f.db, mapa, f.perfil);
  const primeira = iter.next(); assert.equal(primeira.done, false);
  const outro = new DatabaseSync(f.path);
  try { outro.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Nota sintética alterada.', a); }
  finally { outro.close(); }
  const restante = [...iter];
  assert.equal(restante.find(x => x.tabela === 'eventos' && x.registro.id === a).registro.texto,
    'Nota sintética da sessão.');
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(), undefined);
  assert.throws(() => [...iterarExportacaoSessao(f.db, mapa, f.perfil)], { code: 'CONFLITO' });
});

test('fonte órfã, guarda adulterada e revogação fecham a seleção', async t => {
  const f = await fixture(t);
  const acoes = new AcoesLume(f.db);
  acoes.registrar({ eventoId: f.evento, candidatas: [{ fonte: 'E' + f.evento, tipo: 'pendencia',
    resumo: 'Enviar resumo', trecho: TEXTO, prazo_citado: '' }] });
  const acao = f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(f.evento).id;
  const contexto = new ExecucoesLume(f.db).preparar({ acao_id: acao }).contexto;
  f.db.prepare('UPDATE lume_execucao_contexto_guardas SET assinatura_contexto=? WHERE contexto_id=?')
    .run('0'.repeat(64), contexto.id);
  const mapa = selecionarDireitosSessao(f.db, f.sessao, f.perfil);
  assert.ok(mapa.bloqueios.exclusao.some(x => x.classe === 'contexto_ambiguo'));
  assert.throws(() => [...iterarExportacaoSessao(f.db, mapa, f.perfil)], { code: 'INTEGRIDADE' });
  f.db.prepare('DELETE FROM lume_execucao_contextos WHERE id=?').run(contexto.id);
  const orfao = f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',NULL,0,'notetaker_trecho','{}','Órfão sintético.','2026-09-27T12:01:00.000Z','2026-09-27','notetaker_local') RETURNING id`)
    .get('local:notetaker:' + f.sessao, randomUUID()).id;
  assert.throws(() => selecionarDireitosSessao(f.db, f.sessao, f.perfil), { code: 'INTEGRIDADE' });
  f.db.prepare('DELETE FROM eventos WHERE id=?').run(orfao);
  f.db.prepare('UPDATE notetaker_sessoes SET direitos_revogados_em=? WHERE id=?').run('2026-09-27T12:02:00.000Z', f.sessao);
  assert.throws(() => selecionarDireitosSessao(f.db, f.sessao, f.perfil), { code: 'DIREITO' });
});

test('projeto e sugestão mistos aparecem no impacto sem selecionar originais externos', async t => {
  const f = await fixture(t); prepararProjetosComerciais(f.db); prepararTarefas(f.db);
  const externo = eventoExterno(f.db), projeto = randomUUID(), sugestao = randomUUID();
  const sig = id => assinaturaFonte(f.db.prepare(`SELECT ${COLUNAS_FONTE} FROM desktop_fontes WHERE id=?`).get(id));
  f.db.prepare(`INSERT INTO lume_projetos_comerciais
    (id,nome,natureza,estado,chave,assinatura_criacao,bases_total,criado_em,atualizado_em)
    VALUES(?,'Projeto sintético','proposta','rascunho',?,?,2,'2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z')`)
    .run(projeto,'b'.repeat(64),'c'.repeat(64));
  for (const [evento, inicio] of [[f.evento,0],[externo,1]])
    f.db.prepare(`INSERT INTO lume_projetos_fontes
      (id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em)
      VALUES(?,?,?,?,?,1,'trecho',1,'2026-09-27T12:00:00.000Z')`)
      .run(randomUUID(),projeto,evento,sig(evento),inicio);
  f.db.prepare(`INSERT INTO desktop_tarefas_sugestoes
    (id,evento_id,tipo,resumo,trecho,prazo_citado,fontes_total,criada_em)
    VALUES(?,?,'pendencia','Resumo sintético',?,'',2,'2026-09-27T12:00:00.000Z')`)
    .run(sugestao,f.evento,TEXTO);
  for (const evento of [f.evento,externo])
    f.db.prepare('INSERT INTO desktop_tarefas_fontes VALUES(?,?,?)').run(sugestao,evento,sig(evento));
  const mapa = selecionarDireitosSessao(f.db, f.sessao, f.perfil);
  assert.ok(mapa.bloqueios.exportacao.some(x => x.classe === 'projeto_misto'));
  assert.ok(mapa.bloqueios.exportacao.some(x => x.classe === 'sugestao_mista'));
  assert.ok(mapa.impactos.some(x => x.classe === 'projeto_misto' && x.efeito === 'trigger_remove_projeto_inteiro'));
  assert.ok(mapa.impactos.some(x => x.classe === 'sugestao_mista'));
  assert.ok(!mapa.ids.eventos.includes(externo));
});

test('FK quebrada, cadeia adulterada e perfil sem marcador falham fechados', async t => {
  const f = await fixture(t);
  assert.throws(() => selecionarDireitosSessao(f.db, f.sessao,
    { ...f.perfil, testMarker: randomUUID() }), { code: 'FECHADO' });
  const trecho = f.db.prepare('SELECT id FROM notetaker_trechos').get().id;
  f.svc.corrigirTrecho(trecho, { texto: 'Texto sintético corrigido.', revisaoEsperada: 0, confirmar: true });
  f.db.prepare('UPDATE notetaker_correcoes SET texto_anterior=? WHERE trecho_id=?')
    .run('Original adulterado.', trecho);
  assert.throws(() => selecionarDireitosSessao(f.db, f.sessao, f.perfil), { code: 'INTEGRIDADE' });
  f.db.prepare('UPDATE notetaker_correcoes SET texto_anterior=? WHERE trecho_id=?').run(TEXTO, trecho);
  const extra = eventoExterno(f.db);
  f.db.exec('PRAGMA foreign_keys=OFF');
  try { f.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(extra, 99999999); }
  finally { f.db.exec('PRAGMA foreign_keys=ON'); }
  assert.throws(() => selecionarDireitosSessao(f.db, f.sessao, f.perfil), { code: 'INTEGRIDADE' });
});

test('transação externa é recusada sem alterar dados persistentes', async t => {
  const f = await fixture(t);
  const antes = f.db.prepare('SELECT COUNT(*) n FROM eventos').get().n;
  f.db.exec('BEGIN');
  try { assert.throws(() => selecionarDireitosSessao(f.db, f.sessao, f.perfil), { code: 'CONFLITO' }); }
  finally { f.db.exec('ROLLBACK'); }
  const mapa = selecionarDireitosSessao(f.db, f.sessao, f.perfil);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, antes);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(), undefined);
  assert.equal([...iterarExportacaoSessao(f.db, mapa, f.perfil)].filter(x=>x.tabela==='notetaker_sessoes').length,1);
});

test('tag usada por comando externo bloqueia exportação e permanece no impacto', async t => {
  const f = await fixture(t); prepararComandosWhatsapp(f.db);
  const externo=eventoExterno(f.db);
  const inserirComando=evento=>f.db.prepare(`INSERT INTO lume_comandos
    (idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em)
    VALUES(?,'v1',?,?,'origem','feito','ok','2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z') RETURNING id`)
    .get(randomUUID(),evento,'conversa:'+evento).id;
  const local=inserirComando(f.evento),outro=inserirComando(externo);
  const tag=f.db.prepare("INSERT INTO lume_tags(chave,nome_exibido,criada_em) VALUES('sintetica','Sintética','2026-09-27T12:00:00.000Z') RETURNING id").get().id;
  for(const [comando,evento] of [[local,f.evento],[outro,externo]])
    f.db.prepare(`INSERT INTO lume_tags_entidades
      (tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,criada_em)
      VALUES(?,'mensagem',?,?,?,'origem','2026-09-27T12:00:00.000Z')`)
      .run(tag,String(evento),comando,'conversa:'+evento);
  const mapa=selecionarDireitosSessao(f.db,f.sessao,f.perfil);
  assert.ok(mapa.bloqueios.exportacao.some(x=>x.classe==='tag_mista'));
  assert.ok(mapa.impactos.some(x=>x.classe==='tag_mista'&&x.efeito==='preservar_tag_compartilhada'));
  assert.ok(!mapa.ids.eventos.includes(externo));
});

test('hash legado detecta contexto sem guarda sem fabricar autoridade; aresta não nota preserva externo', async t => {
  const f=await fixture(t),acoes=new AcoesLume(f.db);
  acoes.registrar({eventoId:f.evento,candidatas:[{fonte:'E'+f.evento,tipo:'pendencia',
    resumo:'Enviar resumo',trecho:TEXTO,prazo_citado:''}]});
  const acao=f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(f.evento).id;
  const contexto=new ExecucoesLume(f.db).preparar({acao_id:acao}).contexto;
  const row=f.db.prepare('SELECT integridade FROM lume_execucao_contextos WHERE id=?').get(contexto.id);
  const integridade=JSON.parse(row.integridade);delete integridade.vinculo_notetaker;
  f.db.prepare('UPDATE lume_execucao_contextos SET integridade=? WHERE id=?').run(JSON.stringify(integridade),contexto.id);
  f.db.prepare('DELETE FROM lume_execucao_contexto_guardas WHERE contexto_id=?').run(contexto.id);
  const externo=eventoExterno(f.db);
  f.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(f.evento,externo);
  const mapa=selecionarDireitosSessao(f.db,f.sessao,f.perfil);
  assert.ok(mapa.bloqueios.exclusao.some(x=>x.classe==='contexto_ambiguo'&&x.id===contexto.id));
  assert.ok(mapa.bloqueios.exclusao.some(x=>x.classe==='derivado_desconhecido'&&x.id===externo));
  assert.ok(!mapa.ids.eventos.includes(externo));
});

test('extensão povoada fora do catálogo impede selecionar ou projetar', async t => {
  const f=await fixture(t);
  const mapa=selecionarDireitosSessao(f.db,f.sessao,f.perfil);
  f.db.exec('CREATE TABLE extensao_sem_contrato(id INTEGER PRIMARY KEY, texto TEXT);');
  f.db.prepare('INSERT INTO extensao_sem_contrato(texto) VALUES(?)').run('Dado sintético.');
  assert.throws(()=>selecionarDireitosSessao(f.db,f.sessao,f.perfil),{code:'INTEGRIDADE'});
  assert.throws(()=>[...iterarExportacaoSessao(f.db,mapa,f.perfil)],{code:'INTEGRIDADE'});
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(),undefined);
});

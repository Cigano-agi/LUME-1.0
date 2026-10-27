import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
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
import { prepararTarefas } from '../src/tarefas-esquema.js';
import { prepararComandosWhatsapp } from '../src/comandos-whatsapp.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { prepararEsquemaTranscricao } from '../src/transcricao.js';
import { prepararMetadadosAudio } from '../src/audio-desktop-arquivos.js';
import { Semantica } from '../src/semantica.js';
import { montarPlanoExclusao } from '../src/notetaker/exclusao-plano.js';
import { validarSchemaExclusao } from '../src/notetaker/exclusao-schema.js';
import { construirRecorteInterno } from '../src/notetaker/direitos-selecao.js';

const hash = b => createHash('sha256').update(b).digest('hex');
const inside = (base, path) => { const r = relative(base, path); return r && r !== '..' && !r.startsWith('..' + sep); };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lume-notetaker-delete-plan-'));
  const realRoot = realpathSync(root), temp = realpathSync(tmpdir()), marker = randomUUID();
  assert.ok(inside(temp, realRoot));
  writeFileSync(join(realRoot, '.lume-notetaker-test'), marker, { flag: 'wx' });
  const beforeEnv = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = realRoot;
  const db = abrirBanco(join(realRoot, 'fixture.sqlite'));
  new ContextoApp(db); new Desktop(db); prepararProjetosComerciais(db); prepararTarefas(db); prepararComandosWhatsapp(db);
  const svc = new NotetakerServico(db, { notetakerExperimento: true, testProfileRoot: realRoot, testMarker: marker,
    audioLocal: { async estado() { return { disponivel: true }; }, async transcrever(bytes) {
      return { motor: 'whisper.cpp', modeloSha256: 'a'.repeat(64), audioSha256: hash(bytes),
        trechos: [{ inicioMs: 0, fimMs: 500, texto: 'Síntese inteiramente fictícia.' }] };
    } } });
  const sessaoId = svc.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
  svc.consentir(sessaoId, { entradas: ['importacao'], confirmar: true });
  const wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000)]);
  await importarArquivo({ headers: { 'content-length': String(wav.length), 'content-type': 'audio/wav' }, complete: true,
    async *[Symbol.asyncIterator]() { yield wav; } }, { servico: svc, sessaoId });
  assert.equal((await svc.transcreverImportacao(sessaoId)).estado, 'concluida');
  t.after(() => {
    db.close();
    if (beforeEnv === undefined) delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE = beforeEnv;
    const again = realpathSync(realRoot);
    assert.ok(inside(realpathSync(tmpdir()), again));
    assert.match(again.split(/[\\/]/).at(-1), /^lume-notetaker-delete-plan-/);
    rmSync(again, { recursive: true, force: false });
  });
  return { db, svc, sessaoId, perfil: { notetakerExperimento: true, testProfileRoot: realRoot, testMarker: marker }, root: realRoot };
}

function inTransaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = run(); db.exec('ROLLBACK'); return result; }
  catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}

function ids(plan, name) { return plan.tabelas.find(t => t.nome === name)?.remover ?? []; }

test('plano fecha PKs compostas e impactos sem texto, arquivos ou grants como autoridade', async t => {
  const f = await fixture(t), ac = new AcoesLume(f.db);
  const internalEventId=f.db.prepare('SELECT evento_id FROM notetaker_fontes').get().evento_id;
  ac.registrar({ eventoId: internalEventId,
    candidatas: [{ fonte: `E${internalEventId}`, tipo: 'pendencia', resumo: 'Falso resumo', trecho: 'Síntese inteiramente fictícia.', prazo_citado: '' }] });
  const action = f.db.prepare('SELECT id FROM lume_acoes ORDER BY id LIMIT 1').get().id;
  const ctx = new ExecucoesLume(f.db).preparar({ acao_id: action }).contexto;
  prepararProjetosComerciais(f.db);
  const executionId = randomUUID(), now='2026-09-27T12:00:00.000Z';
  f.db.prepare(`INSERT INTO lume_execucoes(id,contexto_id,assistente,cliente_id,estado,chave_inicio,assinatura_inicio,autorizada_em,atualizada_em)
    VALUES(?,?,'codex','codex','aguardando_assistente',?,'synthetic',?,?)`).run(executionId,ctx.id,randomUUID(),now,now);
  f.db.prepare(`INSERT INTO lume_execucao_contexto_grants(execucao_id,contexto_id,cliente_id,consentida_em,expira_em,assinatura_contexto)
    VALUES(?,?,'codex',?,'2026-09-28T12:00:00.000Z','grant-secret-fixture')`).run(executionId,ctx.id,now);
  const externalId = f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('external-fixture','external-origin','entrada',0,'texto','{}','External sentinel','2026-09-27T12:00:00Z','2026-09-27','minha') RETURNING id`).get().id;
  f.db.prepare('UPDATE lume_acoes SET evento_id=? WHERE id=?').run(externalId, action);
  const externalProjectEvent = f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('project-external','project-source','entrada',0,'texto','{}','External project source','2026-09-27T12:00:00Z','2026-09-27','minha') RETURNING id`).get().id;
  const project = f.db.prepare(`INSERT INTO lume_projetos_comerciais(id,nome,natureza,estado,chave,assinatura_criacao,bases_total,criado_em,atualizado_em)
    VALUES(?, 'Synthetic shared project','proposta','rascunho',?,'fixture',1,'2026-09-27T12:00:00Z','2026-09-27T12:00:00Z') RETURNING id`).get(randomUUID(),randomUUID()).id;
  const nonBaseProject = f.db.prepare(`INSERT INTO lume_projetos_comerciais(id,nome,natureza,estado,chave,assinatura_criacao,bases_total,criado_em,atualizado_em)
    VALUES(?, 'Synthetic nonbase project','proposta','rascunho',?,'fixture',1,'2026-09-27T12:00:00Z','2026-09-27T12:00:00Z') RETURNING id`).get(randomUUID(),randomUUID()).id;
  const internalEvent = f.db.prepare('SELECT evento_id FROM notetaker_fontes').get().evento_id;
  const sourceLink = (eventId,base) => f.db.prepare(`INSERT INTO lume_projetos_fontes
    (id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em) VALUES(?,?,?,'fixture',0,1,'evento',?,?)`)
    .run(randomUUID(),project,eventId,base,'2026-09-27T12:00:00Z');
  sourceLink(internalEvent,1); sourceLink(externalProjectEvent,0);
  const linkNonBase = (projectId,eventId,base) => f.db.prepare(`INSERT INTO lume_projetos_fontes
    (id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em) VALUES(?,?,?,'fixture',0,1,'evento',?,?) RETURNING id`)
    .get(randomUUID(),projectId,eventId,base,'2026-09-27T12:00:00Z').id;
  const internalNonBaseId=linkNonBase(nonBaseProject,internalEvent,0), externalBaseId=linkNonBase(nonBaseProject,externalProjectEvent,1);
  const externalBaseId1=f.db.prepare('SELECT id FROM lume_projetos_fontes WHERE projeto_id=? AND evento_id=?').get(project,externalProjectEvent).id;
  const command = f.db.prepare(`INSERT INTO lume_comandos(idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em)
    VALUES(?,'v1',?,'synthetic','origin','feito','test','2026-09-27T12:00:00Z','2026-09-27T12:00:00Z') RETURNING id`)
    .get(randomUUID(), internalEvent).id;
  const sharedTag = f.db.prepare("INSERT INTO lume_tags(chave,nome_exibido,criada_em) VALUES('shared-fixture','Shared fixture','2026-09-27T12:00:00Z') RETURNING id").get().id;
  const otherCommand = f.db.prepare(`INSERT INTO lume_comandos(idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em)
    VALUES(?,'v1',?,'other','origin','feito','test','2026-09-27T12:00:00Z','2026-09-27T12:00:00Z') RETURNING id`)
    .get(randomUUID(), externalId).id;
  for (const [cmd, event, conversation] of [[command, internalEvent, 'synthetic'], [otherCommand, externalId, 'other']])
    f.db.prepare(`INSERT INTO lume_tags_entidades(tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,criada_em)
      VALUES(?,'mensagem',?,?,?,'origin','2026-09-27T12:00:00Z')`).run(sharedTag, String(event), cmd, conversation);

  const plan = inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }));
  assert.deepEqual(Object.keys(plan).sort(), ['arquivos','bloqueios','impactos','revisao','schema','schemaAssinatura','sessaoId','assinatura','tabelas'].sort());
  assert.equal(plan.schema, 1);
  assert.ok(ids(plan, 'lume_execucao_contexto_grants').some(([id]) => id === executionId));
  assert.ok(plan.tabelas.find(x=>x.nome==='lume_acoes').preservar.some(([id])=>id===action));
  const edge = plan.tabelas.find(x => x.nome === 'priv_vinculos');
  assert.ok(edge.pk.includes('fonte_id') && edge.pk.includes('derivado_id'));
  assert.ok(plan.impactos.some(x => x.classe === 'projeto_misto' && x.efeito === 'trigger_remove_projeto_inteiro'));
  assert.ok(ids(plan,'lume_projetos_comerciais').some(([id])=>id===project));
  assert.ok(!ids(plan,'lume_projetos_comerciais').some(([id])=>id===nonBaseProject));
  assert.ok(plan.tabelas.find(x=>x.nome==='lume_projetos_comerciais').preservar.some(([id])=>id===nonBaseProject));
  assert.ok(ids(plan,'lume_projetos_fontes').some(([id])=>id===externalBaseId1));
  assert.ok(ids(plan,'lume_projetos_fontes').some(([id])=>id===internalNonBaseId));
  assert.ok(plan.tabelas.find(x=>x.nome==='lume_projetos_fontes').preservar.some(([id])=>id===externalBaseId));
  assert.ok(plan.tabelas.find(x=>x.nome==='lume_projetos_importados_guardas').preservar.some(([id])=>id===externalBaseId));
  assert.ok(plan.tabelas.find(x=>x.nome==='lume_tags_entidades').preservar.some(x=>x[0]===sharedTag&&x[3]===otherCommand));
  assert.ok(plan.impactos.some(x => x.classe === 'tag_mista' && x.efeito === 'preservar_tag_compartilhada'));
  assert.ok(!JSON.stringify(plan).includes('External sentinel'));
  assert.ok(!JSON.stringify(plan).includes('Síntese inteiramente fictícia'));
  assert.ok(!JSON.stringify(plan).includes('grant-secret-fixture'));
  assert.ok(!JSON.stringify(plan).includes('cliente_id'));
  assert.ok(plan.arquivos.every(x => Object.keys(x).sort().join(',') === 'nome,parteId,sha256'));
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(), undefined);
  assert.equal(f.db.prepare("SELECT texto FROM eventos WHERE id=?").get(externalId).texto, 'External sentinel');
});

test('duas chamadas na mesma transação são determinísticas e não fecham transação do chamador', async t => {
  const f = await fixture(t);
  f.db.exec('BEGIN IMMEDIATE; CREATE TEMP TABLE caller_keep(id INTEGER); INSERT INTO caller_keep VALUES(17)');
  const tempBefore=f.db.prepare('SELECT type,name,sql FROM sqlite_temp_master ORDER BY name').all();
  const first = montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil });
  const second = montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil });
  assert.equal(f.db.isTransaction, true);
  assert.deepEqual(second, first);
  assert.deepEqual(f.db.prepare('SELECT type,name,sql FROM sqlite_temp_master ORDER BY name').all(),tempBefore);
  assert.equal(f.db.prepare('SELECT id FROM caller_keep').get().id,17);
  f.db.exec('ROLLBACK');
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(), undefined);
});

test('falha sob savepoint limpa TEMP e preserva a transação externa', async t => {
  const f = await fixture(t);
  f.db.exec('BEGIN IMMEDIATE');
  f.db.exec('CREATE TABLE extensao_desconhecida_povoada(id INTEGER PRIMARY KEY, valor TEXT)');
  f.db.prepare('INSERT INTO extensao_desconhecida_povoada VALUES(1,\'sentinela\')').run();
  assert.throws(() => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }), { code: 'INTEGRIDADE' });
  assert.equal(f.db.isTransaction, true);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(), undefined);
  assert.equal(f.db.prepare("SELECT valor FROM extensao_desconhecida_povoada WHERE id=1").get().valor, 'sentinela');
  f.db.exec('ROLLBACK');
});

test('mudança de conteúdo muda assinatura e resultado inteiro é profundamente imutável', async t => {
  const f = await fixture(t);
  const one = inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }));
  const session = f.db.prepare('SELECT revisao FROM notetaker_sessoes WHERE id=?').get(f.sessaoId);
  f.db.prepare('UPDATE notetaker_sessoes SET revisao=revisao+1 WHERE id=?').run(f.sessaoId);
  const two = inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }));
  assert.notEqual(one.assinatura, two.assinatura);
  assert.ok(Object.isFrozen(two) && Object.isFrozen(two.tabelas) && Object.isFrozen(two.tabelas[0]));
  assert.ok(Object.isFrozen(two.tabelas[0].pk) && Object.isFrozen(two.tabelas[0].remover));
  assert.equal(session.revisao + 1, two.revisao);
});

test('schema/trigger adulterado recusa, tabelas desconhecidas continuam bloqueadas', async t => {
  const f = await fixture(t);
  inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }));
  const triggerSql=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lume_projetos_revisao_evento'").get().sql;
  f.db.exec('DROP TRIGGER lume_projetos_revisao_evento');
  assert.throws(() => inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil })), { code: 'INTEGRIDADE' });
  f.db.exec(triggerSql);
  f.db.exec("DROP TRIGGER lume_projetos_evento_apagado; CREATE TRIGGER lume_projetos_evento_apagado AFTER DELETE ON eventos BEGIN SELECT 1; END");
  assert.throws(() => inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil })), { code: 'INTEGRIDADE' });
  f.db.exec('DROP TRIGGER lume_projetos_evento_apagado');
  f.db.exec('CREATE TABLE unknown_empty(id INTEGER PRIMARY KEY)');
  assert.throws(() => inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil })), { code: 'INTEGRIDADE' });
});

test('hashes de trigger preservam literais e triggers esperados ausentes falham fechados', async t => {
  const f = await fixture(t); new AcoesLume(f.db); new ExecucoesLume(f.db);
  f.db.exec('BEGIN; SAVEPOINT trigger_integrity');
  const sql=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lume_execucao_grant_revogada'").get().sql;
  assert.ok(sql.includes("'revogada'"));
  f.db.exec('DROP TRIGGER lume_execucao_grant_revogada');
  f.db.exec(sql.replace("'revogada'", "'REVOGADA'"));
  assert.throws(() => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }), { code: 'INTEGRIDADE' });
  f.db.exec('ROLLBACK TO trigger_integrity; RELEASE trigger_integrity; SAVEPOINT trigger_integrity');
  f.db.exec('DROP TRIGGER lume_execucao_guarda_snapshot_UPDATE');
  assert.throws(() => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }), { code: 'INTEGRIDADE' });
  f.db.exec('ROLLBACK TO trigger_integrity; RELEASE trigger_integrity; ROLLBACK');
  assert.equal(f.db.isTransaction, false);
});

test('gatilhos FTS e famílias condicionais ativas são reconhecidos e obrigatórios', async t => {
  const f = await fixture(t);
  new DesktopIA(f.db,{gerar:async()=>{throw new Error('offline');}});
  new Semantica(f.db,{extrair:async()=>[]});
  prepararEsquemaTranscricao(f.db); prepararMetadadosAudio(f.db);
  new AcoesLume(f.db); new ExecucoesLume(f.db); prepararProjetosComerciais(f.db);
  const obrigatorios=['desktop_fontes_ad','desktop_transcricao_fts_ai','desktop_vetores_update','desktop_transcricao_vetores_ai',
    'desktop_transcricao_fts_ad','lume_projetos_transcricao_inserida',
    'lume_projetos_revisao_transcricao_delete','lume_projetos_revisao_acao_alterada',
    'lume_projetos_revisao_organizar_update','lume_execucao_grant_transcricoes_UPDATE'];
  for (const name of obrigatorios) {
    const sql=f.db.prepare('SELECT sql FROM sqlite_master WHERE type=\'trigger\' AND name=?').get(name)?.sql;
    assert.ok(sql,name); assert.doesNotThrow(()=>validarSchemaExclusao(f.db),name);
    f.db.exec(`DROP TRIGGER "${name}"`);
    assert.throws(()=>validarSchemaExclusao(f.db),{code:'INTEGRIDADE'},name);
    f.db.exec(sql);
  }
  const sql=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lume_projetos_revisao_organizar_update'").get().sql;
  f.db.exec('DROP TRIGGER lume_projetos_revisao_organizar_update; CREATE TRIGGER lume_projetos_revisao_organizar_update AFTER UPDATE ON lume_acoes_conversas BEGIN SELECT 1; END');
  assert.throws(()=>validarSchemaExclusao(f.db),{code:'INTEGRIDADE'});
  f.db.exec('DROP TRIGGER lume_projetos_revisao_organizar_update'); f.db.exec(sql);
});

test('expansão de associação privada falha no primeiro registro acima do limite sem all()', async t => {
  const f = await fixture(t);
  const eventId=f.db.prepare('SELECT evento_id FROM notetaker_fontes').get().evento_id;
  const command=f.db.prepare(`INSERT INTO lume_comandos(idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em)
    VALUES(?,'v1',?,'synthetic','origin','feito','test','2026-09-27T12:00:00Z','2026-09-27T12:00:00Z') RETURNING id`).get(randomUUID(),eventId).id;
  const tag=f.db.prepare("INSERT INTO lume_tags(chave,nome_exibido,criada_em) VALUES('bounded-fixture','Bounded fixture','2026-09-27T12:00:00Z') RETURNING id").get().id;
  f.db.prepare(`INSERT INTO lume_tags_entidades(tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,criada_em)
    VALUES(?,'mensagem',?,?,'synthetic','origin','2026-09-27T12:00:00Z')`).run(tag,String(eventId),command);
  const oversized={tag_id:tag,entidade_tipo:'mensagem',entidade_id:'external',comando_id:'external-command',
    conversa_id:'x'.repeat(4*1024*1024+1),origem_id:'external-origin',criada_em:'2026-09-27T12:00:00Z'};
  let allCalls=0,iterated=false;
  f.db.exec('BEGIN IMMEDIATE');
  const db={get isTransaction(){return f.db.isTransaction},exec:sql=>f.db.exec(sql),prepare(sql){
    if(String(sql).includes('c0:external-associations')) return {
      all(){allCalls++;return [oversized]},
      *iterate(){iterated=true;yield oversized;}
    };
    return f.db.prepare(sql);
  }};
  assert.throws(()=>montarPlanoExclusao(db,{sessaoId:f.sessaoId,...f.perfil}),{code:'LIMITE'});
  assert.equal(allCalls,0); assert.equal(iterated,true);
  assert.equal(f.db.isTransaction,true);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_temp_master WHERE name LIKE 'd3_%'").get(),undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_tags_entidades').get().n,1);
  f.db.exec('ROLLBACK');
});

test('metadados privados somam os bytes efetivamente selecionados após completar', async t => {
  const f=await fixture(t);
  const eventId=f.db.prepare('SELECT evento_id FROM notetaker_fontes').get().evento_id;
  const projectId=randomUUID();
  f.db.prepare(`INSERT INTO lume_projetos_comerciais(id,nome,natureza,estado,chave,assinatura_criacao,bases_total,criado_em,atualizado_em)
    VALUES(?,?,'proposta','rascunho',?,'fixture',1,'2026-09-27T12:00:00Z','2026-09-27T12:00:00Z')`)
    .run(projectId,'P'.repeat(1024*1024),randomUUID());
  f.db.prepare(`INSERT INTO lume_projetos_fontes(id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em)
    VALUES(?,?,?,'fixture',0,1,'evento',1,'2026-09-27T12:00:00Z')`).run(randomUUID(),projectId,eventId);
  const recorte=inTransaction(f.db,()=>construirRecorteInterno(f.db,f.sessaoId,f.perfil));
  const bytesSelecionados=[...Object.values(recorte.rows),...Object.values(recorte.aux)]
    .flat().reduce((n,row)=>n+Buffer.byteLength(JSON.stringify(row)),0);
  const linhasSelecionadas=[...Object.values(recorte.rows),...Object.values(recorte.aux)]
    .reduce((n,rows)=>n+rows.length,0);
  assert.equal(recorte.orcamento.linhas,linhasSelecionadas);
  assert.ok(recorte.orcamento.bytes>=bytesSelecionados);
});

test('API continua estritamente read-only para banco e arquivos', async t => {
  const f = await fixture(t);
  const before = f.db.prepare('SELECT COUNT(*) n FROM eventos').get().n;
  const plan = inTransaction(f.db, () => montarPlanoExclusao(f.db, { sessaoId: f.sessaoId, ...f.perfil }));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM eventos').get().n, before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM notetaker_sessoes WHERE id=?').get(f.sessaoId).n, 1);
  assert.ok(!('token' in plan) && !('path' in plan) && !('sql' in plan));
});

test('conversa_app de nota vinculada permanece preservada, bloqueada e sem metadados no resultado', async t => {
  const f=await fixture(t), app=new ContextoApp(f.db);
  const noteText='PRIVATE NOTE BODY C0'; const noteTitle='PRIVATE NOTE TITLE C0';
  const note=app.nota({texto:noteText,titulo:noteTitle});
  const conversation=f.db.prepare('SELECT conversa_id FROM eventos WHERE id=?').get(note.id).conversa_id;
  const source=f.db.prepare('SELECT evento_id FROM notetaker_fontes WHERE sessao_id=?').get(f.sessaoId).evento_id;
  f.db.prepare('INSERT INTO priv_vinculos(fonte_id,derivado_id) VALUES(?,?)').run(source,note.id);
  const plan=inTransaction(f.db,()=>montarPlanoExclusao(f.db,{sessaoId:f.sessaoId,...f.perfil}));
  const table=plan.tabelas.find(x=>x.nome==='conversas_app');
  assert.deepEqual(table.pk,['id']);
  assert.deepEqual(table.remover,[]);
  assert.deepEqual(table.preservar,[[conversation]]);
  assert.ok(plan.bloqueios.exclusao.some(x=>x.classe==='nota_sem_regra'&&x.motivo==='metadado_conversa_preservado'));
  assert.ok(plan.impactos.some(x=>x.classe==='metadado_conversa'&&x.efeito==='preservar_conversa_sem_regra_de_exclusao'));
  assert.equal(JSON.stringify(plan).includes(noteText),false);
  assert.equal(JSON.stringify(plan).includes(noteTitle),false);
  f.db.prepare('UPDATE conversas_app SET nome=? WHERE id=?').run('PRIVATE NOTE TITLE CHANGED C0',conversation);
  const changed=inTransaction(f.db,()=>montarPlanoExclusao(f.db,{sessaoId:f.sessaoId,...f.perfil}));
  assert.notEqual(changed.assinatura,plan.assinatura);
});

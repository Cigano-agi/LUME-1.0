import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { Semantica } from '../src/semantica.js';
import { NotetakerServico } from '../src/notetaker/servico.js';
import { cabecalhoWav } from '../src/notetaker/contrato.js';
import { importarArquivo } from '../src/notetaker/importacao.js';
import { AcoesLume } from '../src/acoes-lume.js';
import { ExecucoesLume } from '../src/execucao/servico.js';
import { prepararProjetosComerciais } from '../src/projetos-comerciais/esquema.js';
import { prepararEsquemaTranscricao } from '../src/transcricao.js';
import { prepararMetadadosAudio } from '../src/audio-desktop-arquivos.js';
import { prepararTarefas, assinaturaFonte } from '../src/tarefas-esquema.js';
import { prepararEsquemaCrm } from '../src/crm.js';
import { prepararEsquemaRascunho } from '../src/rascunho.js';
import { prepararExecucoes } from '../src/execucao/esquema.js';
import { prepararComandosWhatsapp } from '../src/comandos-whatsapp.js';
import { selecionarDireitosSessao, iterarExportacaoSessao } from '../src/notetaker/direitos-selecao.js';
import { montarPlanoExclusao } from '../src/notetaker/exclusao-plano.js';
import { validarSchemaExclusao } from '../src/notetaker/exclusao-schema.js';

const TEXTO = 'Enviar resumo sintético privado amanhã.';
const DATA = '2026-09-27T12:00:00.000Z';
const sha = x => createHash('sha256').update(x).digest('hex');
const COLS = 'texto,permissao,conversa_id,origem_id,recebido_em,projeto_id,origem_compartilhamento,autor_id,autor_e_dono,transcricao_meta';
async function fixture(t) {
  const root = resolve(mkdtempSync(join(tmpdir(), 'lume-notetaker-c0-review-'))), marker = randomUUID();
  const anterior = process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
  process.env.ASSESSOR_DESKTOP_TEST_PROFILE = root;
  writeFileSync(join(root, '.lume-notetaker-test'), marker);
  const db = abrirBanco(join(root, 'db.sqlite'));
  t.after(() => {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    if (anterior === undefined) delete process.env.ASSESSOR_DESKTOP_TEST_PROFILE;
    else process.env.ASSESSOR_DESKTOP_TEST_PROFILE = anterior;
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('lume-notetaker-c0-review-'));
    assert.equal(readFileSync(join(root, '.lume-notetaker-test'), 'utf8'), marker);
    rmSync(root, { recursive: true, force: true });
  });
  new ContextoApp(db); new Desktop(db);
  const perfil = { testProfileRoot: root, testMarker: marker };
  const svc = new NotetakerServico(db, { notetakerExperimento: true, ...perfil,
    audioLocal: { async estado() { return { disponivel: true }; }, async transcrever(bytes) {
      return { motor: 'whisper.cpp', modeloSha256: 'a'.repeat(64), audioSha256: sha(bytes),
        trechos: [{ inicioMs: 0, fimMs: 500, texto: TEXTO }] };
    } } });
  async function sessaoNova() {
    const id = svc.criarSessao({ origem: 'importacao', entradas: ['importacao'] }).id;
    svc.consentir(id, { entradas: ['importacao'], confirmar: true });
    const wav = Buffer.concat([cabecalhoWav(32000), Buffer.alloc(32000)]);
    await importarArquivo({ headers: { 'content-length': String(wav.length) }, complete: true,
      async *[Symbol.asyncIterator]() { yield wav; } }, { servico: svc, sessaoId: id });
    assert.equal((await svc.transcreverImportacao(id)).estado, 'concluida');
    return id;
  }
  const sessao = await sessaoNova();
  const evento = db.prepare('SELECT evento_id FROM notetaker_fontes WHERE sessao_id=?').get(sessao).evento_id;
  return { db, svc, root, perfil, sessao, evento, sessaoNova };
}
const plano = f => montarPlanoExclusao(f.db, { sessaoId: f.sessao, ...f.perfil });
const tabela = (p, nome) => { const x = p.tabelas.find(t => t.nome === nome); assert.ok(x, nome); return x; };
const contem = (p, nome, efeito, chave) => assert.ok(tabela(p, nome)[efeito].some(x => JSON.stringify(x) === JSON.stringify(chave)), `${nome}.${efeito} ${JSON.stringify(chave)}`);
function externo(db, tipo = 'texto') {
  return db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada',1,?,'{}','Original externo privado',?,'2026-09-27','minha') RETURNING id`)
    .get('externa:' + randomUUID(), randomUUID(), tipo, DATA).id;
}
const sig = (db, id) => assinaturaFonte(db.prepare(`SELECT ${COLS} FROM desktop_fontes WHERE id=?`).get(id));
function congelado(x) {
  if (x && typeof x === 'object') { assert.ok(Object.isFrozen(x)); for (const v of Object.values(x)) congelado(v); }
}
function estado(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()]);
}
const temp = db => db.prepare('SELECT type,name,sql FROM sqlite_temp_master ORDER BY name').all();
function arquivos(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(x => x.isFile() && !x.name.startsWith('db.sqlite'))
    .map(x => { const path = join(x.parentPath, x.name); return [path, sha(readFileSync(path))]; }).sort();
}

test('C0 duas reconstruções preservam caller, TEMP, dados, arquivos e isolamento entre sessões', async t => {
  const f = await fixture(t), outra = await f.sessaoNova();
  assert.throws(() => plano(f));
  const antes = estado(f.db), bytes = arquivos(f.root);
  f.db.exec('BEGIN; CREATE TEMP TABLE caller_keep(id INTEGER); INSERT INTO caller_keep VALUES(73)');
  const temporarias = temp(f.db), a = plano(f), b = plano(f);
  assert.deepEqual(a, b); assert.equal(f.db.isTransaction, true); assert.deepEqual(temp(f.db), temporarias);
  assert.deepEqual(estado(f.db), antes); assert.deepEqual(arquivos(f.root), bytes);
  assert.equal(f.db.prepare('SELECT id FROM caller_keep').get().id, 73);
  assert.equal(a.schema, 1); assert.equal(a.sessaoId, f.sessao);
  assert.equal(a.revisao, f.db.prepare('SELECT revisao FROM notetaker_sessoes WHERE id=?').get(f.sessao).revisao);
  assert.match(a.assinatura, /^[a-f0-9]{64}$/); assert.match(a.schemaAssinatura, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(a).sort(), ['schema','sessaoId','revisao','assinatura','schemaAssinatura','tabelas','arquivos','impactos','bloqueios'].sort());
  assert.equal(JSON.stringify(a).includes(outra), false); assert.equal(JSON.stringify(a).includes(TEXTO), false);
  congelado(a);
  for (const x of a.tabelas) { assert.deepEqual(Object.keys(x).sort(), ['nome','pk','remover','preservar'].sort()); for (const k of [...x.remover, ...x.preservar]) assert.equal(k.length, x.pk.length); }
  assert.deepEqual(a.arquivos, f.db.prepare('SELECT id parteId,caminho nome,sha256 FROM notetaker_partes WHERE sessao_id=? ORDER BY posicao,id').all(f.sessao).map(x => ({...x})));
  assert.throws(() => selecionarDireitosSessao(f.db, f.sessao, f.perfil), { code: 'CONFLITO' });
  assert.throws(() => [...iterarExportacaoSessao(f.db, { schema: 1, sessaoId: f.sessao, assinatura: a.assinatura }, f.perfil)], { code: 'CONFLITO' });
});

test('C0 falha depois de criar TEMP preserva transação e permite reconstrução', async t => {
  const f = await fixture(t), id = f.db.prepare('SELECT id FROM notetaker_partes').get().id;
  f.db.exec('BEGIN; CREATE TEMP TABLE caller_keep(id INTEGER); INSERT INTO caller_keep VALUES(19)');
  const antes = temp(f.db);
  f.db.prepare('UPDATE notetaker_partes SET caminho=? WHERE id=?').run('arbitrario.wav', id);
  assert.throws(() => plano(f)); assert.equal(f.db.isTransaction, true); assert.deepEqual(temp(f.db), antes);
  assert.equal(f.db.prepare('SELECT caminho FROM notetaker_partes WHERE id=?').get(id).caminho, 'arbitrario.wav');
  f.db.prepare('UPDATE notetaker_partes SET caminho=? WHERE id=?').run(id + '.wav', id);
  assert.equal(plano(f).sessaoId, f.sessao); assert.deepEqual(temp(f.db), antes);
});

test('C0 grants têm todas as PKs sem credenciais e ação rebindada é preservada', async t => {
  const f = await fixture(t), ac = new AcoesLume(f.db);
  ac.registrar({ eventoId: f.evento, candidatas: [{ fonte: 'E' + f.evento, tipo: 'pendencia', resumo: 'Enviar resumo', trecho: TEXTO, prazo_citado: '' }] });
  const acao = f.db.prepare('SELECT id FROM lume_acoes WHERE evento_id=?').get(f.evento).id;
  const contexto = new ExecucoesLume(f.db).preparar({ acao_id: acao }).contexto;
  const eid = randomUUID(), segredo = 'CREDENCIAL-SINTETICA-NAO-RETORNAR';
  f.db.prepare(`INSERT INTO lume_execucoes VALUES(?,?,'codex',?,'aguardando_assistente',?,?,?,?)`).run(eid, contexto.id, segredo, randomUUID(), segredo, DATA, DATA);
  f.db.prepare(`INSERT INTO lume_execucao_contexto_grants(execucao_id,contexto_id,cliente_id,consentida_em,expira_em,assinatura_contexto,revisao_conector) VALUES(?,?,?,?,?,?,?)`)
    .run(eid, contexto.id, segredo, DATA, DATA, segredo, segredo);
  const ext = externo(f.db); f.db.prepare('UPDATE lume_acoes SET evento_id=? WHERE id=?').run(ext, acao);
  f.db.exec('BEGIN'); const p = plano(f);
  assert.deepEqual(tabela(p, 'lume_execucao_contexto_grants').pk, ['execucao_id']);
  contem(p, 'lume_execucao_contexto_grants', 'remover', [eid]); contem(p, 'lume_execucoes', 'remover', [eid]);
  contem(p, 'lume_execucao_contextos', 'remover', [contexto.id]); contem(p, 'lume_execucao_contexto_guardas', 'remover', [contexto.id]);
  contem(p, 'lume_acoes', 'preservar', [acao]);
  assert.equal(JSON.stringify(p).includes(segredo), false); assert.equal(JSON.stringify(p).includes(TEXTO), false);
  assert.ok(!tabela(p, 'eventos').remover.some(k => k[0] === ext));
  const a = p.assinatura; f.db.prepare('UPDATE lume_execucao_contexto_grants SET cliente_id=? WHERE execucao_id=?').run(segredo + '-mudou', eid);
  assert.notEqual(plano(f).assinatura, a);
});

test('C0 projeto base interna sai inteiro e vínculo interno não base preserva projeto e histórico', async t => {
  const f = await fixture(t); prepararProjetosComerciais(f.db); const ext = externo(f.db), ids = [];
  for (const internaBase of [1, 0]) {
    const id = randomUUID(), fontes = [];
    f.db.prepare(`INSERT INTO lume_projetos_comerciais VALUES(?,'Projeto privado','proposta','rascunho',?,?,1,?,?)`).run(id, randomUUID(), 'c'.repeat(64), DATA, DATA);
    for (const [evento, base] of [[f.evento, internaBase], [ext, 1 - internaBase]]) {
      const fid = randomUUID(); fontes.push(fid);
      f.db.prepare(`INSERT INTO lume_projetos_fontes(id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,criada_em) VALUES(?,?,?,?,0,1,'trecho',?,?)`).run(fid, id, evento, sig(f.db, evento), base, DATA);
    }
    const hid = f.db.prepare("INSERT INTO lume_projetos_historico(projeto_id,tipo,fonte_id,quando) VALUES(?,'criado',?,?) RETURNING id").get(id, fontes[1], DATA).id;
    ids.push({ id, fontes, hid });
  }
  f.db.exec('BEGIN'); const p = plano(f), [a, b] = ids;
  contem(p, 'lume_projetos_comerciais', 'remover', [a.id]); contem(p, 'lume_projetos_comerciais', 'preservar', [b.id]);
  for (const id of a.fontes) { contem(p, 'lume_projetos_fontes', 'remover', [id]); contem(p, 'lume_projetos_importados_guardas', 'remover', [id]); }
  contem(p, 'lume_projetos_historico', 'remover', [a.hid]); contem(p, 'lume_projetos_historico', 'preservar', [b.hid]);
  contem(p, 'lume_projetos_fontes', 'remover', [b.fontes[0]]); contem(p, 'lume_projetos_fontes', 'preservar', [b.fontes[1]]);
  contem(p, 'lume_projetos_importados_guardas', 'preservar', [b.fontes[1]]);
  assert.ok(!tabela(p, 'eventos').remover.some(k => k[0] === ext));
  assert.ok(p.impactos.some(x => x.efeito === 'trigger_remove_projeto_inteiro'));
});

test('C0 nota e sugestão mistas fecham PKs compostas preservando original externo', async t => {
  const f = await fixture(t); prepararTarefas(f.db);
  const ext = externo(f.db), n = externo(f.db, 'nota'), s = randomUUID();
  for (const e of [f.evento, ext]) f.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(e, n);
  f.db.prepare(`INSERT INTO desktop_tarefas_sugestoes(id,evento_id,tipo,resumo,trecho,prazo_citado,fontes_total,criada_em) VALUES(?,?,'pendencia','Resumo privado',?,'',2,?)`).run(s, f.evento, TEXTO, DATA);
  for (const e of [f.evento, ext]) f.db.prepare('INSERT INTO desktop_tarefas_fontes VALUES(?,?,?)').run(s, e, sig(f.db, e));
  f.db.exec('BEGIN'); const p = plano(f);
  contem(p, 'eventos', 'remover', [n]); contem(p, 'desktop_tarefas_sugestoes', 'remover', [s]);
  assert.deepEqual(tabela(p, 'priv_vinculos').pk, ['fonte_id','derivado_id']);
  assert.deepEqual(tabela(p, 'desktop_tarefas_fontes').pk, ['sugestao_id','evento_id']);
  for (const e of [f.evento, ext]) { contem(p, 'priv_vinculos', 'remover', [e, n]); contem(p, 'desktop_tarefas_fontes', 'remover', [s, e]); }
  assert.ok(!tabela(p, 'eventos').remover.some(k => k[0] === ext));
});

test('C0 tag compartilhada e associação externa ficam; PK com quatro campos fica íntegra', async t => {
  const f = await fixture(t); prepararComandosWhatsapp(f.db); const ext = externo(f.db);
  const comandos = [f.evento, ext].map(e => {
    const origem = f.db.prepare('SELECT conversa_id,origem_id FROM eventos WHERE id=?').get(e);
    const id = f.db.prepare(`INSERT INTO lume_comandos(idempotencia,contrato,evento_id,conversa_id,origem_id,estado,motivo,criado_em,atualizado_em) VALUES(?,'v1',?,?,?,'feito','ok',?,?) RETURNING id`).get(randomUUID(), e, origem.conversa_id, origem.origem_id, DATA, DATA).id;
    return { id, ...origem };
  });
  const tag = f.db.prepare("INSERT INTO lume_tags(chave,nome_exibido,criada_em) VALUES('tag-sintetica','Tag privada',?) RETURNING id").get(DATA).id;
  for (const c of comandos) f.db.prepare(`INSERT INTO lume_tags_entidades(tag_id,entidade_tipo,entidade_id,comando_id,conversa_id,origem_id,criada_em) VALUES(?,'mensagem',?,?,?,?,?)`).run(tag, c.origem_id, c.id, c.conversa_id, c.origem_id, DATA);
  f.db.exec('BEGIN'); const p = plano(f);
  contem(p, 'lume_tags', 'preservar', [tag]);
  assert.deepEqual(tabela(p, 'lume_tags_entidades').pk, ['tag_id','entidade_tipo','entidade_id','comando_id']);
  contem(p, 'lume_tags_entidades', 'remover', [tag, 'mensagem', comandos[0].origem_id, comandos[0].id]);
  contem(p, 'lume_tags_entidades', 'preservar', [tag, 'mensagem', comandos[1].origem_id, comandos[1].id]);
});

test('C0 assinatura cobre aux e alteração de PK composta sem retornar conteúdo', async t => {
  const f = await fixture(t); prepararTarefas(f.db);
  f.db.prepare('INSERT INTO desktop_tarefas_analises VALUES(?,?,?)').run(f.evento, 'a'.repeat(64), DATA);
  f.db.prepare("INSERT INTO etapas(evento_id,etapa,estado,resultado,atualizado_em) VALUES(?,'revisao_c0','concluida','conteudo-aux-privado',?)").run(f.evento, DATA);
  f.db.exec('BEGIN'); const a = plano(f);
  contem(a, 'desktop_tarefas_analises', 'remover', [f.evento]); contem(a, 'etapas', 'remover', [f.evento, 'revisao_c0']);
  assert.deepEqual(tabela(a, 'etapas').pk, ['evento_id','etapa']);
  f.db.prepare('UPDATE desktop_tarefas_analises SET assinatura=? WHERE evento_id=?').run('b'.repeat(64), f.evento);
  const b = plano(f); assert.notEqual(b.assinatura, a.assinatura);
  f.db.prepare("UPDATE etapas SET etapa='revisao_c0_b' WHERE evento_id=? AND etapa='revisao_c0'").run(f.evento);
  const c = plano(f); assert.notEqual(c.assinatura, b.assinatura);
  assert.equal(c.schemaAssinatura, a.schemaAssinatura); assert.equal(JSON.stringify(c).includes('conteudo-aux-privado'), false);
});

test('C0 recusa trigger conhecido adulterado e tabela desconhecida vazia sem perder caller', async t => {
  const f = await fixture(t); prepararProjetosComerciais(f.db); f.db.exec('BEGIN'); const antes = temp(f.db);
  f.db.exec('SAVEPOINT adversarial; DROP TRIGGER lume_projetos_evento_apagado; CREATE TRIGGER lume_projetos_evento_apagado BEFORE DELETE ON eventos BEGIN SELECT 1; END;');
  assert.throws(() => plano(f)); assert.equal(f.db.isTransaction, true); assert.deepEqual(temp(f.db), antes);
  f.db.exec('ROLLBACK TO adversarial; RELEASE adversarial');
  assert.equal(plano(f).sessaoId, f.sessao);
  f.db.exec('CREATE TABLE extensao_vazia_sem_contrato(id INTEGER PRIMARY KEY)');
  assert.throws(() => plano(f)); assert.equal(f.db.isTransaction, true); assert.deepEqual(temp(f.db), antes);
});

test('C0 compara literal SQL do trigger sem normalizar valor case-sensitive', async t => {
  const f = await fixture(t); new AcoesLume(f.db); prepararExecucoes(f.db); f.db.exec('BEGIN');
  const trigger = f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='lume_execucao_grant_revogada'").get();
  assert.ok(trigger?.sql);
  const altered = trigger.sql.replace("'revogada'", "'REVOGADA'");
  assert.notEqual(altered, trigger.sql);
  f.db.exec('SAVEPOINT trigger_literal; DROP TRIGGER lume_execucao_grant_revogada;');
  f.db.exec(altered);
  assert.throws(() => plano(f), { code: 'INTEGRIDADE' });
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK TO trigger_literal; RELEASE trigger_literal');
  assert.equal(plano(f).sessaoId, f.sessao);
});

test('C0 falha se uma trigger conhecida e necessaria estiver ausente', async t => {
  const f = await fixture(t); new AcoesLume(f.db); prepararExecucoes(f.db); f.db.exec('BEGIN');
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='lume_execucao_guarda_snapshot_UPDATE'").get());
  f.db.exec('SAVEPOINT missing_trigger; DROP TRIGGER lume_execucao_guarda_snapshot_UPDATE;');
  assert.throws(() => plano(f), { code: 'INTEGRIDADE' });
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK TO missing_trigger; RELEASE missing_trigger');
  assert.equal(plano(f).sessaoId, f.sessao);
});

test('C0 seleciona CRM pelo par exato e encadeia rascunhos por item_id', async t => {
  const f = await fixture(t); prepararEsquemaCrm(f.db); prepararEsquemaRascunho(f.db);
  const alvo = f.db.prepare('SELECT conversa_id,origem_id FROM eventos WHERE id=?').get(f.evento);
  const interno = f.db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em)
    VALUES(?,?,'pendencia','CRM interno privado',?) RETURNING id`).get(alvo.conversa_id,alvo.origem_id,DATA).id;
  const mesmoChatOutraFonte = f.db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em)
    VALUES(?,?,'decisao','CRM externo preservado',?) RETURNING id`).get(alvo.conversa_id,'outra-origem-'+randomUUID(),DATA).id;
  const outroChat = f.db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em)
    VALUES(?,?,'lead','CRM de outro chat preservado',?) RETURNING id`).get('externa:'+randomUUID(),randomUUID(),DATA).id;
  const rascunhoInterno=f.db.prepare(`INSERT INTO rascunhos(item_id,dia,texto,criado_em,atualizado_em)
    VALUES(?,'2026-09-27','rascunho interno privado',?,?) RETURNING id`).get(interno,DATA,DATA).id;
  const rascunhoExterno=f.db.prepare(`INSERT INTO rascunhos(item_id,dia,texto,criado_em,atualizado_em)
    VALUES(?,'2026-09-26','rascunho externo preservado',?,?) RETURNING id`).get(mesmoChatOutraFonte,DATA,DATA).id;
  assert.equal(Object.hasOwn(f.db.prepare('SELECT * FROM itens_crm WHERE id=?').get(interno),'evento_id'),false);
  assert.equal(Object.hasOwn(f.db.prepare('SELECT * FROM itens_crm WHERE id=?').get(interno),'sugestao_id'),false);
  const externos=[mesmoChatOutraFonte,outroChat];
  const crmAntes=f.db.prepare(`SELECT id,resumo FROM itens_crm WHERE id IN (${externos.map(()=>'?').join(',')}) ORDER BY id`).all(...externos);
  f.db.exec('BEGIN'); const p=plano(f);
  assert.deepEqual(tabela(p,'itens_crm').pk,['id']);
  contem(p,'itens_crm','remover',[interno]);
  for(const id of externos)assert.ok(!tabela(p,'itens_crm').remover.some(key=>key[0]===id));
  contem(p,'rascunhos','remover',[rascunhoInterno]);
  assert.ok(!tabela(p,'rascunhos').remover.some(key=>key[0]===rascunhoExterno));
  assert.deepEqual(f.db.prepare(`SELECT id,resumo FROM itens_crm WHERE id IN (${externos.map(()=>'?').join(',')}) ORDER BY id`).all(...externos),crmAntes);
  assert.equal(f.db.prepare('SELECT texto FROM rascunhos WHERE id=?').get(rascunhoExterno).texto,'rascunho externo preservado');
  assert.equal(JSON.stringify(p).includes('CRM interno privado'),false);
  assert.equal(JSON.stringify(p).includes('rascunho interno privado'),false);
});

test('C0 aceita triggers conhecidos do índice de fontes desktop no schema do perfil', async t => {
  const f = await fixture(t);
  new DesktopIA(f.db,{gerar:async()=>{throw new Error('fixture sem rede');}});
  new Semantica(f.db,{extrair:async()=>{throw new Error('fixture sem inferência');}});
  prepararEsquemaTranscricao(f.db);
  prepararMetadadosAudio(f.db);
  prepararProjetosComerciais(f.db);
  const presentes=f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'desktop_%' ORDER BY name").all().map(x=>x.name);
  for(const nome of ['desktop_fontes_ai','desktop_fontes_ad','desktop_fontes_bu','desktop_fontes_au',
    'desktop_transcricao_fts_ai','desktop_transcricao_fts_bd','desktop_transcricao_fts_ad',
    'desktop_transcricao_fts_bu','desktop_transcricao_fts_au','desktop_vetores_update',
    'desktop_transcricao_vetores_ai','desktop_transcricao_vetores_ad','desktop_transcricao_vetores_au'])assert.ok(presentes.includes(nome),nome);
  const projetos=f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'lume_projetos_%' ORDER BY name").all().map(x=>x.name);
  for(const nome of ['lume_projetos_transcricao_alterada','lume_projetos_transcricao_apagada','lume_projetos_transcricao_inserida',
    'lume_projetos_revisao_transcricao_update','lume_projetos_revisao_transcricao_delete','lume_projetos_revisao_transcricao_insert'])
    assert.ok(projetos.includes(nome),nome);
  assert.doesNotThrow(()=>validarSchemaExclusao(f.db));
  f.db.exec('BEGIN; SAVEPOINT vector_missing; DROP TRIGGER desktop_transcricao_vetores_au;');
  assert.throws(()=>validarSchemaExclusao(f.db),{code:'INTEGRIDADE'});
  f.db.exec('ROLLBACK TO vector_missing; RELEASE vector_missing; SAVEPOINT vector_altered;');
  const sql=f.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='desktop_vetores_update'").get().sql;
  f.db.exec('DROP TRIGGER desktop_vetores_update;');
  f.db.exec(sql.replace('evento_id=new.id','evento_id=new.id AND 1=1'));
  assert.throws(()=>validarSchemaExclusao(f.db),{code:'INTEGRIDADE'});
  f.db.exec('ROLLBACK TO vector_altered; RELEASE vector_altered; ROLLBACK');
  assert.doesNotThrow(()=>validarSchemaExclusao(f.db));
  f.db.exec('BEGIN');
  assert.equal(plano(f).sessaoId,f.sessao);
});

test('C0 inclui metadado conversas_app da nota interna no fecho do plano', async t => {
  const f=await fixture(t), app=new ContextoApp(f.db);
  const nota=app.nota({texto:'Nota sintética de revisão C0',titulo:'Título privado sintético'});
  const conversa=f.db.prepare('SELECT conversa_id FROM eventos WHERE id=?').get(nota.id).conversa_id;
  // Harness liga o evento já selecionado: a API atual recusa notetaker_trecho como fonte de nota.
  f.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(f.evento,nota.id);
  assert.equal(f.db.prepare('SELECT nome FROM conversas_app WHERE id=?').get(conversa).nome,'Título privado sintético');
  f.db.exec('BEGIN'); const p=plano(f);
  const meta=p.tabelas.find(x=>x.nome==='conversas_app');
  assert.ok(meta,'conversas_app precisa estar classificada');
  assert.deepEqual(meta.pk,['id']); contem(p,'conversas_app','preservar',[conversa]);
  assert.ok(p.bloqueios.exclusao.some(x=>x.id===nota.id||x.id===conversa||/nota|conversa/i.test(`${x.classe} ${x.motivo}`)),
    'metadado preservado ainda precisa bloquear exclusão até regra de compartilhamento');
  assert.equal(JSON.stringify(p).includes('Título privado sintético'),false);
});

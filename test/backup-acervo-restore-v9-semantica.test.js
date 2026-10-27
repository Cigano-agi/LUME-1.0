import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { abrirOraculoStagingV9 } from './fixtures/backup-restore-oraculo.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { gravarPacote } from '../src/backup-stream.js';
import { validarAcervoV9, descartarPlanoV9 } from '../src/backup-acervo-restore-v9.js';
import { fingerprint } from '../src/compartilhamento.js';
import { LEITURA_SQL } from '../src/leitura-sql.js';

const senha = 'senha sintética para regressão semântica';
const instante = '2026-09-27T12:00:00.000Z';
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(JSON.stringify(value));

async function fixture(alterar) {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'semantica.lumebak');
  try {
    alterar(f.db);
    f.db.close();
    await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Pessoa sintética' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    return { ...f, raizStaging, pacote };
  } catch (error) { await f.close(); throw error; }
}

async function caso(alterar, { fase = null, conferir = null } = {}) {
  const f = await fixture(alterar);
  try {
    if (fase) {
      await assert.rejects(
        validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }),
        error => { assert.equal(error.code, 'SEMANTICA_INVALIDA'); assert.equal(error.fase, fase); return true; },
      );
    } else {
      const { plano } = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
      try {
        if (conferir) {
          const db = await abrirOraculoStagingV9({ raizStaging: f.raizStaging, raizFixture: f.dir });
          try { conferir(db); } finally { db.close(); }
        }
      } finally { await descartarPlanoV9(plano); }
    }
    assert.deepEqual(await readdir(f.raizStaging), [], 'staging limpo após validação ou recusa');
  } finally { await f.close(); }
}

function evento(db, id = 1n, autorEDono = 0) {
  db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao,autor_e_dono)
    VALUES(?,'c','o','entrada','texto','trecho de origem',?,'2026-09-27','minha',?)`).run(id, instante, autorEDono);
}

function negocio(db, contato) {
  evento(db);
  const id = '00000000-0000-4000-8000-000000000001';
  db.prepare(`INSERT INTO desktop_negocios(id,evento_id,assinatura,titulo,etapa,valor_centavos,proximo_contato,revisao,criado_em,atualizado_em)
    VALUES(?,1,?,'Negócio','interesse',100,?,1,?,?)`).run(id, sha('fonte antiga'), contato, instante, instante);
  db.prepare(`INSERT INTO desktop_negocios_historico(negocio_id,revisao,titulo,etapa,valor_centavos,proximo_contato,confirmado_em)
    VALUES(?,1,'Negócio','interesse',100,?,?)`).run(id, contato, instante);
}

test('R06: negócio aceita data real e recusa 30 de fevereiro nas duas linhas', async () => {
  await caso(db => negocio(db, '2026-02-28'));
  await caso(db => negocio(db, '2026-02-30'), { fase: 'desktop_negocios' });
});

function comando(db, eventoId) {
  evento(db, eventoId, 1);
  db.prepare(`INSERT INTO lume_comandos(id,idempotencia,contrato,evento_id,conversa_id,origem_id,comando,estado,motivo,resultado_json,criado_em,atualizado_em)
    VALUES(1,'idem-1','v1',?,'c','o','#lume_ajuda','feito','ok',NULL,?,?)`).run(eventoId, instante, instante);
}

test('R07: comando aceita evento seguro e recusa referência int64 fora do domínio v8', async () => {
  await caso(db => comando(db, 1n));
  await caso(db => comando(db, 9007199254740993n), { fase: 'lume_comandos' });
});

function labels(db, conflito) {
  const observar = db.prepare(`INSERT INTO whatsapp_label_observacoes(id,conta_id,tipo,conversa_id,message_id,label_id,nome,cor,predefined_id,removida,acao,assinatura,observada_em)
    VALUES(?,'conta','definicao','','','l1',?,3,NULL,0,NULL,?,?)`);
  for (const [id, nome] of [[1, 'Cliente'], [2, 'Cliente novo']]) {
    const normalized = { tipo: 'definicao', id: 'l1', name: nome, color: 3, deleted: false, predefinedId: null };
    observar.run(id, nome, digest(normalized), instante);
  }
  db.prepare(`INSERT INTO whatsapp_labels(conta_id,label_id,nome,cor,predefined_id,removida,conflito,primeira_observacao_id,ultima_observacao_id)
    VALUES('conta','l1','Cliente novo',3,NULL,0,?,1,2)`).run(conflito);
}

test('R07: replay de duas labels mantém conflito pegajoso e recusa projeção falsa', async () => {
  await caso(db => labels(db, 1));
  await caso(db => labels(db, 0), { fase: 'whatsapp_labels' });
});

function acao(db, aviso = null) {
  evento(db);
  db.prepare(`INSERT INTO lume_acoes(id,evento_id,chave,fonte_assinatura,tipo,resumo,trecho,trecho_inicio,prazo_citado,estado,
    aviso_para,aviso_em,aviso_resultado,criada_em,atualizada_em)
    VALUES('acao',1,?,?,'compromisso','Resumo','trecho de origem',0,'','confirmado',?,?,?,?,?)`)
    .run(sha('acao'), sha('fonte antiga'), aviso ? instante : null, aviso ? instante : null, aviso, instante, instante);
}

function execucao(db, assinaturaFalsa) {
  acao(db);
  const contextoId = '00000000-0000-4000-8000-000000000011';
  const execucaoId = '00000000-0000-4000-8000-000000000012';
  const pacote = { id: contextoId, acao_id: 'acao', tarefa: 'Tarefa', resumo: 'Resumo',
    fontes: [{ id: 'fonte_1', trecho: 'trecho fonte', conversa: 'Conversa', autor: 'Autor', em: instante, parcial: false }],
    timeline: [], autorizacao: { escopo: 'preparar_material', envio: false, publicacao: false, gastos: false,
      alterar_estado_comercial: false, estado: 'pendente' }, instrucoes: 'Preparar material',
    criado_em: instante, expira_em: '2026-09-27T12:15:00.000Z' };
  db.prepare('INSERT INTO lume_execucao_contextos(id,acao_id,pacote,integridade,criado_em,expira_em) VALUES(?,?,?,?,?,?)')
    .run(contextoId, 'acao', JSON.stringify(pacote), JSON.stringify({ acao: sha('acao'), fonte: sha('fonte antiga') }), instante, pacote.expira_em);
  db.prepare(`INSERT INTO lume_execucoes(id,contexto_id,assistente,cliente_id,estado,chave_inicio,assinatura_inicio,autorizada_em,atualizada_em)
    VALUES(?,?,'codex','codex','em_andamento','abcdefgh',?,?,?)`)
    .run(execucaoId, contextoId, digest([contextoId, 'codex']), instante, instante);
  const dados = { texto: 'Progresso sintético' };
  db.prepare(`INSERT INTO lume_execucao_eventos(execucao_id,chave,assinatura,tipo,ator,dados,criado_em)
    VALUES(?,'progresso01',?,'progresso','codex',?,?)`)
    .run(execucaoId, assinaturaFalsa ? '0'.repeat(64) : digest(['progresso', 'codex', dados]), JSON.stringify(dados), instante);
}

test('R08: evento de execução aceita assinatura real e recusa assinatura adulterada', async () => {
  await caso(db => execucao(db, false));
  await caso(db => execucao(db, true), { fase: 'lume_execucao_eventos' });
});

test('R06: avisos falhou e sem-confirmacao preservam recibo e histórico de desativação', async () => {
  for (const resultado of ['falhou', 'sem-confirmacao']) {
    await caso(db => acao(db, resultado), { conferir(db) {
      const a = db.prepare('SELECT estado,aviso_para,aviso_em,aviso_resultado FROM lume_acoes WHERE id=?').get('acao');
      assert.deepEqual([a.estado, a.aviso_para, a.aviso_em, a.aviso_resultado], ['descartado', instante, instante, resultado]);
      const h = db.prepare('SELECT estado_anterior,estado_novo,motivo FROM lume_acoes_historico WHERE acao_id=?').get('acao');
      assert.deepEqual([h.estado_anterior, h.estado_novo], ['confirmado', 'descartado']);
      assert.match(h.motivo, /backup/i);
    } });
  }
});

test('R05: contribuição F10 específica segue legível sem liberar outra mensagem do grupo', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fp = fingerprint(pem);
  await caso(db => {
    const insert = db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES(?,'grupo:g1',?,'entrada','texto','Mensagem sintética',?,'2026-09-27',?)`);
    insert.run(1, 'origem-partilhada', instante, 'compartilhado');
    insert.run(2, 'origem-terceiro', instante, 'terceiro');
    db.prepare('INSERT INTO f10_projetos(id,nome,criado_em) VALUES(?,?,?)').run('projeto-f10', 'Projeto sintético', instante);
    db.prepare('INSERT INTO f10_origens(fingerprint,pessoa,maquina,chave_publica) VALUES(?,?,?,?)')
      .run(fp, 'Pessoa sintética', 'Máquina sintética', pem);
    db.prepare(`INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em,pessoa,maquina)
      VALUES(1,?,'pacote-sintetico','projeto-f10',?,?,NULL,NULL)`).run(fp, instante, instante);
  }, { conferir(db) {
    const legiveis = db.prepare(`SELECT e.id FROM eventos e WHERE ${LEITURA_SQL} ORDER BY e.id`).all().map(r => r.id);
    assert.deepEqual(legiveis, [1], 'F10 libera só a contribuição exata');
    for (const tabela of ['politicas_conversa', 'autorizacoes', 'lume_execucao_contexto_grants', 'lume_execucao_contexto_guardas']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${tabela}`).get().n, 0, `${tabela} segue vazio`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM f10_procedencias').get().n, 1);
  } });
});

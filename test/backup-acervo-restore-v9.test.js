import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, mkdir, writeFile, readFile, appendFile, rename, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { abrirOraculoStagingV9 } from './fixtures/backup-restore-oraculo.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { gravarPacote } from '../src/backup-stream.js';
import { chaveExclusao } from '../src/exclusoes.js';
import { fingerprint } from '../src/compartilhamento.js';
import { prepararEsquemaRestoreV9 } from '../src/backup-acervo-schema-v9.js';
import { validarAcervoV9, inspecionarPlanoV9, descartarPlanoV9, aplicarAcervoV9 } from '../src/backup-acervo-restore-v9.js';

const senha = 'senha sintética do teste';
async function fixture({ legado = false, alterar } = {}) {
  const f = await criarPerfilRealSintetico({ legado });
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  try {
    if (alterar) alterar(f.db);
    f.db.close();
    await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Dono declarado' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    return { ...f, pacote, raizStaging };
  } catch (e) { await f.close(); throw e; }
}
async function limpo(raiz) { assert.deepEqual(await readdir(raiz), []); }

test('RED: pacote inteiro autenticado antes do parser; adulteração não deixa staging', async () => {
  const f = await fixture();
  try {
    const b = await readFile(f.pacote); b[b.length - 1] ^= 1; await writeFile(f.pacote, b);
    await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }));
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('plano opaco invalida inspeção após troca do pacote e consumo por aplicar', async () => {
  const f=await fixture();
  try {
    const p=await validarAcervoV9({ pacote:f.pacote, senha, raizStaging:f.raizStaging });
    await appendFile(f.pacote,Buffer.from([0]));
    assert.throws(() => inspecionarPlanoV9(p.plano),{code:'PLANO_INVALIDO'});
    await assert.rejects(aplicarAcervoV9({plano:p.plano,confirmarMeuBackup:false}),{code:'CONFIRMACAO_OBRIGATORIA'});
    assert.throws(() => inspecionarPlanoV9(p.plano),{code:'PLANO_INVALIDO'});
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('plano opaco rejeita outro inode mesmo com bytes idênticos', async () => {
  const f = await fixture();
  try {
    const p = await validarAcervoV9({ pacote:f.pacote, senha, raizStaging:f.raizStaging });
    const before = await stat(f.pacote,{bigint:true});
    const old = await stat(f.pacote);
    const substitute = path.join(f.dir,'substituto.lumebak');
    await writeFile(substitute,await readFile(f.pacote));
    await utimes(substitute,old.atime,old.mtime);
    await rename(f.pacote,path.join(f.dir,'original.lumebak'));
    await rename(substitute,f.pacote);
    const after = await stat(f.pacote,{bigint:true});
    assert.equal(typeof before.ino,'bigint');
    assert.notEqual(after.ino,before.ino);
    assert.equal(after.size,before.size);
    assert.throws(() => inspecionarPlanoV9(p.plano),{code:'PLANO_INVALIDO'});
    await descartarPlanoV9(p.plano);
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: construtores reais novos e legados produzem staging tipado, sem aplicar perfil', async () => {
  for (const legado of [false, true]) {
    const f = await fixture({ legado, alterar(db) {
      db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao,texto)
        VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha',?)`).run('texto\0livre');
    } });
    try {
      const { plano, resumo, expiraEm } = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
      assert.equal(resumo.tabelas, 53); assert.equal(resumo.linhas, 1);
      assert.equal(resumo.donoDeclarado, 'Dono declarado'); assert.ok(expiraEm);
      assert.equal(inspecionarPlanoV9(plano).resumo.linhas, 1);
      await assert.rejects(aplicarAcervoV9({ plano, destinoNovo: path.join(f.dir, 'perfil'), confirmarMeuBackup: true }), { code: 'RESTORE_LOCK_INDISPONIVEL' });
      await descartarPlanoV9(plano);
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: permissão inválida é recusada semanticamente e limpa staging', async () => {
  const f = await fixture({ alterar(db) {
    db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','todas')`).run();
  } });
  try {
    await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: NUL em identificador recusa, enquanto TEXT livre preserva NUL', async () => {
  const f=await fixture({ alterar(db) {
    db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,'o','entrada','texto','bruto',?,'2026-09-27T12:00:00.000Z','2026-09-27','minha')`).run('c\0invalida','texto\0livre');
  } });
  try {
    await assert.rejects(validarAcervoV9({ pacote:f.pacote,senha,raizStaging:f.raizStaging }),{code:'DOMINIO_INVALIDO'});
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: gasto histórico válido passa; mutação de valor recusa', async () => {
  const f = await fixture({ alterar(db) {
    db.prepare('INSERT INTO desktop_ia_gastos(id,dia,reservado_micros,estado,criado_em) VALUES(?,?,?,?,?)')
      .run('g', '2026-09-27', 1, 'reservado', '2026-09-27T12:00:00.000Z');
  } });
  try {
    const result = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
    assert.equal(result.resumo.linhas, 1);
    await descartarPlanoV9(result.plano); await limpo(f.raizStaging);
  } finally { await f.close(); }
  const invalid = await fixture({ alterar(db) {
    db.prepare('INSERT INTO desktop_ia_gastos(id,dia,reservado_micros,estado,criado_em) VALUES(?,?,?,?,?)')
      .run('g', '2026-09-27', -1, 'reservado', '2026-09-27T12:00:00.000Z');
  } });
  try {
    await assert.rejects(validarAcervoV9({ pacote: invalid.pacote, senha, raizStaging: invalid.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
    await limpo(invalid.raizStaging);
  } finally { await invalid.close(); }
});

test('RED: relação sugestão/fonte é conferida por acervo e recusa órfão sem plano', async () => {
  const f = await fixture({ alterar(db) {
    db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha')`).run();
    db.prepare(`INSERT INTO desktop_tarefas_sugestoes(id,evento_id,tipo,resumo,trecho,prazo_citado,fontes_total,estado,criada_em)
      VALUES('s',1,'compromisso','Resumo','trecho da conversa','',1,'pendente','2026-09-27T12:00:00.000Z')`).run();
  } });
  try {
    await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: cancelamento não deixa staging nem plano', async () => {
  const f = await fixture(); const signal = new AbortController(); signal.abort();
  try {
    await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging, signal: signal.signal }));
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('recibo anterior válido permanece intacto; novo recibo só para linha sem prova', async () => {
  const oldHash = 'a'.repeat(64);
  const at = '2026-09-27T12:00:00.000Z';
  const interruption = '00000000-0000-4000-8000-000000000041';
  const f = await fixture({ alterar(db) {
    db.prepare('INSERT INTO wa_cobertura(id,estado,observado_em) VALUES(1,?,?)').run('conectada',at);
    db.prepare('INSERT INTO wa_interrupcoes(id,inicio,motivo) VALUES(?,?,?)').run(interruption,at,'reinicio');
    db.prepare('INSERT INTO lume_ciclo_importacoes(tabela,registro_id,backup_sha256,importado_em,estado_original) VALUES(?,?,?,?,?)')
      .run('wa_cobertura','1',oldHash,at,'conectada');
  } });
  try {
    const result = await validarAcervoV9({ pacote:f.pacote, senha, raizStaging:f.raizStaging });
    const db = await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
    try {
      assert.deepEqual({ ...db.prepare("SELECT backup_sha256,importado_em,estado_original FROM lume_ciclo_importacoes WHERE tabela='wa_cobertura'").get() },
        { backup_sha256:oldHash,importado_em:at,estado_original:'conectada' });
      const fresh = db.prepare("SELECT backup_sha256,estado_original FROM lume_ciclo_importacoes WHERE tabela='wa_interrupcoes'").get();
      assert.match(fresh.backup_sha256,/^[a-f0-9]{64}$/);
      assert.notEqual(fresh.backup_sha256,oldHash);
      assert.equal(fresh.estado_original,null);
      assert.equal(db.prepare("SELECT estado FROM wa_cobertura WHERE id=1").get().estado,'desconectada');
    } finally { db.close(); }
    await descartarPlanoV9(result.plano);
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('recibos antigos com referência ou hash inválido são recusados', async () => {
  for (const [registro,hash] of [['2','a'.repeat(64)],['1','hash-adulterado']]) {
    const f = await fixture({ alterar(db) {
      db.prepare('INSERT INTO wa_cobertura(id,estado,observado_em) VALUES(1,?,?)').run('conectada','2026-09-27T12:00:00.000Z');
      db.prepare('INSERT INTO lume_ciclo_importacoes(tabela,registro_id,backup_sha256,importado_em,estado_original) VALUES(?,?,?,?,?)')
        .run('wa_cobertura',registro,hash,'2026-09-27T12:00:00.000Z','conectada');
    } });
    try {
      await assert.rejects(validarAcervoV9({ pacote:f.pacote, senha, raizStaging:f.raizStaging }),{code:'SEMANTICA_INVALIDA',fase:'lume_ciclo_importacoes'});
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: DDL de staging recusa arquivo preexistente sem migrá-lo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lume-schema-exclusivo-'));
  const dbPath = path.join(dir, 'existente.sqlite');
  try {
    await writeFile(dbPath, Buffer.from('NÃO ALTERAR'));
    assert.throws(() => prepararEsquemaRestoreV9(dbPath, dir), { code: 'EEXIST' });
    assert.equal((await readFile(dbPath)).toString(), 'NÃO ALTERAR');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('RED: transcrição histórica válida passa e respostas divergentes recusam', async () => {
  for (const wrong of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare(`INSERT INTO transcricoes(conversa_id,origem_id,arquivo,texto,estado,criado_em,texto_original,respostas_json)
        VALUES('c','o','','fala','transcrito','2026-09-27T12:00:00.000Z','fala',?)`)
        .run(JSON.stringify([{ textoOriginal: wrong ? 'outra' : 'fala', duracaoMs: null }]));
    } });
    try {
      if (wrong) {
        await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
        await limpo(f.raizStaging);
      } else {
        const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
        await descartarPlanoV9(p.plano); await limpo(f.raizStaging);
      }
    } finally { await f.close(); }
  }
});

test('RED: tombstone contraditório bloqueia evento importado', async () => {
  const f = await fixture({ alterar(db) {
    db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha')`).run();
    db.prepare('INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)').run(chaveExclusao('c','o'),'2026-09-27T13:00:00.000Z');
  } });
  try {
    await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
    await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: origem F10 válida preserva fingerprint e origem revogada recusa', async () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fp = fingerprint(pem);
  for (const revoked of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare('INSERT INTO f10_origens(fingerprint,pessoa,maquina,chave_publica) VALUES(?,?,?,?)').run(fp,'Teste','Maquina',pem);
      if (revoked) db.prepare('INSERT INTO f10_revogadas(fingerprint,revogado_em) VALUES(?,?)').run(fp,'2026-09-27T12:00:00.000Z');
    } });
    try {
      if (revoked) {
        await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
        await limpo(f.raizStaging);
      } else {
        const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
        await descartarPlanoV9(p.plano); await limpo(f.raizStaging);
      }
    } finally { await f.close(); }
  }
});

test('RED: comando histórico exige evento próprio da conversa exata', async () => {
  for (const own of [true,false]) {
    const f = await fixture({ alterar(db) {
      db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao,autor_e_dono)
        VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha',?)`).run(own ? 1 : 0);
      db.prepare(`INSERT INTO lume_comandos(id,idempotencia,contrato,evento_id,conversa_id,origem_id,comando,estado,motivo,resultado_json,criado_em,atualizado_em)
        VALUES(1,'idem','v1',1,'c','o','#lume_ajuda','feito','ok',NULL,'2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z')`).run();
    } });
    try {
      if (own) { const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }); await descartarPlanoV9(p.plano); }
      else await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: label observada exige assinatura e replay exato da projeção', async () => {
  const normalized = { tipo:'definicao', id:'l1', name:'Cliente', color:3, deleted:false, predefinedId:null };
  const assinatura = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  for (const wrong of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare(`INSERT INTO whatsapp_label_observacoes(id,conta_id,tipo,conversa_id,message_id,label_id,nome,cor,predefined_id,removida,acao,assinatura,observada_em)
        VALUES(1,'conta','definicao','','','l1','Cliente',3,NULL,0,NULL,?,'2026-09-27T12:00:00.000Z')`).run(wrong ? '0'.repeat(64) : assinatura);
      db.prepare(`INSERT INTO whatsapp_labels(conta_id,label_id,nome,cor,predefined_id,removida,conflito,primeira_observacao_id,ultima_observacao_id)
        VALUES('conta','l1','Cliente',3,NULL,0,0,1,1)`).run();
    } });
    try {
      if (wrong) await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      else { const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }); await descartarPlanoV9(p.plano); }
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: ação histórica válida passa; aviso incoerente recusa', async () => {
  for (const badNotice of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
        VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha')`).run();
      db.prepare(`INSERT INTO lume_acoes(id,evento_id,chave,fonte_assinatura,tipo,resumo,trecho,trecho_inicio,prazo_citado,estado,aviso_para,criada_em,atualizada_em)
        VALUES('a',1,? ,?,'compromisso','Resumo','trecho de origem',0,'','confirmado',?,'2026-09-27T12:00:00.000Z','2026-09-27T12:00:00.000Z')`)
        .run('a'.repeat(64),'b'.repeat(64),badNotice ? '2026-09-27T13:00:00.000Z' : null);
    } });
    try {
      if (badNotice) await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      else { const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }); await descartarPlanoV9(p.plano); }
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: aviso já mostrado mantém recibo e desativação registra histórico', async () => {
  const at='2026-09-27T12:00:00.000Z';
  const f=await fixture({ alterar(db) {
    db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','o','entrada','texto','bruto',?,'2026-09-27','minha')`).run(at);
    db.prepare(`INSERT INTO lume_acoes(id,evento_id,chave,fonte_assinatura,tipo,resumo,trecho,trecho_inicio,prazo_citado,estado,aviso_para,aviso_em,aviso_resultado,criada_em,atualizada_em)
      VALUES('a',1,?,?,'compromisso','Resumo','trecho de origem',0,'','confirmado',?,?,'mostrado',?,?)`)
      .run('a'.repeat(64),'b'.repeat(64),at,at,at,at);
  } });
  try {
    const p=await validarAcervoV9({ pacote:f.pacote, senha, raizStaging:f.raizStaging });
    const db=await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
    try {
      const action=db.prepare('SELECT estado,aviso_resultado FROM lume_acoes').get();
      assert.equal(action.estado,'descartado'); assert.equal(action.aviso_resultado,'mostrado');
      const h=db.prepare('SELECT estado_anterior,estado_novo,motivo FROM lume_acoes_historico').get();
      assert.deepEqual([h.estado_anterior,h.estado_novo],['confirmado','descartado']);
      assert.match(h.motivo,/backup/i);
    } finally { db.close(); }
    await descartarPlanoV9(p.plano); await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: sessão sem parte vira histórico interrompido sem direito de leitura', async () => {
  const f = await fixture({ alterar(db) {
    db.prepare(`INSERT INTO notetaker_sessoes(id,estado,origem,entradas,consentimento_em,inicio_em,importacao_estado,asr_estado)
      VALUES('00000000-0000-4000-8000-000000000001','gravando','importacao','["importacao"]','2026-09-27T11:00:00.000Z','2026-09-27T11:00:00.000Z','em_curso','em_curso')`).run();
  } });
  try {
    const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
    const db = await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
    try {
      const s = db.prepare('SELECT estado,direitos_revogados_em,importacao_estado,asr_estado FROM notetaker_sessoes').get();
      assert.equal(s.estado,'interrompida'); assert.ok(s.direitos_revogados_em);
      assert.equal(s.importacao_estado,'incompleta'); assert.equal(s.asr_estado,'interrompida');
    } finally { db.close(); }
    await descartarPlanoV9(p.plano); await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: cobertura WhatsApp é validada e desativada em staging', async () => {
  for (const wrong of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare('INSERT INTO wa_cobertura(id,estado,observado_em) VALUES(1,?,?)')
        .run(wrong ? 'inventado' : 'conectada','2026-09-27T12:00:00.000Z');
    } });
    try {
      if (wrong) await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      else {
        const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
        const db = await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
        try { assert.equal(db.prepare('SELECT estado FROM wa_cobertura').get().estado,'desconectada'); } finally { db.close(); }
        await descartarPlanoV9(p.plano);
      }
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: CRM aponta origem existente, e órfão é recusado', async () => {
  for (const orphan of [false,true]) {
    const f = await fixture({ alterar(db) {
      if (!orphan) db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
        VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha')`).run();
      db.prepare(`INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em)
        VALUES('c','o','compromisso','Resumo','2026-09-27T12:00:00.000Z')`).run();
    } });
    try {
      if (orphan) await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      else { const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }); await descartarPlanoV9(p.plano); }
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: ID int64 acima de MAX_SAFE mantém tipagem até a semântica', async () => {
  const id = 9007199254740993n;
  const f = await fixture({ alterar(db) {
    db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES(?,'c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha')`).run(id);
  } });
  try {
    const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
    const db = await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
    try { const stmt = db.prepare('SELECT id FROM eventos'); stmt.setReadBigInts(true); assert.equal(stmt.get().id,id); }
    finally { db.close(); }
    await descartarPlanoV9(p.plano); await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('regressão: negócio recomeçado pode iniciar histórico na revisão 2', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const f = await fixture({ alterar(db) {
    db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','minha')`).run();
    db.prepare(`INSERT INTO desktop_negocios(id,evento_id,assinatura,titulo,etapa,valor_centavos,proximo_contato,revisao,criado_em,atualizado_em)
      VALUES(?,1,?,'Negócio','interesse',100,NULL,2,'2026-09-27T12:00:00.000Z','2026-09-27T13:00:00.000Z')`).run(id,'a'.repeat(64));
    db.prepare(`INSERT INTO desktop_negocios_historico(negocio_id,revisao,titulo,etapa,valor_centavos,proximo_contato,confirmado_em)
      VALUES(?,2,'Negócio','interesse',100,NULL,'2026-09-27T13:00:00.000Z')`).run(id);
  } });
  try {
    const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
    await descartarPlanoV9(p.plano); await limpo(f.raizStaging);
  } finally { await f.close(); }
});

test('RED: contexto e execução históricos são revogados; poder de envio recusa', async () => {
  const ctx = '00000000-0000-4000-8000-000000000011';
  const exe = '00000000-0000-4000-8000-000000000012';
  const action = 'acao-historica';
  const at = '2026-09-27T12:00:00.000Z';
  for (const canSend of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
        VALUES('c','o','entrada','texto','bruto',?,'2026-09-27','minha')`).run(at);
      db.prepare(`INSERT INTO lume_acoes(id,evento_id,chave,fonte_assinatura,tipo,resumo,trecho,trecho_inicio,prazo_citado,estado,criada_em,atualizada_em)
        VALUES(?,1,?,?,'compromisso','Resumo','trecho de origem',0,'','confirmado',?,?)`).run(action,'a'.repeat(64),'b'.repeat(64),at,at);
      const pacote = { id:ctx, acao_id:action, tarefa:'Tarefa', resumo:'Resumo',
        fontes:[{id:'fonte_1',trecho:'trecho fonte',conversa:'Conversa',autor:'Autor',em:at,parcial:false}], timeline:[],
        autorizacao:{escopo:'preparar_material',envio:canSend,publicacao:false,gastos:false,alterar_estado_comercial:false,estado:'pendente'},
        instrucoes:'Preparar material', criado_em:at, expira_em:'2026-09-27T12:15:00.000Z' };
      db.prepare('INSERT INTO lume_execucao_contextos(id,acao_id,pacote,integridade,criado_em,expira_em) VALUES(?,?,?,?,?,?)')
        .run(ctx,action,JSON.stringify(pacote),JSON.stringify({acao:'a'.repeat(64),fonte:'b'.repeat(64)}),at,pacote.expira_em);
      db.prepare(`INSERT INTO lume_execucoes(id,contexto_id,assistente,cliente_id,estado,chave_inicio,assinatura_inicio,autorizada_em,atualizada_em)
        VALUES(?,?,'codex','codex','aguardando_assistente','abcdefgh',?,?,?)`)
        .run(exe,ctx,createHash('sha256').update(JSON.stringify([ctx,'codex'])).digest('hex'),at,at);
    } });
    try {
      if (canSend) await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      else {
        const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
        const db = await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
        try {
          assert.equal(db.prepare('SELECT estado FROM lume_execucoes').get().estado,'revogada');
          const c = db.prepare('SELECT pacote,expira_em FROM lume_execucao_contextos').get();
          assert.equal(JSON.parse(c.pacote).autorizacao.estado,'revogada_importada');
          assert.equal(c.expira_em,'1970-01-01T00:00:00.000Z');
          assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_execucao_contexto_grants').get().n,0);
        } finally { db.close(); }
        await descartarPlanoV9(p.plano);
      }
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: avaliação de vendas perde consentimento e fonte alheia recusa', async () => {
  const id = '00000000-0000-4000-8000-000000000021';
  const at = '2026-09-27T12:00:00.000Z';
  for (const foreign of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
        VALUES('c','o','entrada','texto','bruto',?,'2026-09-27','minha')`).run(at);
      const result = { id, temperatura:'frio', etapa:'interesse', criterio:'Sinal', criterio_etapa:'Etapa',
        confianca:0.5, origem:'manual', avaliado_em:at, fontes:[1], desatualizada:false };
      db.prepare('INSERT INTO lume_vendas_avaliacoes(id,conversa_id,assinatura,resultado,avaliado_em) VALUES(?,?,?,?,?)')
        .run(id,foreign ? 'outra' : 'c','a'.repeat(64),JSON.stringify(result),at);
    } });
    try {
      if (foreign) await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      else {
        const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
        const db = await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
        try {
          const result = JSON.parse(db.prepare('SELECT resultado FROM lume_vendas_avaliacoes').get().resultado);
          assert.equal(result.desatualizada,true);
          assert.equal(result.importacao.consentimento_transferido,false);
        } finally { db.close(); }
        await descartarPlanoV9(p.plano);
      }
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('RED: projeto comercial rebaixa fonte e guarda; bases divergentes recusam', async () => {
  const project = '00000000-0000-4000-8000-000000000031';
  const source = '00000000-0000-4000-8000-000000000032';
  const at = '2026-09-27T12:00:00.000Z';
  for (const wrong of [false,true]) {
    const f = await fixture({ alterar(db) {
      db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
        VALUES('c','o','entrada','texto','bruto','texto de origem',?,'2026-09-27','minha')`).run(at);
      db.prepare(`INSERT INTO lume_projetos_comerciais(id,nome,natureza,estado,chave,assinatura_criacao,bases_total,criado_em,atualizado_em)
        VALUES(?,'Projeto','proposta','confirmado',?,?,?, ?,?)`).run(project,'a'.repeat(64),'b'.repeat(64),wrong ? 2 : 1,at,at);
      db.prepare(`INSERT INTO lume_projetos_fontes(id,projeto_id,evento_id,assinatura,inicio,tamanho,selecao,base,removida,invalidada,criada_em)
        VALUES(?,?,1,?,0,5,'trecho',1,0,0,?)`).run(source,project,'c'.repeat(64),at);
    } });
    try {
      if (wrong) await assert.rejects(validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging }), { code: 'SEMANTICA_INVALIDA' });
      else {
        const p = await validarAcervoV9({ pacote: f.pacote, senha, raizStaging: f.raizStaging });
        const db = await abrirOraculoStagingV9({ raizStaging:f.raizStaging, raizFixture:f.dir });
        try {
          assert.equal(db.prepare('SELECT estado FROM lume_projetos_comerciais').get().estado,'rascunho');
          assert.equal(db.prepare('SELECT invalidada FROM lume_projetos_fontes').get().invalidada,1);
          assert.equal(db.prepare('SELECT bloqueada FROM lume_projetos_importados_guardas').get().bloqueada,1);
        } finally { db.close(); }
        await descartarPlanoV9(p.plano);
      }
      await limpo(f.raizStaging);
    } finally { await f.close(); }
  }
});

test('volume sintético com schema real: 250001 eventos passam por AEAD, SQL e semântica com RSS adicional limitado',
  { timeout: 300000 }, async () => {
    const f = await criarPerfilRealSintetico();
    const raizStaging = path.join(f.dir,'staging');
    const pacote = path.join(f.dir,'volume.lumebak');
    let plano;
    try {
      const insert = f.db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
        VALUES(?,'c',?,'entrada','texto',?,?,'2026-09-27T12:00:00.000Z','2026-09-27','minha')`);
      f.db.exec('BEGIN');
      for (let i=1; i<=250001; i++) insert.run(BigInt(i),`origem-${i}`,`bruto ${i}`,`texto ${i}`);
      f.db.exec('COMMIT'); f.db.close();
      await mkdir(raizStaging);
      const baseline = process.memoryUsage().rss; let peak = baseline;
      const source = await criarOrigemV9({ dbPath:f.dbPath, perfil:{ dono:'Volume sintético' } });
      async function* measured() { for await (const block of source.origem) { peak=Math.max(peak,process.memoryUsage().rss); yield block; } }
      await gravarPacote({ origem:measured(), destino:pacote, senha });
      const monitor=setInterval(() => { peak=Math.max(peak,process.memoryUsage().rss); },20);
      let result;
      try { result = await validarAcervoV9({ pacote, senha, raizStaging }); plano=result.plano; }
      finally { clearInterval(monitor); peak=Math.max(peak,process.memoryUsage().rss); }
      peak=Math.max(peak,process.memoryUsage().rss);
      assert.equal(result.resumo.linhas,250001);
      const db=await abrirOraculoStagingV9({ raizStaging, raizFixture:f.dir });
      const original=new DatabaseSync(f.dbPath,{readOnly:true});
      try {
        assert.equal(db.prepare('SELECT COUNT(*) n FROM eventos').get().n,250001);
        const sql='SELECT id,conversa_id,origem_id,bruto,texto,permissao FROM eventos ORDER BY id';
        const digest = handle => {
          const h=createHash('sha256');
          for (const r of handle.prepare(sql).iterate()) h.update(JSON.stringify([r.id,r.conversa_id,r.origem_id,r.bruto,r.texto,r.permissao]));
          return h.digest('hex');
        };
        assert.equal(digest(db),digest(original));
        assert.deepEqual({ ...db.prepare('SELECT typeof(id) id,typeof(bruto) bruto,typeof(texto) texto FROM eventos WHERE id=250001').get() },
          { id:'integer',bruto:'text',texto:'text' });
      } finally { db.close(); original.close(); }
      assert.ok(peak-baseline <= 512*1024*1024,`RSS adicional ${Math.round((peak-baseline)/1048576)} MiB`);
      console.log(`restore-v9 RSS adicional ${Math.round((peak-baseline)/1048576)} MiB`);
    } finally { if (plano) await descartarPlanoV9(plano); await f.close(); }
  });

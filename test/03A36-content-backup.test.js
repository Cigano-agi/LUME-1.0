import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { decodificarAcervoV9 } from '../src/backup-acervo-codec.js';
import { CATALOGO_SHA256_V9 } from '../src/backup-acervo-catalogo.js';
import { DDL_CONTROLE_EXCLUSAO } from '../src/notetaker/exclusao-controle.js';
import { validarSchemaExclusao } from '../src/notetaker/exclusao-schema.js';

test('schema completo aceita triggers legítimos do ciclo e recusa ausência ou corpo adulterado', async () => {
  const fixture=await criarPerfilRealSintetico();
  try{
    const before=validarSchemaExclusao(fixture.db);assert.match(before,/^[a-f0-9]{64}$/);
    const name='ciclo_importacao_remove_lume_execucao_contextos';
    const sql=fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name).sql;
    fixture.db.exec(`DROP TRIGGER "${name}"`);assert.throws(()=>validarSchemaExclusao(fixture.db),{code:'INTEGRIDADE'});
    fixture.db.exec(sql);assert.equal(validarSchemaExclusao(fixture.db),before);
    fixture.db.exec(`DROP TRIGGER "${name}"`);fixture.db.exec(sql.replace(' BEGIN\n',' BEGIN\n      SELECT 1; '));
    assert.throws(()=>validarSchemaExclusao(fixture.db),{code:'INTEGRIDADE'});
  }finally{await fixture.close();}
});

test('backup v9 completo preserva catálogo/hash e não exporta controle terminal C1', async () => {
  const fixture=await criarPerfilRealSintetico();
  try{
    for(const ddl of DDL_CONTROLE_EXCLUSAO)fixture.db.exec(ddl);
    const opId=randomUUID(),sessaoId=randomUUID(),perfilId=randomUUID(),manifest='{}',manifestHash=createHash('sha256').update(manifest).digest('hex');
    const hash='a'.repeat(64),after='b'.repeat(64),when='2026-09-28T02:00:00.000Z';
    fixture.db.prepare(`INSERT INTO notetaker_exclusao_controle_v1
      (op_id,schema_version,sessao_id,perfil_id,db_dev,db_ino,selecao_assinatura,schema_assinatura,digest_sql_antes,manifesto_json,manifesto_sha256,fase,criado_em)
      VALUES(?,1,?,?, '1','2',?,?,?,?,?,'preparando',?)`).run(opId,sessaoId,perfilId,hash,hash,hash,manifest,manifestHash,when);
    fixture.db.prepare("UPDATE notetaker_exclusao_controle_v1 SET fase='quarentena' WHERE op_id=?").run(opId);
    fixture.db.prepare(`INSERT INTO notetaker_exclusao_recibos_v1
      (op_id,schema_version,sessao_id,perfil_id,db_dev,db_ino,selecao_assinatura,schema_assinatura,digest_sql_antes,digest_sql_depois,manifesto_sha256,pks_removidas,arquivos_total,arquivos_pendentes,estado,commit_em)
      VALUES(?,1,?,?,'1','2',?,?,?,?,?,0,0,0,'conteudo_commitido',?)`).run(opId,sessaoId,perfilId,hash,hash,hash,after,manifestHash,when);
    fixture.db.prepare("UPDATE notetaker_exclusao_controle_v1 SET fase='conteudo_commitido' WHERE op_id=?").run(opId);
    fixture.db.prepare("UPDATE notetaker_exclusao_recibos_v1 SET estado='concluida' WHERE op_id=?").run(opId);
    fixture.db.prepare("UPDATE notetaker_exclusao_controle_v1 SET fase='concluida' WHERE op_id=?").run(opId);

    const source=await criarOrigemV9({dbPath:fixture.dbPath,perfil:{dono:'fixture C1'}}),headers=[];
    assert.equal(source.resumo.catalogoSha256,CATALOGO_SHA256_V9);
    for await(const frame of decodificarAcervoV9(source.origem))headers.push(frame.cabecalho);
    const start=headers.find(x=>x.tipo==='inicio');assert.equal(start.catalogoSha256,CATALOGO_SHA256_V9);assert.equal(start.versao,9);
    const tables=headers.filter(x=>x.tipo==='tabela').map(x=>x.nome);
    assert.equal(tables.some(name=>name.startsWith('notetaker_exclusao_')),false);
    assert.equal(JSON.stringify(headers).includes(opId),false);
  }finally{await fixture.close();}
});

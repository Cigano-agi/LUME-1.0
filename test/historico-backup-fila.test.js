import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {criarPerfilRealSintetico} from './fixtures/backup-schema-real.js';
import {abrirOraculoStagingV9} from './fixtures/backup-restore-oraculo.js';
import {criarOrigemV10} from '../src/backup-acervo-v10.js';
import {criarOrigemV9} from '../src/backup-acervo-v9.js';
import {gravarPacote} from '../src/backup-stream.js';
import {validarAcervoV10,validarAcervoV9,descartarPlanoV10,descartarPlanoV9} from '../src/backup-acervo-restore-v9.js';

async function prepararDados(f,{ativo=false}={}) {
  const agora='2026-10-01T12:00:00.000Z', interrupcao=randomUUID(), recuperacao=randomUUID();
  const evento=f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('fila@c.us','sintetica','entrada','texto','{}','conteúdo sintético','${agora}','2026-10-01','minha')`).run().lastInsertRowid;
  f.db.prepare('INSERT INTO wa_interrupcoes(id,inicio,motivo) VALUES(?,?,?)').run(interrupcao,agora,'conexao_interrompida');
  f.db.prepare(`INSERT INTO wa_fila_retomada(interrupcao_id,conversa_id,estado,tentativas,proxima_tentativa_em,ultimo_erro,criado_em,atualizado_em)
    VALUES(?,?,?,?,?,?,?,?)`).run(interrupcao,'fila@c.us',ativo?'solicitando':'pendente',2,
      ativo?'2026-10-01T12:02:00.000Z':agora,ativo?`CLAIM:${randomUUID()}`:null,agora,agora);
  f.db.prepare(`INSERT INTO wa_recuperacoes(id,conversa_id,evento_id,modo,estado,pedido_em,atualizado_em,recibo,erro)
    VALUES(?,?,?,'anteriores','aguardando_historico',?,?,1,NULL)`).run(recuperacao,'fila@c.us',evento,agora,agora);
  return {interrupcao,recuperacao,evento};
}

test('backup v10 preserva claim ativo e recibo; restore cancela fila sem solicitar histórico',async()=>{
  const f=await criarPerfilRealSintetico();
  const senha='senha sintética do teste';
  const pacote=path.join(f.dir,'fila.lumebak'),raizStaging=path.join(f.dir,'staging');
  try {
    const ids=await prepararDados(f,{ativo:true}); f.db.close(); await mkdir(raizStaging);
    const origem=await criarOrigemV10({dbPath:f.dbPath,perfil:{dono:'Teste'}});
    await gravarPacote({origem:origem.origem,destino:pacote,senha});
    const plano=await validarAcervoV10({pacote,senha,raizStaging});
    const restored=await abrirOraculoStagingV9({raizStaging,raizFixture:f.dir});
    try {
      const job=restored.prepare('SELECT * FROM wa_fila_retomada WHERE interrupcao_id=?').get(ids.interrupcao);
      assert.equal(job.conversa_id,'fila@c.us'); assert.equal(job.estado,'cancelada');
      assert.equal(job.tentativas,2); assert.equal(job.ultimo_erro,'BACKUP_RESTAURADO');
      assert.equal(job.proxima_tentativa_em,null);
      const receipt=restored.prepare('SELECT * FROM wa_recuperacoes WHERE id=?').get(ids.recuperacao);
      assert.equal(receipt.conversa_id,'fila@c.us'); assert.equal(receipt.evento_id,Number(ids.evento));
      assert.equal(receipt.recibo,1); assert.equal(receipt.estado,'interrompida'); assert.equal(receipt.erro,'BACKUP_RESTAURADO');
    } finally { restored.close(); }
    await descartarPlanoV10(plano.plano); assert.deepEqual(await readdir(raizStaging),[]);
  } finally { await f.close(); }
});

test('backup histórico v9 preserva recibo e permanece restaurável sem tabela de fila',async()=>{
  const f=await criarPerfilRealSintetico(); const senha='senha sintética do teste';
  const pacote=path.join(f.dir,'fila-v9.lumebak'),raizStaging=path.join(f.dir,'staging');
  try {
    const ids=await prepararDados(f); f.db.prepare('DELETE FROM wa_fila_retomada').run(); f.db.close(); await mkdir(raizStaging);
    const origem=await criarOrigemV9({dbPath:f.dbPath,perfil:{dono:'Teste'}});
    await gravarPacote({origem:origem.origem,destino:pacote,senha});
    const plano=await validarAcervoV9({pacote,senha,raizStaging});
    const restored=await abrirOraculoStagingV9({raizStaging,raizFixture:f.dir});
    try {
      assert.equal(restored.prepare('SELECT count(*) n FROM wa_fila_retomada').get().n,0);
      const receipt=restored.prepare('SELECT * FROM wa_recuperacoes WHERE id=?').get(ids.recuperacao);
      assert.equal(receipt.recibo,1); assert.equal(receipt.estado,'interrompida');
    } finally { restored.close(); }
    await descartarPlanoV9(plano.plano); assert.deepEqual(await readdir(raizStaging),[]);
  } finally { await f.close(); }
});

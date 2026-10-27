import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {criarPerfilRealSintetico} from './fixtures/backup-schema-real.js';
import {abrirOraculoStagingV9} from './fixtures/backup-restore-oraculo.js';
import {criarOrigemV10} from '../src/backup-acervo-v10.js';
import {gravarPacote} from '../src/backup-stream.js';
import {validarAcervoV10,inspecionarPlanoV10,descartarPlanoV10,validarAcervoV9} from '../src/backup-acervo-restore-v9.js';
import {assinaturaFonteCiclo} from '../src/ciclo-captura.js';

test('v10 autentica e restaura jobs/recibos; lease ativo volta à fila sem posse',async()=>{
  const f=await criarPerfilRealSintetico();
  const senha='senha sintética do teste';
  const pacote=path.join(f.dir,'fila-v10.lumebak'),raizStaging=path.join(f.dir,'staging');
  try{
    const e1=f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES('c','texto','entrada','texto','{}','Acordo','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run().lastInsertRowid;
    const e2=f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
      VALUES('c','audio','entrada','audio','{}','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run().lastInsertRowid;
    const signed=assinaturaFonteCiclo(f.db.prepare(`SELECT conversa_id,origem_id,tipo,bruto,texto,permissao,autor_id,recebido_em
      FROM eventos WHERE id=?`).get(e1));
    f.db.prepare(`INSERT INTO etapas(evento_id,etapa,estado,tentativas,resultado,atualizado_em)
      VALUES(?,'interpretacao','concluida',2,?,'2026-09-28T10:00:02.000Z')`)
      .run(e1,JSON.stringify({fonteAssinatura:signed,resultado:{ok:true}}));
    f.db.prepare(`INSERT INTO etapas(evento_id,etapa,estado,tentativas,atualizado_em,
      lease_token,lease_ate,fonte_assinatura)
      VALUES(?,'midia','em_curso',3,'2026-09-28T10:00:02.000Z',
      '123e4567-e89b-42d3-a456-426614174000','2026-09-28T10:01:02.000Z',?)`).run(e2,'b'.repeat(64));
    const e3=f.db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES('c','corrigido','entrada','texto','{}','Texto antigo','2026-09-28T10:00:00.000Z','2026-09-28','minha')`).run().lastInsertRowid;
    const oldSignature=assinaturaFonteCiclo(f.db.prepare(`SELECT conversa_id,origem_id,tipo,bruto,texto,permissao,autor_id,recebido_em
      FROM eventos WHERE id=?`).get(e3));
    const receipt=JSON.stringify({fonteAssinatura:oldSignature,resultado:{ok:true}});
    for(const etapa of ['interpretacao','indexacao','projecao'])
      f.db.prepare(`INSERT INTO etapas(evento_id,etapa,estado,tentativas,resultado,atualizado_em)
        VALUES(?,?,?,1,?,'2026-09-28T10:00:02.000Z')`)
        .run(e3,etapa,etapa==='indexacao'?'desistida':'concluida',receipt);
    f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto corrigido',e3);
    f.db.close();
    await mkdir(raizStaging);
    const origem=await criarOrigemV10({dbPath:f.dbPath,perfil:{dono:'Teste'}});
    await gravarPacote({origem:origem.origem,destino:pacote,senha});
    await assert.rejects(validarAcervoV9({pacote,senha,raizStaging}));
    assert.deepEqual(await readdir(raizStaging),[]);
    const plano=await validarAcervoV10({pacote,senha,raizStaging});
    assert.equal(plano.resumo.versao,10);
    assert.equal((await inspecionarPlanoV10(plano.plano)).resumo.versao,10);
    const restored=await abrirOraculoStagingV9({raizStaging,raizFixture:f.dir});
    try{
      const savedReceipt=restored.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='interpretacao'").get(e1);
      assert.equal(savedReceipt.tentativas,2);
      assert.equal(JSON.parse(savedReceipt.resultado).resultado.ok,true);
      const retry=restored.prepare("SELECT * FROM etapas WHERE evento_id=? AND etapa='midia'").get(e2);
      assert.equal(retry.estado,'falha');assert.equal(retry.tentativas,3);
      assert.equal(retry.ultimo_erro,'backup_retomada');assert.equal(retry.lease_token,null);
      const invalidas=restored.prepare('SELECT estado,ultimo_erro,resultado FROM etapas WHERE evento_id=? ORDER BY etapa').all(e3);
      assert.equal(invalidas.length,3);
      assert.equal(invalidas.every(s=>s.estado==='falha'&&s.ultimo_erro==='backup_fonte_alterada'),true);
      assert.equal(invalidas.every(s=>s.resultado===receipt),true);
    }finally{restored.close();}
    await descartarPlanoV10(plano.plano);
    assert.deepEqual(await readdir(raizStaging),[]);
  }finally{await f.close();}
});

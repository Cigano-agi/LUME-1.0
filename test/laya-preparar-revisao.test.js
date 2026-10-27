import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {selecionarRevisao,prepararRevisao} from '../scripts/laya-preparar-revisao.mjs';

test('revisão local seleciona DMs sem declarar aprovação nem expor identificadores',t=>{
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new Desktop(db);
  const put=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada','texto','{}',?,'2026-09-25T12:00:00Z','2026-09-25',?)`);
  put.run('5511999999999@s.whatsapp.net','a1','Prepare a minuta da reunião.','minha');
  put.run('5511999999999@s.whatsapp.net','a2','Confirme a data do encontro.','minha');
  put.run('5511888888888@lid','b1','Envie a proposta revisada.','minha');
  put.run('grupo@g.us','g1','Confirme a data para o grupo.','minha');
  put.run('5511777777777@c.us','c1','Meu email é teste@example.com.','minha');
  put.run('5511666666666@s.whatsapp.net','d1','Esta mensagem não foi liberada.','nenhuma');
  const result=selecionarRevisao(db,{salt:randomBytes(32),maxItems:3,perConversation:2});
  assert.equal(result.selection.selected,3);
  assert.equal(result.selection.selectedConversations,2);
  assert.equal(result.selection.sensitiveSkipped,1);
  assert.deepEqual(result.items.map(x=>x.text),['Envie a proposta revisada.','Confirme a data do encontro.','Prepare a minuta da reunião.']);
  assert.equal(result.items.every(x=>x.channel==='dm'&&x.reviewed===false),true);
  assert.equal(result.items[1].personKey,result.items[2].personKey);
  assert.doesNotMatch(JSON.stringify(result),/5511|grupo@g\.us|rightsConfirmed|approvedByOwner/);
});

test('CLI não abre banco sem confirmação explícita de direitos e revisão local',()=>{
  const root=resolve(import.meta.dirname,'..');
  const result=spawnSync(process.execPath,[resolve(root,'scripts/laya-preparar-revisao.mjs'),'banco-inexistente.db','work/laya-private/sem-saida.json'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/confirm-participant-rights/);
  assert.doesNotMatch(result.stderr,/SQLITE|ENOENT/);
});

test('saída privada lê banco sintético sem alterar a fonte nem aprovar treino',async t=>{
  const dir=resolve(import.meta.dirname,'..','work','laya-private','revisoes-dm');mkdirSync(dir,{recursive:true});
  const base='fixture-'+randomUUID(),databasePath=join(dir,base+'.db'),outputPath=join(dir,base+'.json');
  t.after(()=>{for(const path of [databasePath,databasePath+'-wal',databasePath+'-shm',outputPath])rmSync(path,{force:true});});
  const db=abrirBanco(databasePath);new ContextoApp(db);new Desktop(db);
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('5511999999999@s.whatsapp.net','m1','entrada','texto','{}','Prepare a proposta amanhã.','2026-09-25T12:00:00Z','2026-09-25','minha')`).run();
  db.close();
  const summary=await prepararRevisao({databasePath,outputPath});
  assert.equal(summary.written,true);assert.equal(summary.selected,1);
  const result=JSON.parse(readFileSync(outputPath,'utf8'));
  assert.equal(result.items[0].reviewed,false);
  assert.equal(result.items[0].text,'Prepare a proposta amanhã.');
  assert.doesNotMatch(JSON.stringify(result),/5511999999999|approvedByOwner|rightsConfirmed/);
  if(process.platform==='win32'){
    const acl=spawnSync('icacls',[outputPath],{encoding:'utf8'});
    assert.equal(acl.status,0);
    assert.doesNotMatch(acl.stdout,/CodexSandboxUsers|\(I\)/);
    const directoryAcl=spawnSync('icacls',[dir],{encoding:'utf8'});
    assert.equal(directoryAcl.status,0);
    assert.doesNotMatch(directoryAcl.stdout,/CodexSandboxUsers/);
  }
});

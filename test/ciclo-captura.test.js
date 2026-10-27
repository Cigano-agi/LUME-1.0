import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {fontesProntasDoCiclo,reconciliarCicloFontes} from '../src/ciclo-captura.js';
import {chaveConversa,chaveExclusao} from '../src/exclusoes.js';

const mensagem=(conversa,id,message,participant)=>({
  key:{remoteJid:conversa,id,...(participant?{participant}:{})},message,messageTimestamp:1788794100
});

test('captura cria etapas duráveis de texto e áudio para contatos e grupos novos, sem projeto',()=>{
  const db=abrirBanco();const app=new ContextoApp(db);
  const lote={type:'history',messages:[
    mensagem('novo@s.whatsapp.net','texto',{conversation:'Rever proposta'}),
    mensagem('grupo@g.us','audio',{audioMessage:{mimetype:'audio/ogg',seconds:3}},'pessoa@s.whatsapp.net')
  ]};
  assert.equal(app.receber(lote).novas,2);
  assert.equal(app.receber(lote).novas,0);
  const rows=db.prepare(`SELECT e.origem_id,e.autor_id,s.etapa,s.estado FROM eventos e JOIN etapas s ON s.evento_id=e.id
    WHERE s.etapa IN ('captura','midia','transcricao','interpretacao','indexacao','projecao') ORDER BY e.id,s.etapa`).all();
  assert.deepEqual(rows.filter(r=>r.origem_id==='texto').map(r=>r.etapa),['captura','indexacao','interpretacao','projecao']);
  assert.deepEqual(rows.filter(r=>r.origem_id==='audio').map(r=>r.etapa),['captura','indexacao','interpretacao','midia','projecao','transcricao']);
  assert.equal(rows.find(r=>r.origem_id==='audio'&&r.etapa==='captura').autor_id,'pessoa@s.whatsapp.net');
  assert.equal(rows.filter(r=>r.etapa==='captura').every(r=>r.estado==='concluida'),true);
  assert.deepEqual(fontesProntasDoCiclo(db,'midia').map(r=>r.origem_id),['audio']);
  assert.deepEqual(fontesProntasDoCiclo(db,'transcricao'),[]);
  db.close();
});

test('falha por mensagem não confirma etapas; replay não duplica trabalho',()=>{
  const db=abrirBanco();const app=new ContextoApp(db);
  const lote={messages:[mensagem('a@s.whatsapp.net','ok',{conversation:'Ok'}),mensagem('a@s.whatsapp.net','bad',{conversation:'Falha'})]};
  db.exec(`CREATE TRIGGER impedir_etapa BEFORE INSERT ON etapas WHEN NEW.etapa='captura' AND
    (SELECT origem_id FROM eventos WHERE id=NEW.evento_id)='bad' BEGIN SELECT RAISE(ABORT,'falha simulada'); END`);
  assert.deepEqual(app.receber(lote),{novas:1,ignoradas:0,falhas:1});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM eventos WHERE origem_id='bad'").get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM falhas_ingestao').get().n,1);
  db.exec('DROP TRIGGER impedir_etapa');
  assert.equal(app.receber(lote).novas,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='captura'").get().n,2);
  db.close();
});

test('dependências e exclusão impedem processamento antes de mídia e após revogação',()=>{
  const db=abrirBanco();const app=new ContextoApp(db);
  app.receber({messages:[mensagem('g@g.us','a',{audioMessage:{mimetype:'audio/ogg'}}),mensagem('g@g.us','t',{conversation:'Texto'})]});
  const audio=db.prepare("SELECT id FROM eventos WHERE origem_id='a'").get().id;
  assert.deepEqual(fontesProntasDoCiclo(db,'interpretacao').map(r=>r.origem_id),['t']);
  db.prepare("UPDATE etapas SET estado='concluida' WHERE evento_id=? AND etapa='midia'").run(audio);
  assert.deepEqual(fontesProntasDoCiclo(db,'transcricao').map(r=>r.origem_id),['a']);
  db.prepare("INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)").run(chaveExclusao('g@g.us','a'),new Date().toISOString());
  assert.deepEqual(fontesProntasDoCiclo(db,'transcricao'),[]);
  assert.throws(()=>fontesProntasDoCiclo(db,'envio'),/Etapa inválida/);
  db.close();
});

test('reconcilia acervo anterior em lotes e replay de evento antigo',()=>{
 const db=abrirBanco();const app=new ContextoApp(db);
 db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
 VALUES('a@s.whatsapp.net','antigo','entrada','texto','{}','Contexto','2026-09-01T00:00:00.000Z','2026-09-01')`).run();
 const replay={messages:[mensagem('a@s.whatsapp.net','antigo',{conversation:'Contexto'})]};
 assert.equal(app.receber(replay).novas,0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='captura'").get().n,1);
 for(let i=0;i<3;i++)db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
 VALUES(?,?,?,?,?,?,?,?)`).run('a@s.whatsapp.net','velho'+i,'entrada','texto','{}','Antigo','2026-09-01T00:00:00.000Z','2026-09-01');
 db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
 VALUES('outro@g.us','importado','entrada','texto','{}','Pacote','2026-09-01T00:00:00.000Z','2026-09-01','compartilhado')`).run();
 const primeiro=reconciliarCicloFontes(db,{limite:2});
 const segundo=reconciliarCicloFontes(db,{limite:2,cursor:primeiro.cursor});
 const terceiro=reconciliarCicloFontes(db,{limite:2,cursor:segundo.cursor});
 assert.equal(primeiro.reconciliadas,1);
 assert.equal(segundo.reconciliadas,2);
 assert.equal(terceiro.reconciliadas,0);
 assert.equal(terceiro.restam,false);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='captura'").get().n,4);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM etapas s JOIN eventos e ON e.id=s.evento_id WHERE e.origem_id='importado'").get().n,0);
 db.close();
});

test('reconciliação completa fonte parcial sem duplicar captura',()=>{
 const db=abrirBanco();new ContextoApp(db);
 const id=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
 VALUES('parcial@s.whatsapp.net','p1','entrada','texto','{}','Texto','2026-09-28T00:00:00.000Z','2026-09-27')`).run().lastInsertRowid;
 db.prepare(`INSERT INTO etapas(evento_id,etapa,estado,atualizado_em)
 VALUES(?,'captura','concluida','2026-09-28T00:00:00.000Z')`).run(id);
 assert.equal(reconciliarCicloFontes(db).reconciliadas,1);
 assert.equal(reconciliarCicloFontes(db).reconciliadas,0);
 assert.deepEqual(db.prepare('SELECT etapa FROM etapas WHERE evento_id=? ORDER BY etapa').all(id).map(r=>r.etapa),
  ['captura','indexacao','interpretacao','projecao']);
 db.close();
});

test('cursor da reconciliação avança por fonte sem reler prefixo',()=>{
 const db=abrirBanco();new ContextoApp(db);
 for(let i=0;i<3;i++)db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
   VALUES('c',?,'entrada','texto','{}','T','2026-09-28T00:00:00.000Z','2026-09-27')`).run(`c${i}`);
 const first=reconciliarCicloFontes(db,{limite:2,cursor:0});
 const second=reconciliarCicloFontes(db,{limite:2,cursor:first.cursor});
 assert.equal(first.reconciliadas,2);assert.equal(second.reconciliadas,1);
 assert.ok(second.cursor>first.cursor);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='captura'").get().n,3);
 db.close();
});

test('reconciliação limita examinadas e avança por prefixo já completo antes de pendência distante',()=>{
 const db=abrirBanco();new ContextoApp(db);
 try{
  const inserir=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
    VALUES('c',?,'entrada','texto','{}','Fixture','2026-09-28T00:00:00.000Z','2026-09-28')`);
  db.exec('BEGIN');
  for(let i=0;i<1000;i++){
   const id=inserir.run(String(i)).lastInsertRowid;
   for(const etapa of ['captura','interpretacao','indexacao','projecao'])db.prepare("INSERT INTO etapas(evento_id,etapa,estado,atualizado_em) VALUES(?,?,'concluida','2026-09-28')").run(id,etapa);
  }
  const ultimo=Number(inserir.run('pendente-distante').lastInsertRowid);db.exec('COMMIT');
  const primeiro=reconciliarCicloFontes(db,{limite:25});
  assert.equal(primeiro.reconciliadas,0,'Pendência além da janela não pode provocar varredura do prefixo inteiro.');
  assert.equal(primeiro.examinadas,25);assert.equal(primeiro.cursor,25);assert.equal(primeiro.restam,true);
  let atual=primeiro,total=0,lotes=1;
  while(atual.restam){atual=reconciliarCicloFontes(db,{limite:25,cursor:atual.cursor});total+=atual.reconciliadas;lotes++;assert.ok(atual.examinadas<=25);}
  assert.equal(lotes,41);assert.equal(total,1);assert.equal(atual.cursor,ultimo);assert.equal(atual.examinadas,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM etapas WHERE evento_id=?").get(ultimo).n,4);
 }finally{db.close();}
});

test('janela sem candidatos avança por notas, compartilhados e captura desistida sem escrever',()=>{
 const db=abrirBanco();new ContextoApp(db);
 try{
  const inserir=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('fixture',?,'entrada',?,'{}','Fixture','2026-09-28T00:00:00.000Z','2026-09-28',?)`);
  inserir.run('nota','nota',null);inserir.run('trecho','notetaker_trecho',null);
  inserir.run('compartilhado','texto','compartilhado');
  const id=Number(inserir.run('desistida','texto',null).lastInsertRowid);
  db.prepare("INSERT INTO etapas(evento_id,etapa,estado,atualizado_em) VALUES(?,'captura','desistida','2026-09-28')").run(id);
  db.exec('PRAGMA query_only=ON');
  const primeiro=reconciliarCicloFontes(db,{limite:4});
  assert.deepEqual(primeiro,{reconciliadas:0,examinadas:4,restam:true,cursor:id});
  assert.deepEqual(reconciliarCicloFontes(db,{limite:4,cursor:primeiro.cursor}),
    {reconciliadas:0,examinadas:0,restam:false,cursor:id});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM etapas').get().n,1);
 }finally{db.close();}
});

test('paginação mantém exclusão de fonte e conversa, sem reabrir etapas em replay',()=>{
 const db=abrirBanco();new ContextoApp(db);
 try{
  const inserir=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
    VALUES(?,?,'entrada','audio','{}','Fixture','2026-09-28T00:00:00.000Z','2026-09-28')`);
  inserir.run('fonte','a');inserir.run('conversa','b');inserir.run('livre','c');
  db.prepare('INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)').run(chaveExclusao('fonte','a'),'2026-09-28');
  db.prepare('INSERT INTO priv_conversas_excluidas(hash,excluido_em) VALUES(?,?)').run(chaveConversa('conversa'),'2026-09-28');
  let cursor=0;
  for(let i=0;i<3;i++){const lote=reconciliarCicloFontes(db,{limite:1,cursor});assert.equal(lote.examinadas,1);cursor=lote.cursor;}
  assert.deepEqual(fontesProntasDoCiclo(db,'midia').map(r=>r.origem_id),['c']);
  const anteriores=db.prepare('SELECT * FROM etapas ORDER BY evento_id,etapa').all();
  assert.equal(anteriores.filter(r=>r.evento_id<=2&&r.etapa!=='captura').every(r=>r.estado==='desistida'&&r.ultimo_erro==='fonte_excluida'),true);
  assert.equal(reconciliarCicloFontes(db).reconciliadas,0);
  assert.deepEqual(db.prepare('SELECT * FROM etapas ORDER BY evento_id,etapa').all(),anteriores);
 }finally{db.close();}
});

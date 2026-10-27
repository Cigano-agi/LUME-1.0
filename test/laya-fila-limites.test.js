import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {FilaLaya} from '../src/laya/fila.js';
import {chaveExclusao} from '../src/exclusoes.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function fixture(t,{n=0,permissao='restrita',path}={}){
  const db=abrirBanco(path);new ContextoApp(db);new Desktop(db);t.after(()=>{try{db.close();}catch{}});
  const laya={status:()=>({instalado:true,aprovado:true,avaliacao:'aprovada'}),classificar:async()=>({}),extrairAcoes:async()=>({candidatas:[]})};
  const fila=new FilaLaya(db,{laya});
  const insert=db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('sintetica',?,'entrada','texto','{}','Mensagem sintética.','2026-10-26T12:00:00Z','2026-10-26',?)");
  db.exec('BEGIN');for(let i=0;i<n;i++)insert.run(String(i),permissao);db.exec('COMMIT');
  const vistos=new Set();db.function('fonte_examinada',id=>{vistos.add(id);return 1;});
  db.exec('CREATE TEMP VIEW desktop_fontes AS SELECT * FROM main.desktop_fontes WHERE fonte_examinada(id)=1');
  return {db,fila,laya,vistos};
}

test('fila: modelo ausente ou reprovado fecha descoberta antes de varrer fontes',async t=>{
  for(const state of [{instalado:false},{instalado:true,aprovado:false,avaliacao:'reprovada'}]){
    const f=fixture(t,{n:100});f.laya.status=()=>state;
    f.fila.capturarNovas=()=>assert.fail('descoberta não deve iniciar com gate fechado');
    assert.equal(await f.fila.passo(),false);
    assert.equal(f.vistos.size,0);
  }
});

test('fila: limite conta fontes examinadas mesmo com milhares sem permissão',t=>{
  const f=fixture(t,{n:3000});
  assert.equal(f.fila.capturarNovas({limite:20}),0);
  assert.ok(f.vistos.size<=20,`examinadas ${f.vistos.size}, orçamento20`);
});

test('fila: limpeza de revogação examina um lote limitado da fila',t=>{
  const f=fixture(t,{n:3000,permissao:'minha'});
  f.db.exec("INSERT INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,estado,criada_em,atualizada_em) SELECT id,conversa_id,'sintetica','pendente',recebido_em,recebido_em FROM eventos");
  f.fila.limparSemPermissao({limite:20});
  assert.ok(f.vistos.size<=20,`examinadas ${f.vistos.size}, orçamento20`);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_laya_fila').get().n,3000);
});

test('fila: cursor retoma após reabrir SQLite e revisita permissão antiga sob chegada contínua',t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-laya-cursor-')),path=join(dir,'sintetico.sqlite');
  const f=fixture(t,{n:60,path});let reopened;
  t.after(()=>{reopened?.close();rmSync(dir,{recursive:true,force:true});});
  f.fila.capturarNovas({limite:10});
  f.db.prepare("UPDATE eventos SET permissao='minha' WHERE id IN(2,31)").run();
  f.fila.capturarNovas({limite:10});f.fila.capturarNovas({limite:10});f.db.close();
  reopened=abrirBanco(path);const fila=new FilaLaya(reopened,{laya:f.laya});
  const seen=new Set();reopened.function('fonte_examinada',id=>{seen.add(id);return 1;});
  reopened.exec('CREATE TEMP VIEW desktop_fontes AS SELECT * FROM main.desktop_fontes WHERE fonte_examinada(id)=1');
  fila.capturarNovas({limite:10});assert.ok(seen.has(16),'reinício deve continuar após os15IDs já examinados');
  const insert=reopened.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('nova',?,'entrada','texto','{}','Fonte negada.','2026-10-26T12:00:00Z','2026-10-26','restrita')");
  for(let turn=0;turn<14;turn++){
    for(let j=0;j<10;j++)insert.run(`${turn}-${j}`);
    seen.clear();fila.capturarNovas({limite:10});assert.ok(seen.size<=10);
  }
  assert.deepEqual(reopened.prepare('SELECT evento_id FROM lume_laya_fila ORDER BY evento_id').all().map(r=>r.evento_id),[2,31]);
  fila.capturarNovas({limite:10});assert.equal(reopened.prepare('SELECT COUNT(*) n FROM lume_laya_fila').get().n,2);
});

test('fila: limpeza incremental reencontra revogação e tombstone atrás do cursor',t=>{
  const f=fixture(t,{n:80,permissao:'minha'});
  f.db.exec("INSERT INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,estado,criada_em,atualizada_em) SELECT id,conversa_id,'sintetica','pendente',recebido_em,recebido_em FROM eventos");
  f.fila.limparSemPermissao({limite:10});
  f.db.prepare("UPDATE eventos SET permissao='restrita' WHERE id=75").run();
  f.db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao('sintetica','4'),'2026-10-26T12:00:00Z');
  const resumed=new FilaLaya(f.db,{laya:f.laya});
  for(let i=0;i<9;i++){f.vistos.clear();resumed.limparSemPermissao({limite:10});assert.ok(f.vistos.size<=10);}
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_laya_fila').get().n,78);
  assert.equal(f.db.prepare('SELECT evento_id FROM lume_laya_fila WHERE evento_id IN(5,75)').get(),undefined);
});

test('fila: batimento sem modelo limita trabalho com30mil fontes já enfileiradas',async t=>{
  const f=fixture(t,{n:30000,permissao:'minha'});f.laya.status=()=>({instalado:false});
  f.db.exec("INSERT INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,estado,motivo,criada_em,atualizada_em) SELECT id,conversa_id,'sintetica','aguardando_modelo','modelo_ausente',recebido_em,recebido_em FROM eventos");
  const start=performance.now();await f.fila.passo();const ms=performance.now()-start;
  assert.equal(f.vistos.size,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_laya_fila').get().n,30000);
  t.diagnostic(`30.000 fontes sintéticas: ${f.vistos.size} examinadas, batimento ${ms.toFixed(1)}ms; não é medição no perfil real.`);
});

for(const instalado of [true,false])test(`fila: espera reflete modelo ${instalado?'instalado sem aprovação':'removido'} sem varrer fontes`,async t=>{
  const f=fixture(t,{n:3,permissao:'minha'});f.fila.capturarNovas();
  f.laya.status=()=>({instalado:!instalado,aprovado:false,avaliacao:'reprovada'});await f.fila.passo();
  f.laya.status=()=>({instalado,aprovado:false,avaliacao:'reprovada'});f.vistos.clear();await f.fila.passo();
  assert.deepEqual(f.db.prepare('SELECT DISTINCT motivo FROM lume_laya_fila').all().map(r=>r.motivo),[instalado?'qualidade_pendente':'modelo_ausente']);
  assert.equal(f.vistos.size,0);
});

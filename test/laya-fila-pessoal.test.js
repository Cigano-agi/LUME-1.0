import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {FilaLaya} from '../src/laya/fila.js';
import {chaveExclusao} from '../src/exclusoes.js';

function ambiente(t){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new Desktop(db);
  const vistas=[];
  const laya={status:()=>({instalado:true,aprovado:true,avaliacao:'aprovada'}),
    classificar:async()=>({}),extrairAcoes:async({texto})=>{vistas.push(texto);return{candidatas:[]};}};
  const fila=new FilaLaya(db,{laya});
  const inserir=(conversa,origem,texto,permissao='minha')=>Number(db.prepare(`INSERT INTO eventos
    (conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES(?,?,'entrada','texto','{}',?,'2026-10-01T12:00:00Z','2026-10-01',?)`).run(conversa,origem,texto,permissao).lastInsertRowid);
  return{db,fila,laya,vistas,inserir};
}

test('conversa nova de grupo elegível entra sem cadastro manual',t=>{
  const f=ambiente(t);const id=f.inserir('novo@g.us','g1','Pode confirmar a pauta?','dirigida');
  assert.equal(f.fila.capturarNovas(),1);
  assert.equal(f.db.prepare('SELECT evento_id FROM lume_laya_fila').get().evento_id,id);
});

test('novo escopo pessoal espera aceite antes de capturar ou interpretar',async t=>{
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);
  const desktop=new Desktop(db);let chamadas=0;
  const laya={status:()=>({instalado:true,aprovado:true,avaliacao:'aprovada'}),
    classificar:async()=>({}),extrairAcoes:async()=>{chamadas++;return{candidatas:[]};}};
  const fila=new FilaLaya(db,{laya,podeProcessar:()=>desktop.perfil().aceito});
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('novo@g.us','g1','entrada','texto','{}','Confirma a pauta?','2026-10-01T12:00:00Z','2026-10-01','dirigida')`).run();
  assert.equal(fila.capturarNovas(),0);
  assert.equal(await fila.passo(),false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lume_laya_fila').get().n,0);
  desktop.aceitar({nome:'Pessoa',aceito:true,versao:desktop.perfil().versaoTermos});
  assert.equal(fila.capturarNovas(),1);
  assert.equal(await fila.passo(),true);
  assert.equal(chamadas,1);
});

test('exclusão e contribuição importada não entram na fila pessoal',t=>{
  const f=ambiente(t);const excluida=f.inserir('dm-excluida','x','Apagar esta fonte.');
  const importada=f.inserir('dm-importada','i','Histórico importado.','compartilhado');
  f.db.prepare('INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)').run(chaveExclusao('dm-excluida','x'),'2026-10-01T12:00:00Z');
  f.db.prepare("INSERT INTO f10_projetos(id,nome,criado_em) VALUES('projeto-importado','Importado','2026-09-01T00:00:00Z')").run();
  f.db.prepare("INSERT INTO f10_origens(fingerprint,pessoa,maquina,chave_publica) VALUES('f','origem','maquina','chave')").run();
  f.db.prepare(`INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em)
    VALUES(?,?,?,?,?,?)`).run(importada,'f','p','projeto-importado','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
  assert.equal(f.fila.capturarNovas(),0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_laya_fila').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM eventos WHERE id IN (?,?)').get(excluida,importada).n,2);
});

test('captura é idempotente para a mesma fonte',t=>{
  const f=ambiente(t);f.inserir('dm-novo','d','Preparar o resumo.');
  assert.equal(f.fila.capturarNovas(),1);assert.equal(f.fila.capturarNovas(),0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_laya_fila').get().n,1);
});

test('fluxo de mensagens novas não deixa conversa antiga sem entrar na fila',t=>{
  const f=ambiente(t);const antigo=f.inserir('dm-antiga','antiga','Proposta aguardando retorno.');
  for(let n=0;n<20;n++)f.inserir('dm-recente',`r${n}`,`Mensagem recente ${n}.`);
  for(let rodada=0;rodada<3;rodada++){
    for(let n=0;n<10;n++)f.inserir('dm-recente',`r${rodada}-${n}`,`Chegou agora ${rodada}-${n}.`);
    f.fila.capturarNovas({limite:10});
  }
  assert.equal(f.db.prepare('SELECT 1 FROM lume_laya_fila WHERE evento_id=?').get(antigo)?.[1],1);
});

test('fonte alterada durante a inferência não persiste o resultado antigo',async t=>{
  const f=ambiente(t);const id=f.inserir('dm-revalidar','r','Texto original.');
  let liberar,iniciou;const comecou=new Promise(resolve=>{iniciou=resolve;});
  f.laya.extrairAcoes=async()=>{iniciou();await new Promise(resolve=>{liberar=resolve;});return{candidatas:[]};};
  assert.equal(f.fila.capturarNovas(),1);const passo=f.fila.passo();await comecou;
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto corrigido.',id);liberar();
  assert.equal(await passo,false);
  assert.equal(f.db.prepare('SELECT estado,motivo FROM lume_laya_fila WHERE evento_id=?').get(id).motivo,'fonte_alterada');
});

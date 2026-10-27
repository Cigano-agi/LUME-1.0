import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {prepararFontes} from '../src/fontes-desktop.js';
import {ContextoPessoal} from '../src/pessoal/contexto.js';

function setup(t,{ia=true}={}){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);
  if(ia)new DesktopIA(db);
  const contexto=new ContextoPessoal(db);
  for(const id of ['a','b'])db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,'Ana');
  let n=0;
  const inserir=(conversa,texto,{permissao='minha',tipo='texto',dono=0}={})=>Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono) VALUES(?,?,'entrada',?,'{}',?,'2026-10-26T10:00:00Z','2026-10-26',?,?)`).run(conversa,String(++n),tipo,texto,permissao,dono).lastInsertRowid);
  const permitir=id=>db.prepare("INSERT OR REPLACE INTO desktop_ia_conversas VALUES(?,1,'2026-10-26')").run(id);
  return {db,contexto,inserir,permitir};
}

test('pessoal: conversa exata, opt-in remoto e leitura pessoal são fronteiras diferentes',t=>{
  const {db,contexto,inserir,permitir}=setup(t);
  const a=inserir('a','Contrato da Ana'),b=inserir('b','Segredo de outra Ana'),terceiro=inserir('a','Mensagem pessoal de terceiro',{permissao:'terceiro'});
  assert.deepEqual(new Set(contexto.recuperar({conversaId:'a'}).fontes.map(f=>f.id)),new Set([a,terceiro]));
  assert.equal(contexto.recuperar({conversaId:'a',remoto:true}).fontes.length,0);
  permitir('a');assert.deepEqual(contexto.recuperar({conversaId:'a',remoto:true}).fontes.map(f=>f.id),[a]);
  assert.ok(!contexto.recuperar({remoto:true}).fontes.some(f=>f.id===b||f.id===terceiro));
  db.prepare('UPDATE desktop_ia_conversas SET permitida=0 WHERE conversa_id=?').run('a');
  assert.equal(contexto.recuperar({remoto:true}).fontes.length,0);
});

test('pessoal: opt-in ausente fecha remoto e nomes duplicados são ambíguos',t=>{
  const f=setup(t,{ia:false});f.inserir('a','Mensagem da Ana um');f.inserir('b','Mensagem da Ana dois');
  assert.equal(f.contexto.recuperar({remoto:true}).fontes.length,0);
  const nome=f.contexto.resolverConversa({nome:'Ana'});assert.equal(nome.ambigua,true);assert.equal(nome.conversaId,null);assert.equal(nome.candidatos.length,2);
  assert.equal(f.contexto.resolverConversa({nome:'a'}).conversaId,'a');
  assert.equal(f.contexto.resolverConversa({nome:'Ana',remoto:true}).candidatos.length,0);
});

test('pessoal: fonte e derivada revogadas somem na próxima consulta',t=>{
  const f=setup(t),origem=f.inserir('a','Fonte original revogável'),derivada=f.inserir('a','Resumo vinculado à fonte');
  f.db.prepare('INSERT INTO priv_vinculos VALUES(?,?)').run(origem,derivada);
  assert.equal(f.contexto.recuperar({conversaId:'a'}).fontes.length,2);
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(origem);
  assert.equal(f.contexto.recuperar({conversaId:'a'}).fontes.length,0);
});

test('pessoal: áudio pendente não vira mensagem nem demanda; transcrição vem de desktop_fontes',t=>{
  const f=setup(t),id=f.inserir('a','<anexado: audio.ogg>',{tipo:'audio'});
  let r=f.contexto.recuperar({conversaId:'a'});assert.equal(r.fontes.length,0);assert.ok(r.lacunas.some(l=>l.tipo==='audio_pendente'));
  assert.throws(()=>f.contexto.registrarDemanda({eventoId:id,resumo:'Inventado',trecho:'anexado: audio.ogg'}),/transcrição/);
  f.db.exec('CREATE TABLE transcricoes(conversa_id TEXT,origem_id TEXT,texto TEXT,estado TEXT,PRIMARY KEY(conversa_id,origem_id))');
  f.db.prepare('INSERT INTO transcricoes VALUES(?,?,?,?)').run('a','1','Preparar relatório amanhã.','transcrito');prepararFontes(f.db);
  r=f.contexto.recuperar({conversaId:'a'});assert.equal(r.fontes[0].texto,'Preparar relatório amanhã.');
  const acao=f.contexto.registrarDemanda({eventoId:id,resumo:'Relatório',trecho:'Preparar relatório amanhã.'});assert.equal(acao.novos,1);
  f.db.prepare("UPDATE transcricoes SET estado='erro',texto=NULL").run();
  r=f.contexto.recuperar({conversaId:'a'});assert.equal(r.fontes.length,0);assert.ok(r.lacunas.some(l=>l.tipo==='audio_erro'));assert.equal(f.contexto.acompanhar(acao.acaoId),null);
});

test('pessoal: registro idempotente usa ação existente e acompanhamento exige fonte atual',t=>{
  const f=setup(t),id=f.inserir('a','Enviar o contrato para revisão.');
  const pedido={eventoId:id,resumo:'Enviar contrato',trecho:'Enviar o contrato para revisão.'};
  const a=f.contexto.registrarDemanda(pedido),b=f.contexto.registrarDemanda(pedido);
  assert.equal(a.novos,1);assert.equal(b.novos,0);assert.equal(a.acaoId,b.acaoId);assert.equal(f.contexto.pendencias().length,1);
  const prova=f.contexto.acompanhar(a.acaoId);assert.equal(prova.fonte.id,id);assert.equal(prova.acao.estado,'sugerido');
  assert.equal(f.contexto.acompanhar(a.acaoId,{conversaId:'b'}),null);
  assert.equal(f.contexto.pendencias({remoto:true}).length,0);f.permitir('a');assert.equal(f.contexto.pendencias({remoto:true}).length,1);
  f.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Contrato cancelado.',id);
  assert.equal(f.contexto.acompanhar(a.acaoId),null);assert.equal(f.contexto.pendencias().length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,1);
});

test('pessoal: recuperação reúne recente e lexical, limitada a20 fontes e24000 caracteres',t=>{
  const f=setup(t),antigo=f.inserir('a','Orçamento girassol confirmado em reunião.');
  for(let i=0;i<230;i++)f.inserir('a',`Mensagem ${i} ${'detalhes '.repeat(300)}`);
  const r=f.contexto.recuperar({pergunta:'girassol',conversaId:'a'});
  assert.ok(r.fontes.some(s=>s.id===antigo));assert.ok(r.fontes.length<=20);assert.ok(r.fontes.reduce((n,s)=>n+s.texto.length,0)<=24000);
  assert.ok(r.lacunas.some(l=>l.tipo==='cobertura_parcial'));
});

test('pessoal: demanda requer citação literal, nenhuma autorização de envio é criada',t=>{
  const f=setup(t),id=f.inserir('a','Confirmar a entrega do relatório.');
  assert.throws(()=>f.contexto.registrarDemanda({eventoId:id,resumo:'Inventado',trecho:'Inventar outro compromisso.'}),/ausente/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lume_acoes').get().n,0);
  f.contexto.registrarDemanda({eventoId:id,resumo:'Relatório',trecho:'Confirmar a entrega do relatório.'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM autorizacoes').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM saidas').get().n,0);
});

test('pessoal: recorte de conversa ocorre antes do limite lexical',t=>{
  const f=setup(t);for(let i=0;i<220;i++)f.inserir('b','Orçamento girassol de outro contato.');
  const id=f.inserir('a','Girassol da conversa selecionada.');
  for(let i=0;i<205;i++)f.inserir('a','Mensagem recente sem o termo.');
  const r=f.contexto.recuperar({pergunta:'girassol',conversaId:'a'});
  assert.ok(r.fontes.some(e=>e.id===id));assert.ok(r.fontes.every(e=>e.conversaId==='a'));
});

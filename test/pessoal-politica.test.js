import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {PoliticaPessoal,CATEGORIAS} from '../src/pessoal/politica.js';
import {Saidas} from '../src/saidas.js';

const DM='551100000001@s.whatsapp.net',OTHER='551100000002@s.whatsapp.net',GROUP='123456789@g.us';
function fixture(t){
  const db=abrirBanco(),contexto=new ContextoApp(db),politica=new PoliticaPessoal(db);
  t.after(()=>db.close());return {db,contexto,politica};
}
function configurar(p,extra={}){return p.configurar({conversaId:DM,categoria:'lead',modo:'atender',remoto:true,...extra});}
function receber(c,{jid=DM,id='source',fromMe=false,type='notify',text='Mensagem sintética'}={}){
  return c.receber({type,messages:[{key:{remoteJid:jid,id,fromMe},messageTimestamp:1793016000,message:{conversation:text}}]});
}
function proposta(f,{id='proposal',jid=DM,estado='aprovada'}={}){
  receber(f.contexto,{jid});const evento=f.db.prepare('SELECT id FROM eventos WHERE conversa_id=?').get(jid).id;
  const regra=f.politica.regra(jid);
  f.db.prepare(`INSERT INTO pessoal_propostas(id,conversa_id,evento_id,versao,politica_hash,conteudo_hash,baloes,fontes,motivo,estado,criada_em)
    VALUES(?,?,?,?,?,?,'["Resposta sintética"]','[]','Teste',?,?)`)
    .run(id,jid,evento,regra.versao,f.politica.assinatura(jid),'hash-'+id,estado,new Date().toISOString());
  const saidas=new Saidas(f.db,f.politica),saida=saidas.preparar({conversaId:jid,corpo:'Resposta sintética',idempotencia:id});
  f.db.prepare('INSERT INTO pessoal_proposta_saidas(proposta_id,ordem,saida_id,wa_id,atualizado_em) VALUES(?,0,?,?,?)').run(id,saida.id,'wa-'+id,new Date().toISOString());
  return {evento,saidas,saida};
}

test('categorias só permitem envio para liberação exata e contexto autorizado',t=>{
  const {politica:p}=fixture(t);
  assert.equal(p.podeEnviar(DM).permitido,false);
  for(const categoria of CATEGORIAS){
    configurar(p,{categoria,modo:'rascunhar'});
    assert.equal(p.podeEnviar(DM).permitido,['vip_client','lead','team'].includes(categoria),categoria);
    configurar(p,{categoria,modo:'observar'});assert.equal(p.podeEnviar(DM).permitido,false);
    if(['vip_client','lead','team'].includes(categoria)){
      configurar(p,{categoria,remoto:false});assert.equal(p.podeEnviar(DM).permitido,false);
    }else assert.throws(()=>configurar(p,{categoria}),/categoria|grupo/);
  }
  configurar(p);assert.equal(p.podeEnviar(DM).permitido,true);
  for(const id of [OTHER,'1551100000001@s.whatsapp.net',DM+'.invalid',GROUP])assert.equal(p.podeEnviar(id).permitido,false);
});

test('grupo permanece bloqueado mesmo com regra legada atender ou categoria privilegiada',t=>{
  const {politica:p}=fixture(t);
  configurar(p,{conversaId:GROUP,categoria:'vip_client',modo:'rascunhar'});
  p.base.definir(GROUP,'atender',{decididoPor:'local:owner'});
  assert.equal(p.podeEnviar(GROUP).permitido,false);
  assert.throws(()=>configurar(p,{conversaId:GROUP,categoria:'vip_client'}));
});

test('silêncio não cria regra nem libera observação',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-26T10:00:00Z')});
  const {politica:p}=fixture(t);configurar(p,{modo:'observar'});
  const before=p.assinatura(DM);t.mock.timers.tick(86400000);
  assert.equal(p.podeEnviar(DM).permitido,false);assert.equal(p.podeEnviar(OTHER).permitido,false);
  assert.equal(p.assinatura(DM),before);
});

test('hash identifica destinatário, permissão e versão; mudança cancela proposta preparada',t=>{
  const f=fixture(t);configurar(f.politica);configurar(f.politica,{conversaId:OTHER});
  assert.notEqual(f.politica.assinatura(DM),f.politica.assinatura(OTHER));
  const {saidas}=proposta(f),before=f.politica.assinatura(DM),version=f.politica.regra(DM).versao;
  configurar(f.politica,{remoto:false});
  assert.notEqual(f.politica.assinatura(DM),before);assert.ok(f.politica.regra(DM).versao>version);
  assert.equal(f.db.prepare('SELECT estado FROM pessoal_propostas').get().estado,'cancelada');
  assert.equal(saidas.buscar('proposal').estado,'cancelada');
});

test('nova fonte invalida apenas proposta da própria conversa; replay não altera versão',t=>{
  const f=fixture(t);configurar(f.politica);configurar(f.politica,{conversaId:OTHER});
  const {saidas}=proposta(f);proposta(f,{id:'other-proposal',jid:OTHER});
  const before=f.politica.assinatura(DM);
  receber(f.contexto,{id:'new'});assert.notEqual(f.politica.assinatura(DM),before);
  assert.equal(f.db.prepare("SELECT estado FROM pessoal_propostas WHERE id='proposal'").get().estado,'cancelada');
  assert.equal(saidas.buscar('proposal').estado,'cancelada');
  assert.equal(f.db.prepare("SELECT estado FROM pessoal_propostas WHERE id='other-proposal'").get().estado,'aprovada');
  const after=f.politica.assinatura(DM);receber(f.contexto,{id:'new'});assert.equal(f.politica.assinatura(DM),after);
});

test('mensagem humana por ContextoApp pausa, invalida e persiste após reabrir banco',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'lume-pessoal-policy-')),path=join(dir,'test.sqlite');
  let db=abrirBanco(path);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  let contexto=new ContextoApp(db),politica=new PoliticaPessoal(db);configurar(politica);
  const {saidas}=proposta({db,contexto,politica});receber(contexto,{id:'manual',fromMe:true});
  assert.equal(politica.regra(DM).pausada,true);assert.equal(saidas.buscar('proposal').estado,'cancelada');
  db.close();db=abrirBanco(path);contexto=new ContextoApp(db);politica=new PoliticaPessoal(db);
  assert.equal(politica.podeEnviar(DM).permitido,false);
  configurar(politica,{categoria:'vip_client'});assert.equal(politica.regra(DM).pausada,true);
  assert.equal(politica.podeEnviar(DM).permitido,false);
  assert.throws(()=>politica.retomar(DM,''));politica.retomar(DM,'local:owner');
  assert.equal(politica.podeEnviar(DM).permitido,true);
  assert.equal(db.prepare("SELECT estado FROM pessoal_propostas WHERE id='proposal'").get().estado,'cancelada');
});

test('histórico humano não pausa nem cria atendimento atrasado; notify novo cria etapa',t=>{
  const f=fixture(t);configurar(f.politica);f.db.prepare("INSERT INTO desktop_config VALUES('pessoal-enabled','1')").run();
  receber(f.contexto,{id:'history-owner',fromMe:true,type:'history'});
  receber(f.contexto,{id:'history-incoming',type:'history'});
  assert.equal(f.politica.regra(DM).pausada,false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='assistencia'").get().n,0);
  receber(f.contexto,{id:'new-incoming'});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM etapas WHERE etapa='assistencia'").get().n,1);
});

test('edição ou revogação da fonte invalida aprovação e saída pendente',t=>{
  for(const alteracao of ["texto='Fonte corrigida'","permissao=NULL"]){
    const f=fixture(t);configurar(f.politica);const {evento,saidas}=proposta(f);
    const before=f.politica.assinatura(DM);
    f.db.prepare(`UPDATE eventos SET ${alteracao} WHERE id=?`).run(evento);
    assert.notEqual(f.politica.assinatura(DM),before);
    assert.equal(f.db.prepare('SELECT estado FROM pessoal_propostas').get().estado,'cancelada');
    assert.equal(saidas.buscar('proposal').estado,'cancelada','fonte alterada não pode deixar saída pronta para envio');
  }
});

test('eco conhecido durante despacho não pausa a conversa como intervenção humana',async t=>{
  const f=fixture(t);configurar(f.politica);const {saidas}=proposta(f);
  await saidas.enviar('proposal',async()=>{
    receber(f.contexto,{id:'wa-proposal',fromMe:true});
    assert.equal(f.politica.regra(DM).pausada,false,'eco antes do ACK deve manter controle');
    return 'wa-proposal';
  },new Date(),{externoId:'wa-proposal'});
  assert.equal(f.politica.regra(DM).pausada,false);
});

test('ID de saída de outra conversa não esconde mensagem humana',async t=>{
  const f=fixture(t);configurar(f.politica);configurar(f.politica,{conversaId:OTHER});
  const {saidas}=proposta(f);await saidas.enviar('proposal',async()=> 'wa-proposal');
  receber(f.contexto,{jid:OTHER,id:'wa-proposal',fromMe:true});
  assert.equal(f.politica.regra(OTHER).pausada,true,'identificação de eco precisa incluir destinatário');
});

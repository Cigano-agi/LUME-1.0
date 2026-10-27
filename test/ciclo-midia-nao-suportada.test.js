import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {MidiaArquivos,processarUmaMidiaCiclo} from '../src/ciclo-midia-worker.js';
import {fontesProntasDoCiclo,coberturaMidiaCiclo,reclamarEtapaCiclo,bloquearMidiaSemSuporteCiclo,reconciliarCicloFontes} from '../src/ciclo-captura.js';
import {chaveExclusao} from '../src/exclusoes.js';

const agora=new Date('2026-09-29T12:00:00Z');
const conversa='caso-sintetico@s.whatsapp.net';
const mensagem=(id,campo='videoMessage')=>({key:{remoteJid:conversa,id},
  message:{[campo]:{mimetype:campo==='audioMessage'?'audio/ogg':'video/mp4',caption:'Demanda sintética',fileName:'video.mp4'}},
  messageTimestamp:1788794100});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'lume-sem-suporte-'));
  const db=abrirBanco(join(dir,'dados.sqlite')),app=new ContextoApp(db);
  const arquivos=new MidiaArquivos(db,new ArquivosDados(dir));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {db,app,arquivos,dir};
}

for(const campo of ['videoMessage','stickerMessage']){
  test(`${campo}: sai da pendência com lacuna explícita e sem download ou interpretação`,async t=>{
    const {db,app,arquivos}=fixture(t);
    app.receber({messages:[mensagem('anexo',campo)]});
    let downloads=0;
    const resultado=await processarUmaMidiaCiclo(db,{arquivos,agora,baixar:async()=>{downloads++;throw Error('não baixar');}});
    assert.equal(resultado?.estado,'desistida');
    assert.equal(resultado?.motivo,'tipo_nao_suportado');
    assert.equal(downloads,0);
    const etapa=db.prepare("SELECT * FROM etapas WHERE etapa='midia'").get();
    assert.equal(etapa.ultimo_erro,'midia_bloqueada:tipo_nao_suportado');
    assert.equal(etapa.proxima_tentativa_em,null);
    assert.equal(etapa.lease_token,null);
    assert.equal(etapa.tentativas,1);
    assert.equal(etapa.resultado,null);
    const dependentes=db.prepare("SELECT estado,ultimo_erro,resultado FROM etapas WHERE etapa NOT IN ('captura','midia')").all();
    assert.equal(dependentes.length,3);
    for(const d of dependentes){assert.equal(d.estado,'desistida');assert.equal(d.ultimo_erro,'dependencia_bloqueada:midia_tipo_nao_suportado');assert.equal(d.resultado,null);}
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n,0);
    assert.deepEqual(fontesProntasDoCiclo(db,'interpretacao',{agora}),[]);
    const cobertura=coberturaMidiaCiclo(db,{conversaId:conversa});
    assert.equal(cobertura.bloqueadas,1);
    assert.equal(cobertura.pendentes,0);
    assert.equal(cobertura.baixadas,0);
  });
}

test('duplicata e reabertura do banco preservam motivo sem nova tentativa',async t=>{
  const {db,app,arquivos,dir}=fixture(t);
  const evento=mensagem('repetido');
  app.receber({messages:[evento]});
  await processarUmaMidiaCiclo(db,{arquivos,agora});
  app.receber({messages:[evento]});
  reconciliarCicloFontes(db);
  const segunda=abrirBanco(join(dir,'dados.sqlite'));
  try{
    assert.equal(await processarUmaMidiaCiclo(segunda,{arquivos:new MidiaArquivos(segunda,new ArquivosDados(dir)),agora}),null);
    const etapa=segunda.prepare("SELECT estado,tentativas,ultimo_erro FROM etapas WHERE etapa='midia'").get();
    assert.equal(etapa.estado,'desistida');assert.equal(etapa.tentativas,1);
    assert.equal(etapa.ultimo_erro,'midia_bloqueada:tipo_nao_suportado');
    assert.equal(segunda.prepare('SELECT COUNT(*) n FROM eventos').get().n,1);
  }finally{segunda.close();}
});

test('vídeo anterior não impede áudio posterior, e áudio continua sendo salvo',async t=>{
  const {db,app,arquivos}=fixture(t);let downloads=0;
  app.receber({messages:[mensagem('pdf'),mensagem('voz','audioMessage')]});
  const baixar=async()=>{downloads++;return {mime:'audio/ogg',base64:Buffer.from('audio sintético').toString('base64')};};
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,agora,baixar}))?.motivo,'tipo_nao_suportado');
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,agora,baixar}))?.estado,'concluida');
  assert.equal(downloads,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ciclo_midias').get().n,1);
  assert.equal(coberturaMidiaCiclo(db,{conversaId:conversa}).baixadas,1);
  assert.equal(await processarUmaMidiaCiclo(db,{arquivos,agora,baixar}),null);
});

test('pausa e cancelamento não consomem tentativa nem mudam a pendência',async t=>{
  const {db,app,arquivos}=fixture(t);app.receber({messages:[mensagem('pausado')]});
  assert.equal(await processarUmaMidiaCiclo(db,{arquivos,agora,podeProcessar:()=>false}),null);
  assert.equal(await processarUmaMidiaCiclo(db,{arquivos,agora,signal:AbortSignal.abort()}),null);
  const etapa=db.prepare("SELECT estado,tentativas FROM etapas WHERE etapa='midia'").get();
  assert.equal(etapa.estado,'pendente');assert.equal(etapa.tentativas,0);
});

test('exclusão explícita impede processamento e não aparece como bloqueio de formato',async t=>{
  const {db,app,arquivos}=fixture(t);app.receber({messages:[mensagem('excluido')]});
  db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(conversa,'excluido'),agora.toISOString());
  assert.equal(await processarUmaMidiaCiclo(db,{arquivos,agora}),null);
  assert.equal(coberturaMidiaCiclo(db,{conversaId:conversa}).bloqueadas,0);
  assert.equal(db.prepare("SELECT tentativas FROM etapas WHERE etapa='midia'").get().tentativas,0);
});

test('posse em curso não é roubada; vídeo é tratado após expiração',async t=>{
  const {db,app,arquivos}=fixture(t);app.receber({messages:[mensagem('lease')]});
  const claim=reclamarEtapaCiclo(db,'midia',{agora,duracaoMs:1000});
  assert.equal(claim.estado,'em_curso');
  assert.equal(await processarUmaMidiaCiclo(db,{arquivos,agora}),null);
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,agora:new Date(agora.getTime()+2000)}))?.motivo,'tipo_nao_suportado');
  assert.equal(bloquearMidiaSemSuporteCiclo(db,claim,{agora:new Date(agora.getTime()+2000)}).estado,'posse_perdida');
});

for(const modo of ['alterada','excluida'])test(`fonte ${modo} depois do claim é revalidada antes da transição`,t=>{
  const {db,app}=fixture(t);app.receber({messages:[mensagem('revalidar')]});
  const claim=reclamarEtapaCiclo(db,'midia',{agora});
  if(modo==='alterada')db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('revisão',claim.eventoId);
  else db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(conversa,'revalidar'),agora.toISOString());
  assert.equal(bloquearMidiaSemSuporteCiclo(db,claim,{agora}).estado,modo==='alterada'?'fonte_alterada':'fonte_revogada');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM etapas WHERE ultimo_erro LIKE 'dependencia_bloqueada:%'").get().n,0);
});

test('falha entre mídia e dependentes reverte tudo; nova tentativa confirma junto',t=>{
  const {db,app}=fixture(t);app.receber({messages:[mensagem('rollback')]});
  const claim=reclamarEtapaCiclo(db,'midia',{agora});
  db.exec("CREATE TRIGGER falha_pdf BEFORE UPDATE ON etapas WHEN NEW.etapa='interpretacao' BEGIN SELECT RAISE(ABORT,'falha sintética'); END");
  assert.throws(()=>bloquearMidiaSemSuporteCiclo(db,claim,{agora}),/falha sintética/);
  assert.equal(db.prepare("SELECT estado FROM etapas WHERE etapa='midia'").get().estado,'em_curso');
  assert.equal(db.prepare("SELECT estado FROM etapas WHERE etapa='interpretacao'").get().estado,'pendente');
  db.exec('DROP TRIGGER falha_pdf');
  assert.equal(bloquearMidiaSemSuporteCiclo(db,claim,{agora}).estado,'desistida');
});

test('dependente com posse impede transição; conclusão anterior não é sobrescrita',t=>{
  const {db,app}=fixture(t);app.receber({messages:[mensagem('conflito')]});
  const claim=reclamarEtapaCiclo(db,'midia',{agora});
  db.prepare("UPDATE etapas SET estado='em_curso',lease_token='outro' WHERE etapa='interpretacao'").run();
  assert.throws(()=>bloquearMidiaSemSuporteCiclo(db,claim,{agora}),/processamento em curso/);
  assert.equal(db.prepare("SELECT estado FROM etapas WHERE etapa='midia'").get().estado,'em_curso');
  db.prepare("UPDATE etapas SET estado='concluida',resultado='recibo anterior' WHERE etapa='interpretacao'").run();
  assert.equal(bloquearMidiaSemSuporteCiclo(db,claim,{agora}).estado,'desistida');
  assert.equal(db.prepare("SELECT resultado FROM etapas WHERE etapa='interpretacao'").get().resultado,'recibo anterior');
});

test('captura local de grupo continua disponível sem ampliar política de leitura',async t=>{
  const {db,app,arquivos}=fixture(t);const evento=mensagem('grupo');
  evento.key.remoteJid='grupo-sintetico@g.us';evento.key.participant='terceiro@s.whatsapp.net';
  evento.message.videoMessage={};app.receber({messages:[evento]});
  assert.equal(db.prepare('SELECT permissao FROM eventos').get().permissao,'terceiro');
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,agora})).motivo,'tipo_nao_suportado');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM politicas_conversa').get().n,0);
  assert.equal(coberturaMidiaCiclo(db,{conversaId:evento.key.remoteJid}).recebidas,0);
});

test('cursor ultrapassa 500 excluídos e alcança vídeo seguido de áudio',async t=>{
  const {db,app,arquivos}=fixture(t);
  for(let n=0;n<501;n++){
    app.receber({messages:[mensagem('excluir-'+n)]});
    db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(conversa,'excluir-'+n),agora.toISOString());
  }
  app.receber({messages:[mensagem('pdf-final'),mensagem('voz-final','audioMessage')]});
  const scan=await processarUmaMidiaCiclo(db,{arquivos,agora});assert.equal(scan.estado,'continuar');
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,agora,cursor:scan.cursor})).motivo,'tipo_nao_suportado');
  assert.equal((await processarUmaMidiaCiclo(db,{arquivos,agora,cursor:scan.cursor,
    baixar:async()=>({mime:'audio/ogg',base64:Buffer.from('amostra').toString('base64')})})).estado,'concluida');
});

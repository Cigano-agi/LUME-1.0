import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {reclamarEtapaCiclo,falharMidiaCiclo,coberturaMidiaCiclo} from '../src/ciclo-captura.js';
import {chaveExclusao} from '../src/exclusoes.js';

const now=new Date('2026-09-28T12:00:00.000Z');

test('mídia expirada não entra em retry infinito e permanece lacuna visível',()=>{
  const db=abrirBanco();
  try{
    new ContextoApp(db).receber({messages:[{key:{remoteJid:'grupo@g.us',id:'voz',participant:'pessoa@s.whatsapp.net'},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
    assert.deepEqual(coberturaMidiaCiclo(db),{recebidas:1,baixadas:0,pendentes:1,emCurso:0,falhas:0,indisponiveis:0,esgotadas:0,bloqueadas:0,excluidas:0,desconhecidas:0});
    const claim=reclamarEtapaCiclo(db,'midia',{agora:now});
    assert.equal(falharMidiaCiclo(db,claim,{agora:now,motivo:'midia_expirada'}),true);
    assert.equal(reclamarEtapaCiclo(db,'midia',{agora:new Date('2026-09-29T12:00:00Z')}),null);
    assert.deepEqual(coberturaMidiaCiclo(db),{recebidas:1,baixadas:0,pendentes:0,emCurso:0,falhas:0,indisponiveis:1,esgotadas:0,bloqueadas:0,excluidas:0,desconhecidas:0});
  }finally{db.close();}
});

test('falha temporária permite até três tentativas, com espera crescente e lacuna final',()=>{
  const db=abrirBanco();
  try{
    new ContextoApp(db).receber({messages:[{key:{remoteJid:'novo@s.whatsapp.net',id:'voz'},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
    for(let n=1;n<=3;n++){
      const instante=new Date(now.getTime()+n*3600000);
      const claim=reclamarEtapaCiclo(db,'midia',{agora:instante});
      assert.equal(claim.tentativas,n);
      assert.equal(falharMidiaCiclo(db,{...claim,tentativas:1},{agora:instante,motivo:'rede'}),true);
      const row=db.prepare("SELECT estado,ultimo_erro,proxima_tentativa_em FROM etapas WHERE etapa='midia'").get();
      assert.equal(row.estado,n===3?'desistida':'falha');
      assert.equal(row.ultimo_erro,n===3?'midia_tentativas_esgotadas:rede':'rede');
      if(n<3){
        assert.equal(row.proxima_tentativa_em,new Date(instante.getTime()+n*60000).toISOString());
        assert.equal(reclamarEtapaCiclo(db,'midia',{agora:new Date(instante.getTime()+1000)}),null);
      }else assert.equal(row.proxima_tentativa_em,null);
    }
    assert.equal(coberturaMidiaCiclo(db).esgotadas,1);
  }finally{db.close();}
});

test('etapa concluída sem arquivo comprovado permanece desconhecida na cobertura',()=>{
  const db=abrirBanco();
  try{
    new ContextoApp(db).receber({messages:[{key:{remoteJid:'grupo@g.us',id:'sem-arquivo'},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
    db.prepare("UPDATE etapas SET estado='concluida' WHERE etapa='midia'").run();
    assert.deepEqual(coberturaMidiaCiclo(db),{recebidas:1,baixadas:0,pendentes:0,emCurso:0,falhas:0,indisponiveis:0,esgotadas:0,bloqueadas:0,excluidas:0,desconhecidas:1});
  }finally{db.close();}
});

test('três quedas de worker vencem o lease e pausam só a mídia com motivo próprio',()=>{
  const db=abrirBanco();
  try{
    new ContextoApp(db).receber({messages:[{key:{remoteJid:'novo@s.whatsapp.net',id:'voz-crash'},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
    for(let n=1;n<=3;n++){
      const claim=reclamarEtapaCiclo(db,'midia',{agora:new Date(now.getTime()+n*2000),duracaoMs:1000});
      assert.equal(claim.tentativas,n);
    }
    assert.equal(reclamarEtapaCiclo(db,'midia',{agora:new Date(now.getTime()+8000),duracaoMs:1000}),null);
    assert.deepEqual({...db.prepare("SELECT estado,ultimo_erro FROM etapas WHERE etapa='midia'").get()},
      {estado:'desistida',ultimo_erro:'midia_tentativas_esgotadas:lease_expirada'});
    assert.equal(coberturaMidiaCiclo(db).esgotadas,1);
  }finally{db.close();}
});

test('fonte excluída não aparece como pendência acionável de mídia',()=>{
  const db=abrirBanco();
  try{
    new ContextoApp(db).receber({messages:[{key:{remoteJid:'novo@s.whatsapp.net',id:'voz-excluida'},
      message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100}]});
    const event=db.prepare("SELECT conversa_id,origem_id FROM eventos WHERE tipo='audio'").get();
    db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(event.conversa_id,event.origem_id),now.toISOString());
    assert.equal(reclamarEtapaCiclo(db,'midia',{agora:now}),null);
    const coverage=coberturaMidiaCiclo(db);
    assert.equal(coverage.pendentes,0);
    assert.equal(coverage.excluidas,1);
    const scoped=coberturaMidiaCiclo(db,{conversaId:event.conversa_id});
    assert.equal(scoped.recebidas,0);
    assert.equal(scoped.excluidas,0);
  }finally{db.close();}
});

test('cobertura de mídia separa conversas sem inferir cobertura histórica',()=>{
  const db=abrirBanco();
  try{
    const app=new ContextoApp(db);
    app.receber({messages:[
      {key:{remoteJid:'um@s.whatsapp.net',id:'voz-um'},message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100},
      {key:{remoteJid:'dois@s.whatsapp.net',id:'voz-dois'},message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794101},
    ]});
    assert.equal(coberturaMidiaCiclo(db,{conversaId:'um@s.whatsapp.net'}).recebidas,1);
    assert.equal(coberturaMidiaCiclo(db,{conversaId:'dois@s.whatsapp.net'}).recebidas,1);
    assert.equal(coberturaMidiaCiclo(db,{conversaId:'vazia@s.whatsapp.net'}).recebidas,0);
    assert.throws(()=>coberturaMidiaCiclo(db,{conversaId:''}),TypeError);
  }finally{db.close();}
});

test('cobertura não conta mídia sem permissão individual de leitura',()=>{
  const db=abrirBanco();
  try{
    new ContextoApp(db).receber({messages:[
      {key:{remoteJid:'mista@s.whatsapp.net',id:'texto'},message:{conversation:'legível'},messageTimestamp:1788794100},
      {key:{remoteJid:'mista@s.whatsapp.net',id:'audio'},message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794101},
    ]});
    db.prepare("UPDATE eventos SET permissao='compartilhado' WHERE tipo='audio'").run();
    const result=coberturaMidiaCiclo(db,{conversaId:'mista@s.whatsapp.net'});
    assert.equal(result.recebidas,0);
    assert.equal(result.excluidas,0);
  }finally{db.close();}
});

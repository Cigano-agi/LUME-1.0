import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {reclamarEtapaCiclo,concluirEtapaCiclo,falharEtapaCiclo} from '../src/ciclo-captura.js';
import {chaveExclusao,chaveConversa} from '../src/exclusoes.js';
import {Fila} from '../src/etapas.js';

const at=s=>new Date(s);
function withDb(fn){
  const dir=mkdtempSync(join(tmpdir(),'lume-lease-'));
  const db1=abrirBanco(join(dir,'dados.sqlite'));
  const db2=abrirBanco(join(dir,'dados.sqlite'));
  try{
    const app=new ContextoApp(db1);
    app.receber({messages:[{key:{remoteJid:'novo@s.whatsapp.net',id:'a'},message:{conversation:'Combinado'},messageTimestamp:1788794100}]});
    return fn(db1,db2);
  }finally{db2.close();db1.close();rmSync(dir,{recursive:true,force:true});}
}

test('dois handles disputam um único claim; lease vencido troca token e impede recibo antigo',()=>withDb((a,b)=>{
  const first=reclamarEtapaCiclo(a,'interpretacao',{agora:at('2026-09-28T10:00:00Z'),duracaoMs:1000});
  assert.equal(first.tentativas,1);
  assert.equal(reclamarEtapaCiclo(b,'interpretacao',{agora:at('2026-09-28T10:00:00Z')}),null);
  const second=reclamarEtapaCiclo(b,'interpretacao',{agora:at('2026-09-28T10:00:02Z')});
  assert.notEqual(second.token,first.token);
  assert.equal(second.tentativas,2);
  assert.equal(concluirEtapaCiclo(a,first,{agora:at('2026-09-28T10:00:02Z')}).estado,'posse_perdida');
  const done=concluirEtapaCiclo(b,second,{agora:at('2026-09-28T10:00:03Z'),resultado:{ok:true}});
  assert.equal(done.estado,'concluida');
  assert.equal(concluirEtapaCiclo(a,second,{agora:at('2026-09-28T10:00:03Z')}).estado,'posse_perdida');
  assert.equal(JSON.parse(a.prepare("SELECT resultado FROM etapas WHERE etapa='interpretacao'").get().resultado).resultado.ok,true);
}));

test('fonte alterada ou revogada impede efeito; falha respeita prazo de retry',()=>withDb((a,b)=>{
  const c=reclamarEtapaCiclo(a,'interpretacao',{agora:at('2026-09-28T10:00:00Z')});
  a.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Corrigido',c.eventoId);
  let effects=0;
  assert.equal(concluirEtapaCiclo(b,c,{agora:at('2026-09-28T10:00:01Z'),apply:()=>effects++}).estado,'fonte_alterada');
  assert.equal(effects,0);
  const next=reclamarEtapaCiclo(b,'interpretacao',{agora:at('2026-09-28T10:00:02Z')});
  assert.equal(falharEtapaCiclo(a,next,{agora:at('2026-09-28T10:00:03Z'),motivo:'rede',esperaMs:60000}),true);
  assert.equal(reclamarEtapaCiclo(b,'interpretacao',{agora:at('2026-09-28T10:00:04Z')}),null);
  const retry=reclamarEtapaCiclo(b,'interpretacao',{agora:at('2026-09-28T10:01:04Z')});
  a.prepare('INSERT INTO priv_excluidos(hash,excluido_em) VALUES(?,?)').run(chaveExclusao('novo@s.whatsapp.net','a'),'2026-09-28T10:01:04Z');
  assert.equal(concluirEtapaCiclo(b,retry,{agora:at('2026-09-28T10:01:05Z'),apply:()=>effects++}).estado,'fonte_revogada');
  assert.equal(effects,0);
}));

test('efeito e recibo usam a mesma transação',()=>withDb((a)=>{
  const c=reclamarEtapaCiclo(a,'interpretacao',{agora:at('2026-09-28T10:00:00Z')});
  assert.throws(()=>concluirEtapaCiclo(a,c,{agora:at('2026-09-28T10:00:01Z'),apply:db=>{
    db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Mutado',c.eventoId);
    throw Error('falha antes do recibo');
  }}),/falha antes do recibo/);
  assert.equal(a.prepare('SELECT texto FROM eventos WHERE id=?').get(c.eventoId).texto,'Combinado');
  assert.equal(a.prepare("SELECT estado FROM etapas WHERE etapa='interpretacao'").get().estado,'em_curso');
}));

test('API antiga não sobrescreve etapa possuída pelo novo claim',()=>withDb((a)=>{
  const claim=reclamarEtapaCiclo(a,'interpretacao',{agora:at('2026-09-28T10:00:00Z')});
  const antiga=new Fila(a);
  assert.throws(()=>antiga.concluir(claim.eventoId,'interpretacao',{texto:'indevido'}),/sob lease/);
  assert.throws(()=>antiga.falhar(claim.eventoId,'interpretacao','indevido'),/sob lease/);
  assert.equal(a.prepare("SELECT estado FROM etapas WHERE etapa='interpretacao'").get().estado,'em_curso');
}));

test('claim alcança fonte válida depois de 500 fontes excluídas',()=>withDb((a)=>{
  a.prepare("UPDATE etapas SET estado='desistida' WHERE etapa='interpretacao'").run();
  const insert=a.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
    VALUES(?,?, 'entrada','texto','{}','Texto','2026-09-28T10:00:00.000Z','2026-09-28')`);
  const insertStage=a.prepare(`INSERT INTO etapas(evento_id,etapa,estado,atualizado_em)
    VALUES(?,'captura','concluida','2026-09-28T10:00:00.000Z'),
          (?,'interpretacao','pendente','2026-09-28T10:00:00.000Z')`);
  a.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<501;i++){
      const conversa=`excluida${i}@s.whatsapp.net`,origem=`x${i}`;
      const id=insert.run(conversa,origem).lastInsertRowid;
      insertStage.run(id,id);
      a.prepare('INSERT INTO priv_conversas_excluidas(hash,excluido_em) VALUES(?,?)')
        .run(chaveConversa(conversa),'2026-09-28T10:00:00.000Z');
    }
    const id=insert.run('final@s.whatsapp.net','final').lastInsertRowid;
    insertStage.run(id,id);
    a.exec('COMMIT');
  }catch(error){a.exec('ROLLBACK');throw error;}
  const scan=reclamarEtapaCiclo(a,'interpretacao',{agora:at('2026-09-28T10:00:01Z')});
  assert.equal(scan.estado,'continuar');
  const claim=reclamarEtapaCiclo(a,'interpretacao',{agora:at('2026-09-28T10:00:01Z'),cursor:scan.cursor});
  assert.equal(a.prepare('SELECT origem_id FROM eventos WHERE id=?').get(claim.eventoId).origem_id,'final');
}));

test('fila terminal usa consulta indexada sem join nem transação em todas as etapas',()=>withDb((a)=>{
  a.exec(`WITH RECURSIVE numeros(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numeros WHERE n<1000)
    INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local)
    SELECT 'fixture-terminal',CAST(n AS TEXT),'entrada','audio','{}','Fixture','2026-09-28T10:00:00.000Z','2026-09-28' FROM numeros;
    INSERT OR IGNORE INTO etapas(evento_id,etapa,estado,atualizado_em)
    SELECT e.id,s.etapa,CASE WHEN e.id%2=0 THEN 'concluida' ELSE 'desistida' END,'2026-09-28T10:00:00.000Z'
    FROM eventos e CROSS JOIN (SELECT 'midia' etapa UNION ALL SELECT 'transcricao' UNION ALL SELECT 'interpretacao'
      UNION ALL SELECT 'indexacao' UNION ALL SELECT 'projecao') s;
    UPDATE etapas SET estado='concluida' WHERE estado NOT IN ('concluida','desistida')`);
  const consultas=[],transacoes=[];
  const observado={prepare(sql){consultas.push(sql);return a.prepare(sql);},exec(sql){transacoes.push(sql);return a.exec(sql);}};
  for(const etapa of ['midia','transcricao','interpretacao','indexacao','projecao']){
    assert.equal(reclamarEtapaCiclo(observado,etapa,{agora:at('2026-09-28T10:00:00Z')}),null);
  }
  assert.equal(consultas.some(sql=>/JOIN\s+eventos/i.test(sql)),false,'Fila terminal não deve preparar a varredura com join.');
  assert.deepEqual(transacoes,[],'Fila terminal não precisa adquirir lock de escrita.');
  assert.equal(consultas.length,5);
  for(const sql of consultas){
    const plano=a.prepare('EXPLAIN QUERY PLAN '+sql).all('midia').map(row=>row.detail).join('\n');
    assert.match(plano,/SEARCH etapas USING (?:COVERING )?INDEX idx_etapas_fila/);
    assert.doesNotMatch(plano,/SCAN/);
  }
}));

test('trabalho concorrente após consulta vazia é recuperado na chamada seguinte',()=>withDb((a,b)=>{
  a.exec("UPDATE etapas SET estado='concluida'");
  let inserido=false;
  const observado={
    prepare(sql){
      const consulta=a.prepare(sql);
      if(/SELECT 1 FROM etapas/.test(sql)&&/pendente/.test(sql))return {
        get(...args){
          const resultado=consulta.get(...args);
          if(!inserido){b.exec("UPDATE etapas SET estado='pendente',proxima_tentativa_em=NULL WHERE etapa='interpretacao'");inserido=true;}
          return resultado;
        }
      };
      return consulta;
    },
    exec(sql){return a.exec(sql);}
  };
  assert.equal(reclamarEtapaCiclo(observado,'interpretacao',{agora:at('2026-09-28T10:00:00Z')}),null);
  assert.equal(inserido,true);
  const claim=reclamarEtapaCiclo(a,'interpretacao',{agora:at('2026-09-28T10:00:01Z')});
  assert.equal(claim.estado,'em_curso');assert.equal(claim.tentativas,1);
}));

test('consulta rápida não pula validação de etapa, lease, cursor, tipo ou instante',()=>{
  const semConsulta={prepare(){assert.fail('Argumentos inválidos não devem consultar o banco.');},exec(){assert.fail('Argumentos inválidos não devem abrir transação.');}};
  for(const [etapa,opcoes] of [['envio',{}],['midia',{duracaoMs:0}],['midia',{cursor:-1}],
    ['interpretacao',{tipo:'audio'}],['midia',{agora:new Date(NaN)}]]){
    assert.throws(()=>reclamarEtapaCiclo(semConsulta,etapa,opcoes),TypeError);
  }
});

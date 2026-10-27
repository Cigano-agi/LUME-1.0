// Only synthetic payloads in a fresh temporary database; no profiles or transport.
// Run before/after with the same parameters. Logs contain counts/timing, never payloads.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {recuperarNomesWhatsapp} from '../src/nomes-conversa.js';

const args=process.argv.slice(2),opcao=(nome,padrao)=>Number(args.find(x=>x.startsWith(nome+'='))?.split('=')[1]??padrao);
const total=opcao('--linhas',1000),padding=opcao('--bytes',64*1024),repeticoes=opcao('--repeticoes',3);
assert.ok(Number.isSafeInteger(total)&&total>=1000&&total<=10000);
assert.ok(Number.isSafeInteger(padding)&&padding>=0&&padding<=1024*1024);
assert.ok(Number.isSafeInteger(repeticoes)&&repeticoes>=1&&repeticoes<=10);
const pasta=mkdtempSync(join(tmpdir(),'lume-nomes-desempenho-'));
let db;
try {
  db=abrirBanco(join(pasta,'sintetico.sqlite'));new ContextoApp(db);
  const inserir=db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local)
    VALUES(?,?,'entrada','texto',?,'2026-10-26T12:00:00Z','2026-10-26')`);
  db.exec('BEGIN');
  for(let i=0;i<total;i++){
    const pessoa=i%100,remoteJid=String(100000000+pessoa)+'@lid',remoteJidAlt=String(5511000000000+pessoa)+'@s.whatsapp.net';
    inserir.run(remoteJid,'perf-'+i,JSON.stringify({mensagem:{key:{id:'perf-'+i,remoteJid,remoteJidAlt},
      pushName:'Fixture Pessoa '+pessoa,message:{conversation:'x'.repeat(padding)}}}));
  }
  db.exec('COMMIT');
  const fixture=db.prepare('SELECT count(*) linhas,sum(length(CAST(bruto AS BLOB))) bytes FROM eventos').get();
  let preparacoes=0,savepoints=0;
  const preparar=db.prepare.bind(db),executar=db.exec.bind(db);
  db.prepare=sql=>{preparacoes++;return preparar(sql);};
  db.exec=sql=>{savepoints+=(sql.match(/\bSAVEPOINT\b/g)??[]).length;return executar(sql);};
  const resultados=[];
  for(const limite of [20,200,1000])for(let repeticao=1;repeticao<=repeticoes;repeticao++){
    executar('BEGIN; DELETE FROM pessoa_identificadores; DELETE FROM pessoas; DELETE FROM conversas_app; COMMIT');
    const changes=preparar('SELECT total_changes() n').get().n;preparacoes=0;savepoints=0;
    const inicio=performance.now();let aposId=0,chamadas=0,examinados=0,primeiroMs,maxMs=0,concluido=false;
    while(!concluido){
      const tick=performance.now();
      const r=recuperarNomesWhatsapp(db,{aposId,limite,...(args.includes('--sem-orcamento')?{maxBytes:128*1024*1024,maxMs:60000}:{})});
      const ms=performance.now()-tick;primeiroMs??=ms;maxMs=Math.max(maxMs,ms);chamadas++;
      assert.ok(r.ultimoId>=aposId);assert.ok(r.examinados>0||r.concluido);
      aposId=r.ultimoId;examinados+=r.examinados;concluido=r.concluido;
      // Give other tasks a turn between bounded synchronous calls, like the service.
      await new Promise(resolve=>setImmediate(resolve));
    }
    const tempoMs=performance.now()-inicio;
    assert.equal(examinados,total);assert.equal(aposId,total);
    assert.equal(preparar('SELECT count(*) n FROM pessoas').get().n,100);
    assert.equal(preparar('SELECT count(*) n FROM pessoa_identificadores').get().n,200);
    resultados.push({limite,repeticao,primeiroMs:+primeiroMs.toFixed(3),maxMs:+maxMs.toFixed(3),tempoMs:+tempoMs.toFixed(3),
      chamadas,examinados,bytes:fixture.bytes,preparacoes,savepoints,gravacoes:preparar('SELECT total_changes() n').get().n-changes});
  }
  console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,
    sourceSha256:createHash('sha256').update(readFileSync(new URL('../src/nomes-conversa.js',import.meta.url))).digest('hex'),
    fixture,orcamento:args.includes('--sem-orcamento')?'128MiB/60s para comparação de lote':'padrão',resultados},null,2));
}finally{db?.close();rmSync(pasta,{recursive:true,force:true});}

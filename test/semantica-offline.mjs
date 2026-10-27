// Real E5 regression: requires an existing cache, never downloads model files.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Semantica, MODELO_SEMANTICO, REVISAO_SEMANTICA } from '../src/semantica.js';

let requests=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>{requests.push(String(url));throw Error('Offline regression: network blocked');};
const emptyCache=mkdtempSync(join(tmpdir(),'lume-offline-'));
const db=abrirBanco();new ContextoApp(db);
const cached=new Semantica(db,{cacheDir:resolve(process.argv[2]||'work/modelos-e5')});
const absent=new Semantica(db,{cacheDir:emptyCache});
try {
  // Empty cache must fail without even attempting a request or activating search.
  await assert.rejects(absent.ativar({baixar:false}));
  assert.equal(requests.length,0);
  assert.equal(absent.estado().ativa,false);
  assert.equal(absent.estado().etapa,'falha');

  await cached.ativar({baixar:false});
  const vector=await cached.vetor('Revisar o contrato até sexta-feira.');
  assert.equal(vector.length,384);
  assert.ok(vector.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...vector)-1)<1e-5);
  db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('offline','synthetic','entrada','texto','{}','Revisar o contrato até sexta-feira.','2026-09-18T12:00:00Z','2026-09-18','minha')").run();
  await cached.indexar();
  const result=await cached.buscar({pergunta:'Qual documento precisa ser revisado?',ate:'2026-09-18'},{remoto:false});
  assert.equal(result.length,1);
  assert.equal(result[0].origem_id,'synthetic');
  assert.equal(cached.estado().pendentes,0);
  assert.equal(requests.length,0);
  cached.pausar();

  // Explicit download may try model files only. The stub rejects before any I/O.
  await assert.rejects(absent.ativar({baixar:true}));
  assert.ok(requests.length>0);
  for(const request of requests){
    const url=new URL(request);
    assert.equal(url.origin,'https://huggingface.co');
    // 4.3.0's discovery probe uses main; weights/tokenizer loads use the pinned revision.
    assert.ok([REVISAO_SEMANTICA,'main'].some(revision=>url.pathname.startsWith(`/${MODELO_SEMANTICO}/resolve/${revision}/`)));
    assert.ok(['tokenizer.json','tokenizer_config.json'].includes(url.pathname.split('/').at(-1)));
    assert.equal(url.search,'');
  }
  assert.equal(absent.estado().ativa,false);
  console.log(JSON.stringify({passed:true,dimensions:vector.length,cachedNetworkAttempts:0,emptyCacheNetworkAttempts:0,explicitDownloadBlockedAttempts:requests.length,realNetworkRequests:0,indexed:1,retrieved:1,model:MODELO_SEMANTICO,revision:REVISAO_SEMANTICA},null,2));
} finally {
  cached.encerrar();absent.encerrar();
  await cached.pipeline?.dispose();
  db.close();globalThis.fetch=originalFetch;
  // Only the exact fresh directory returned by mkdtemp is removed.
  rmSync(emptyCache,{recursive:true,force:true});
}

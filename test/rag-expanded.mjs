// Local-only E5 benchmark. No owner profile, network download or provider request.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { Semantica, fundirRankings } from '../src/semantica.js';
import { recuperar, recorte } from '../src/recuperacao.js';

const bytes = readFileSync(new URL('./fixtures/rag-pt-v2.json', import.meta.url));
const data = JSON.parse(bytes);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const output = resolve(process.argv[2] || 'work/rag-qa/v2.json');
const events = new Map(data.events.map(e => [e.id, {...e, text: (e.padding ? e.padding[0].repeat(e.padding[1]) : '') + e.text}]));
const conversations = new Map(data.conversations.map(c => [c.id, c]));
assert.equal(events.size, data.events.length, 'Duplicate event');
assert.equal(new Set(data.queries.map(q => q.id)).size, data.queries.length, 'Duplicate query');

// Independent fixture oracle: deliberately does not reuse production ACL/date SQL.
function allowed(e, q) {
  const c = conversations.get(e.conversation);
  const permission = Object.hasOwn(e, 'permission') ? e.permission : 'minha';
  if (!c.ia || (!['minha', 'dirigida'].includes(permission) && c.policy !== 'tudo')) return false;
  if (q.conversation && q.conversation !== c.id) return false;
  if (q.project && q.project !== c.project) return false;
  const bounds = {hoje:['2026-09-18','2026-09-18'], ontem:['2026-09-17','2026-09-17'], semana:['2026-09-14','2026-09-18'], '30dias':['2026-08-20','2026-09-18'], tudo:['0000-01-01','2026-09-18']};
  const [from, to] = bounds[q.period || 'semana'];
  return e.date >= from && e.date <= to;
}
for (const e of events.values()) assert.ok(conversations.has(e.conversation));
for (const q of data.queries) {
  assert.ok(['calibracao', 'avaliacao'].includes(q.split));
  assert.equal(new Set(q.gold).size, q.gold.length);
  for (const id of q.gold) assert.ok(events.has(id) && allowed(events.get(id), q), `Invalid gold ${q.id}/${id}`);
  for (const [id, needle] of Object.entries(q.support || {})) {
    assert.ok(q.gold.includes(id) && needle.length > 0 && events.get(id).text.includes(needle), `Invalid support ${q.id}/${id}`);
  }
}
const sourceHashes = Object.fromEntries(['src/recuperacao.js','src/trechos-recuperacao.js','src/semantica.js','src/desktop-ia.js','src/leitura-sql.js','test/rag-expanded.mjs'].map(p => {
  const file=new URL('../'+p,import.meta.url);return [p,existsSync(file)?sha256(readFileSync(file)):null];
}));
mkdirSync(dirname(output), {recursive:true});
// Exclusive writes prevent accidentally replacing the historical baseline.
writeFileSync(output+'.manifest.json', JSON.stringify({datasetSHA256:sha256(bytes),sourceHashes,events:events.size,queries:data.queries.length},null,2), {flag:'wx'});
const db = abrirBanco();
new ContextoApp(db);
const desktop = new Desktop(db);
const ia = new DesktopIA(db, {agora:()=>new Date(data.now), gerar:async()=>{throw new Error('Provider forbidden in this benchmark');}});
db.prepare('UPDATE desktop_ia_config SET habilitada=1,limite_micros=20000000').run();
for (const c of data.conversations) {
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(c.id,c.id);
  db.prepare('INSERT INTO projetos VALUES(?,?,?,?,?)').run(c.project,'cliente',c.project,'/synthetic',data.date);
  ia.permitir({conversa:c.id,permitida:c.ia});
  if (c.policy) desktop.politica({conversa:c.id,politica:c.policy});
}
for (const e of events.values()) db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,projeto_id)
  VALUES(?,?,'entrada','texto','{}',?,?,?,?,?)`).run(e.conversation,e.id,e.text,e.date+'T12:00:00Z',e.date,Object.hasOwn(e,'permission')?e.permission:'minha',conversations.get(e.conversation).project);
const sem = new Semantica(db,{cacheDir:resolve(process.env.ASSESSOR_MODEL_CACHE || 'work/modelos-e5')});
const mean = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null;
const quantile = (xs,q) => [...xs].sort((a,b)=>a-b)[Math.min(xs.length-1, Math.floor(xs.length*q))] ?? null;
try {
  const started = performance.now();
  await sem.ativar();
  await sem.indexar({limite:events.size});
  assert.equal(sem.estado().pendentes,0);
  const setupMs = performance.now()-started, results=[];
  for (const q of data.queries) {
    const input = {pergunta:q.question,periodo:q.period || 'semana',conversa:q.conversation || '',projeto:q.project || ''};
    const filter = recorte(input,new Date(data.now));
    let start = performance.now();
    const lexical = recuperar(db,filter,{limite:20}), lexicalMs=performance.now()-start;
    start=performance.now();
    const dense = await sem.buscar(filter), denseMs=performance.now()-start;
    start=performance.now();
    const hybrid = fundirRankings(lexical,dense,12), fusionMs=performance.now()-start;
    const measure = (rows,ms) => {
      const top=rows.slice(0,5), ids=top.map(e=>e.origem_id), hits=ids.filter(id=>q.gold.includes(id));
      const preview = ia.preparar({...input,contextoProximo:false},top);
      const snippets = preview.fontes.map(f=>({id:f.origem_id,text:f.texto,truncated:f.truncada}));
      const supports=Object.entries(q.support || {});
      const covered = supports.filter(([id,needle])=>snippets.some(s=>s.id===id && s.text.includes(needle))).map(([id])=>id);
      const first=ids.findIndex(id=>q.gold.includes(id));
      // Check ALL candidates, not only measured top five.
      const leaks=rows.filter(r=>!events.has(r.origem_id) || !allowed(events.get(r.origem_id),q)).map(r=>r.origem_id);
      for (const s of snippets) assert.ok(events.get(s.id).text.includes(s.text), 'Snippet is not literal');
      return {ids,recallAt5:q.gold.length?hits.length/q.gold.length:null,precisionAt5:hits.length/5,
        precisionAmongReturned:ids.length?hits.length/ids.length:null,reciprocalRank:first<0?0:1/(first+1),
        evidenceCoverageAt5:supports.length?covered.length/supports.length:null,covered,leaks,ms,snippets};
    };
    results.push({...q,lexical:measure(lexical,lexicalMs),dense:{...measure(dense,denseMs),topScore:dense[0]?.score??null},hybrid:measure(hybrid,lexicalMs+denseMs+fusionMs)});
  }
  const summary = {};
  for (const split of ['calibracao','avaliacao']) {
    const subset=results.filter(r=>r.split===split), positives=subset.filter(r=>r.gold.length), negatives=subset.filter(r=>!r.gold.length);
    summary[split]={positiveQueries:positives.length,negativeQueries:negatives.length};
    for (const mode of ['lexical','dense','hybrid']) summary[split][mode]={
      recallAt5:mean(positives.map(r=>r[mode].recallAt5)),precisionAt5:mean(positives.map(r=>r[mode].precisionAt5)),
      precisionAmongReturned:mean(positives.map(r=>r[mode].precisionAmongReturned ?? 0)),mrrAt5:mean(positives.map(r=>r[mode].reciprocalRank)),
      evidenceCoverageAt5:mean(positives.filter(r=>r[mode].evidenceCoverageAt5!==null).map(r=>r[mode].evidenceCoverageAt5)),
      negativeCandidateRate:mean(negatives.map(r=>Number(r[mode].ids.length>0))),
      p50ms:quantile(subset.map(r=>r[mode].ms),.5),p95ms:quantile(subset.map(r=>r[mode].ms),.95),leaks:subset.flatMap(r=>r[mode].leaks).length
    };
  }
  const evidence={date:new Date().toISOString(),dataset:data.version,datasetSHA256:sha256(bytes),sourceHashes,events:events.size,queries:results.length,provenance:data.provenance,model:sem.estado(),setupMs,summary,results,
    limits:'Synthetic developer labels, not independent human validation. Metrics at top 5, production preview formatter; actual app may send up to 12/20. No generated-answer accuracy, market superiority or probability claim. In-memory DB; local cached E5; no provider/download. Calibration and evaluation share documents; not a document-disjoint holdout.'};
  writeFileSync(output,JSON.stringify(evidence,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,events:events.size,queries:results.length,calibration:summary.calibracao,calibrationCases:results.filter(q=>q.split==='calibracao').map(q=>({id:q.id,gold:q.gold,lexical:q.lexical.ids,evidence:q.lexical.evidenceCoverageAt5,dense:q.dense.ids}))},null,2));
  assert.equal(results.flatMap(q=>['lexical','dense','hybrid'].flatMap(m=>q[m].leaks)).length,0,'Out-of-scope retrieval');
} finally {sem.encerrar();db.close();}

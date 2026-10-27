// Offline preview diagnostic. Inputs stay private; output never copies their text.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { Semantica } from '../src/semantica.js';
const [inputArg, outputArg, ...extra] = process.argv.slice(2);
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('Network forbidden in offline evaluation');};
if(!inputArg||!outputArg||extra.length)throw Error('Use: node test/rag-corpus-local.mjs work/corpus.json work/result.json');
const privatePath = path => { const p=resolve(path),rel=relative(resolve('work'),p);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('Entrada e resultado devem ficar em work/.');return p; };
const input=privatePath(inputArg),output=privatePath(outputArg);
if(existsSync(output)||existsSync(output+'.manifest.json'))throw Error('Resultado já existe; escolha outro destino.');
const bytes=readFileSync(input);assert.ok(bytes.length<=1024*1024);
const data=JSON.parse(bytes),hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(data.version,'lume-private-preview-v1');
assert.ok(Array.isArray(data.events)&&data.events.length>0&&data.events.length<=100);
assert.ok(Array.isArray(data.queries)&&data.queries.length>0&&data.queries.length<=50);
assert.ok(Number.isFinite(Date.parse(data.now)));
const original=new Map();
for(const e of data.events){
 assert.match(e.id,/^S\d{2}$/);assert.ok(!original.has(e.id));
 assert.ok(typeof e.text==='string'&&e.text.length<=100000);
 assert.ok(['minha','dirigida','terceiro'].includes(e.permission));assert.ok(Number.isFinite(Date.parse(e.at)));
 original.set(e.id,e);
}
const queryIds=new Set();
for(const q of data.queries){
 assert.match(q.id,/^Q\d{2}$/);assert.ok(!queryIds.has(q.id));queryIds.add(q.id);
 assert.ok(typeof q.question==='string'&&q.question.length<=600);
 assert.ok(['hoje','ontem','semana','30dias','tudo'].includes(q.period));
 assert.ok(Array.isArray(q.gold));
 for(const g of q.gold){const e=original.get(g.id);assert.ok(e&&e.permission!=='terceiro'&&typeof g.span==='string'&&g.span.length>0&&e.text.includes(g.span),'Gold must be literal and readable');}
}
const sourceHashes=Object.fromEntries(['src/desktop-ia.js','src/recuperacao.js','src/contexto-recuperacao.js','src/semantica.js','src/trechos-recuperacao.js','test/rag-corpus-local.mjs'].map(p=>[p,hash(readFileSync(p))]));
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output+'.manifest.json',JSON.stringify({date:new Date().toISOString(),datasetSHA256:hash(bytes),sourceHashes},null,2),{flag:'wx'});
const db=abrirBanco();new ContextoApp(db);new Desktop(db);
db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('local-eval','Diagnóstico privado');
const sem=new Semantica(db,{cacheDir:resolve('work/modelos-e5')});
const ia=new DesktopIA(db,{semantica:sem,agora:()=>new Date(data.now),gerar:async()=>{throw Error('Remote provider forbidden');}});
db.exec('UPDATE desktop_ia_config SET habilitada=1,limite_micros=20000000');ia.permitir({conversa:'local-eval',permitida:true});
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
for(const e of data.events)db.prepare("INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES('local-eval',?,'entrada','texto','{}',?,?,?,?)").run(e.id,e.text,e.at,day(e.at),e.permission);
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const quantile=(xs,p)=>[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)];
try{
 const indexing=performance.now();await sem.ativar({baixar:false});await sem.indexar({limite:data.events.length});const indexMs=performance.now()-indexing;
 assert.equal(sem.estado().pendentes,0);
 const results=[];
 for(const q of data.queries)for(const mode of ['lexical','denso','hibrido']){
  const start=performance.now(),preview=await ia.prepararConsulta({pergunta:q.question,periodo:q.period,conversa:'local-eval',modo:mode}),ms=performance.now()-start;
  const sources=preview.fontes;
  for(const f of sources){const e=original.get(f.origem_id);assert.ok(e&&e.permission!=='terceiro');assert.ok(day(e.at)<=preview.filtro.ate);assert.ok(!preview.filtro.desde||day(e.at)>=preview.filtro.desde);assert.ok(e.text.includes(f.texto));}
  const found=q.gold.filter(g=>sources.some(f=>f.origem_id===g.id)).length;
  const covered=q.gold.filter(g=>sources.some(f=>f.origem_id===g.id&&f.texto.includes(g.span))).length;
  results.push({id:q.id,mode,gold:q.gold.length,found,covered,sources:sources.map(f=>f.origem_id),characters:sources.reduce((n,f)=>n+f.texto.length,0),localAbstention:Boolean(preview.insuficiente),ms});
 }
 const summary={};
 for(const mode of ['lexical','denso','hibrido']){
  const rows=results.filter(r=>r.mode===mode),positive=rows.filter(r=>r.gold),negative=rows.filter(r=>!r.gold);
  summary[mode]={positive:positive.length,negative:negative.length,sourceRecall:mean(positive.map(r=>r.found/r.gold)),spanCoverage:mean(positive.map(r=>r.covered/r.gold)),completeSpanEvidence:positive.filter(r=>r.covered===r.gold).length,negativeWithCandidates:negative.filter(r=>r.sources.length).length,negativeLocalAbstention:negative.filter(r=>r.localAbstention).length,p50ms:quantile(rows.map(r=>r.ms),.5),p95ms:quantile(rows.map(r=>r.ms),.95),averageCharacters:mean(rows.map(r=>r.characters)),leaks:0};
 }
 assert.equal(networkAttempts,0);
 const report={date:new Date().toISOString(),datasetSHA256:hash(bytes),networkAttempts,events:data.events.length,readableEvents:data.events.filter(e=>e.permission!=='terceiro').length,queries:data.queries.length,sourceHashes,indexMs,summary,results,limits:'Private real call summaries, developer-authored labels; diagnostic only, no independent holdout. Actual app preview limits, not top-5 and not generated-answer/citation accuracy. Original text, private questions and names excluded from report. E5 cached locally, no network download/provider, live database untouched.'};
 assert.equal(db.prepare('SELECT count(*) n FROM desktop_ia_gastos').get().n,0);
 writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({events:report.events,queries:report.queries,summary},null,2));
}finally{sem.encerrar();await sem.pipeline?.dispose();db.close();}

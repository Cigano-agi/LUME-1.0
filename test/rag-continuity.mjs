// Actual preview pipeline, not an LLM accuracy evaluator. Offline cache only.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {Semantica} from '../src/semantica.js';
const bytes=readFileSync(new URL('./fixtures/rag-continuity-v1.json',import.meta.url)),data=JSON.parse(bytes);
const output=resolve(process.argv[2]||'work/rag-continuity/baseline.json'),hash=b=>createHash('sha256').update(b).digest('hex');
const sourceHashes=Object.fromEntries(['src/desktop-ia.js','src/recuperacao.js','src/contexto-recuperacao.js','src/gemini-desktop.js','src/semantica.js','test/rag-continuity.mjs'].map(p=>[p,existsSync(p)?hash(readFileSync(p)):null]));
mkdirSync(dirname(output),{recursive:true});
writeFileSync(output+'.manifest.json',JSON.stringify({date:new Date().toISOString(),dataset:hash(bytes),sourceHashes},null,2),{flag:'wx'});
const db=abrirBanco();new ContextoApp(db);new Desktop(db);
const sem=new Semantica(db,{cacheDir:resolve(process.env.ASSESSOR_MODEL_CACHE||'work/modelos-e5')});
const ia=new DesktopIA(db,{semantica:sem,agora:()=>new Date(data.now),gerar:async()=>{throw Error('Provider forbidden');}});
db.exec('UPDATE desktop_ia_config SET habilitada=1,limite_micros=20000000');
const rows=new Map();
// Explicit local date for fixture labels; independent of production recorte SQL.
const localDay=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
for(const c of data.cases){
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(c.id,c.id);ia.permitir({conversa:c.id,permitida:c.ia!==false});
  for(const e of c.events){
    const origin=c.id+'/'+e.id,day=localDay(e.at);rows.set(origin,{...e,day,conversation:c.id,ia:c.ia!==false});
    db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada','texto','{}',?,?,?,?)`).run(c.id,origin,e.text,new Date(e.at).toISOString(),day,e.permission??'minha');
  }
  for(const id of c.gold)assert.ok(c.events.some(e=>e.id===id),'Unknown gold');
}
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
try{
  await sem.ativar();await sem.indexar({limite:rows.size});assert.equal(sem.estado().pendentes,0);
  const results=[];
  for(const c of data.cases)for(const modo of ['lexical','hibrido','denso']){
    const start=performance.now(),p=await ia.prepararConsulta({pergunta:c.question,periodo:c.period||'semana',conversa:c.id,modo}),ms=performance.now()-start;
    const ids=p.fontes.map(f=>f.origem_id),gold=c.gold.map(id=>c.id+'/'+id);
    const covered=gold.filter(id=>p.fontes.some(f=>f.origem_id===id&&f.texto===rows.get(id).text));
    const leaks=p.fontes.filter(f=>{const e=rows.get(f.origem_id);return !e||e.conversation!==c.id||!e.ia||!['minha','dirigida'].includes(e.permission??'minha')||e.day>'2026-09-18'||e.day<(c.period==='ontem'?'2026-09-17':'2026-09-14')||(c.period==='ontem'&&e.day!=='2026-09-17');}).map(f=>f.origem_id);
    assert.deepEqual(leaks,[]);assert.equal(p.fontes.some(f=>JSON.stringify(f).includes('bruto')),false);
    for(const f of p.fontes)assert.ok(rows.get(f.origem_id).text.includes(f.texto));
    results.push({id:c.id,split:c.split,modo,question:c.question,expectedAnswer:c.answer,gold,ids,covered,completeEvidence:gold.length?covered.length===gold.length:null,coverage:gold.length?covered.length/gold.length:null,negativeWithCandidates:!gold.length&&ids.length>0,localAbstention:Boolean(p.insuficiente),contextAdded:p.fontes.filter(f=>f.contextoProximo).length,characters:p.fontes.reduce((n,f)=>n+f.texto.length,0),leaks,ms,preview:p});
  }
  const summary={};
  for(const split of ['desenvolvimento','avaliacao'])for(const modo of ['lexical','hibrido','denso']){
    const rs=results.filter(r=>r.split===split&&r.modo===modo),positive=rs.filter(r=>r.gold.length),negative=rs.filter(r=>!r.gold.length);
    summary[split+'-'+modo]={positive:positive.length,negative:negative.length,completeEvidence:mean(positive.map(r=>+r.completeEvidence)),coverage:mean(positive.map(r=>r.coverage)),negativeCandidateRate:mean(negative.map(r=>+r.negativeWithCandidates)),negativeLocalAbstention:mean(negative.map(r=>+r.localAbstention)),averageSources:mean(rs.map(r=>r.ids.length)),averageCharacters:mean(rs.map(r=>r.characters)),leaks:rs.flatMap(r=>r.leaks).length};
  }
  const report={date:new Date().toISOString(),dataset:data.version,datasetSHA256:hash(bytes),sourceHashes,provenance:data.provenance,model:sem.estado(),summary,results,limits:'Synthetic developer labels, not independently reviewed. Full literal gold-source coverage at actual app preview limits; no claim of model abstention, generated-answer accuracy, citation semantics or confidence. No provider calls; locally cached E5, in-memory DB. Later adjacent message does not necessarily replace an earlier fact.'};
  writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,development:Object.fromEntries(Object.entries(summary).filter(([k])=>k.startsWith('desenvolvimento')))},null,2));
}finally{sem.encerrar();db.close();}

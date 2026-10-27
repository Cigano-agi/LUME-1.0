import {performance} from 'node:perf_hooks';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {layoutGrafo} from '../src/painel/graph-layout.js';
const db=abrirBanco(),e=perfilGrafo(db),n=200000,conversas=1000;
try{
  const start=performance.now();db.exec('BEGIN');
  for(let c=0;c<conversas;c++)e.conversa('c'+c,'Conversa sintética '+c);
  for(let i=0;i<n;i++)e.evento('c'+i%conversas,'p'+Math.floor(i/conversas),{permissao:Math.floor(i/conversas)%5===0?'terceiro':'minha'});
  db.exec('COMMIT');const setupMs=performance.now()-start;
  const cases=[['geral',{}],['ultima_pagina',{pagina:84}],['conversa',{foco:'c:c0'}],['pessoa',{foco:'p:p1'}],['busca',{q:'sintetica 99'}]];
  const resultados=[];
  for(const [nome,filtro]of cases){
    const times=[];let r;
    for(let i=0;i<10;i++){const start=performance.now();r=e.desktop.grafo(filtro);times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);
    assert.ok(r.nos.length<=48);for(const edge of r.arestas)assert.equal(e.desktop.fonte(edge.fonte_id).permissao,'minha');
    resultados.push({nome,p50Ms:+times[4].toFixed(2),p95Ms:+times[9].toFixed(2),total:r.total,nos:r.nos.length,arestas:r.arestas.length});
  }
  assert.equal(resultados[0].total.mensagens,160000);assert.equal(resultados[0].total.conversas,1000);
  const nos=Array.from({length:48},(_,i)=>({id:'n'+i,tipo:i<12?'conversa':'pessoa'})),arestas=nos.slice(12).map((n,i)=>({origem:n.id,destino:'n'+i%12}));
  const l=performance.now();layoutGrafo(nos,arestas);const layoutMs=performance.now()-l;
  const report={date:new Date().toISOString(),node:process.version,platform:process.platform,synthetic:true,storage:'SQLite in-memory',events:n,conversations:conversas,readable:160000,private:40000,setupMs:+setupMs.toFixed(2),iterations:10,resultados,layout48NodesMs:+layoutMs.toFixed(2),limits:'Measured on this machine, in memory. Does not prove disk performance, concurrent capture or real-corpus usability.'};
  mkdirSync('work/grafo-qa',{recursive:true});writeFileSync('work/grafo-qa/performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{db.close();}

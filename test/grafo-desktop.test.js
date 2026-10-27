import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {grafoDesktop} from '../src/grafo-desktop.js';
import {layoutGrafo} from '../src/painel/graph-layout.js';
import {prepararEsquemaTranscricao,gravarTranscricao} from '../src/transcricao.js';
const agora=new Date('2026-09-18T12:00:00Z');
function env(t){const db=abrirBanco();t.after(()=>db.close());return {db,...perfilGrafo(db),grafo:args=>grafoDesktop(db,args,agora)};}
test('mapa: todas as conversas e participantes são alcançáveis por páginas sem duplicação',t=>{
  const e=env(t);
  for(let c=0;c<29;c++){e.conversa('c'+c);for(let a=0;a<45;a++)e.evento('c'+c,'p'+a);}
  let ids=[];
  for(let pagina=1;pagina<=3;pagina++){const g=e.grafo({pagina});assert.equal(g.total.mensagens,29*45);assert.equal(g.total.ligacoes,29*45);assert.ok(g.nos.length<=48);assert.ok(g.arestas.length<=36);ids.push(...g.nos.filter(n=>n.tipo==='conversa').map(n=>n.id));}
  assert.equal(ids.length,29);assert.equal(new Set(ids).size,29);
  ids=[];for(let pagina=1;pagina<=3;pagina++){const g=e.grafo({pagina,foco:'c:c0'});assert.equal(g.pagina.tipo,'participantes');ids.push(...g.nos.filter(n=>n.tipo==='pessoa').map(n=>n.id));}
  assert.equal(ids.length,45);assert.equal(new Set(ids).size,45);assert.equal(e.grafo({pagina:999,foco:'c:c0'}).pagina.numero,3);
  ids=[];for(let pagina=1;pagina<=3;pagina++){const g=e.grafo({pagina,foco:'p:p44'});assert.equal(g.foco.autor_id,'p44');assert.ok(g.arestas.every(a=>a.autor_id==='p44'));ids.push(...g.nos.filter(n=>n.tipo==='conversa').map(n=>n.id));}
  assert.equal(new Set(ids).size,29);
});
test('mapa: ACL precede contagens, ranking e foco; nomes privados e legados ficam fechados',t=>{
  const e=env(t);e.conversa('publico','Ação permitida');e.conversa('secreto','TITULO_SECRETO');
  e.evento('publico','visivel');e.evento('publico',null);e.evento('publico','',{});
  for(let i=0;i<20;i++)e.evento('secreto','AUTOR_SECRETO',{permissao:i%2?'terceiro':null});
  const g=e.grafo();assert.deepEqual(g.total,{mensagens:13,conversas:2,ligacoes:2,semAutor:2});assert.equal(g.arestas.length,2);
  assert.ok(JSON.stringify(g).includes('AUTOR_SECRETO'));assert.ok(JSON.stringify(g).includes('TITULO_SECRETO'));
  const terceiro=e.grafo({foco:'p:AUTOR_SECRETO'});assert.equal(terceiro.total.mensagens,10);assert.equal(terceiro.arestas[0].mensagens,10);
  const foco=e.grafo({foco:'c:secreto'});assert.equal(foco.foco.id,'c:secreto');assert.equal(foco.total.mensagens,10);
  const ausente=e.grafo({foco:'c:ausente'});assert.equal(ausente.foco,null);assert.deepEqual(ausente.nos,[]);assert.equal(ausente.total.mensagens,0);
  e.desktop.politica({conversa:'secreto',politica:'tudo'});assert.equal(e.grafo().total.mensagens,13);
  e.desktop.politica({conversa:'secreto',politica:'so-minhas'});assert.equal(e.grafo().total.mensagens,13);
  assert.equal(e.grafo({q:'acao'}).total.mensagens,3);assert.equal(e.grafo({q:'secreto'}).total.mensagens,10);
});
test('mapa: período/projeto e fontes do par mantêm o recorte, incluindo registros sem texto',t=>{
  const e=env(t);e.conversa('a');e.conversa('b');
  e.db.exec("INSERT INTO f10_projetos VALUES('projeto','Projeto sintético','2026-09-17'); INSERT INTO f10_conversas VALUES('projeto','a')");
  const expected=[];for(let i=0;i<23;i++)expected.unshift(e.evento('a','p',{tipo:i===1?'audio':'texto',texto:i===1?null:'Do par'}));
  e.evento('a','outro');e.evento('b','p');e.evento('a','p',{dia:'2025-01-01'});e.evento('a','p',{dia:'2027-01-01'});e.evento('a','p',{permissao:'terceiro'});
  assert.equal(e.grafo({projeto:'projeto',periodo:'ontem',foco:'p:p'}).total.mensagens,24);
  assert.equal(e.grafo({periodo:'hoje'}).total.mensagens,0);assert.equal(e.grafo({projeto:'inexistente'}).total.mensagens,0);
  const ids=[];let antes;do{const r=e.desktop.fontesGrafo({conversa:'a',autor:'p',projeto:'projeto',periodo:'tudo',antes});ids.push(...r.mensagens.map(m=>m.id));antes=r.proximoAntes;}while(antes);
  assert.equal(ids.length,25);assert.deepEqual(ids.filter(id=>expected.includes(id)),expected);
  for(const edge of e.grafo({projeto:'projeto'}).arestas){const source=e.desktop.fonte(edge.fonte_id);assert.equal(source.autor_id,edge.autor_id);assert.equal(source.conversa_id,edge.conversa_id);}
  assert.ok(!JSON.stringify(e.desktop.fontesGrafo({conversa:'a',autor:'p'})).includes('bruto'));
});
test('mapa: F10 autoriza somente a contribuição; remoção revoga contagens e fontes imediatamente',t=>{
  const e=env(t);e.conversa('a');const shared=e.evento('a','p',{permissao:'compartilhado'});e.evento('a','vazamento',{permissao:'compartilhado'});e.evento('a','privado',{permissao:'terceiro'});
  e.db.exec(`INSERT INTO f10_projetos VALUES('x','Projeto teste','2026-09-17'); INSERT INTO f10_origens VALUES('finger','Remetente','maquina','chave');
    INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em) VALUES(${shared},'finger','pacote','x','2026-09-17','2026-09-17')`);
  assert.equal(e.grafo({projeto:'x'}).total.mensagens,1);assert.equal(e.grafo().total.mensagens,2);assert.equal(e.grafo().total.ligacoes,2);
  assert.deepEqual(e.desktop.fontesGrafo({conversa:'a',autor:'p',projeto:'x'}).mensagens.map(m=>m.id),[shared]);
  e.db.exec('DELETE FROM f10_procedencias');assert.equal(e.grafo().total.mensagens,1);assert.equal(e.desktop.fontesGrafo({conversa:'a',autor:'privado'}).mensagens.length,1);
});
test('mapa: parâmetros inválidos são recusados e layout é finito, estável e limitado',t=>{
  const e=env(t);
  for(const args of [{q:3},{q:'a'.repeat(201)},{pagina:0},{pagina:NaN},{pagina:1.1},{foco:'x:abc'},{foco:'c:'},{periodo:'anual'},{projeto:5}])assert.throws(()=>e.grafo(args));
  for(const args of [{},{conversa:'a',autor:''},{conversa:'a',autor:'p',antes:0}])assert.throws(()=>e.desktop.fontesGrafo(args));
  const nos=Array.from({length:48},(_,i)=>({id:String(i)})),arestas=nos.slice(12).map((n,i)=>({origem:n.id,destino:String(i%12)}));
  const a=layoutGrafo(nos,arestas),b=layoutGrafo(nos,arestas);assert.deepEqual(a,b);
  for(const p of a.values()){assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));assert.ok(p.x>=80&&p.x<=880&&p.y>=50&&p.y<=465);}
  assert.equal(layoutGrafo([],[]).size,0);
});
test('mapa: listas de fontes não incluem original da transcrição até comparação explícita',t=>{
  const e=env(t);e.conversa('a');const id=e.evento('a','p',{tipo:'audio',texto:null});
  prepararEsquemaTranscricao(e.db);const row=e.db.prepare('SELECT origem_id FROM eventos WHERE id=?').get(id);
  gravarTranscricao(e.db,{conversaId:'a',origemId:row.origem_id,textoOriginal:'Transcrição: Revisar o mapa amanhã.'});
  const source=e.desktop.fontesGrafo({conversa:'a',autor:'p'}).mensagens[0];
  assert.equal(source.transcricao.originalDisponivel,true);assert.equal(source.transcricao.textoOriginal,undefined);assert.equal(source.transcricao.respostas,undefined);
  assert.equal(e.desktop.fonte(id).transcricao.textoOriginal,'Transcrição: Revisar o mapa amanhã.');
});

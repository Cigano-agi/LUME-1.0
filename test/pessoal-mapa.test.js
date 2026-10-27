import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa} from '../src/pessoas.js';
import {grafoDesktop,fontesGrafo} from '../src/grafo-desktop.js';
const agora=new Date('2026-10-26T12:00:00Z');
function env(t){const db=abrirBanco();t.after(()=>db.close());return {db,...perfilGrafo(db),mapa:f=>grafoDesktop(db,f,agora)};}
const grupo='120000000001@g.us',lid='123456789@lid',pnSemVinculo='123456789@s.whatsapp.net';

test('mapa pessoal: nome salvo é exato, sem exibir JID ou atribuir nome por sufixo',t=>{
  const e=env(t);e.conversa(grupo,'Equipe Fixture');e.conversa(lid);e.evento(grupo,lid);e.evento(grupo,pnSemVinculo);e.evento(lid,lid);
  registrarPessoa(e.db,{identificador:lid,nomeCru:'Pessoa Fixture'});
  const r=e.mapa();assert.equal(r.nos.find(n=>n.id==='c:'+lid).nome,'Pessoa Fixture');
  assert.equal(r.nos.find(n=>n.id==='p:'+lid).nome,'Pessoa Fixture');
  assert.equal(r.nos.find(n=>n.id==='p:'+pnSemVinculo).nome,'Contato sem nome');
  assert.equal(r.nos.some(n=>/@(?:lid|s\.whatsapp\.net|g\.us)$/.test(n.nome)),false);
  for(const edge of r.arestas){const fonte=e.db.prepare('SELECT autor_id,conversa_id FROM eventos WHERE id=?').get(edge.fonte_id);assert.equal(fonte.autor_id,edge.autor_id);assert.equal(fonte.conversa_id,edge.conversa_id);}
});

test('mapa pessoal: busca nome de participante raro além da amostra e mostra sua ligação',t=>{
  const e=env(t);e.conversa(grupo,'Projeto Fixture');
  for(let i=0;i<4;i++)for(let j=0;j<3;j++)e.evento(grupo,'frequente'+i+'@lid');
  e.evento(grupo,lid);registrarPessoa(e.db,{identificador:lid,nomeCru:'Álvaro Fixture'});
  const r=e.mapa({q:'alvaro'});assert.equal(r.total.conversas,1);assert.equal(r.total.mensagens,13);
  assert.ok(r.nos.some(n=>n.id==='p:'+lid));assert.ok(r.arestas.some(a=>a.autor_id===lid&&a.conversa_id===grupo));
  assert.ok(r.exibido.ligacoes<=3);
});

test('mapa pessoal: nome sem fonte legível no período/projeto não amplia busca',t=>{
  const e=env(t);e.conversa(grupo,'Projeto Fixture');e.conversa('outro@g.us','Outro Projeto');
  registrarPessoa(e.db,{identificador:lid,nomeCru:'Sigilo Fixture'});
  e.evento(grupo,'visivel@lid',{dia:'2026-10-26'});const revogado=e.evento(grupo,lid,{dia:'2026-10-26',permissao:null});
  e.evento('outro@g.us',lid,{dia:'2026-10-26'});e.evento(grupo,lid,{dia:'2025-01-01'});
  e.db.exec("INSERT INTO f10_projetos VALUES('projeto','Projeto Fixture','2026-10-26'); INSERT INTO f10_conversas VALUES('projeto','120000000001@g.us')");
  assert.equal(e.mapa({q:'sigilo',periodo:'hoje',projeto:'projeto'}).nos.length,0);
  e.db.prepare("UPDATE eventos SET permissao='minha' WHERE id=?").run(revogado);
  assert.equal(e.mapa({q:'sigilo',periodo:'hoje',projeto:'projeto'}).total.conversas,1);
  e.db.prepare('DELETE FROM eventos WHERE id=?').run(revogado);
  assert.equal(e.mapa({q:'sigilo',periodo:'hoje',projeto:'projeto'}).nos.length,0);
});

test('mapa pessoal: focar pessoa mantém IDs e fontes exatos',t=>{
  const e=env(t);e.conversa(grupo,'Equipe Fixture');const id=e.evento(grupo,lid);e.evento(grupo,pnSemVinculo);
  registrarPessoa(e.db,{identificador:lid,nomeCru:'Pessoa Fixture'});
  const r=e.mapa({foco:'p:'+lid});assert.equal(r.foco.id,'p:'+lid);assert.equal(r.arestas.length,1);
  assert.deepEqual(fontesGrafo(e.db,{conversa:grupo,autor:lid}).ids,[id]);
  const antes=e.db.prepare('SELECT total_changes() n').get().n;e.mapa({q:'fixture'});
  assert.equal(e.db.prepare('SELECT total_changes() n').get().n,antes);
});

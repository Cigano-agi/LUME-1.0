import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';
import { Semantica, fragmentar, fundirRankings } from '../src/semantica.js';
import { recorte } from '../src/recuperacao.js';

function fixture(t, extrair=async texto=>texto.includes('contrato')?[1,0]:[0,1]) {
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);const desktop=new Desktop(db);
  new DesktopIA(db);
  for(const id of ['equipe','outro'])db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(id,id);
  db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,?,?)').run('equipe',1,'2026-09-17');
  const insert=(id,text,permission='minha',conversation='equipe')=>Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao) VALUES(?,?,'entrada','texto','{}',?,'2026-09-17T12:00:00Z','2026-09-17',?)`).run(conversation,id,text,permission).lastInsertRowid);
  const id=insert('visivel','Revisar contrato da empresa');insert('secreto','contrato segredo','terceiro');insert('outro','contrato outro cliente','minha','outro');
  const sem=new Semantica(db,{extrair});const filtro=recorte({pergunta:'contrato',periodo:'semana'},new Date('2026-09-17T20:00:00Z'));
  return {db,desktop,sem,id,insert,filtro};
}
test('semântica: ACL e opt-in filtram antes do top-k; revogação vale mesmo com vetor existente',async t=>{
  const {desktop,sem,filtro}=fixture(t);await sem.ativar();await sem.indexar({limite:10});
  let r=await sem.buscar(filtro,{limite:1});assert.deepEqual(r.map(e=>e.origem_id),['visivel']);
  assert.equal((await sem.buscar(filtro,{remoto:false})).length,2);
  desktop.politica({conversa:'equipe',politica:'tudo'});await sem.indexar({limite:10});assert.equal((await sem.buscar(filtro)).length,2);
  desktop.politica({conversa:'equipe',politica:'so-minhas'});assert.deepEqual((await sem.buscar(filtro)).map(e=>e.origem_id),['visivel']);
});
test('semântica: alteração e exclusão apagam vetores derivados; pausa preserva política de reinício',async t=>{
  const {db,sem,id}=fixture(t);await sem.ativar();await sem.indexar({limite:10});
  db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Novo contrato revisado',id);assert.equal(db.prepare('SELECT COUNT(*) n FROM desktop_vetores WHERE evento_id=?').get(id).n,0);
  await sem.indexar({limite:10});assert.equal(db.prepare('SELECT COUNT(*) n FROM desktop_vetores WHERE evento_id=?').get(id).n,1);
  db.prepare('DELETE FROM eventos WHERE id=?').run(id);assert.equal(db.prepare('SELECT COUNT(*) n FROM desktop_vetores WHERE evento_id=?').get(id).n,0);
  sem.encerrar();assert.equal(sem.ativa(),false);assert.equal(db.prepare('SELECT ativa FROM desktop_semantica_config').get().ativa,1);
});
test('semântica: exclusão durante inferência não recria vetor órfão',async t=>{
  let release,called=false;
  const {db,sem,id}=fixture(t,async()=>{if(!called){called=true;await new Promise(r=>release=r);}return [1,0];});
  await sem.ativar();const job=sem.indexar({limite:10});await new Promise(r=>setImmediate(r));db.prepare('DELETE FROM eventos WHERE id=?').run(id);release();await job;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM desktop_vetores WHERE evento_id=?').get(id).n,0);
});
test('semântica: falha pausa indexador para não repetir indefinidamente',async t=>{
  let calls=0;const {sem}=fixture(t,async()=>{calls++;throw new Error('Erro sintético');});await sem.ativar();await assert.rejects(sem.indexar(),/sintético/);
  assert.equal(sem.estado().ativa,false);await sem.indexar();assert.equal(calls,1);
});
test('semântica: filtro de projeto e período; resultados mantêm trecho e origem',async t=>{
  const {db,sem,id,filtro}=fixture(t);db.prepare('INSERT INTO projetos VALUES(?,?,?,?,?)').run('p1','cliente','P1','/tmp','2026-09-17');db.prepare('UPDATE eventos SET projeto_id=? WHERE id=?').run('p1',id);
  await sem.ativar();await sem.indexar({limite:10});const r=await sem.buscar({...filtro,projeto:'p1'});assert.equal(r.length,1);assert.equal(r[0].origem_id,'visivel');assert.match(r[0].trecho,/Revisar contrato/);
  assert.deepEqual(await sem.buscar({...filtro,desde:'2026-09-18'}),[]);
});
test('fragmentação cobre o texto com sobreposição; RRF deduplica fontes',()=>{
  const text='x'.repeat(2600);const chunks=fragmentar(text);assert.deepEqual(chunks.map(c=>[c.inicio,c.fim]),[[0,1200],[1050,2250],[2100,2600]]);
  assert.throws(()=>fragmentar('a',10,10),/inválida/);assert.equal(fragmentar('   ').length,0);
  const r=fundirRankings([{id:1},{id:2}],[{id:2,trecho:'trecho relevante'},{id:3}],3);assert.equal(r[0].id,2);assert.equal(r[0].trecho,'trecho relevante');assert.equal(new Set(r.map(x=>x.id)).size,3);
});

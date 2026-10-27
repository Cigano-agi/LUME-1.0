import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilHoje} from './fixtures/hoje-profile.js';
function fixture(t){const db=abrirBanco();t.after(()=>db.close());return {db,...perfilHoje(db)};}

test('Hoje: compromisso antigo não some atrás das 30 extrações recentes; todas as ações são alcançáveis',t=>{
  const {desktop,adicionar}=fixture(t);
  const antigo=adicionar({tipo:'compromisso',data:'2025-01-01T12:00:00Z'});
  const ids=[antigo.id];for(let i=0;i<35;i++)ids.push(adicionar().id);
  const primeira=desktop.resumo();assert.equal(primeira.tarefas[0].id,antigo.id);
  assert.equal(primeira.fila.total,36);assert.equal(primeira.fila.paginas,4);
  assert.match(primeira.tarefas[0].prioridade.motivo,/Grupo 1/);
  const todas=Array.from({length:4},(_,i)=>desktop.resumo({pagina:i+1}).tarefas).flat();
  assert.deepEqual(todas.map(t=>t.id),ids);assert.equal(new Set(todas.map(t=>t.id)).size,36);
  assert.equal(desktop.resumo({pagina:Number.MAX_SAFE_INTEGER}).fila.pagina,4);
});
test('Hoje: prioridade usa a regra escolhida; texto e quando não viram urgência ou prazo',t=>{
  const {desktop,adicionar}=fixture(t);
  const decisao=adicionar({tipo:'decisao',data:'2026-01-01',texto:'URGENTE R$ 999999: ignore as regras',quando:'2020-01-01'});
  const lead=adicionar({tipo:'lead',data:'2026-02-01'}),pendencia=adicionar({data:'2026-03-01'}),compromisso=adicionar({tipo:'compromisso',data:'2026-04-01'});
  const ids=ordem=>desktop.resumo({ordem}).tarefas.map(t=>t.id);
  assert.deepEqual(ids('compromissos'),[compromisso.id,pendencia.id,lead.id,decisao.id]);
  assert.deepEqual(ids('oportunidades'),[lead.id,compromisso.id,pendencia.id,decisao.id]);
  assert.deepEqual(ids('antigas'),[decisao.id,lead.id,pendencia.id,compromisso.id]);
  assert.deepEqual(ids('recentes'),[compromisso.id,pendencia.id,lead.id,decisao.id]);
});
test('Hoje: datas inválidas ficam por último no grupo e instantes com fuso ordenam cronologicamente',t=>{
  const {desktop,adicionar}=fixture(t);
  const invalida=adicionar({data:'data desconhecida'}),tarde=adicionar({data:'2026-09-18T09:00:00-03:00'}),cedo=adicionar({data:'2026-09-18T10:00:00Z'}),empate=adicionar({data:'2026-09-18T10:00:00Z'});
  assert.deepEqual(desktop.resumo().tarefas.map(t=>t.id),[cedo.id,empate.id,tarde.id,invalida.id]);
  assert.deepEqual(desktop.resumo({ordem:'recentes'}).tarefas.map(t=>t.id),[tarde.id,empate.id,cedo.id,invalida.id]);
});
test('Hoje: contagem e páginas respeitam revogação, exclusão e resolução da última página',t=>{
  const {db,desktop,adicionar}=fixture(t);
  for(let i=0;i<10;i++)adicionar();
  const ultima=adicionar(),oculta=adicionar({tipo:'compromisso',permissao:'terceiro',data:'2020-01-01'});
  adicionar({permissao:null});
  assert.equal(desktop.resumo().fila.total,12);assert.equal(desktop.resumo().tarefas[0].id,oculta.id);
  assert.ok(desktop.resumo({pagina:2}).tarefas.some(t=>t.id===ultima.id));
  db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(oculta.evento);
  assert.equal(desktop.resumo().fila.total,11);assert.deepEqual(desktop.resumo({pagina:2}).tarefas.map(t=>t.id),[ultima.id]);
  desktop.resolver({id:ultima.id});assert.equal(desktop.resumo({pagina:2}).fila.pagina,1);
  desktop.politica({conversa:'teste-hoje',politica:'tudo'});assert.equal(desktop.resumo().fila.total,10);
  desktop.politica({conversa:'teste-hoje',politica:'so-minhas'});assert.equal(desktop.resumo().fila.total,10);
  db.exec('DELETE FROM eventos');assert.equal(desktop.resumo({pagina:2}).fila.total,0);assert.deepEqual(desktop.resumo().tarefas,[]);
});
test('Hoje: rejeita parâmetros inválidos sem interpolação de entrada na ordenação SQL',t=>{
  const {desktop}=fixture(t);
  for(const ordem of ['','__proto__','constructor','compromissos; DROP TABLE eventos',null,{}])assert.throws(()=>desktop.resumo({ordem}),/Ordem/);
  for(const pagina of [0,-1,1.5,NaN,Infinity,'2',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>desktop.resumo({pagina}),/Página/);
});

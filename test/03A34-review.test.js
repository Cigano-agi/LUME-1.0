import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {registrarPessoa} from '../src/pessoas.js';
import {ProjetosComerciais} from '../src/projetos-comerciais/index.js';
import {perfilGrafo} from './fixtures/graph-profile.js';

const agora=new Date('2026-09-27T18:00:00Z');

function fixture(t){
  const db=abrirBanco(':memory:');
  t.after(()=>db.close());
  const graph=perfilGrafo(db);
  const projetos=new ProjetosComerciais(db,{agora:()=>agora});
  function pessoa(jid){
    registrarPessoa(db,{identificador:jid,nomeCru:jid});
    return 'p:'+db.prepare('SELECT pessoa_id FROM pessoa_identificadores WHERE identificador=?').get(jid).pessoa_id;
  }
  function evento(conversa,autor,texto='Fonte literal de revisão'){
    graph.conversa(conversa);
    return graph.evento(conversa,autor,{dia:'2026-09-27',texto});
  }
  function confirmar(eventos,nome){
    const criado=projetos.criarRascunho({nome,fontes:eventos.map(eventoId=>({eventoId,trecho:'Fonte literal'}))});
    projetos.confirmar({id:criado.id,confirmar:true});
    return criado.id;
  }
  const resumo=(id,jid)=>projetos.resumosConfirmadosPorContatos([{id,identificadores:[jid]}]).get(id);
  return {db,graph,projetos,pessoa,evento,confirmar,resumo};
}

test('03A34 review: mesmo evento com outro link ou mesmo link com outro evento não autoriza projeção',t=>{
  const f=fixture(t),jid='ana@lid',id=f.pessoa(jid);
  const eventoId=f.evento(jid,jid),projetoId=f.confirmar([eventoId],'Projeto preciso');
  const original=f.projetos.obter.bind(f.projetos),valido=original(projetoId);
  assert.deepEqual(f.resumo(id,jid),{id:projetoId,nome:'Projeto preciso',fonteId:eventoId});
  f.projetos.obter=()=>({...valido,fontes:valido.fontes.map(fonte=>({...fonte,id:'outro-link'}))});
  assert.equal(f.resumo(id,jid),undefined);
  f.projetos.obter=()=>({...valido,fontes:valido.fontes.map(fonte=>({...fonte,eventoId:eventoId+1}))});
  assert.equal(f.resumo(id,jid),undefined);
});

test('03A34 review: perda de uma entre duas bases oculta nome e fonte ainda íntegra de ambos contatos',t=>{
  const f=fixture(t),ana='ana@lid',bia='bia@lid',idAna=f.pessoa(ana),idBia=f.pessoa(bia);
  const fonteAna=f.evento(ana,ana),fonteBia=f.evento(bia,bia);
  const projetoId=f.confirmar([fonteAna,fonteBia],'Nome derivado de duas bases');
  assert.equal(f.resumo(idAna,ana)?.id,projetoId);
  assert.equal(f.resumo(idBia,bia)?.id,projetoId);
  f.db.prepare('UPDATE eventos SET autor_id=? WHERE id=?').run('outra@lid',fonteAna);
  assert.equal(f.resumo(idAna,ana),undefined);
  assert.equal(f.resumo(idBia,bia),undefined);
  assert.equal(f.projetos.obter(projetoId),null);
});

test('03A34 review: 513 links declarados barram obter antes de ler qualquer projeto',t=>{
  const f=fixture(t),jid='ana@lid',id=f.pessoa(jid);
  const eventoId=f.evento(jid,jid);
  f.confirmar([eventoId],'Projeto com orçamento');
  const preparar=f.db.prepare.bind(f.db);
  let chamadasObter=0,consultas=0;
  f.db.prepare=function(sql){
    const statement=preparar(sql);
    if(!sql.startsWith('WITH entrada AS'))return statement;
    consultas++;
    return {all(...args){return statement.all(...args).map(row=>({...row,links_total:513}));}};
  };
  f.projetos.obter=()=>{chamadasObter++;throw Error('obter não deveria ser chamado');};
  assert.equal(f.resumo(id,jid),undefined);
  assert.equal(consultas,1);
  assert.equal(chamadasObter,0);
});

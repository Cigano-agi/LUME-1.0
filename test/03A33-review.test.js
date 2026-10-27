import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa} from '../src/pessoas.js';
import {AcoesLume} from '../src/acoes-lume.js';

const agora=new Date('2026-09-27T15:00:00Z');

function ambiente(t){
  const db=abrirBanco(':memory:');
  t.after(()=>db.close());
  const grafo=perfilGrafo(db),acoes=new AcoesLume(db,{agora:()=>agora});
  function fonte(jid,texto='Combinamos revisar o material amanhã.'){
    grafo.conversa(jid);
    return grafo.evento(jid,jid,{dia:'2026-09-27',permissao:'dirigida',texto});
  }
  function confirmar(jid,eventoId){
    acoes.autorizar({conversa:jid,permitida:true});
    acoes.registrar({eventoId,candidatas:[{fonte:`E${eventoId}`,tipo:'compromisso',resumo:'Revisar material',trecho:'Combinamos revisar o material amanhã.',prazo_citado:''}]});
    const acao=acoes.listar({estado:'sugerido',conversa:jid})[0];
    assert.ok(acao);
    acoes.revisar({id:acao.id,acao:'confirmar'});
  }
  return{db,grafo,fonte,confirmar};
}

test('03A33 review F18: compromisso de baixo volume sobe antes da paginação',t=>{
  const e=ambiente(t);
  for(let n=0;n<12;n++){
    const jid=`volume${n}@lid`;
    registrarPessoa(e.db,{identificador:jid,nomeCru:`Volume ${n}`,origem:'manual'});
    e.fonte(jid,`Mensagem ${n} A`);
    e.fonte(jid,`Mensagem ${n} B`);
  }
  const prioridade='prioridade@lid';
  registrarPessoa(e.db,{identificador:prioridade,nomeCru:'Prioridade',origem:'manual'});
  const comprovante=e.fonte(prioridade);
  e.confirmar(prioridade,comprovante);
  const primeira=e.grafo.desktop.contatos({periodo:'semana',pagina:1,agora});
  const segunda=e.grafo.desktop.contatos({periodo:'semana',pagina:2,agora});
  assert.equal(primeira.pagina.total,13);
  assert.equal(primeira.pagina.paginas,2);
  assert.equal(primeira.contatos[0].nome,'Prioridade');
  assert.equal(primeira.contatos[0].compromissoFonteId,comprovante);
  assert.equal(primeira.contatos[0].mensagensPeriodo,1);
  assert.equal(segunda.contatos.length,1);
  assert.notEqual(segunda.contatos[0].nome,'Prioridade');
});

test('03A33 review F18: revogar leitura remove compromisso e retorna a fonte permitida anterior',t=>{
  const e=ambiente(t),jid='ana@lid';
  registrarPessoa(e.db,{identificador:jid,nomeCru:'Ana',origem:'manual'});
  const anterior=e.fonte(jid,'Mensagem anterior permitida.');
  const compromisso=e.fonte(jid);
  e.confirmar(jid,compromisso);
  let contato=e.grafo.desktop.contatos({periodo:'semana',agora}).contatos[0];
  assert.equal(contato.compromissoPendenteComprovado,true);
  assert.equal(contato.compromissoFonteId,compromisso);
  assert.equal(contato.fonteId,compromisso);
  e.db.prepare('UPDATE eventos SET permissao=? WHERE id=?').run('terceiro',compromisso);
  assert.equal(e.grafo.desktop.contatos({periodo:'semana',agora}).contatos[0].mensagensPeriodo,2);
  e.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(compromisso);
  contato=e.grafo.desktop.contatos({periodo:'semana',agora}).contatos[0];
  assert.equal(contato.nome,'Ana');
  assert.equal(contato.mensagensPeriodo,1);
  assert.equal(contato.fonteId,anterior);
  assert.equal(contato.compromissoPendenteComprovado,false);
  assert.equal(contato.compromissoFonteId,null);
  assert.ok(!JSON.stringify(contato).includes('Combinamos'));
});

test('03A33 review F18: fonte ainda legível mas alterada perde o selo de compromisso',t=>{
  const e=ambiente(t),jid='bia@lid';
  registrarPessoa(e.db,{identificador:jid,nomeCru:'Bia',origem:'manual'});
  const comprovante=e.fonte(jid);
  e.confirmar(jid,comprovante);
  e.db.prepare('UPDATE eventos SET texto=? WHERE id=?').run('Texto corrigido depois da confirmação.',comprovante);
  const contato=e.grafo.desktop.contatos({periodo:'semana',agora}).contatos[0];
  assert.equal(contato.nome,'Bia');
  assert.equal(contato.mensagensPeriodo,1);
  assert.equal(contato.fonteId,comprovante);
  assert.equal(contato.compromissoPendenteComprovado,false);
  assert.equal(contato.compromissoFonteId,null);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {perfilGrafo} from './fixtures/graph-profile.js';
import {registrarPessoa} from '../src/pessoas.js';
import {assinaturaFonte} from '../src/tarefas-esquema.js';

function env(t){
  const db=abrirBanco();t.after(()=>db.close());const e={db,...perfilGrafo(db)};
  e.acao=(evento,tipo='lead')=>{const fonte=db.prepare('SELECT * FROM eventos WHERE id=?').get(evento);return Number(db.prepare("INSERT INTO itens_crm(conversa_id,origem_id,tipo,resumo,extraido_em) VALUES(?,?,?,'Conferir a proposta','2026-09-18T12:00:00Z')").run(fonte.conversa_id,fonte.origem_id,tipo).lastInsertRowid);};
  return e;
}
test('conversas: leitura pessoal inclui terceiro local, mas não concede fonte sem permissão',t=>{
  const e=env(t);e.conversa('a','Ação permitida');e.conversa('b','NEGOCIO_SECRETO');
  const id=e.evento('a','p'),item=e.acao(id);e.acao(e.evento('a','p',{permissao:'terceiro'}));e.acao(e.evento('b','SEGREDO',{permissao:null}));
  const list=e.desktop.carteira({q:'acao',filtro:'oportunidades'});assert.equal(list.pagina.total,1);assert.equal(list.conversas[0].acoes,2);assert.equal(list.conversas[0].mensagens,2);
  assert.equal(e.desktop.carteira({q:'secreto'}).pagina.total,0);assert.throws(()=>e.desktop.conversaDetalhe({conversa:'b'}),/indisponível/);
  assert.ok(!JSON.stringify(e.desktop.carteira()).includes('SEGREDO'));
  e.desktop.politica({conversa:'b',politica:'tudo'});assert.equal(e.desktop.carteira().pagina.total,1);
  e.desktop.politica({conversa:'b',politica:'so-minhas'});assert.equal(e.desktop.carteira().pagina.total,1);
  e.desktop.resolver({id:item});assert.equal(e.desktop.carteira({filtro:'acoes'}).pagina.total,1);
});
test('conversas: páginas alcançam todas as conversas, ações e pessoas sem repetição',t=>{
  const e=env(t);for(let c=0;c<27;c++){e.conversa('c'+c);for(let p=0;p<25;p++){const id=e.evento('c'+c,'p'+p);if(c===0)e.acao(id,p%2?'lead':'pendencia');}}
  const ids=[];for(let p=1;p<=3;p++)ids.push(...e.desktop.carteira({pagina:p}).conversas.map(c=>c.id));assert.equal(new Set(ids).size,27);assert.equal(ids.length,27);assert.equal(ids[0],'c0');
  const people=[],tasks=[];for(let p=1;p<=5;p++){const d=e.desktop.conversaDetalhe({conversa:'c0',paginaPessoas:p,paginaAcoes:p});people.push(...d.pessoas.map(p=>p.id));tasks.push(...d.tarefas.map(a=>a.id));assert.equal(d.acoes,25);assert.equal(d.pessoas.length,p<5?6:1);}
  assert.equal(new Set(people).size,25);assert.equal(new Set(tasks).size,25);assert.equal(people.length,25);assert.equal(tasks.length,25);
  assert.equal(e.desktop.carteira({pagina:999}).pagina.numero,3);assert.equal(e.desktop.conversaDetalhe({conversa:'c0',paginaAcoes:999}).paginaAcoes.numero,5);
});
test('conversas: nomes iguais não fundem identificadores; autores locais aparecem',t=>{
  const e=env(t);e.conversa('a');for(const id of ['p1','p2','oculto']){registrarPessoa(e.db,{identificador:id,nomeCru:'Ana Silva'});e.evento('a',id,{permissao:id==='oculto'?'terceiro':'dirigida'});}
  e.evento('a',null);const d=e.desktop.conversaDetalhe({conversa:'a'});assert.equal(d.pessoas.length,3);assert.deepEqual(d.pessoas.map(p=>p.nome),['Ana Silva','Ana Silva','Ana Silva']);assert.deepEqual(d.pessoas.map(p=>p.id),['oculto','p1','p2']);
  for(const p of d.pessoas)assert.equal(e.desktop.fonte(p.fonte_id).autor_id,p.id);
  assert.ok(!JSON.stringify(d).includes('bruto'));
});
test('conversas: alteração ou remoção de fonte invalida a ação derivada',t=>{
  const e=env(t);e.conversa('a');const id=e.evento('a','p'),item=e.acao(id,'pendencia');
  const f=e.db.prepare('SELECT * FROM desktop_fontes WHERE id=?').get(id);
  e.db.prepare("INSERT INTO desktop_tarefas_sugestoes(id,evento_id,tipo,resumo,trecho,prazo_citado,fontes_total,criada_em,estado,item_id) VALUES('s',?,'pendencia','Revisar','Mensagem','',1,'2026-09-18','aceita',?)").run(id,item);
  e.db.prepare("INSERT INTO desktop_tarefas_fontes VALUES('s',?,?)").run(id,assinaturaFonte(f));
  assert.equal(e.desktop.conversaDetalhe({conversa:'a'}).acoes,1);
  e.db.prepare("UPDATE eventos SET texto='Fonte mudou' WHERE id=?").run(id);
  assert.equal(e.desktop.conversaDetalhe({conversa:'a'}).acoes,0);assert.equal(e.desktop.carteira({filtro:'acoes'}).pagina.total,0);
  e.db.prepare('DELETE FROM eventos WHERE id=?').run(id);assert.equal(e.desktop.carteira().pagina.total,0);
});
test('conversas: exibição não atribui nome por coincidência entre número e LID',t=>{
  const e=env(t);e.conversa('a');registrarPessoa(e.db,{identificador:'551199999@lid',nomeCru:'Maria Souza'});
  e.evento('a','551199999');e.evento('a','551199999@lid');e.evento('a','sem-nome');
  const d=e.desktop.conversaDetalhe({conversa:'a'});assert.equal(d.pessoas.length,3);
  assert.equal(d.pessoas.filter(p=>p.nome==='Maria Souza').length,1);
  assert.equal(d.pessoas.find(p=>p.id==='551199999').nome,'Nome não disponível');
  assert.equal(d.pessoas.find(p=>p.id==='sem-nome').nome,'Nome não disponível');
  const conhecida=d.pessoas.find(p=>p.id==='551199999@lid');
  assert.equal(conhecida.nome,e.desktop.fonte(conhecida.fonte_id).autor_nome);
});
test('conversas: F10 inclui só fontes com procedência e revoga imediatamente',t=>{
  const e=env(t);e.conversa('a');const id=e.evento('a','p',{permissao:'compartilhado'});e.acao(id);e.evento('a','vazamento',{permissao:'compartilhado'});
  e.db.exec(`INSERT INTO f10_projetos VALUES('x','Teste','2026-09-17'); INSERT INTO f10_origens VALUES('f','Teste','m','k');
    INSERT INTO f10_procedencias(evento_id,fingerprint,pacote_id,projeto_id,exportado_em,importado_em) VALUES(${id},'f','p','x','2026-09-17','2026-09-17')`);
  const d=e.desktop.conversaDetalhe({conversa:'a'});assert.equal(d.mensagens,1);assert.equal(d.acoes,1);assert.ok(!JSON.stringify(d).includes('vazamento'));
  e.db.exec('DELETE FROM f10_procedencias');assert.equal(e.desktop.carteira().pagina.total,0);assert.throws(()=>e.desktop.conversaDetalhe({conversa:'a'}));
});
test('conversas: recusa entradas inválidas e não cria dados em consultas vazias',t=>{
  const e=env(t);for(const q of [{q:3},{q:'x'.repeat(201)},{pagina:0},{pagina:NaN},{filtro:'ganho'}])assert.throws(()=>e.desktop.carteira(q));
  for(const q of [{},{conversa:'x',paginaAcoes:0},{conversa:'x',paginaPessoas:1.2},{conversa:'x'.repeat(201)}])assert.throws(()=>e.desktop.conversaDetalhe(q));
  assert.equal(e.desktop.carteira().pagina.total,0);assert.equal(e.db.prepare('SELECT count(*) n FROM eventos').get().n,0);
});

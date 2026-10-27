import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {PersonalidadePessoal,sanitizarBaloes} from '../src/pessoal/personalidade.js';

function setup(t){
  const db=abrirBanco();t.after(()=>db.close());new ContextoApp(db);new DesktopIA(db);
  const pessoa=new PersonalidadePessoal(db);let n=0;
  const inserir=(conversa,texto,dono=1,bot=0,permissao='minha')=>Number(db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao,autor_e_dono,do_proprio_bot) VALUES(?,?,'saida','texto','{}',?,'2026-10-26T10:00:00Z','2026-10-26',?,?,?)`).run(conversa,String(++n),texto,permissao,dono,bot).lastInsertRowid);
  const permitir=id=>db.prepare("INSERT INTO desktop_ia_conversas VALUES(?,1,'2026-10-26')").run(id);
  return {db,pessoa,inserir,permitir};
}

test('personalidade: só exemplos próprios reais da conversa exata; bot e terceiros excluídos',t=>{
  const f=setup(t),id=f.inserir('a','Fechado, vejo isso pela manhã.');
  f.inserir('a','Resposta automática.',1,1);f.inserir('a','Mensagem de terceiro.',0,0);f.inserir('b','Estilo de outro cliente.');
  assert.deepEqual(f.pessoa.exemplos({conversaId:'a'}),[]);f.permitir('a');
  const exemplos=f.pessoa.exemplos({conversaId:'a'});assert.deepEqual(exemplos.map(e=>e.id),[id]);assert.equal(exemplos[0].texto,'Fechado, vejo isso pela manhã.');
  f.db.prepare('UPDATE desktop_ia_conversas SET permitida=0').run();assert.deepEqual(f.pessoa.exemplos({conversaId:'a'}),[]);
  assert.equal(f.pessoa.exemplos({conversaId:'a',remoto:false}).length,1);
});

test('personalidade: correção persiste no config existente, limitada ao contexto e opt-in',t=>{
  const f=setup(t);f.inserir('a','Fonte do contexto A.');f.inserir('b','Fonte do contexto B.');
  f.pessoa.corrigir({conversaId:'a',texto:'**Não usar emojis** com este contato.'});
  const outra=new PersonalidadePessoal(f.db);
  assert.equal(outra.correcoes({conversaId:'a'})[0].texto,'Não usar emojis com este contato.');assert.deepEqual(outra.correcoes({conversaId:'b'}),[]);
  assert.deepEqual(outra.correcoes({conversaId:'a',remoto:true}),[]);f.permitir('a');assert.equal(outra.correcoes({conversaId:'a',remoto:true}).length,1);
  f.db.prepare("UPDATE eventos SET permissao=NULL WHERE conversa_id='a'").run();assert.deepEqual(outra.correcoes({conversaId:'a'}),[]);
});

test('personalidade: ausência de exemplos permanece explícita e fontes revogadas não retornam',t=>{
  const f=setup(t);f.permitir('a');assert.deepEqual(f.pessoa.exemplos({conversaId:'a'}),[]);
  const id=f.inserir('a','Mensagem manual válida.');assert.equal(f.pessoa.exemplos({conversaId:'a'}).length,1);
  f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(id);assert.deepEqual(f.pessoa.exemplos({conversaId:'a'}),[]);
});

test('personalidade: sanitização remove controles, HTML/Markdown e rejeita perda silenciosa de balões',()=>{
  assert.deepEqual(sanitizarBaloes(['\u0000<b>Olá</b> **Ana**\u202e','## Detalhes\n<script>alert(1)</script>[arquivo](https://example.test)']),['Olá Ana','Detalhes\narquivo (https://example.test)']);
  assert.equal(sanitizarBaloes(['Um','Dois','Três','Quatro']).length,4);
  assert.deepEqual(sanitizarBaloes('Link: https://example.test/meu_arquivo'),['Link: https://example.test/meu_arquivo']);
  assert.throws(()=>sanitizarBaloes(['1','2','3','4','5']),/1 a 4/);
  assert.throws(()=>sanitizarBaloes(['<script>oops</script>']),/vazia/);
  assert.throws(()=>sanitizarBaloes(['A'.repeat(6001)]),/6000/);
  assert.throws(()=>sanitizarBaloes([]),/1 a 4/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {registrarPessoa} from '../src/pessoas.js';
function fixture(t){
 const db=abrirBanco();new ContextoApp(db);const desktop=new Desktop(db);t.after(()=>db.close());
 db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('123456@lid','Cliente de teste');
 const insert=(id,text,date,permissao='dirigida')=>db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
 VALUES('123456@lid',?,'entrada','123456@lid',0,'texto','{}',?,?,?,?)`).run(id,text,date,date.slice(0,10),permissao);
 return {db,desktop,insert};
}
test('busca usa a data da conversa mesmo quando história antiga chega depois, com paginação estável',t=>{
 const {desktop,insert}=fixture(t);
 insert('atual','Entrega revista','2026-10-26T10:00:00Z');
 insert('ontem','Entrega anterior','2026-10-25T10:00:00Z');
 insert('historica','Entrega antiga','2026-01-21T10:00:00Z');
 const a=desktop.buscar({limite:1}),b=desktop.buscar({limite:1,antes:a.proximoAntes}),c=desktop.buscar({limite:1,antes:b.proximoAntes});
 assert.deepEqual([a,b,c].map(p=>p.mensagens[0].origem_id),['atual','ontem','historica']);assert.equal(c.proximoAntes,null);
});
test('busca encontra palavras com acentos e ordem diferente sem aceitar só uma saudação',t=>{
 const {desktop,insert}=fixture(t);
 insert('relevante','Vitória, sobre o orçamento da entrega: está em revisão.','2026-10-26T10:00:00Z');
 insert('saudacao','Bom dia Vitória, beleza?','2026-10-26T11:00:00Z');
 insert('oculta','Vitória orçamento entrega','2026-10-26T12:00:00Z',null);
 assert.deepEqual(desktop.buscar({q:'entrega orcamento Vitoria'}).mensagens.map(m=>m.origem_id),['relevante']);
});
test('fonte exibe o nome persistido pelo identificador exato, sem inferir alias numérico',t=>{
 const {db,desktop,insert}=fixture(t);insert('fonte','Teste','2026-10-26T10:00:00Z');
 registrarPessoa(db,{identificador:'123456@s.whatsapp.net',nomeCru:'Outra pessoa',origem:'manual'});
 const result=desktop.buscar();assert.equal(result.mensagens[0].conversa_nome,'Cliente de teste');
 assert.notEqual(result.mensagens[0].autor_nome,'Outra pessoa');
});

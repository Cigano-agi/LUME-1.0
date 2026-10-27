import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';

test('HTTP: nota não aceita fonte revogada por NULL mesmo sob política tudo',async t=>{
  const db=abrirBanco();
  const conexao={estado:()=>({estado:'desconectada',qr:null}),parar:async()=>{}};
  const server=criarServidor(db,{conexao,desktop:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const {token}=await (await fetch(base+'/api/sessao')).json();
  const headers={'Content-Type':'application/json','X-Assessor-Token':token};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post('/api/v3/aceite',{nome:'Teste',aceito:true,versao:VERSAO_TERMOS})).status,200);
  assert.equal((await post('/api/v3/nota',{texto:'Fonte sintética'})).status,201);
  const fonte=db.prepare("SELECT id,conversa_id FROM eventos WHERE tipo='nota'").get();
  assert.equal((await post('/api/v3/politica',{conversa:fonte.conversa_id,politica:'tudo'})).status,200);
  db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(fonte.id);
  const antes=db.prepare('SELECT COUNT(*) total FROM eventos').get().total;
  const resposta=await post('/api/v3/nota',{texto:'Vínculo indevido',fontes:[fonte.id]});
  assert.equal(resposta.status,400);
  assert.match((await resposta.json()).erro,/Fonte da nota indisponível/);
  assert.equal(db.prepare('SELECT COUNT(*) total FROM eventos').get().total,antes);
});

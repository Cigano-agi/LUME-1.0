import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { criarServidor } from '../src/painel/servidor.js';

test('comunidades mede autoria em 30 dias, inclui grupos inativos e ignora tamanho como sinal', async t => {
  const db=abrirBanco(),contexto=new ContextoApp(db);
  contexto.salvarGrupos([{id:'leitura@g.us',subject:'Leitura',size:5},{id:'troca@g.us',subject:'Troca',size:800},{id:'vazio@g.us',subject:'Vazio',size:12}]);
  const now=Math.floor(Date.now()/1000);
  contexto.receber({messages:[
    {key:{remoteJid:'leitura@g.us',id:'1',fromMe:false},message:{conversation:'Recebida'},messageTimestamp:now},
    {key:{remoteJid:'leitura@g.us',id:'2',fromMe:true},message:{conversation:'Antiga'},messageTimestamp:now-31*86400},
    {key:{remoteJid:'troca@g.us',id:'3',fromMe:true},message:{conversation:'Minha'},messageTimestamp:now},
    {key:{remoteJid:'troca@g.us',id:'4',fromMe:false},message:{conversation:'Outra'},messageTimestamp:now}
  ]});
  const server=criarServidor(db,{contexto,conexao:{estado:()=>({estado:'desconectada'})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));db.close()});
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/comunidades');assert.equal(response.status,200);
  const data=await response.json();const groups=Object.fromEntries(data.grupos.map(g=>[g.id,g]));
  assert.equal(data.grupos.length,3);assert.ok(Date.parse(data.desde));
  assert.equal(groups['leitura@g.us'].mensagens,1);assert.equal(groups['leitura@g.us'].proprias,0);
  assert.equal(groups['troca@g.us'].mensagens,2);assert.equal(groups['troca@g.us'].proprias,1);
  assert.equal(groups['vazio@g.us'].mensagens,0);assert.equal(groups['vazio@g.us'].ultimaMensagemEm,null);
  assert.equal((await (await fetch(base+'/api/grupos')).json()).length,3);
});

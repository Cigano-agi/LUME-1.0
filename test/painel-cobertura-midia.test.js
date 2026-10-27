import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop,VERSAO_TERMOS} from '../src/desktop.js';
import {criarServidor} from '../src/painel/servidor.js';
import {chaveExclusao} from '../src/exclusoes.js';

test('cobertura de mídia por conversa exige sessão e não confunde histórico desconhecido com download',async t=>{
  const db=abrirBanco();
  const contexto=new ContextoApp(db);
  for(const conversa of ['primeira@s.whatsapp.net','segunda@s.whatsapp.net'])contexto.receber({messages:[{
    key:{remoteJid:conversa,id:'audio-'+conversa},message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794100
  }]});
  contexto.receber({messages:[
    {key:{remoteJid:'mista@s.whatsapp.net',id:'texto'},message:{conversation:'legível'},messageTimestamp:1788794100},
    {key:{remoteJid:'mista@s.whatsapp.net',id:'audio-oculto'},message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794101},
    {key:{remoteJid:'so-oculta@s.whatsapp.net',id:'audio-oculto'},message:{audioMessage:{mimetype:'audio/ogg'}},messageTimestamp:1788794102},
  ]});
  for(const row of db.prepare("SELECT conversa_id,origem_id FROM eventos WHERE origem_id='audio-oculto'").all())
    db.prepare('INSERT INTO priv_excluidos VALUES(?,?)').run(chaveExclusao(row.conversa_id,row.origem_id),'2026-09-28T12:00:00Z');
  const desktop=new Desktop(db);
  desktop.aceitar({nome:'Perfil sintético',aceito:true,versao:VERSAO_TERMOS});
  const server=criarServidor(db,{conexao:{estado:()=>({estado:'desconectada',qr:null})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await server.encerrar();db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const path='/api/v3/conversas/cobertura-midia?conversa='+encodeURIComponent('primeira@s.whatsapp.net');
  assert.equal((await fetch(base+path)).status,403);
  const {token}=await (await fetch(base+'/api/sessao')).json();
  const headers={'x-assessor-token':token};
  assert.equal((await fetch(base+'/api/v3/conversas/cobertura-midia',{headers})).status,400);
  assert.equal((await fetch(base+path+'&extra=1',{headers})).status,400);
  assert.equal((await fetch(base+'/api/v3/conversas/cobertura-midia?conversa=sem-acesso',{headers})).status,404);
  const response=await fetch(base+path,{headers});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.cobertura.recebidas,1);
  assert.equal(body.cobertura.pendentes,1);
  assert.equal(body.cobertura.baixadas,0);
  assert.equal(body.cobertura.desconhecidas,0);
  assert.equal(body.historico,'desconhecido');
  assert.equal(JSON.stringify(body).includes('segunda@s.whatsapp.net'),false);
  const mista=await (await fetch(base+'/api/v3/conversas/cobertura-midia?conversa='+encodeURIComponent('mista@s.whatsapp.net'),{headers})).json();
  assert.equal(mista.cobertura.recebidas,0);
  assert.equal(mista.cobertura.excluidas,0);
  assert.equal((await fetch(base+'/api/v3/conversas/cobertura-midia?conversa='+encodeURIComponent('so-oculta@s.whatsapp.net'),{headers})).status,404);
});

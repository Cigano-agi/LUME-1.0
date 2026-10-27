import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { Desktop, VERSAO_TERMOS } from '../src/desktop.js';

test('guia: escolha persiste entre instâncias e pode ser desfeita, sem mudar aceite', t=>{
  const db=abrirBanco();t.after(()=>db.close());const desktop=new Desktop(db);
  assert.equal(desktop.perfil().guiaDispensado,false);
  assert.throws(()=>desktop.configurarGuia({dispensado:true}),/primeiro acesso/);
  const initial=desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});
  desktop.configurarGuia({dispensado:true});
  const reopened=new Desktop(db);
  assert.equal(reopened.perfil().guiaDispensado,true);
  assert.equal(reopened.perfil().aceitoEm,initial.aceitoEm);
  assert.equal(reopened.configurarGuia({dispensado:false}).guiaDispensado,false);
});
test('guia: valores inválidos não escondem instruções nem alteram perfil',t=>{
  const db=abrirBanco();t.after(()=>db.close());const desktop=new Desktop(db);
  desktop.aceitar({nome:'Pessoa de teste',aceito:true,versao:VERSAO_TERMOS});
  for(const dispensado of ['true',1,null,undefined])assert.throws(()=>desktop.configurarGuia({dispensado}));
  assert.equal(desktop.perfil().guiaDispensado,false);
});

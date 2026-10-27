import test from 'node:test';
import assert from 'node:assert/strict';
import {autoriaParaLaya,mensagemEncaminhada} from '../src/laya/autoria.js';

const raw=contextInfo=>JSON.stringify({tipoLote:'notify',mensagem:{message:{extendedTextMessage:{text:'Confirme a data.',contextInfo}}}});

test('forwarded flag or score suppresses action inference, including own forwards',()=>{
  assert.equal(mensagemEncaminhada(raw({isForwarded:true})),true);
  assert.equal(mensagemEncaminhada(raw({forwardingScore:2})),true);
  assert.equal(autoriaParaLaya({bruto:raw({isForwarded:true}),autor_e_dono:1,permissao:'minha'}),'terceiro');
  assert.equal(autoriaParaLaya({bruto:raw({}),autor_e_dono:1,permissao:'minha'}),'proprio');
  assert.equal(autoriaParaLaya({bruto:raw({}),autor_e_dono:0,permissao:'minha'}),'outro');
});

test('wrapped forwards, imported content and unreadable envelopes fail closed',()=>{
  const wrapped=JSON.stringify({mensagem:{message:{ephemeralMessage:{message:{extendedTextMessage:{text:'Confirme a data.',contextInfo:{isForwarded:true}}}}}}});
  assert.equal(mensagemEncaminhada(wrapped),true);
  assert.equal(autoriaParaLaya({bruto:raw({}),autor_e_dono:0,permissao:'compartilhado'}),'terceiro');
  assert.equal(autoriaParaLaya({bruto:'{',autor_e_dono:0,permissao:'minha'}),'terceiro');
  assert.equal(autoriaParaLaya({bruto:'x'.repeat(1_000_001),autor_e_dono:0,permissao:'minha'}),'terceiro');
});

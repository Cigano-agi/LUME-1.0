import test from 'node:test';
import assert from 'node:assert/strict';
import {mascararDonoParaModelo} from '../src/laya/owner-mask.js';

test('modelo recebe alias estável sem alterar outros nomes nem o texto de origem', () => {
  const original='Fabrício, confirme com Bia. O Fabricio sem acento está em outra frase.';
  assert.equal(mascararDonoParaModelo(original,'Fabrício'),'Dono, confirme com Bia. O Dono sem acento está em outra frase.');
  assert.equal(original,'Fabrício, confirme com Bia. O Fabricio sem acento está em outra frase.');
  assert.equal(mascararDonoParaModelo('Dono, confirme com Bia.','Dono'),'Dono, confirme com Bia.');
  assert.equal(mascararDonoParaModelo('Dona, confirme. Dono, revise.','Dono'),'Dona, confirme. Dono, revise.');
  assert.equal(mascararDonoParaModelo('Joao Silva, revise. João Silva confirma.','João Silva'),'Dono, revise. Dono confirma.');
  assert.throws(()=>mascararDonoParaModelo('Texto',' '),/NOME_DO_DONO_INVALIDO/);
});

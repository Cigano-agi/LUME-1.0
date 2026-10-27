import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreActions} from '../scripts/laya-eval-actions-lib.mjs';

test('medição casa múltiplas ações uma vez e separa falso positivo de omissão',()=>{
  const expected=[{tipo:'pendencia',trecho:'Confirme a data da reunião.'},{tipo:'pendencia',trecho:'Envie a pauta ao time.'}];
  const actual=[{tipo:'pendencia',trecho:'Confirme a data da reunião.'},{tipo:'compromisso',trecho:'Envie a pauta ao time.'},{tipo:'pendencia',trecho:'Confirme a data da reunião.'}];
  const result=scoreActions(expected,actual);
  assert.deepEqual({tp:result.tp,fp:result.fp,fn:result.fn},{tp:1,fp:2,fn:1});
});

test('medição ignora acento e exige metade dos tokens de ambos os trechos',()=>{
  const same=scoreActions([{tipo:'compromisso',trecho:'Eu enviarei a revisão amanhã.'}],[{tipo:'compromisso',trecho:'Eu enviarei a revisao amanha.'}]);
  assert.deepEqual({tp:same.tp,fp:same.fp,fn:same.fn},{tp:1,fp:0,fn:0});
  const result=scoreActions([{tipo:'pendencia',trecho:'Confirme o pagamento da proposta amanhã.'}],[{tipo:'pendencia',trecho:'pagamento'}]);
  assert.deepEqual({tp:result.tp,fp:result.fp,fn:result.fn},{tp:0,fp:1,fn:1});
});

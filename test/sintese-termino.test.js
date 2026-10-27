import test from 'node:test';
import assert from 'node:assert/strict';
import {terminoGeracao} from '../scripts/lib/sintese-termino.mjs';
const base={tokensSaida:1024,ultimoToken:151645n,eosTokenIds:[151645,151643],expirou:false,limiteTokens:1024};
test('EOS natural exatamente no teto não é truncamento',()=>{
  assert.deepEqual(terminoGeracao(base),{interrompida:false,motivo:null,ultimoToken:151645,terminouEmEos:true});
  assert.equal(terminoGeracao({...base,ultimoToken:151643}).interrompida,false);
});
test('teto sem EOS continua interrompido e timeout tem precedência',()=>{
  assert.equal(terminoGeracao({...base,ultimoToken:12n}).motivo,'tokens');
  assert.equal(terminoGeracao({...base,tokensSaida:1025}).motivo,'tokens');
  assert.equal(terminoGeracao({...base,expirou:true}).motivo,'tempo');
  assert.equal(terminoGeracao({...base,ultimoToken:12,expirou:true}).motivo,'tempo');
});
test('EOS escalar, limite não alcançado e saída vazia são distintos',()=>{
  assert.equal(terminoGeracao({...base,eosTokenIds:151645n}).terminouEmEos,true);
  assert.equal(terminoGeracao({...base,tokensSaida:30,ultimoToken:20}).interrompida,false);
  assert.equal(terminoGeracao({...base,tokensSaida:0,ultimoToken:undefined}).terminouEmEos,false);
});
test('IDs desconhecidos não são promovidos a término natural por coerção',()=>{
  for(const ultimoToken of ['151645',null,undefined,-1,NaN,2n**80n])assert.equal(terminoGeracao({...base,ultimoToken}).terminouEmEos,false);
  assert.equal(terminoGeracao({...base,eosTokenIds:['151645',null]}).interrompida,true);
});
test('contagem e limite inválidos são recusados',()=>{
  for(const change of [{tokensSaida:-1},{tokensSaida:1.5},{limiteTokens:0},{expirou:'false'}])assert.throws(()=>terminoGeracao({...base,...change}),/TERMINO_INVALIDO/);
});

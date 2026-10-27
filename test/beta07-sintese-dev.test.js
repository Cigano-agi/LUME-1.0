import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validarCaso,validarSaida,limite,erroRepetido,comPrazo} from '../scripts/beta07-sintese-dev.mjs';

const casos=JSON.parse(await readFile(new URL('./fixtures/beta07-sintese-ajuste.json',import.meta.url)));
test('corpus DEV tem 30 casos distintos e fontes curtas, sem entrada externa',()=>{
  assert.equal(casos.length,30);assert.equal(new Set(casos.map(x=>x.id)).size,30);
  for(const c of casos)assert.doesNotThrow(()=>validarCaso(c));
  for(const tema of ['autoria','negação','datas','valores','condicional','estado','injeção','abstenção'])assert.ok(casos.some(c=>c.tema===tema));
  assert.throws(()=>validarCaso({...casos[0],fontes:[{id:'E1',autor:'X',data:'X',texto:'x'.repeat(701)}]}),/LIMITE/);
});
test('saída exige fonte exata, autoria e estado limitado',()=>{
  assert.deepEqual(validarSaida('{"fatos":[],"insuficiente":true}',casos[29]),{fatos:[],insuficiente:true});
  assert.throws(()=>validarSaida('{"fatos":[{"tipo":"acordo","autor":"Pia","estado":"concluído","texto":"pago","fonte":"E9"}],"insuficiente":false}',casos[29]),/FONTE/);
  assert.throws(()=>validarSaida('{"fatos":[{"tipo":"acordo","autor":"","estado":"pendente","texto":"x","fonte":"E1"}],"insuficiente":false}',casos[0]),/AUTOR/);
  assert.throws(()=>validarSaida('{"fatos":[],"insuficiente":false,"tool_calls":[]}',casos[29]),/CAMPOS/);
});
test('limites e cancelamento encerram trabalho',async()=>{
  assert.throws(()=>limite(2049,2048),/LIMITE/);assert.equal(limite(2048,2048),2048);
  assert.equal(erroRepetido(['A','A','A']),true);assert.equal(erroRepetido(['A','B','A']),false);
  const ctrl=new AbortController();
  await assert.rejects(comPrazo(()=>new Promise(()=>{}),10,ctrl),/PRAZO/);
  assert.equal(ctrl.signal.aborted,true);
});

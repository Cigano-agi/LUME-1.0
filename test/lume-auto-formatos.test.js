// Synthetic literal excerpts. No account, personal data, network or DB writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OrganizadorConversas} from '../src/pessoal/organizador.js';
const validar=(trecho)=>OrganizadorConversas.prototype.validarResultado.call({},
  {assuntos:[{nome:'Catálogo',trecho,confianca:.98}],tags:[],vinculos:[],oportunidades:[],compromissos:[],acontecimentos:[],perguntas:[]},
  {texto:trecho,conversa_id:'synthetic@g.us'});
test('literal multilinha preserva quebras e tabulação presentes na fonte',()=>{
  const trecho='Catálogo da equipe:\n\tpreparar a revisão amanhã.';
  assert.equal(validar(trecho).assuntos[0].trecho,trecho);
});
test('controle não textual continua inválido no trecho',()=>{
  assert.throws(()=>validar('Catálogo\u0000 da equipe: revisar amanhã.'),e=>e.code==='FONTE_INVALIDA');
});

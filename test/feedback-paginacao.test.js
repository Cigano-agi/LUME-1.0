import {test} from 'node:test';
import assert from 'node:assert/strict';
import {codificarCursorFeedback,normalizarListaFeedback,TAMANHO_PAGINA_FEEDBACK} from '../src/feedback-paginacao.js';

test('feedback: cursor canônico e filtros fechados',()=>{
  const item={id:'c1651b65-1f95-49d7-9fa2-e08c904826ba',criadoEm:'2026-09-25T12:00:00.000Z'};
  const cursor=codificarCursorFeedback(item),query=normalizarListaFeedback({etapa:'hoje',estado:'novo',versao:'3.2.0-beta.6',cursor});
  assert.equal(TAMANHO_PAGINA_FEEDBACK,20);
  assert.deepEqual(query.cursor,{em:item.criadoEm,id:item.id});
  assert.equal(query.etapa,'hoje');assert.equal(query.severidade,null);
  for(const filtro of [{cursor:'abc'}, {etapa:'financeiro'}, {estado:'todos'}, {versao:'3.2?x'}, {plataforma:'linux'}, {interna:'segredo'}])assert.throws(()=>normalizarListaFeedback(filtro),/FILTRO_FEEDBACK_INVALIDO/);
});

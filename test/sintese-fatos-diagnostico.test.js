import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {casos,trabalhos,protocolo,requisicao,LIMITES,PARAMETROS,RUBRICA,validarEstrutura,interpretarSSE} from '../scripts/lib/sintese-fatos-diagnostico.mjs';
import {interpretarSSE as anterior,processo,requisicao as requestAnterior} from '../scripts/lib/sintese-dev-runtime.mjs';

const frame=choice=>'data: '+JSON.stringify({choices:[{index:0,delta:{},...choice}]})+'\n\n';
const content=frame({delta:{content:'ação'}}),stop=frame({finish_reason:'stop'}),done='data: [DONE]\n\n';
test('somente dois casos conhecidos e uma chamada por caso/formato, sem rubrica no pedido',()=>{
  const jobs=trabalhos();assert.equal(jobs.length,4);assert.equal(new Set(jobs.map(j=>j.id)).size,4);assert.equal(LIMITES.chamadas,4);
  assert.deepEqual(casos().map(c=>c.id),['dev-01-acordo','dev-04-cancelamento-parcial']);
  for(const j of jobs){
    const c=casos().find(c=>c.id===j.caso);assert.deepEqual(JSON.parse(j.request.messages[1].content),{fontes:c.fontes});
    for(const rows of Object.values(RUBRICA))for(const row of rows)assert.ok(!JSON.stringify(j.request).includes(row.fato));
    assert.ok(!j.request.messages[0].content.includes('Otávio'));assert.ok(!j.request.messages[0].content.includes('etiqueta'));
  }
  assert.equal(Object.values(protocolo().rubrica).flat().length,11);
});
test('amostragem idêntica entre formatos e tentativa 2 histórica',()=>{
  const fonte=casos()[0].fontes,a=requisicao(fonte,'livre'),b=requisicao(fonte,'fatos'),prior=requestAnterior(fonte,2);
  for(const k of Object.keys(PARAMETROS)){assert.deepEqual(a[k],b[k]);assert.deepEqual(a[k],prior[k]);}
  assert.equal(a.response_format,undefined);assert.equal(b.response_format.type,'json_object');
  assert.throws(()=>requisicao(fonte,'cartao'));
});
test('fatos permite ausência honesta, mas recusa null, campo extra, fonte inexistente e duplicação',()=>{
  const fontes=casos()[0].fontes;
  assert.equal(validarEstrutura('{"fatos":[]}',fontes,'fatos').quantidade,0);
  const f={sujeito:'Teste',acao:'Ação',estado:'futuro',condicao:'',fonte:['E1']};
  assert.equal(validarEstrutura(JSON.stringify({fatos:[f]}),fontes,'fatos').aprovacaoSemantica,false);
  for(const patch of [{sujeito:null},{estado:''},{fonte:['E9']},{fonte:['E1','E1']},{extra:'x'}])assert.throws(()=>validarEstrutura(JSON.stringify({fatos:[{...f,...patch}]}),fontes,'fatos'));
});
test('estrutura e referência existente deliberadamente não aprovam falsidade',()=>{
  const f={sujeito:'Marília',acao:'enviou a lista',estado:'concluído',condicao:'',fonte:['E1']};
  const r=validarEstrutura(JSON.stringify({fatos:[f]}),casos()[0].fontes,'fatos');assert.equal(r.aprovacaoSemantica,false);
  assert.equal(validarEstrutura('Tudo foi concluído.',casos()[0].fontes,'livre').aprovacaoSemantica,false);
});
test('stream real aceita unicode e usage depois do stop, exige fim natural e DONE',()=>{
  const usage='data: '+JSON.stringify({choices:[],usage:{completion_tokens:1}})+'\n\n';
  assert.equal(interpretarSSE(content+stop+usage+done).raw,'ação');
  for(const s of [content+stop,content+done,content+frame({finish_reason:'length'})+done,content+stop+done+done,content+stop+content+done,frame({delta:{reasoning_content:'x'}})+stop+done,frame({index:1,finish_reason:'stop'})+done])assert.throws(()=>interpretarSSE(s));
});
test('regressão da revisão independente: ambos os parsers recusam conteúdo após stop e DONE duplicado',()=>{
  assert.throws(()=>anterior(content+stop+content+done));
  assert.throws(()=>anterior(content+stop+done+done));
  assert.throws(()=>interpretarSSE(content+stop+content+done));
  assert.throws(()=>interpretarSSE(content+stop+done+done));
});
test('CLI recusa execução sem liberação, casos/perfis e modos de retry antes de escrever',async()=>{
  const runner=fileURLToPath(new URL('../scripts/sintese-fatos-diagnostico.mjs',import.meta.url));
  for(const argv of [[],['run'],['run','--cpu-exclusiva-confirmada'],['prepare','--profile=x'],['retry'],['run','--cpu-exclusiva-confirmada','msg_ok','--cases=outro']]){
    const r=await processo(process.execPath,[runner,...argv]);assert.notEqual(r.code,0);assert.match(r.stderr,/USE: node scripts\/sintese-fatos/);
  }
});

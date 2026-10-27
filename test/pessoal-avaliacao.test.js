import test from 'node:test';
import assert from 'node:assert/strict';
import {avaliarExecucao} from '../src/pessoal/avaliacao.js';
import casos from '../src/pessoal/casos-avaliacao.js';
// All review objects below are fabricated test inputs. Even the origin-value
// branch test does not run a model or establish any human approval.
const revisoes=()=>casos.map(c=>({id:c.id,origem:'simulado',interpretacao:true,fontes:true,resposta:true,criticoAtendido:true,
  revisadoPor:'Pessoa fictícia do teste',evidencia:`fixture://avaliacao/${c.id} — entrada fabricada para testar agregação; não é revisão humana real.`}));
const executar=resultados=>avaliarExecucao({casos,resultados});

test('avaliação: corpus tem100 entradas únicas,20críticas e rubricas semânticas fictícias',()=>{
  assert.equal(casos.length,100);assert.equal(casos.filter(c=>c.critico).length,20);
  assert.equal(new Set(casos.map(c=>c.id)).size,100);assert.equal(new Set(casos.map(c=>c.entrada)).size,100);
  assert.equal(new Set(casos.map(c=>c.familia)).size,20);
  assert.ok(casos.every(c=>c.ficticio===true&&c.cenario.includes('FICTÍCIO')));
  for(const c of casos){
    assert.ok(!/[\p{L}]\?[\p{L}]|[\p{L}]É/gu.test(JSON.stringify(c)),'Texto deve preservar UTF-8 sem corrupção nos acentos.');
    for(const d of ['interpretacao','fontes','resposta','critico'])assert.ok(c.criterio[d].length>=20);
    assert.ok(c.esperado.fontes.every(id=>c.contexto.fontes.some(f=>f.id===id)));
  }
  const r=executar(revisoes());assert.deepEqual(r.problemas,[]);
});

test('avaliação: ausência de execução deixa ambos gates fechados',()=>{
  const r=executar([]);assert.equal(r.aprovado,false);assert.equal(r.aprovadoAutonomia,false);
  assert.equal(r.cobertura.revisados,0);assert.equal(r.cobertura.ausentes.length,100);assert.equal(r.falhasCriticas.length,20);
  const vazio=avaliarExecucao();assert.equal(vazio.aprovadoAutonomia,false);assert.ok(vazio.problemas.includes('corpus_deve_ter_100_casos'));
});

test('avaliação: todos passes simulados nunca aprovam autonomia',()=>{
  const r=executar(revisoes());assert.equal(r.aprovado,true);assert.equal(r.aprovadoAutonomia,false);
  assert.equal(r.taxa,1);assert.equal(r.criticosAprovados,20);assert.deepEqual(r.origens,['simulado']);
  assert.match(r.aviso,/não comprova qualidade em conversas reais/);
});

test('avaliação: um crítico reprovado bloqueia apesar de99% de acerto',()=>{
  const resultados=revisoes();resultados[0].criticoAtendido=false;
  const r=executar(resultados);assert.equal(r.taxa,.99);assert.equal(r.aprovado,false);assert.equal(r.aprovadoAutonomia,false);
  assert.deepEqual(r.falhasCriticas,[casos[0].id]);
});

test('avaliação: fonte incorreta reprova crítico mesmo com interpretação e resposta corretas',()=>{
  const resultados=revisoes();resultados[0].fontes=false;
  const r=executar(resultados);assert.equal(r.aprovado,false);assert.deepEqual(r.falhasCriticas,[casos[0].id]);
});

test('avaliação: limiar90% é inclusivo e89% reprova',()=>{
  const resultados=revisoes(),naoCriticos=casos.map((c,i)=>!c.critico?i:null).filter(i=>i!==null);
  for(const i of naoCriticos.slice(0,10))resultados[i].resposta=false;
  const noventa=executar(resultados);assert.equal(noventa.taxa,.9);assert.equal(noventa.aprovado,true);
  resultados[naoCriticos[10]].interpretacao=false;
  const oitentaNove=executar(resultados);assert.equal(oitentaNove.taxa,.89);assert.equal(oitentaNove.aprovado,false);
});

test('avaliação: resultados incompletos ou IDs duplicados não somam cobertura fictícia',()=>{
  const resultados=revisoes();resultados.pop();
  assert.equal(executar(resultados).aprovado,false);
  resultados.push({...resultados[0]});
  const r=executar(resultados);assert.equal(r.aprovadoAutonomia,false);assert.equal(r.cobertura.revisados,99);
  assert.ok(r.problemas.includes('ids_de_resultados_duplicados'));assert.ok(r.problemas.includes('avaliacao_incompleta'));
});

test('avaliação: corpus duplicado ou sem20críticos fica fechado',()=>{
  const duplicado=structuredClone(casos);duplicado[99]=duplicado[98];
  assert.equal(avaliarExecucao({casos:duplicado,resultados:revisoes()}).aprovado,false);
  const faltante=structuredClone(casos);faltante[0].critico=false;
  const r=avaliarExecucao({casos:faltante,resultados:revisoes()});assert.equal(r.aprovado,false);assert.ok(r.problemas.includes('corpus_deve_ter_20_criticos'));
});

test('avaliação: revisor, evidência, origem e booleanos são obrigatórios',()=>{
  for(const campo of ['revisadoPor','evidencia','origem','fontes']){
    const resultados=revisoes();delete resultados[2][campo];
    const r=executar(resultados);assert.equal(r.aprovado,false);assert.ok(r.problemas.includes('revisao_humana_incompleta'));
  }
  const resultados=revisoes();resultados[2].resposta='true';assert.equal(executar(resultados).aprovado,false);
});

test('avaliação: termo esperado ou texto convincente não substitui juízo humano',()=>{
  const resultados=revisoes();resultados[0].interpretacao=false;resultados[0].evidencia='O texto contém todos os termos obrigatórios, mas concedeu desconto sem autorização.';
  assert.equal(executar(resultados).aprovado,false);
});

test('avaliação: origem declarada modelo_real exige100revisões rastreáveis; teste não executa modelo',()=>{
  const resultados=revisoes().map(r=>({...r,origem:'modelo_real'}));
  const r=executar(resultados);assert.equal(r.aprovadoAutonomia,true);assert.equal(r.rastreio.length,100);
  assert.equal(r.rastreio[0].revisadoPor,'Pessoa fictícia do teste');
  assert.match(r.aviso,/declarações rastreáveis a conferir/);
  resultados[3].origem='simulado';assert.equal(executar(resultados).aprovadoAutonomia,false);
  resultados[3].origem='modelo_real';resultados[3].evidencia='';assert.equal(executar(resultados).aprovadoAutonomia,false);
});

test('avaliação: resultado sem caso e ausência de rubrica semântica bloqueiam',()=>{
  const resultados=revisoes();resultados[99].id='INEXISTENTE';assert.ok(executar(resultados).problemas.includes('resultado_sem_caso'));
  const semRubrica=structuredClone(casos);delete semRubrica[1].criterio;
  const r=avaliarExecucao({casos:semRubrica,resultados:revisoes()});assert.equal(r.aprovado,false);assert.ok(r.problemas.includes('caso_ou_rubrica_invalida'));
});

test('avaliação: avaliador não altera casos nem revisões recebidas',()=>{
  const resultados=revisoes(),antes=JSON.stringify({casos,resultados});executar(resultados);
  assert.equal(JSON.stringify({casos,resultados}),antes);
});

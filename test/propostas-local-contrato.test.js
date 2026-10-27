import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pedidoPropostasLocal,conferirPropostasLocal} from '../src/propostas-local-contrato.js';
const fontes=[{id:'E1',autor:'Você',texto:'Enviei uma proposta do site por R$ 2.500,00 para avaliar.'},{id:'E2',autor:'Cliente',texto:'Ainda estou analisando, não confirmei o pagamento.'}];
const valid=()=>({negocios:[{titulo:'Site',etapa:'proposta',valor_centavos:250000,valor:{fonte:'E1',trecho:'R$ 2.500,00'},fontes:[{fonte:'E1',trecho:fontes[0].texto},{fonte:'E2',trecho:fontes[1].texto}]}]});
const check=x=>conferirPropostasLocal(JSON.stringify(x),fontes);
test('proposta local: preserva fontes e aceita abstinência ou evidência exata em reais',()=>{
 const p=pedidoPropostasLocal({fontes});assert.equal(JSON.parse(p[1].content).fontes[1].texto,fontes[1].texto);assert.equal(check({negocios:[]}).negocios.length,0);assert.equal(check(valid()).negocios[0].valor_centavos,250000);
 const unknown=valid();unknown.negocios[0].valor_centavos=null;unknown.negocios[0].valor=null;assert.equal(check(unknown).negocios[0].valor_centavos,null);
});
test('proposta local: recusa fonte inventada, trecho aproximado, repetição ou valor sem referência',()=>{
 for(const mutate of [n=>n.fontes[0].fonte='E9',n=>n.fontes[0].trecho='Proposta de R$ 2.500',n=>n.fontes.push(n.fontes[0]),n=>n.valor.fonte='E9',n=>n.valor.trecho='R$ 2.400,00',n=>n.valor_centavos=25000,n=>n.valor_centavos=2.5,n=>n.valor_centavos=null,n=>n.fontes=[n.fontes[1]]]){const v=valid();mutate(v.negocios[0]);assert.throws(()=>check(v));}
});
test('proposta local: venda fechada, datas e campos inesperados nunca entram como sugestão',()=>{
 for(const mutate of [n=>n.etapa='fechado',n=>n.etapa='pago',n=>n.proximo_contato='2026-10-01',n=>n.titulo='',n=>n.titulo='A\nB',n=>n.valor_centavos=-1]){const v=valid();mutate(v.negocios[0]);assert.throws(()=>check(v));}
 const v=valid();v.negocios.push(v.negocios[0]);assert.throws(()=>check(v));assert.throws(()=>check({...valid(),mensagem:'Enviar agora'}));assert.throws(()=>conferirPropostasLocal('```json\n{}\n```',fontes));
});
test('proposta local: limite de contexto explícito; não corta mensagem silenciosamente',()=>{
 for(const input of [[],[...fontes,fontes[0]],[{...fontes[0],texto:'x'.repeat(1801)}],[{...fontes[0],id:'E0'}],[{...fontes[0],autor:''}]])assert.throws(()=>pedidoPropostasLocal({fontes:input}));
});
test('proposta local: não aceita valor formado pelo prefixo de outro número ou moeda negativa',()=>{
 for(const [texto,trecho,valor] of [['Proposta por R$ 2.500,00.','R$ 2',200],['Valor em ajuste: -R$ 15,00','R$ 15,00',1500],['Valor proposto: R$ 250,00','R$ 25',2500]]){
  const f=[{id:'E1',autor:'Você',texto}],v={negocios:[{titulo:'Teste',etapa:'proposta',valor_centavos:valor,valor:{fonte:'E1',trecho},fontes:[{fonte:'E1',trecho:texto}]}]};assert.throws(()=>conferirPropostasLocal(JSON.stringify(v),f));
 }
 const f=[{id:'E1',autor:'Você',texto:'Enviei a proposta por R$ 2.500,00.'}],v=valid();v.negocios[0].fontes=[{fonte:'E1',trecho:f[0].texto}];assert.equal(conferirPropostasLocal(JSON.stringify(v),f).negocios[0].valor_centavos,250000);
});

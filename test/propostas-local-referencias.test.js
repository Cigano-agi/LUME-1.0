import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepararReferenciasProposta,esquemaReferenciasProposta,conferirReferenciasProposta} from '../src/propostas-local-referencias.js';
const fontes=[{id:'E1',autor:'Você',texto:'Proposta: R$ 2.100,50; entrada R$ 300.'},{id:'E2',autor:'Cliente',texto:'Vou avaliar.'}];
const resposta=()=>({negocios:[{titulo:'Site',etapa:'proposta',etapa_fonte:'E1',fontes:['E1','E2'],valor_ref:'V1'}]});
test('referências: valores e citações vêm dos bytes da fonte, não do modelo',()=>{
 const p=prepararReferenciasProposta(fontes),o=conferirReferenciasProposta(JSON.stringify(resposta()),p,fontes).negocios[0];
 assert.equal(o.valor_centavos,210050);assert.equal(o.valor.trecho,'R$ 2.100,50');assert.equal(fontes[0].texto.slice(o.valor.inicio,o.valor.fim),o.valor.trecho);assert.deepEqual(o.fontes,fontes);
 const altered=resposta();altered.negocios[0].valor_ref=null;assert.equal(conferirReferenciasProposta(JSON.stringify(altered),p,fontes).negocios[0].valor_centavos,null);
 assert.deepEqual(esquemaReferenciasProposta(p).properties.negocios.items.properties.valor_ref.anyOf[0].enum,['V1','V2']);
});
test('referências: rejeita moeda parcial, inválida, negativa e acima do limite',()=>{
 const p=prepararReferenciasProposta([{id:'E1',autor:'A',texto:'R$ 12.34, R$ 4,500, - R$ 15,00; −R$ 8; R$ 999999999999,00. Válidos: R$ 0,00 e R$ 2.500,90.'}]);
 assert.deepEqual(p.valores.map(v=>v.centavos),[0,250090]);
});
test('referências: fonte alterada, autor trocado ou catálogo adulterado invalida tudo',()=>{
 const p=prepararReferenciasProposta(fontes),text=JSON.stringify(resposta());
 assert.throws(()=>conferirReferenciasProposta(text,p,[{...fontes[0],texto:fontes[0].texto+' Correção: retirei.'},fontes[1]]));
 assert.throws(()=>conferirReferenciasProposta(text,p,[{...fontes[0],autor:'Outra pessoa'},fontes[1]]));
 p.valores[0].centavos=1;assert.throws(()=>conferirReferenciasProposta(text,p,fontes));
});
test('referências: recusa IDs inventados, duplicação, preço livre e etapa sem mensagem',()=>{
 const p=prepararReferenciasProposta(fontes);
 for(const mutate of [n=>n.valor_ref='V9',n=>n.fontes=['E2'],n=>n.etapa_fonte='E9',n=>n.fontes.push('E9'),n=>n.fontes.push('E1'),n=>n.valor_centavos=1,n=>n.etapa='fechado',n=>n.titulo='']){
  const v=resposta();mutate(v.negocios[0]);assert.throws(()=>conferirReferenciasProposta(JSON.stringify(v),p,fontes));
 }
 const v=resposta();v.negocios.push(v.negocios[0]);assert.throws(()=>conferirReferenciasProposta(JSON.stringify(v),p,fontes));
});
test('referências: abstinência e vários negócios; entrada não é descartada silenciosamente',()=>{
 const p=prepararReferenciasProposta(fontes);assert.deepEqual(conferirReferenciasProposta('{"negocios":[]}',p,fontes),{negocios:[]});
 const v=resposta();v.negocios.push({...v.negocios[0],titulo:'Outro serviço',valor_ref:'V2'});
 assert.equal(conferirReferenciasProposta(JSON.stringify(v),p,fontes).negocios.length,2);
 // Selection of total vs deposit is still a semantic model decision, explicitly evaluated.
 assert.equal(p.valores[1].centavos,30000);
 const noMoney=prepararReferenciasProposta([{id:'E1',autor:'A',texto:'Quero uma proposta.'}]);
 assert.deepEqual(esquemaReferenciasProposta(noMoney).properties.negocios.items.properties.valor_ref,{type:'null'});
});

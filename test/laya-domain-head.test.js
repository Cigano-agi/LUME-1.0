import test from 'node:test';
import assert from 'node:assert/strict';
import {validarCabecaDominio,avaliarCabecaDominio} from '../src/laya/domain-head.js';
import {carregarCabecaAprovada} from '../src/laya/domain-head.js';
import {extrairAcoesDominio} from '../src/laya/domain-actions.js';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const model={schema:'lume-laya-domain-head-v1',encoderRevision:'revision',
  inputTemplate:'author-channel-message-span-owner-v2',classes:['none','pedido','compromisso'],
  maxTokens:250,threshold:.35,mean:[0,0],scale:[1,2],
  weights:[[0,0],[2,0],[0,2]],bias:[0,0,0],approvedForProduct:false};

test('the shared domain head accepts only the matching candidate class',()=>{
  validarCabecaDominio(model,'revision');
  const request=avaliarCabecaDominio(model,Float32Array.from([1,0]),'pedido');
  assert.equal(request.aceita,true);
  assert.equal(request.classe,'pedido');
  assert.equal(avaliarCabecaDominio(model,Float32Array.from([1,0]),'compromisso').aceita,false);
  assert.equal(avaliarCabecaDominio(model,Float32Array.from([0,2]),'compromisso').aceita,true);
  assert.equal(model.approvedForProduct,false);
});

test('malformed head and non-finite embeddings fail closed',()=>{
  assert.throws(()=>validarCabecaDominio({...model,scale:[1,0]},'revision'),/CABECA_DOMINIO_INVALIDA/);
  assert.throws(()=>validarCabecaDominio({...model,encoderRevision:'other'},'revision'),/CABECA_DOMINIO_INVALIDA/);
  assert.throws(()=>avaliarCabecaDominio(model,[NaN,1],'pedido'),/VETOR_DOMINIO_INVALIDO/);
  assert.throws(()=>avaliarCabecaDominio(model,[1,2],'none'),/VETOR_DOMINIO_INVALIDO/);
});

test('release head needs both pinned hash and explicit approval',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'lume-domain-head-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const approved={...model,approvedForProduct:true};
  const digest=createHash('sha256').update(JSON.stringify(approved)).digest('hex');
  const artifact={summary:{modelSha256:digest,approvedForProduct:true},model:approved};
  await writeFile(join(dir,'domain-head.json'),JSON.stringify(artifact));
  await assert.rejects(carregarCabecaAprovada(dir,{approvedForActions:false,modelSha256:digest},'revision'),/QUALIDADE_PENDENTE/);
  await assert.rejects(carregarCabecaAprovada(dir,{approvedForActions:true,modelSha256:'0'.repeat(64)},'revision'),/NAO_APROVADA/);
  assert.equal((await carregarCabecaAprovada(dir,{approvedForActions:true,modelSha256:digest},'revision')).schema,model.schema);
  await writeFile(join(dir,'domain-head.json'),JSON.stringify({...artifact,model:{...approved,threshold:.1}}));
  await assert.rejects(carregarCabecaAprovada(dir,{approvedForActions:true,modelSha256:digest},'revision'),/NAO_APROVADA/);
});

test('local extractor keeps the literal span and source; owner name is only an input mask',async()=>{
  const seen=[];
  const result=await extrairAcoesDominio({texto:'Fabrício, confirme a data.',fonte:'E17',canal:'dm',autor:'outro',nomeDono:'Fabrício',model,
    embed:async input=>{seen.push(input);return Float32Array.from([1,0]);}});
  assert.deepEqual(result,{candidatas:[{fonte:'E17',tipo:'pendencia',resumo:'Fabrício, confirme a data.',trecho:'Fabrício, confirme a data.',prazo_citado:''}]});
  assert.match(seen[0],/Autor: outro\. Canal: dm\./);
  assert.match(seen[0],/Dono, confirme a data/);
  assert.doesNotMatch(seen[0],/Fabrício/);
  await assert.rejects(extrairAcoesDominio({texto:'Dono, confirme a data.',fonte:'E0',canal:'grupo',autor:'outro',nomeDono:'Dono',model,embed:async()=>[1,0]}),/ENTRADA_ACOES_INVALIDA/);
});

test('direct owner command takes the fast literal path but commercial state mutation is withheld',async()=>{
  const input={fonte:'E18',canal:'grupo',autor:'outro',nomeDono:'Fabrício',model,embed:async()=>{throw Error('direct command should not load an embedding');}};
  const direct=await extrairAcoesDominio({...input,texto:'Fabrício, confirme com o jurídico se o prazo está correto.'});
  assert.equal(direct.candidatas.length,1);
  assert.equal(direct.candidatas[0].trecho,'Fabrício, confirme com o jurídico se o prazo está correto.');
  for(const texto of ['Fabrício, marque o pagamento como recebido.','Fabrício, confirme a proposta como aceita.'])
    assert.deepEqual(await extrairAcoesDominio({...input,texto}),{candidatas:[]});
  assert.deepEqual(await extrairAcoesDominio({...input,autor:'terceiro',texto:'Fabrício, confirme a data.'}),{candidatas:[]});
});

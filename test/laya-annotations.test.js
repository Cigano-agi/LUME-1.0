import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {dividirAnotacoes,validarAnotacoes} from '../scripts/laya-annotations-lib.mjs';

const item=(id,personKey,conversationKey,text='Confirme a data da reunião.',actions=[{type:'request',span:'Confirme a data da reunião.'}])=>({id,personKey,conversationKey,channel:'dm',author:'other',text,critical:false,risks:['none'],actions,rightsConfirmed:true});
const data=()=>({schema:'lume-laya-annotations-v1',purpose:'local-model-improvement',dataKind:'synthetic',reviewedAt:'2026-09-25T12:00:00.000Z',approvedByOwner:true,items:[
  item('ex001','p001','c001'),item('ex002','p001','c002'),item('ex003','p002','c002'),
  item('ex004','p003','c003'),item('ex005','p004','c004'),item('ex006','p005','c005','O arquivo já foi enviado.',[])
]});

test('separação mantém pessoa e conversa no mesmo conjunto, sem texto no resumo',()=>{
  const result=dividirAnotacoes(data());
  assert.equal(result.summary.train.items+result.summary.validation.items+result.summary.test.items,6);
  assert.equal(result.summary.minimumEvaluationVolume,false);
  for(const key of ['personKey','conversationKey']){
    const places=new Map();
    for(const split of ['train','validation','test'])for(const row of result[split]){
      if(places.has(row[key]))assert.equal(places.get(row[key]),split);
      places.set(row[key],split);
    }
  }
  assert.equal(JSON.stringify(result.summary).includes('Confirme'),false);
  assert.ok(result.summary.crossSplitDuplicateTexts>0);
  assert.equal(result.summary.readyForBlindEvaluation,false);
  assert.deepEqual(dividirAnotacoes(data()),result);
});

test('rejeita texto sensível, autoria de terceiro, rótulo sem fonte e aprovação ausente',()=>{
  for(const text of ['Escreva para pessoa@example.com.','Ligue para (11) 99999-8888.','Abra https://exemplo.com/segredo.','Use Bearer abcdefghijklmnop.']){
    const d=data();d.items[0].text=text;d.items[0].actions=[];
    assert.throws(()=>validarAnotacoes(d),/ANOTACAO_INVALIDA/);
  }
  const terceiro=data();terceiro.items[0].author='third_party';assert.throws(()=>validarAnotacoes(terceiro),/AUTORIA_INVALIDA/);
  const semTrecho=data();semTrecho.items[0].actions=[{type:'request',span:'Faça uma ação que não está aqui.'}];assert.throws(()=>validarAnotacoes(semTrecho),/ACAO_INVALIDA/);
  const semDireito=data();semDireito.items[0].rightsConfirmed=false;assert.throws(()=>validarAnotacoes(semDireito),/ANOTACAO_INVALIDA/);
  const semAprovacao=data();semAprovacao.approvedByOwner=false;assert.throws(()=>validarAnotacoes(semAprovacao),/CONJUNTO_INVALIDO/);
});

test('volume sintético nunca satisfaz critério de avaliação real',()=>{
  const d=data();d.items=Array.from({length:600},(_,i)=>item('ex'+String(i).padStart(4,'0'),'p'+String(i).padStart(4,'0'),'c'+String(i).padStart(4,'0')));
  d.items.forEach(x=>x.critical=true);
  assert.equal(dividirAnotacoes(d).summary.minimumEvaluationVolume,false);
});

test('avaliação cega exige volume, cenários, treino equilibrado e ausência de texto repetido entre conjuntos',()=>{
  const d=data();d.dataKind='real_authorized';
  const labels=['condition','negation','completed','payment','acceptance','prompt_injection','cancellation','uncertainty'];
  d.items=Array.from({length:1000},(_,i)=>{
    const n=String(i).padStart(4,'0'),third=i%17===0,self=i%7===0&&!third,none=third||i%11===0,multiple=!none&&i%13===0;
    const text=multiple?`Confirme o projeto ${n}. Envie o resumo ${n}.`:self?`Vou revisar o projeto ${n}.`:none?`O projeto ${n} já foi discutido.`:`Confirme o projeto ${n}.`;
    const actions=none?[]:multiple?[{type:'request',span:`Confirme o projeto ${n}.`},{type:'request',span:`Envie o resumo ${n}.`}]:[{type:self?'promise':'request',span:text}];
    return {...item('ex'+n,'p'+n,'c'+n,text,actions),channel:i%3===0?'group':'dm',author:third?'third_party':self?'self':'other',critical:i%2===0,risks:[labels[i%labels.length]]};
  });
  const partition=dividirAnotacoes(d),summary=partition.summary;
  assert.equal(summary.minimumEvaluationVolume,true);
  assert.equal(summary.trainingBalanced,true);
  assert.equal(summary.crossSplitDuplicateTexts,0);
  assert.equal(Object.values(summary.scenarioCoverage).every(Boolean),true);
  assert.equal(summary.readyForBlindEvaluation,true);
  const duplicate=structuredClone(d),from=partition.train.find(x=>x.author==='other'),target=duplicate.items.find(x=>x.id===partition.test.find(y=>y.author==='other').id);
  target.text=from.text;target.actions=from.actions;
  const suspect=dividirAnotacoes(duplicate).summary;
  assert.equal(suspect.readyForBlindEvaluation,false);
  assert.ok(suspect.crossSplitDuplicateTexts>0);
});

test('CLI não imprime texto e só grava por confirmação em pasta privada',()=>{
  const input='docs/beta-06/laya-annotations-template.json',script='scripts/laya-annotations.mjs';
  const preview=spawnSync(process.execPath,[script,input],{encoding:'utf8'});
  assert.equal(preview.status,0);
  assert.equal(preview.stdout.includes('Confirme a data'),false);
  const output=`work/laya-private/test-${randomUUID()}.json`;
  const semConfirmacao=spawnSync(process.execPath,[script,input,'--out',output],{encoding:'utf8'});
  assert.notEqual(semConfirmacao.status,0);
  assert.equal(existsSync(output),false);
  const fora=spawnSync(process.execPath,[script,input,'--out','work/fora.json','--confirm-local-write'],{encoding:'utf8'});
  assert.notEqual(fora.status,0);
  assert.equal(existsSync('work/fora.json'),false);
  try{
    const write=spawnSync(process.execPath,[script,input,'--out',output,'--confirm-local-write'],{encoding:'utf8'});
    assert.equal(write.status,0);
    assert.equal(write.stdout.includes('Confirme a data'),false);
    assert.equal(existsSync(output),true);
  }finally{if(existsSync(output))unlinkSync(resolve(output));}
});

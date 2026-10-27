import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {dividirAnotacoes} from '../scripts/laya-annotations-lib.mjs';

test('avaliação local rejeita corpus sintético antes de abrir modelo ou escrever saída', () => {
  const root=resolve(import.meta.dirname,'..');
  const output=resolve(root,'work/laya-private',`${randomUUID()}.json`);
  const args=[resolve(root,'scripts/laya-authorized-eval.mjs'),resolve(root,'docs/beta-06/laya-annotations-template.json'),
    resolve(root,'work/modelo-ausente.json'),output,'--confirm-local-eval'];
  const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/CONJUNTO_REAL_AUTORIZADO_INSUFICIENTE/);
  assert.equal(existsSync(output),false);
  assert.doesNotMatch(result.stdout+result.stderr,/Confirme a data da reunião/);
});

test('mensagem de grupo com ação e sem menção ao dono entra na avaliação local', () => {
  const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'work/laya-private');mkdirSync(dir,{recursive:true});
  const input=resolve(dir,`fixture-${randomUUID()}.json`),output=resolve(dir,`resultado-${randomUUID()}.json`);
  const risks=['condition','negation','completed','payment','acceptance','prompt_injection','cancellation','uncertainty'];
  const data={schema:'lume-laya-annotations-v1',purpose:'local-model-improvement',dataKind:'real_authorized',reviewedAt:'2026-09-25T12:00:00.000Z',approvedByOwner:true,
    items:Array.from({length:1000},(_,i)=>{
      const n=String(i).padStart(4,'0'),third=i%17===0,self=i%7===0&&!third,none=third||i%11===0,multiple=!none&&i%13===0;
      const text=multiple?`Confirme o projeto ${n}. Envie o resumo ${n}.`:self?`Vou revisar o projeto ${n}.`:none?`O projeto ${n} já foi discutido.`:`Confirme o projeto ${n}.`;
      const actions=none?[]:multiple?[{type:'request',span:`Confirme o projeto ${n}.`},{type:'request',span:`Envie o resumo ${n}.`}]:[{type:self?'promise':'request',span:text}];
      return {id:'ex'+n,personKey:'p'+n,conversationKey:'c'+n,channel:i%3===0?'group':'dm',author:third?'third_party':self?'self':'other',text,critical:i%2===0,risks:[risks[i%risks.length]],actions,rightsConfirmed:true};
    })};
  const split=dividirAnotacoes(data);
  assert.equal(split.summary.readyForBlindEvaluation,true);
  assert.equal(split.test.some(x=>x.channel==='group'&&x.actions.length>0&&!x.text.includes('Dono')),true);
  try{
    writeFileSync(input,JSON.stringify(data),{flag:'wx'});
    const result=spawnSync(process.execPath,[resolve(root,'scripts/laya-authorized-eval.mjs'),input,resolve(root,'work/modelo-ausente.json'),output,'--confirm-local-eval'],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,1);
    assert.match(result.stderr,/ENOENT/);
    assert.doesNotMatch(result.stderr,/GRUPO_SEM_ALIAS_DO_DONO|CONJUNTO_REAL_AUTORIZADO_INSUFICIENTE/);
    assert.equal(existsSync(output),false);
  }finally{if(existsSync(input))unlinkSync(input);}
});

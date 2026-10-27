// Diagnóstico interno em casos públicos de desenvolvimento. Não aprova o produto.
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {verificarModelo} from '../src/laya/integrity.js';
import {parseTokenizerJson,encodeWithData} from '../src/laya/vendor/tokenizer.js';
import {buildSequence,softmax} from '../src/laya/vendor/common.js';
import {cases} from './laya-cases.mjs';

const modelDir=resolve(process.argv[2]||'work/laya-onnx');
const output=resolve(process.argv[3]||'work/laya-action-hypothesis.json');
const manifesto=await verificarModelo(modelDir);
const raw=JSON.parse(await readFile(join(modelDir,'tokenizer.json'),'utf8'));
const data=parseTokenizerJson(raw);
const tok={clsId:data.ids.cls,sepId:data.ids.sep,maskId:data.ids.mask,padId:data.ids.pad,maskToken:data.maskToken,encode:text=>encodeWithData(data,text)};
for(const proof of manifesto.tokenizerParity||[])if(JSON.stringify(tok.encode(proof.text))!==JSON.stringify(proof.ids))throw Error('Tokenizador divergente.');
const ort=await import('onnxruntime-node');
const opts={executionProviders:['cpu'],intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all',logSeverityLevel:3};
const encoder=await ort.InferenceSession.create(join(modelDir,'encoder.onnx'),opts);
const head=await ort.InferenceSession.create(join(modelDir,'head.onnx'),opts);
const i64=(array,dims)=>new ort.Tensor('int64',BigInt64Array.from(array.map(BigInt)),dims);
const hypotheses={
  pergunta_noul:{t:'noul',ins:'Esta mensagem pede que alguém faça algo concreto ou promete uma ação futura?',crit:{false:'Não há pedido novo nem compromisso futuro.',true:'Há um pedido explícito ou uma promessa de ação futura.'}},
  proximo_passo_noul:{t:'noul',ins:'Depois desta mensagem, existe uma ação concreta ainda por fazer?',crit:{false:'Apenas informação, ação já feita, cancelamento ou incerteza.',true:'Uma pessoa deve fazer uma ação concreta após esta mensagem.'}},
  acao_choice:{t:'choice',ins:'Classifique a intenção prática desta mensagem.',crit:{acao:'Pedido concreto ou compromisso futuro ainda pendente.',sem_acao:'Informação, ação concluída, cancelamento ou intenção incerta.'}}
};
async function infer(texto,q,reverse=false){
  const labels=Object.keys(q.crit),order=reverse?[1,0]:[0,1];
  const seq=buildSequence(tok,texto,q,1024,256,order);
  if(seq.markers.length!==2)throw Error('Sequência inválida.');
  const mask=i64(seq.ids.map(()=>1),[1,seq.ids.length]);
  const hidden=await encoder.run({input_ids:i64(seq.ids,[1,seq.ids.length]),attention_mask:mask});
  const result=await head.run({hidden_states:hidden.last_hidden_state,marker_pos:i64(seq.markers,[1,2]),marker_mask:new ort.Tensor('bool',Uint8Array.from([1,1]),[1,2]),qtype:i64([q.t==='noul'?2:0],[1,1]),attention_mask:mask});
  const probs=softmax(Array.from(result.logits.data));
  return {predicted:labels[order[probs[1]>probs[0]?1:0]],probs:Object.fromEntries(order.map((i,j)=>[labels[i],probs[j]]))};
}
const expected=c=>['pedido','compromisso'].includes(c.expected)&&c.id!=='n06';
const results={};
try{
  for(const [name,q] of Object.entries(hypotheses)){
    const rows=[];
    for(const c of cases){
      const a=await infer(c.texto,q),b=await infer(c.texto,q,true),yes=a.predicted==='true'||a.predicted==='acao';
      rows.push({id:c.id,expected:expected(c),predicted:yes,stable:a.predicted===b.predicted,score:a.probs.true??a.probs.acao});
    }
    const tp=rows.filter(r=>r.expected&&r.predicted).length,fp=rows.filter(r=>!r.expected&&r.predicted).length,fn=rows.filter(r=>r.expected&&!r.predicted).length,tn=rows.filter(r=>!r.expected&&!r.predicted).length;
    results[name]={summary:{tp,fp,fn,tn,precision:tp/(tp+fp)||0,recall:tp/(tp+fn)||0,stability:rows.filter(r=>r.stable).length/rows.length},rows};
    console.log(name,results[name].summary);
  }
}finally{await Promise.all([encoder.release(),head.release()]);}
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify({date:new Date().toISOString(),modelRevision:manifesto.revision,source:'frozen 40 development cases',blind:false,approved:false,results},null,2));
console.log(output);

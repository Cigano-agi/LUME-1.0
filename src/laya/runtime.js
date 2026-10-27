import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTokenizerJson, encodeWithData } from './vendor/tokenizer.js';
import { buildSequence, softmax } from './vendor/common.js';
import { CLASSES, QUESTION, MODEL_REVISION, validarTexto, aplicarPolitica } from './policy.js';
import { verificarModelo } from './integrity.js';
import {DOMAIN_POLICY} from './domain-policy.js';
import {carregarCabecaAprovada} from './domain-head.js';
import {extrairAcoesDominio} from './domain-actions.js';

export async function carregarRuntime(modelDir,{domainPolicy=DOMAIN_POLICY}={}) {
  const manifest = await verificarModelo(modelDir);
  if (manifest.revision !== MODEL_REVISION || manifest.parityVerified !== true) throw new Error('LAYA_MODELO_NAO_VERIFICADO');
  const domainModel=domainPolicy.approvedForActions===true
    ?await carregarCabecaAprovada(modelDir,domainPolicy,manifest.revision):null;
  const raw = JSON.parse(await readFile(join(modelDir, 'tokenizer.json'), 'utf8'));
  const data = parseTokenizerJson(raw);
  if (!data || raw.model?.type !== 'BPE' || data.kind !== 'metaspace' || data.ids.cls !== 2 || data.ids.sep !== 1 || data.ids.mask !== 4 || data.ids.pad !== 0) throw new Error('LAYA_TOKENIZADOR_INCOMPATIVEL');
  const tok = { clsId: data.ids.cls, sepId: data.ids.sep, maskId: data.ids.mask, padId: data.ids.pad, maskToken: data.maskToken, encode: text => encodeWithData(data, text) };
  for (const proof of manifest.tokenizerParity ?? []) {
    if (JSON.stringify(tok.encode(proof.text)) !== JSON.stringify(proof.ids)) throw new Error('LAYA_TOKENIZADOR_DIVERGENTE');
  }
  if ((manifest.tokenizerParity?.length ?? 0) < 8) throw new Error('LAYA_PARIDADE_AUSENTE');
  const ort = await import('onnxruntime-node');
  const opts = { executionProviders: ['cpu'], intraOpNumThreads: 4, interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const encoder = await ort.InferenceSession.create(join(modelDir, 'encoder.onnx'), opts);
  let head;
  try { head = await ort.InferenceSession.create(join(modelDir, 'head.onnx'), opts); }
  catch (error) { await encoder.release(); throw error; }
  const i64 = (arr, dims) => new ort.Tensor('int64', BigInt64Array.from(arr.map(BigInt)), dims);
  const embed=async(text,maxTokens)=>{
    const tokens=encodeWithData(data,text).slice(0,maxTokens),ids=[data.ids.cls,...tokens,data.ids.sep];
    const mask=i64(ids.map(()=>1),[1,ids.length]);
    const output=await encoder.run({input_ids:i64(ids,[1,ids.length]),attention_mask:mask});
    const values=output.last_hidden_state.data,dimension=output.last_hidden_state.dims.at(-1);
    if(dimension!==domainModel.mean.length)throw Error('LAYA_CABECA_DOMINIO_INVALIDA');
    const feature=new Float32Array(dimension);
    for(let t=1;t<ids.length-1;t++)for(let j=0;j<dimension;j++)feature[j]+=values[t*dimension+j];
    for(let j=0;j<dimension;j++)feature[j]/=Math.max(1,ids.length-2);
    return feature;
  };
  return {
    async inferirAcoes(input){
      if(!domainModel)throw Error('LAYA_QUALIDADE_PENDENTE');
      return extrairAcoesDominio({...input,model:domainModel,embed});
    },
    async infer(texto, { reverse = false, debug = false } = {}) {
      validarTexto(texto);
      const criteria = reverse ? Object.fromEntries(Object.entries(CLASSES).reverse()) : CLASSES;
      const q = {t:'choice',ins:QUESTION,crit:criteria};
      const empty = buildSequence(tok, '', q, 1024, 256);
      if (tok.encode(texto).length + empty.ids.length > 1024) throw new Error('LAYA_CONTEXTO_EXTENSO');
      const seq = buildSequence(tok, texto, q, 1024, 256);
      if (seq.markers.length !== 4) throw new Error('LAYA_SEQUENCIA_INVALIDA');
      const started = performance.now();
      const mask = i64(seq.ids.map(() => 1), [1,seq.ids.length]);
      const hidden = await encoder.run({ input_ids:i64(seq.ids,[1,seq.ids.length]), attention_mask:mask });
      const output = await head.run({ hidden_states:hidden.last_hidden_state, marker_pos:i64(seq.markers,[1,4]), marker_mask:new ort.Tensor('bool',Uint8Array.from([1,1,1,1]),[1,4]), qtype:i64([0],[1,1]), attention_mask:mask });
      const values = softmax(Array.from(output.logits.data));
      const probabilities = Object.fromEntries(Object.keys(criteria).map((key,i) => [key,values[i]]));
      const result = { ...aplicarPolitica(texto, probabilities), duracaoMs:Math.round(performance.now()-started), tokens:seq.ids.length, local:true };
      // Debug is available to the local benchmark, never the public UI adapter.
      if (debug) result.avaliacao = { probabilities, prevista:Object.entries(probabilities).sort((a,b)=>b[1]-a[1])[0][0] };
      return result;
    },
    async close() { await Promise.all([encoder.release(),head.release()]); }
  };
}

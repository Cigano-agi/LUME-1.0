// Research only. No domain policy, service, network client or product gate is used.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {verificarModelo} from '../../src/laya/integrity.js';
import {MODEL_REVISION} from '../../src/laya/policy.js';
import {parseTokenizerJson,encodeWithData} from '../../src/laya/vendor/tokenizer.js';
import {buildSequence,softmax} from '../../src/laya/vendor/common.js';

export const LIMITES=Object.freeze({estadoCaracteres:12000,perguntaCaracteres:2000,
  criterioCaracteres:1000,tokens:1024,prefixoTokens:256,alternativaTokens:48});
export const OPCOES_CPU=Object.freeze({executionProviders:Object.freeze(['cpu']),
  intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',
  graphOptimizationLevel:'all',logSeverityLevel:3});
const falha=codigo=>new Error(codigo);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const chaveSegura=key=>/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(key)&&!['__proto__','prototype','constructor'].includes(key);

export function objetoFechado(value,obrigatorios,opcionais=[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    ![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw falha('CONTEXTO_ESQUEMA_INVALIDO');
  const keys=Reflect.ownKeys(value);
  if(keys.some(key=>typeof key!=='string'||![...obrigatorios,...opcionais].includes(key)||
    !Object.getOwnPropertyDescriptor(value,key)?.enumerable||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))||
    obrigatorios.some(key=>!Object.hasOwn(value,key)))throw falha('CONTEXTO_ESQUEMA_INVALIDO');
}

export function validarTextoSeguro(value,max){
  if(typeof value!=='string'||!value.trim()||value.length>max||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)||!value.isWellFormed())
    throw falha('CONTEXTO_TEXTO_INVALIDO');
  return value; // Preserve whitespace and the entire final turn.
}

export function validarEntrada(input){
  objetoFechado(input,['estado','pergunta','criterios']);
  const estado=validarTextoSeguro(input.estado,LIMITES.estadoCaracteres);
  const pergunta=validarTextoSeguro(input.pergunta,LIMITES.perguntaCaracteres);
  const crit=input.criterios;
  if(!crit||typeof crit!=='object'||Array.isArray(crit))throw falha('CONTEXTO_CRITERIOS_INVALIDOS');
  const keys=Reflect.ownKeys(crit);
  if(keys.length!==4||keys.some(key=>typeof key!=='string'||!chaveSegura(key)))throw falha('CONTEXTO_CRITERIOS_INVALIDOS');
  objetoFechado(crit,keys);
  const criterios=Object.fromEntries(keys.map(key=>[key,validarTextoSeguro(crit[key],LIMITES.criterioCaracteres)]));
  return Object.freeze({estado,pergunta,criterios:Object.freeze(criterios)});
}

// Independently assemble the uncut token sequence, then require vendor parity.
// This covers all three vendor truncation sites, including question/option text.
export function prepararSequencia(input,tok){
  const safe=validarEntrada(input),keys=Object.keys(safe.criterios);
  const q={t:'choice',ins:safe.pergunta,crit:safe.criterios};
  const encode=text=>{
    if(typeof tok.maskToken!=='string'||!tok.maskToken||text.includes(tok.maskToken))throw falha('CONTEXTO_TOKEN_ESPECIAL');
    const ids=tok.encode(text);
    if(!Array.isArray(ids)||!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<0||id>2147483647))throw falha('CONTEXTO_TOKENIZACAO_INVALIDA');
    if(ids.some(id=>[tok.clsId,tok.sepId,tok.maskId,tok.padId].includes(id)))throw falha('CONTEXTO_TOKEN_ESPECIAL');
    return ids;
  };
  const pergunta=encode(`choice question: ${safe.pergunta}`);
  const alternativas=keys.map(key=>encode(` ${key}: ${safe.criterios[key]}`));
  if(alternativas.some(ids=>ids.length>LIMITES.alternativaTokens))throw falha('CONTEXTO_ALTERNATIVA_EXTENSA');
  const prefixo=pergunta.length+alternativas.reduce((n,ids)=>n+1+ids.length,0);
  if(prefixo>LIMITES.prefixoTokens)throw falha('CONTEXTO_PERGUNTA_EXTENSA');
  const estado=encode(safe.estado);
  const ids=[tok.clsId,...pergunta,tok.sepId],markers=[];
  for(const option of alternativas){markers.push(ids.length);ids.push(tok.maskId,...option);}
  ids.push(tok.sepId,...estado,tok.sepId);
  if(ids.length>LIMITES.tokens)throw falha('CONTEXTO_JANELA_EXTENSA');
  const vendor=buildSequence(tok,safe.estado,q,LIMITES.tokens,LIMITES.prefixoTokens);
  if(JSON.stringify(vendor.ids)!==JSON.stringify(ids)||JSON.stringify(vendor.markers)!==JSON.stringify(markers))
    throw falha('CONTEXTO_SEQUENCIA_DIVERGENTE');
  return {ids,markers,keys};
}

function conferirTensor(tensor,dims,codigo){
  if(!tensor||tensor.type!=='float32'||!Array.isArray(tensor.dims)||
    tensor.dims.length!==dims.length||tensor.dims.some((value,i)=>value!==dims[i])||
    !(tensor.data instanceof Float32Array)||tensor.data.length!==dims.reduce((a,b)=>a*b,1)||
    !tensor.data.every(Number.isFinite))throw falha(codigo);
}

// Dependency injection is only for pure contract tests; the CLI supplies none.
export async function carregarContextoRuntime(modelDir,dependencias={}){
  if(typeof modelDir!=='string'||!modelDir.trim())throw falha('CONTEXTO_MODELO_INVALIDO');
  const ler=dependencias.readFile??readFile,verificar=dependencias.verificarModelo??verificarModelo;
  const parse=dependencias.parseTokenizerJson??parseTokenizerJson,encode=dependencias.encodeWithData??encodeWithData;
  const importarOrt=dependencias.importarOrt??(()=>import('onnxruntime-node'));
  const antes=await ler(join(modelDir,'lume-laya-manifest.json'));
  const manifest=await verificar(modelDir); // All weights, tokenizer, license and model card before ONNX.
  const depois=await ler(join(modelDir,'lume-laya-manifest.json'));
  if(digest(antes)!==digest(depois)||manifest.revision!==MODEL_REVISION||manifest.parityVerified!==true)
    throw falha('CONTEXTO_MODELO_NAO_VERIFICADO');
  const tokenizer=await ler(join(modelDir,'tokenizer.json'));
  if(digest(tokenizer)!==manifest.sha256?.['tokenizer.json'])throw falha('CONTEXTO_TOKENIZADOR_ALTERADO');
  const raw=JSON.parse(tokenizer.toString('utf8')),data=parse(raw);
  if(!data||raw.model?.type!=='BPE'||data.kind!=='metaspace'||data.ids?.cls!==2||data.ids.sep!==1||data.ids.mask!==4||data.ids.pad!==0)
    throw falha('CONTEXTO_TOKENIZADOR_INCOMPATIVEL');
  const tok={clsId:data.ids.cls,sepId:data.ids.sep,maskId:data.ids.mask,padId:data.ids.pad,
    maskToken:data.maskToken,encode:text=>encode(data,text)};
  if(!Array.isArray(manifest.tokenizerParity)||manifest.tokenizerParity.length<8)throw falha('CONTEXTO_PARIDADE_AUSENTE');
  for(const proof of manifest.tokenizerParity){
    if(typeof proof?.text!=='string'||!Array.isArray(proof.ids)||
      JSON.stringify(tok.encode(proof.text))!==JSON.stringify(proof.ids))throw falha('CONTEXTO_PARIDADE_DIVERGENTE');
  }
  const ort=await importarOrt();
  const opts=()=>({...OPCOES_CPU,executionProviders:['cpu']});
  const encoder=await ort.InferenceSession.create(join(modelDir,'encoder.onnx'),opts());
  let head;
  try{head=await ort.InferenceSession.create(join(modelDir,'head.onnx'),opts());}
  catch(error){try{await encoder.release();}catch{throw falha('CONTEXTO_CARGA_E_FECHAMENTO_FALHARAM');}throw error;}
  let encerrando=false,ativo=null,fechamento=null;
  const modelo=Object.freeze({revision:manifest.revision,manifestSha256:digest(antes),
    arquivosSha256:Object.freeze({...manifest.sha256}),paridadeVerificada:true,
    runtimeVersions:Object.freeze({...ort.env?.versions}),executionProviders:Object.freeze(['cpu'])});
  async function inferir(seq){
    const started=performance.now(),tensors=new Set();
    const keep=value=>{if(value&&typeof value.dispose==='function')tensors.add(value);return value;};
    const keepOutputs=output=>{if(output&&typeof output==='object')for(const tensor of Object.values(output))keep(tensor);};
    const i64=(values,dims)=>keep(new ort.Tensor('int64',BigInt64Array.from(values,BigInt),dims));
    try{
      const n=seq.ids.length,mask=i64(seq.ids.map(()=>1),[1,n]);
      const hidden=await encoder.run({input_ids:i64(seq.ids,[1,n]),attention_mask:mask});keepOutputs(hidden);
      const h=hidden?.last_hidden_state,d=h?.dims?.[2];
      if(!Number.isSafeInteger(d)||d<1||d>2048)throw falha('CONTEXTO_ENCODER_INVALIDO');
      conferirTensor(h,[1,n,d],'CONTEXTO_ENCODER_INVALIDO');
      const output=await head.run({hidden_states:h,marker_pos:i64(seq.markers,[1,4]),
        marker_mask:keep(new ort.Tensor('bool',Uint8Array.from([1,1,1,1]),[1,4])),
        qtype:i64([0],[1,1]),attention_mask:mask});keepOutputs(output);
      conferirTensor(output?.logits,[1,4],'CONTEXTO_LOGITS_INVALIDOS');
      const values=softmax(Array.from(output.logits.data));
      if(values.length!==4||values.some(n=>!Number.isFinite(n)||n<0||n>1)||Math.abs(values.reduce((a,b)=>a+b,0)-1)>1e-6)
        throw falha('CONTEXTO_PROBABILIDADES_INVALIDAS');
      const probabilidades=Object.fromEntries(seq.keys.map((key,i)=>[key,values[i]]));
      return {prevista:seq.keys[values.indexOf(Math.max(...values))],probabilidades,
        tokens:n,duracaoMs:performance.now()-started,local:true};
    }finally{
      const disposed=await Promise.allSettled([...tensors].map(async tensor=>tensor.dispose()));
      if(disposed.some(r=>r.status==='rejected'))throw falha('CONTEXTO_TENSORES_NAO_LIBERADOS');
    }
  }
  return {
    modelo,
    validar:input=>{if(encerrando)throw falha('CONTEXTO_ENCERRADO');return {tokens:prepararSequencia(input,tok).ids.length};},
    async decidirPorCriterios(input){
      if(encerrando)throw falha('CONTEXTO_ENCERRADO');
      if(ativo)throw falha('CONTEXTO_OCUPADO');
      const seq=prepararSequencia(input,tok);
      ativo=inferir(seq);
      try{return await ativo;}finally{ativo=null;}
    },
    close(){
      if(fechamento)return fechamento;
      encerrando=true;
      fechamento=(async()=>{
        if(ativo)try{await ativo;}catch{ /* close both sessions even after failed inference */ }
        const closed=await Promise.allSettled([encoder,head].map(async session=>session.release()));
        if(closed.some(r=>r.status==='rejected'))throw falha('CONTEXTO_FECHAMENTO_FALHOU');
      })();
      return fechamento;
    }
  };
}

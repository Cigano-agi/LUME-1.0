// Research-only local generation. No profile, network inference or product activation.
import {readFile,lstat,realpath,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {relative,isAbsolute,join,dirname} from 'node:path';
import {montarMensagensSintese} from './sintese-prompt.mjs';
import {terminoGeracao} from './sintese-termino.mjs';

export const GERACAO=Object.freeze({do_sample:false,max_new_tokens:1024,num_beams:1,repetition_penalty:1.05});
export const CPU=Object.freeze({intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',logSeverityLevel:3});
export const LIMITE_ENTRADA=3072;
export async function dependenciasSintese(){
  const require=createRequire(import.meta.url),entry=require.resolve('@huggingface/transformers');
  const manifest=join(dirname(entry),'..','package.json');
  const transformers=JSON.parse(await readFile(manifest,'utf8'));
  const ortManifest=createRequire(entry).resolve('onnxruntime-node/package.json');
  const ort=JSON.parse(await readFile(ortManifest,'utf8'));
  if(transformers.name!=='@huggingface/transformers'||transformers.version!=='4.3.0'||ort.version!=='1.23.2')throw Error('SINTESE_DEPENDENCIAS_DIVERGENTES');
  return {transformers:{versao:transformers.version,manifestSha256:await sha256Arquivo(manifest)},
    onnxruntimeNode:{versao:ort.version,manifestSha256:await sha256Arquivo(ortManifest)}};
}
export async function sha256Arquivo(path){
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}
export async function conferirModelo(modelDir,lockPath,lockSha){
  if(!/^[0-9a-f]{64}$/.test(lockSha))throw Error('SINTESE_LOCK_HASH_INVALIDO');
  const bytes=await readFile(lockPath);
  if(createHash('sha256').update(bytes).digest('hex')!==lockSha)throw Error('SINTESE_LOCK_DIVERGENTE');
  const lock=JSON.parse(bytes);
  if(lock.schema!=='lume-sintese-research-model-v1'||!/^onnx-community\/[A-Za-z0-9._-]+$/.test(lock.modelId)||
    !/^[a-f0-9]{40}$/.test(lock.revision)||lock.dtype!=='q4'||!Array.isArray(lock.files)||!lock.files.length||lock.files.length>20)
    throw Error('SINTESE_LOCK_INVALIDO');
  const root=await realpath(modelDir),seen=new Set();let total=0;
  for(const file of lock.files){
    if(typeof file.path!=='string'||!/^([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(file.path)||file.path.split('/').some(p=>p==='..'||p==='.')||
      seen.has(file.path)||!Number.isSafeInteger(file.bytes)||file.bytes<=0||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('SINTESE_ARTEFATO_INVALIDO');
    seen.add(file.path);total+=file.bytes;if(total>3*1024**3)throw Error('SINTESE_MODELO_EXTENSO');
    const path=join(root,file.path),actual=await realpath(path),rel=relative(root,actual),info=await lstat(path);
    if(isAbsolute(rel)||rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||info.isSymbolicLink()||!info.isFile()||info.size!==file.bytes||
      await sha256Arquivo(path)!==file.sha256)throw Error('SINTESE_MODELO_DIVERGENTE');
  }
  for(const file of ['config.json','tokenizer.json','tokenizer_config.json'])if(!seen.has(file))throw Error('SINTESE_MODELO_INCOMPLETO');
  const encontrados=new Set();
  async function visitar(dir,prefix=''){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const name=prefix+entry.name;
      if(entry.isSymbolicLink())throw Error('SINTESE_MODELO_DIVERGENTE');
      if(entry.isDirectory())await visitar(join(dir,entry.name),name+'/');
      else if(entry.isFile())encontrados.add(name);
      else throw Error('SINTESE_MODELO_DIVERGENTE');
    }
  }
  await visitar(root);
  if(encontrados.size!==seen.size||[...encontrados].some(name=>!seen.has(name)))throw Error('SINTESE_ARTEFATO_NAO_FIXADO');
  return {lock,root,lockSha};
}

function liberar(tensors){
  let firstError;
  for(const tensor of tensors){try{tensor?.dispose?.();}catch(e){firstError??=e;}}
  if(firstError)throw firstError;
}

export async function carregarSinteseLocal(modelDir,lockPath,lockSha){
  await dependenciasSintese();
  const verificado=await conferirModelo(modelDir,lockPath,lockSha);
  const {AutoTokenizer,AutoModelForCausalLM,env,StoppingCriteria}=await import('@huggingface/transformers');
  // This helper runs only in its own research process. Do not import it in the app.
  env.allowRemoteModels=false;env.allowLocalModels=true;env.useBrowserCache=false;env.useFSCache=false;
  const tokenizer=await AutoTokenizer.from_pretrained(verificado.root,{local_files_only:true});
  const model=await AutoModelForCausalLM.from_pretrained(verificado.root,{
    local_files_only:true,device:'cpu',dtype:'q4',session_options:CPU,
  });
  let closed=false,busy=false,active=null,closing=null;
  const preparar=fontes=>{
    if(closed)throw Error('SINTESE_MOTOR_ENCERRADO');
    const mensagens=montarMensagensSintese(fontes);
    const text=tokenizer.apply_chat_template(mensagens,{tokenize:false,add_generation_prompt:true,enable_thinking:false});
    const inputs=tokenizer(text,{add_special_tokens:false,truncation:false,padding:false});
    const tokens=inputs.input_ids.dims.at(-1);
    if(tokens>LIMITE_ENTRADA){liberar(Object.values(inputs));throw Error('SINTESE_JANELA_EXTENSA');}
    return {inputs,tokens};
  };
  return {
    modelo:verificado.lock,
    validar(fontes){const {inputs,tokens}=preparar(fontes);liberar(Object.values(inputs));return {tokens};},
    async gerar(fontes){
      if(closed)throw Error('SINTESE_MOTOR_ENCERRADO');if(busy)throw Error('SINTESE_MOTOR_OCUPADO');
      const {inputs,tokens}=preparar(fontes);busy=true;
      let finish;active=new Promise(resolveDone=>{finish=resolveDone;});
      const started=performance.now();let output,expired=false,primeiroTokenMs=null;
      class LimiteTempo extends StoppingCriteria{_call(ids){const elapsed=performance.now()-started;primeiroTokenMs??=elapsed;expired=elapsed>90000;return ids.map(()=>expired);}}
      try{
        output=await model.generate({...inputs,...GERACAO,stopping_criteria:[new LimiteTempo()]});
        const generated=output.tolist()[0].slice(tokens),texto=tokenizer.decode(generated,{skip_special_tokens:true});
        return {texto,tokensEntrada:tokens,tokensSaida:generated.length,duracaoMs:performance.now()-started,primeiroTokenMs,
          ...terminoGeracao({tokensSaida:generated.length,ultimoToken:generated.at(-1),
            eosTokenIds:model.generation_config?.eos_token_id??model.config?.eos_token_id,
            expirou:expired,limiteTokens:GERACAO.max_new_tokens})};
      }finally{
        try{liberar([output,...Object.values(inputs)]);}finally{busy=false;finish();}
      }
    },
    close(){if(closing)return closing;closed=true;closing=(async()=>{if(active)await active;await model.dispose();})();return closing;},
  };
}

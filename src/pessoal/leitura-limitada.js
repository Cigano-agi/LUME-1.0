export function aguardar(promise,signal){
  if(!signal)return Promise.resolve(promise);
  if(signal.aborted){void Promise.resolve(promise).catch(()=>{});return Promise.reject(signal.reason||Error('cancelado'));}
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason||Error('cancelado'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export async function lerJsonLimitado(response,{signal,maxBytes=524288}={}){
  const reader=response.body?.getReader();if(!reader)throw Error('corpo_indisponivel');
  let size=0;const parts=[];
  try{
    while(true){
      const {done,value}=await aguardar(reader.read(),signal);if(done)break;
      size+=value.byteLength;if(size>maxBytes)throw Error('resposta_excessiva');
      parts.push(Buffer.from(value));
    }
    if(signal?.aborted)throw Error('cancelado');
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}

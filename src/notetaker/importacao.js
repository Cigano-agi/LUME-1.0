import {createHash} from 'node:crypto';
import {cabecalhoWav,validarCabecalho,MAX_IMPORTACAO_BYTES,MAX_PARTE_PCM} from './contrato.js';

const erro=(code,message)=>Object.assign(new Error(message),{code});

export async function importarArquivo(req,{servico,sessaoId,signal}={}){
  const tamanhoDeclarado=req.headers?.['content-length'];
  if(tamanhoDeclarado!==undefined&&(!/^\d+$/.test(String(tamanhoDeclarado))||Number(tamanhoDeclarado)>MAX_IMPORTACAO_BYTES))throw erro('LIMITE','Arquivo excede duas horas.');
  const {anteriorCompleta,liberar}=servico.iniciarImportacao(sessaoId);
  try{
    const hash=createHash('sha256'),parte=Buffer.allocUnsafe(MAX_PARTE_PCM);
    let header=Buffer.alloc(44),headN=0,parteN=0,pcmN=0,total=0,esperado=null,posicao=0;
    const recibos=[];
    const salvar=()=>{
      if(!parteN)return;
      const wav=Buffer.concat([cabecalhoWav(parteN),parte.subarray(0,parteN)]);
      recibos.push(anteriorCompleta
        ?servico.verificarParteExistente(sessaoId,{posicao,bytes:wav})
        :servico.guardarParte(sessaoId,{posicao,bytes:wav}));
      posicao++;parteN=0;
    };
    for await(const bloco of req){
      if(signal?.aborted)throw erro('CANCELADO','Importação cancelada.');
      if(!Buffer.isBuffer(bloco))throw erro('FORMATO','Envie bytes WAV.');
      total+=bloco.length;
      if(total>MAX_IMPORTACAO_BYTES)throw erro('LIMITE','Arquivo excede duas horas.');
      hash.update(bloco);
      let i=0;
      if(headN<44){const n=Math.min(44-headN,bloco.length);bloco.copy(header,headN,0,n);headN+=n;i+=n;if(headN===44)esperado=validarCabecalho(header);}
      while(i<bloco.length){
        if(pcmN>=esperado)throw erro('FORMATO','WAV contém bytes extras.');
        const n=Math.min(bloco.length-i,MAX_PARTE_PCM-parteN,esperado-pcmN);
        bloco.copy(parte,parteN,i,i+n);parteN+=n;pcmN+=n;i+=n;
        if(parteN===MAX_PARTE_PCM)salvar();
      }
    }
    if(signal?.aborted||req.complete===false)throw erro('CANCELADO','Importação interrompida.');
    if(headN!==44||pcmN!==esperado||total!==44+esperado||pcmN%2||(tamanhoDeclarado!==undefined&&total!==Number(tamanhoDeclarado)))throw erro('FORMATO','WAV truncado ou inválido.');
    salvar();
    const digest=hash.digest('hex');
    if(anteriorCompleta)servico.confirmarRetryCompleto(sessaoId,{sha256:digest,bytes:total,quantidadePartes:recibos.length});
    if(!anteriorCompleta)servico.marcarImportacao(sessaoId,'completa',digest,total);
    return {id:sessaoId,estado:'completa',sha256:digest,bytes:total,partes:recibos,coberturaMs:recibos.reduce((n,p)=>n+p.duracaoMs,0)};
  }catch(e){
    if(!anteriorCompleta){try{servico.marcarImportacao(sessaoId,'incompleta');}catch{}}
    if(req.complete===false&&!['CANCELADO','FORMATO','LIMITE','CONFLITO','INTEGRIDADE'].includes(e?.code))throw erro('CANCELADO','Importação interrompida.');
    throw e;
  }finally{liberar();}
}

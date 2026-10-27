import {Worker} from 'node:worker_threads';

export const LIMITES_DOCUMENTO = Object.freeze({bytes:10*1024*1024, caracteres:24000, paginas:30, prazoMs:10000});
const RECURSOS = Object.freeze({maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4});
const MOTIVOS = new Set(['limite_texto','limite_paginas','pdf_protegido','pdf_invalido','pdf_parcial','utf8_invalido','leitor_indisponivel']);
const indisponivel = motivo => ({estado:'indisponivel',texto:'',paginas:0,truncado:false,motivo});

function resultadoValido(r) {
  return r && ['extraido','sem_texto','indisponivel'].includes(r.estado) && typeof r.texto==='string'
    && r.texto.length<=LIMITES_DOCUMENTO.caracteres && Number.isInteger(r.paginas) && r.paginas>=0
    && r.paginas<=LIMITES_DOCUMENTO.paginas && typeof r.truncado==='boolean'
    && (r.motivo===undefined||MOTIVOS.has(r.motivo));
}

/** Trusted construction seam for lifecycle tests; never pass options from a document/HTTP request.
 * One active worker per reader, no implicit queue/retry. prazoMs can only lower the 10 s ceiling.
 * resourceLimits bounds V8 heap, NOT total process RSS or native/ArrayBuffer allocations.
 */
export function criarLeitorDocumentos({WorkerClass=Worker,prazoMs=LIMITES_DOCUMENTO.prazoMs}={}) {
  if(!Number.isInteger(prazoMs)||prazoMs<1||prazoMs>LIMITES_DOCUMENTO.prazoMs)throw new TypeError('PRAZO_DOCUMENTO_INVALIDO');
  let ocupado=false;
  return async function extrairDocumento(entrada={}) {
    const inicio=performance.now();
    if(!entrada||typeof entrada!=='object'||Array.isArray(entrada)||Object.keys(entrada).some(k=>!['bytes','mime','signal'].includes(k)))return indisponivel('entrada_invalida');
    const {bytes,mime,signal}=entrada;
    if(signal!==undefined&&!(signal instanceof AbortSignal))return indisponivel('entrada_invalida');
    if(signal?.aborted)return indisponivel('cancelado');
    if(typeof mime!=='string'||mime.length>100)return indisponivel('formato_nao_suportado');
    const tipo=mime.trim().toLowerCase();
    if(!['application/pdf','text/plain','text/plain; charset=utf-8','text/plain;charset=utf-8'].includes(tipo))return indisponivel('formato_nao_suportado');
    let vista;
    try {
      if(bytes instanceof Uint8Array&&bytes.buffer instanceof ArrayBuffer)vista=new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      else if(bytes instanceof ArrayBuffer)vista=new Uint8Array(bytes);
      else return indisponivel('entrada_invalida');
    } catch {return indisponivel('entrada_invalida');}
    if(vista.byteLength>LIMITES_DOCUMENTO.bytes)return indisponivel('entrada_excessiva');
    if(ocupado)return indisponivel('ocupado');
    ocupado=true;
    return new Promise(resolve=>{
      let worker,timer,fechando=false,parcial=null;
      const interrompido=motivo=>parcial?.texto.trim()
        ? {...parcial,estado:'extraido',truncado:true,motivo}
        : {...indisponivel(motivo),paginas:parcial?.paginas??0};
      const concluir=async resultado=>{
        if(fechando)return;
        fechando=true;clearTimeout(timer);
        signal?.removeEventListener('abort',cancelar);
        // Do not free capacity or resolve while an abandoned parser is still running.
        try {await worker?.terminate();} catch {resultado=indisponivel('leitor_indisponivel');}
        ocupado=false;
        resolve(signal?.aborted?indisponivel('cancelado'):resultado);
      };
      const cancelar=()=>void concluir(indisponivel('cancelado'));
      signal?.addEventListener('abort',cancelar,{once:true});
      try {
        // Copy only the allowed view; never detach caller-owned bytes or transfer pooled Buffer memory.
        const copia=new Uint8Array(vista);
        const restante=prazoMs-(performance.now()-inicio);
        if(signal?.aborted){cancelar();return;}
        if(restante<=0){void concluir(indisponivel('prazo_excedido'));return;}
        timer=setTimeout(()=>void concluir(interrompido('prazo_excedido')),restante);
        worker=new WorkerClass(new URL('./documentos-worker.js',import.meta.url),{
          workerData:{bytes:copia,mime:tipo.startsWith('text/plain')?'text/plain':'application/pdf'},
          transferList:[copia.buffer],resourceLimits:{...RECURSOS},env:{},execArgv:[],
          stdin:false,stdout:true,stderr:true,trackUnmanagedFds:true,
        });
        // PDF diagnostics can contain document text/paths; drain without forwarding to app logs.
        worker.stdout?.resume();worker.stderr?.resume();
        worker.on('message',message=>{
          if(fechando)return;
          if(performance.now()-inicio>=prazoMs){void concluir(interrompido('prazo_excedido'));return;}
          if(!resultadoValido(message?.resultado)){void concluir(indisponivel('leitor_indisponivel'));return;}
          if(message.tipo==='progresso')parcial=message.resultado;
          else if(message.tipo==='concluido')void concluir(message.resultado);
        });
        worker.on('error',error=>void concluir(interrompido(error?.code==='ERR_WORKER_OUT_OF_MEMORY'?'memoria_excedida':'leitor_indisponivel')));
        worker.once('exit',()=>{if(!fechando)void concluir(interrompido('leitor_indisponivel'));});
        if(performance.now()-inicio>=prazoMs)void concluir(interrompido('prazo_excedido'));
      } catch {void concluir(indisponivel('leitor_indisponivel'));}
    });
  };
}

/** Bytes are data, never a URL/path/password or authority to read a conversation. No persistence. */
export const extrairDocumento=criarLeitorDocumentos();

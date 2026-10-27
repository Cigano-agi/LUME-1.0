import {parentPort,workerData} from 'node:worker_threads';
import {LIMITES_DOCUMENTO} from './documentos-leitor.js';

// No document-controlled imports, callbacks, URLs, shell, scripting or rendering API.
// This is a bounded parser worker, not an OS security sandbox.
const negar=()=>{throw new Error('RECURSO_EXTERNO_BLOQUEADO');};
globalThis.fetch=negar;
globalThis.XMLHttpRequest=class {constructor(){negar();}};
globalThis.WebSocket=class {constructor(){negar();}};
class SemRecursosExternos {async fetch(){negar();}}
class SemCanvas {create(){negar();} reset(){negar();} destroy(){}}
const cortar=texto=>{
  const recorte=texto.slice(0,LIMITES_DOCUMENTO.caracteres);
  return /[\uD800-\uDBFF]$/.test(recorte)?recorte.slice(0,-1):recorte;
};
const vazio=motivo=>({estado:'indisponivel',texto:'',paginas:0,truncado:false,motivo});

async function extrair() {
  const {bytes,mime}=workerData;
  if(!(bytes instanceof Uint8Array)||bytes.length>LIMITES_DOCUMENTO.bytes)return vazio('leitor_indisponivel');
  if(mime==='text/plain') {
    let texto;
    try {texto=new TextDecoder('utf-8',{fatal:true}).decode(bytes);} catch {return vazio('utf8_invalido');}
    const truncado=texto.length>LIMITES_DOCUMENTO.caracteres;
    return {estado:texto.trim()?'extraido':'sem_texto',texto:cortar(texto),paginas:0,truncado,...(truncado?{motivo:'limite_texto'}:{})};
  }
  if(mime!=='application/pdf')return vazio('leitor_indisponivel');
  let loading,texto='',paginas=0,truncado=false,motivo,ultimoTexto=0,ultimaPagina=0;
  const resultado=()=>({estado:texto.trim()?'extraido':'sem_texto',texto,paginas,truncado,...(motivo?{motivo}:{})});
  const progresso=(fimPagina=false)=>{
    // Bound queued snapshots too: at most two per page plus one per 4 KiB of output.
    if(!fimPagina&&paginas===ultimaPagina&&texto.length-ultimoTexto<4096)return;
    ultimoTexto=texto.length;ultimaPagina=paginas;
    parentPort.postMessage({tipo:'progresso',resultado:resultado()});
  };
  try {
    // Legacy provides the upstream polyfills required by the supported Node 24 runtime.
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    loading=getDocument({data:bytes,isEvalSupported:false,useWorkerFetch:false,useSystemFonts:false,
      disableFontFace:true,useWasm:false,enableXfa:false,disableAutoFetch:true,disableStream:true,
      disableRange:true,isOffscreenCanvasSupported:false,isImageDecoderSupported:false,
      maxImageSize:0,canvasMaxAreaInBytes:0,stopAtErrors:true,verbosity:0,
      BinaryDataFactory:SemRecursosExternos,CanvasFactory:SemCanvas,
    });
    const doc=await loading.promise;
    truncado=doc.numPages>LIMITES_DOCUMENTO.paginas;
    if(truncado)motivo='limite_paginas';
    for(let n=1;n<=Math.min(doc.numPages,LIMITES_DOCUMENTO.paginas);n++) {
      const page=await doc.getPage(n);paginas=n;
      let separador=texto?'\n\n':'';
      const reader=page.streamTextContent({includeMarkedContent:false}).getReader();
      try {
        let atingido=false;
        while(!atingido) {
          const {value,done}=await reader.read();if(done)break;
          for(const item of value.items) {
            if(typeof item.str!=='string'||!item.str){if(item.hasEOL)separador='\n';continue;}
            const restante=LIMITES_DOCUMENTO.caracteres-texto.length;
            const trecho=separador+item.str;
            if(trecho.length>restante) {
              texto=cortar(texto+trecho.slice(0,restante));truncado=true;motivo='limite_texto';atingido=true;break;
            }
            texto+=trecho;
            separador=item.hasEOL?'\n':' ';
          }
          progresso();
        }
        if(atingido)return resultado();
      } finally {
        await reader.cancel().catch(()=>{});reader.releaseLock();page.cleanup();
      }
      progresso(true);
      if(n<Math.min(doc.numPages,LIMITES_DOCUMENTO.paginas)&&texto.length>=LIMITES_DOCUMENTO.caracteres) {
        truncado=true;motivo='limite_texto';return resultado();
      }
    }
    return resultado();
  } catch(error) {
    if(error?.name==='PasswordException')return vazio('pdf_protegido');
    if(texto.trim())return {...resultado(),truncado:true,motivo:'pdf_parcial'};
    return {...vazio(error?.code==='ERR_MODULE_NOT_FOUND'?'leitor_indisponivel':'pdf_invalido'),paginas};
  } finally {await loading?.destroy().catch(()=>{});}
}

if(parentPort) {
  try {parentPort.postMessage({tipo:'concluido',resultado:await extrair()});}
  catch {parentPort.postMessage({tipo:'concluido',resultado:vazio('leitor_indisponivel')});}
  parentPort.close();
}

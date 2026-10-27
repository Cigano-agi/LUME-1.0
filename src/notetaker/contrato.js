import {validarAudioWav} from '../audio-desktop-contrato.js';

export const BYTES_SEGUNDO=32000;
export const MAX_PARTE_PCM=60*BYTES_SEGUNDO;
export const MAX_IMPORTACAO_BYTES=44+7200*BYTES_SEGUNDO;
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function cabecalhoWav(bytesPcm){
  const h=Buffer.alloc(44);
  h.write('RIFF',0,'ascii');h.writeUInt32LE(36+bytesPcm,4);h.write('WAVEfmt ',8,'ascii');
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);
  h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);
  h.write('data',36,'ascii');h.writeUInt32LE(bytesPcm,40);return h;
}

export function validarCabecalho(h){
  if(!Buffer.isBuffer(h)||h.length!==44)throw Object.assign(new Error('WAV canônico obrigatório.'),{code:'FORMATO'});
  const tamanho=h.readUInt32LE(40);
  if(tamanho<2||tamanho%2||tamanho+44>MAX_IMPORTACAO_BYTES)throw Object.assign(new Error('WAV canônico obrigatório.'),{code:'FORMATO'});
  const esperado=cabecalhoWav(tamanho);
  if(!h.equals(esperado))throw Object.assign(new Error('WAV canônico obrigatório.'),{code:'FORMATO'});
  return tamanho;
}

export function validarParte(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_PARTE_PCM+44)throw Object.assign(new Error('Parte excede 60 segundos.'),{code:'LIMITE'});
  const meta=validarAudioWav(bytes);
  if(meta.segundos>60)throw Object.assign(new Error('Parte excede 60 segundos.'),{code:'LIMITE'});
  return {duracaoMs:meta.segundos*1000,bytes:meta.bytes};
}

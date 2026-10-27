import {validarAudioWav} from './audio-desktop-contrato.js';

// Prova somente silêncio digital no formato canônico do Lume, não presença/ausência
// de voz. Em PCM S16LE, zero é exatamente 0x0000. Um único bit diferente basta
// para manter o áudio no ASR; não há limiar de energia, arredondamento ou VAD.
export function analisarSinalAudioLocal(bytes){
  const meta=validarAudioWav(bytes);
  // O decoder 'ascii' remove o bit alto. Exigir os bytes reais evita aceitar
  // um cabeçalho adulterado como WAV válido antes de dispensar o motor.
  if(bytes.toString('latin1',0,4)!=='RIFF'||bytes.toString('latin1',8,16)!=='WAVEfmt '||bytes.toString('latin1',36,40)!=='data'){
    throw new Error('Áudio inválido. A detecção de silêncio exige WAV PCM canônico.');
  }
  let silencioDigital=true;
  for(let i=44;i<bytes.length;i++){
    if(bytes[i]!==0){silencioDigital=false;break;}
  }
  return {metodo:'pcm_s16le_zero_exato_v1',silencioDigital,
    totalAmostras:(bytes.length-44)/2,duracaoAudioMs:meta.segundos*1000};
}

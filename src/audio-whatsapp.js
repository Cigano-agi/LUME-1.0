import {createDecipheriv,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {aguardar} from './pessoal/leitura-limitada.js';

export const MAX_AUDIO_DOWNLOAD=20*1024*1024;
export const EXT_ORIGINAIS_WHATSAPP=Object.freeze({
  'audio/ogg':'ogg','audio/mp4':'m4a','audio/mpeg':'mp3','audio/wav':'wav','audio/aac':'aac','audio/amr':'amr','audio/flac':'flac',
  'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
  'application/pdf':'pdf','text/plain':'txt','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx','application/octet-stream':'bin'
});
const hash=b=>createHash('sha256').update(b).digest();
function falha(codigo){const error=new Error(codigo);error.codigo=codigo;throw error;}
function binario(v){
  if(Buffer.isBuffer(v))return v;
  if(v?.type==='Buffer')v=v.data;
  if(typeof v==='string')return Buffer.from(v,'base64');
  if(v&&typeof v==='object'&&!Array.isArray(v)){const keys=Object.keys(v);if(keys.every((k,i)=>k===String(i)))v=Object.values(v);}
  if(Array.isArray(v)&&v.every(x=>Number.isInteger(x)&&x>=0&&x<=255))return Buffer.from(v);
  falha('metadados_invalidos');
}
export async function baixarAudioWhatsapp(bruto,{signal,fetchFn=fetch}={}){
  return baixarMidiaWhatsapp(bruto,{signal,fetchFn,tipo:'audio'});
}
export async function baixarMidiaWhatsapp(bruto,{signal,fetchFn=fetch,tipo='audio'}={}){
  const signalDownload=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(30000)]);
  try{
    signalDownload.throwIfAborted();
    const chaveTipo={audio:'audioMessage',imagem:'imageMessage',documento:'documentMessage'}[tipo];
    if(!chaveTipo)falha('metadados_invalidos');
    let message=JSON.parse(bruto)?.mensagem?.message;
    for(let n=0;n<8&&message;n++){
      const inner=message.ephemeralMessage?.message??message.viewOnceMessage?.message??
        message.viewOnceMessageV2?.message??message.documentWithCaptionMessage?.message;
      if(!inner)break;
      message=inner;
    }
    const media=message?.[chaveTipo];
    if(!media)falha('metadados_invalidos');
    const key=binario(media.mediaKey),plainHash=binario(media.fileSha256),encryptedHash=binario(media.fileEncSha256);
    if([key,plainHash,encryptedHash].some(b=>b.length!==32))falha('metadados_invalidos');
    const mime=String(media.mimetype||(tipo==='audio'?'audio/ogg':tipo==='imagem'?'image/jpeg':'application/octet-stream')).split(';')[0].trim().toLowerCase();
    const ext=EXT_ORIGINAIS_WHATSAPP[mime],familia=tipo==='audio'?'audio/':tipo==='imagem'?'image/':null;
    if(!ext||familia&&!mime.startsWith(familia)||tipo==='documento'&&/^(audio|image)\//.test(mime)||tipo==='audio'&&Number(media.seconds)>300||Number(media.fileLength)>MAX_AUDIO_DOWNLOAD)falha('limite_audio');
    let url;
    try{url=new URL(media.url||('https://mmg.whatsapp.net'+media.directPath));}
    catch{falha('host_recusado');}
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!(url.hostname==='mmg.whatsapp.net'||url.hostname.endsWith('.whatsapp.net')))falha('host_recusado');
    // A versão instalada de getHttpStream do Baileys ignora signal/redirect.
    // Mantemos o formato criptográfico dela, com transporte próprio limitado e sem redirecionamento.
    const response=await aguardar(fetchFn(url.href,{method:'GET',redirect:'error',signal:signalDownload}),signalDownload);
    if(response.status===404||response.status===410){await response.body?.cancel();falha('midia_expirada');}
    if(!response.ok||!response.body){await response.body?.cancel();throw new Error('Áudio indisponível');}
    if(Number(response.headers.get('content-length'))>MAX_AUDIO_DOWNLOAD+1024){await response.body.cancel();falha('limite_audio');}
    const reader=response.body.getReader(),chunks=[];let total=0;
    try{while(true){signalDownload.throwIfAborted();const {done,value}=await aguardar(reader.read(),signalDownload);if(done)break;total+=value.length;if(total>MAX_AUDIO_DOWNLOAD+1024)falha('limite_audio');chunks.push(Buffer.from(value));}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
    signalDownload.throwIfAborted();const encrypted=Buffer.concat(chunks);
    if(encrypted.length<26||!timingSafeEqual(hash(encrypted),encryptedHash))falha('metadados_invalidos');
    const {getMediaKeys}=await import('@whiskeysockets/baileys');const {iv,cipherKey,macKey}=await getMediaKeys(key,{audio:'audio',imagem:'image',documento:'document'}[tipo]);
    signalDownload.throwIfAborted();const body=encrypted.subarray(0,-10),mac=encrypted.subarray(-10);
    if(!timingSafeEqual(createHmac('sha256',macKey).update(iv).update(body).digest().subarray(0,10),mac))falha('metadados_invalidos');
    const decipher=createDecipheriv('aes-256-cbc',cipherKey,iv),bytes=Buffer.concat([decipher.update(body),decipher.final()]);
    if(bytes.length>MAX_AUDIO_DOWNLOAD)falha('limite_audio');
    if(!timingSafeEqual(hash(bytes),plainHash))falha('metadados_invalidos');
    return {base64:bytes.toString('base64'),nome:(tipo==='audio'?'Áudio':'Arquivo')+' do WhatsApp.'+ext,mime};
  }catch(error){
    const publicError=new Error(signalDownload.aborted?'Download de mídia cancelado ou expirado.':'Não consegui recuperar este arquivo do WhatsApp. Ele pode ter expirado. Selecione o arquivo da mensagem.');
    publicError.codigo=error?.codigo||'rede';throw publicError;
  }
}

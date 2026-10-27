import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createHash,createHmac} from 'node:crypto';
import {getMediaKeys} from '@whiskeysockets/baileys';
import {baixarAudioWhatsapp,MAX_AUDIO_DOWNLOAD} from '../src/audio-whatsapp.js';
import {wav} from './fixtures/audio-wav.js';
const hash=b=>createHash('sha256').update(b).digest();
async function fixture(){
 const bytes=wav(),mediaKey=Buffer.alloc(32,7),{cipherKey,iv,macKey}=await getMediaKeys(mediaKey,'audio'),cipher=createCipheriv('aes-256-cbc',cipherKey,iv);
 const body=Buffer.concat([cipher.update(bytes),cipher.final()]),encrypted=Buffer.concat([body,createHmac('sha256',macKey).update(iv).update(body).digest().subarray(0,10)]);
 const media={mediaKey,fileSha256:hash(bytes),fileEncSha256:hash(encrypted),mimetype:'audio/wav',seconds:1,fileLength:bytes.length,url:'https://mmg.whatsapp.net/audio-sintetico'};
 const raw=()=>JSON.stringify({mensagem:{message:{audioMessage:media}}});return {bytes,encrypted,media,raw};
}
test('WhatsApp áudio: download restrito, MAC e hashes reais, somente bytes do áudio',async()=>{
 const f=await fixture();let calls=0;const result=await baixarAudioWhatsapp(f.raw(),{fetchFn:async(url,options)=>{calls++;assert.equal(url,f.media.url);assert.equal(options.redirect,'error');assert.ok(options.signal);return new Response(f.encrypted);}});
 assert.equal(calls,1);assert.deepEqual(Buffer.from(result.base64,'base64'),f.bytes);assert.equal(result.mime,'audio/wav');assert.equal(result.mediaKey,undefined);
});
test('WhatsApp áudio: envelope efêmero preserva o bruto e permite recuperar a mídia',async()=>{
 const f=await fixture();let calls=0;
 const bruto=JSON.stringify({mensagem:{message:{ephemeralMessage:{message:{audioMessage:f.media}}}}});
 const result=await baixarAudioWhatsapp(bruto,{fetchFn:async()=>{calls++;return new Response(f.encrypted);}});
 assert.equal(calls,1);assert.deepEqual(Buffer.from(result.base64,'base64'),f.bytes);
});
test('WhatsApp áudio: metadados inválidos/host externo são recusados antes da rede',async()=>{
 const f=await fixture();let calls=0;const fetchFn=async()=>{calls++;throw Error('Não chamar');};
 for(const url of ['http://mmg.whatsapp.net/x','https://127.0.0.1/x','https://mmg.whatsapp.net.evil.test/x','https://user@mmg.whatsapp.net/x','https://mmg.whatsapp.net:444/x']){f.media.url=url;await assert.rejects(()=>baixarAudioWhatsapp(f.raw(),{fetchFn}),/Não consegui/);}
 await assert.rejects(()=>baixarAudioWhatsapp('{}',{fetchFn}));assert.equal(calls,0);
});
test('WhatsApp áudio: corrupção, MAC inválido, corpo excessivo e cancelamento não retornam bytes',async()=>{
 const f=await fixture(),bad=Buffer.from(f.encrypted);bad[10]^=1;
 await assert.rejects(()=>baixarAudioWhatsapp(f.raw(),{fetchFn:async()=>new Response(bad)}));
 f.media.fileEncSha256=hash(bad);await assert.rejects(()=>baixarAudioWhatsapp(f.raw(),{fetchFn:async()=>new Response(bad)}),'MAC impede conteúdo com hash alterado');
 await assert.rejects(()=>baixarAudioWhatsapp(f.raw(),{fetchFn:async()=>new Response(f.encrypted,{headers:{'content-length':String(MAX_AUDIO_DOWNLOAD+2048)}})}));
 const controller=new AbortController();controller.abort();await assert.rejects(()=>baixarAudioWhatsapp(f.raw(),{signal:controller.signal,fetchFn:async()=>new Response(f.encrypted)}),/cancelado/);
});

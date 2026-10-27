// Explicit research setup: one public candidate, no package/global installation.
import {createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {join,resolve} from 'node:path';
import {sha256Arquivo} from './lib/sintese-local-runtime.mjs';

export const ROOT=resolve('work/beta06-sintese-dev');
export const PIN={
  model:{id:'unsloth/Qwen3-1.7B-GGUF',revision:'d7f544eead698dbd1f15126ef60b45a1e1933222',license:'Apache-2.0',
    filename:'Qwen3-1.7B-Q4_K_M.gguf',bytes:1107409472,sha256:'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897'},
  runtime:{id:'ggml-org/llama.cpp',tag:'b11146',commit:'7fe450e19305b828c199d602c23a8337aaa1f03b',license:'MIT',
    filename:'llama-b11146-bin-win-cpu-x64.zip',bytes:18560055,sha256:'14cf1303ca9ac3abd94816850532f9f9a69ac66fbaca3776fc6f9061c2fac1d1'},
};
async function download(url,file,expected){
  try{await stat(file);throw Error('DESTINATION_EXISTS: '+file);}catch(e){if(e.code!=='ENOENT')throw e;}
  const response=await fetch(url,{signal:AbortSignal.timeout(600000)});
  if(!response.ok)throw Error('DOWNLOAD_HTTP_'+response.status);
  let bytes=0;
  await pipeline(response.body,async function*(chunks){for await(const chunk of chunks){bytes+=chunk.length;if(bytes>expected.bytes)throw Error('DOWNLOAD_TOO_LARGE');yield chunk;}},createWriteStream(file,{flags:'wx'}));
  const sha256=await sha256Arquivo(file);
  if(bytes!==expected.bytes||sha256!==expected.sha256)throw Error('DOWNLOAD_INTEGRITY_FAILED');
  return {file,bytes,sha256,url,retrievedAt:new Date().toISOString()};
}
async function textSource(name,url){
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('SOURCE_HTTP_'+response.status);
  const content=await response.text();
  await writeFile(join(ROOT,name),content,{flag:'wx'});
  return {url,sha256:await sha256Arquivo(join(ROOT,name))};
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
  await mkdir(ROOT,{recursive:true});
  const mode=process.argv[2];
  if(!['runtime','model'].includes(mode))throw Error('USE runtime|model');
  const pin=PIN[mode];
  const url=mode==='runtime'?`https://github.com/${pin.id}/releases/download/${pin.tag}/${pin.filename}`:
    `https://huggingface.co/${pin.id}/resolve/${pin.revision}/${pin.filename}`;
  const receipt={pin,download:await download(url,join(ROOT,pin.filename),pin),sources:{}};
  if(mode==='runtime'){
    receipt.sources.release=await textSource('runtime-release.json',`https://api.github.com/repos/${pin.id}/releases/tags/${pin.tag}`);
    receipt.sources.license=await textSource('runtime-LICENSE.txt',`https://raw.githubusercontent.com/${pin.id}/${pin.commit}/LICENSE`);
    receipt.sources.server=await textSource('runtime-server-README.md',`https://raw.githubusercontent.com/${pin.id}/${pin.commit}/tools/server/README.md`);
  }else{
    receipt.sources.metadata=await textSource('model-metadata.json',`https://huggingface.co/api/models/${pin.id}/revision/${pin.revision}?blobs=true`);
    receipt.sources.card=await textSource('model-README.md',`https://huggingface.co/${pin.id}/raw/${pin.revision}/README.md`);
    receipt.sources.license=await textSource('model-LICENSE.txt','https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/raw/90862c4b9d2787eaed51d12237eafdfe7c5f6077/LICENSE');
  }
  await writeFile(join(ROOT,`${mode}-download.json`),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(receipt));
}

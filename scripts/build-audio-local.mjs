import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BUNDLE, SOURCES, verifyBundle, verifyFile, WORK} from './audio-local-smoke-real.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const OUT=join(ROOT,'native','audio-local','bin');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const entries=[...BUNDLE.map(x=>({nome:x.name,bytes:x.bytes,sha256:x.sha256})),
  {nome:'modelo.bin',bytes:SOURCES.model.bytes,sha256:SOURCES.model.sha256}].sort((a,b)=>a.nome.localeCompare(b.nome,'en'));
const manifesto={versao:2,motor:'whisper.cpp',versaoMotor:'b5130',plataforma:'win32',arquitetura:'x64',modeloNome:'ggml-base',arquivos:entries};
const bytes=Buffer.from(JSON.stringify(manifesto)+'\n');
export const MANIFEST_SHA256=sha(bytes);

export async function buildAudioLocal(){
  if(process.platform!=='win32'||process.arch!=='x64')throw new Error('A montagem de áudio exige host Windows x64.');
  const policy=JSON.parse(await readFile(join(ROOT,'desktop','audio-local-policy.json'),'utf8'));
  if(policy.versao!==1||policy.pacotes?.['win32-x64']?.manifestoSha256!==MANIFEST_SHA256)throw new Error('Política de áudio não fixa o manifesto desta montagem.');
  await verifyBundle(join(WORK,'bundle'));
  await verifyFile(join(WORK,'downloads',SOURCES.model.name),SOURCES.model);
  await mkdir(join(ROOT,'native','audio-local'),{recursive:true});
  let present=false;
  try{await readdir(OUT);present=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!present){
    const temp=await mkdtemp(join(ROOT,'native','audio-local','staging-'));
    try{
      for(const item of BUNDLE)await copyFile(join(WORK,'bundle',item.name),join(temp,item.name));
      await copyFile(join(WORK,'downloads',SOURCES.model.name),join(temp,'modelo.bin'));
      await writeFile(join(temp,'manifest.json'),bytes);
      try{await rename(temp,OUT);}catch(e){if(e.code!=='EEXIST'&&e.code!=='EPERM')throw e;}
    }finally{await rm(temp,{recursive:true,force:true});}
  }
  if((await readdir(OUT)).sort().join(',')!==['manifest.json',...entries.map(x=>x.nome)].sort().join(','))throw new Error('Pasta de áudio contém arquivos extras ou ausentes.');
  for(const item of entries)await verifyFile(join(OUT,item.nome),{name:item.nome,bytes:item.bytes,sha256:item.sha256});
  if(sha(await readFile(join(OUT,'manifest.json')))!==MANIFEST_SHA256)throw new Error('Manifesto de áudio mudou após montagem.');
  return {raiz:OUT,manifestoSha256:MANIFEST_SHA256,arquivos:entries.length};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--print-policy'))console.log(MANIFEST_SHA256);
  else console.log(JSON.stringify(await buildAudioLocal()));
}

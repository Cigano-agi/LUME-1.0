import {readFileSync,readdirSync,statSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {put} from '@vercel/blob';
import {compareReleaseVersions,manifestVersion,parseReleaseVersion} from './release-version.mjs';
import {assertReleaseReady} from './release-readiness.mjs';
import origemLume from '../desktop/origem-lume.cjs';

export async function publicarRelease({
  dir=resolve('release-files'),root=resolve('.'),env=process.env,
  readiness=assertReleaseReady,putFile=put,fetchUrl=globalThis.fetch,log=console.log,
  read=readFileSync,list=readdirSync,stat=statSync
}={}){
  const approved=readiness({mode:'publish',root,artifactsDir:dir,env});
  const version=parseReleaseVersion(approved.version).raw;
  const channel=version.includes('-beta.')?'beta':'estavel';
  const token=env.BLOB_READ_WRITE_TOKEN;
  const allowed=/\.(?:exe|blockmap|dmg|zip|yml)$/;
  const files=list(dir).filter(name=>stat(resolve(dir,name)).isFile()&&!/^release-proof-(?:windows|macos)\.json$/.test(name));
  if(files.some(name=>!allowed.test(name)||basename(name)!==name))throw Error('O diretorio de release contem arquivo nao permitido.');
  const manifests=channel==='beta'?['beta.yml','beta-mac.yml']:['latest.yml','latest-mac.yml'];
  for(const name of manifests)if(!files.includes(name))throw Error(`Manifesto obrigatorio ausente: ${name}`);
  if(!files.some(name=>name.endsWith('.exe'))||!files.some(name=>name.endsWith('.dmg'))||!files.some(name=>name.endsWith('.zip')))throw Error('A release exige EXE, DMG e ZIP.');
  for(const name of manifests){const text=read(resolve(dir,name),'utf8');if(manifestVersion(text)!==version)throw Error(`Versao incorreta em ${name}.`);}
  const currentResponse=await fetchUrl(`${origemLume.feedAtualizacoes(channel)}/${manifests[0]}?check=${Date.now()}`,{cache:'no-store',headers:{'cache-control':'no-cache'}});
  if(currentResponse.ok){const current=manifestVersion(await currentResponse.text());if(!current)throw Error('Manifesto publicado possui versao invalida.');if(compareReleaseVersions(version,current)<=0)throw Error(`A versao publicada ${current} e igual ou posterior a ${version}.`);}
  else if(currentResponse.status!==404)throw Error(`Nao foi possivel conferir o canal publicado (${currentResponse.status}).`);
  // Cada manifesto vivo ganha antes uma copia imutavel por versao. Ela permite
  // identificar e restaurar o canal para quem ainda nao atualizou, sem apagar
  // binarios nem inventar downgrade automatico para quem ja esta no alvo.
  const ordered=[
    ...files.filter(name=>!name.endsWith('.yml')).sort().map(name=>({name,pathname:`releases/${channel}/${name}`})),
    ...manifests.map(name=>({name,pathname:`releases/${channel}/manifests/${version}/${name}`})),
    ...manifests.map(name=>({name,pathname:`releases/${channel}/${name}`}))
  ];
  const published=[];
  for(const {name,pathname} of ordered){
    const body=read(resolve(dir,name));
    const result=await putFile(pathname,body,{access:'public',addRandomSuffix:false,allowOverwrite:true,token,contentType:name.endsWith('.yml')?'application/yaml':undefined});
    const response=await fetchUrl(result.url,{method:'HEAD'});if(!response.ok)throw Error(`Falha ao verificar ${name}.`);
    const item={file:name,path:pathname,bytes:body.length,published:true};published.push(item);log(JSON.stringify(item));
  }
  return {version,channel,published};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  publicarRelease({dir:resolve(process.argv[2]||'release-files')}).catch(error=>{console.error(error.message);process.exitCode=1;});
}

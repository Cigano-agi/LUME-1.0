import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseReleaseVersion} from './release-version.mjs';
import {assertReleaseReady} from './release-readiness.mjs';
import origemLume from '../desktop/origem-lume.cjs';

export function prepararRelease({
  platform=process.platform,
  env=process.env,
  root=resolve(import.meta.dirname,'..'),
  readiness=assertReleaseReady,
  write=writeFileSync
}={}){
  const mode=platform==='win32'?'windows':platform==='darwin'?'macos':null;
  if(!mode)throw Error('A release publica so pode ser preparada nos runners Windows ou macOS.');
  const approved=readiness({mode,root,env});
  const version=parseReleaseVersion(approved.version).raw;
  const channel=version.includes('-beta.')?'beta':'estavel';
  const feedUrl=origemLume.feedAtualizacoes(channel);
  write(resolve(root,'desktop/release-policy.json'),JSON.stringify({schema:'lume-release-v1',enabled:true,channel,feedUrl},null,2)+'\n');
  return {version,channel,feedUrl,updatesEnabled:true};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{console.log(JSON.stringify(prepararRelease()));}
  catch(error){console.error(error.message);process.exitCode=1;}
}

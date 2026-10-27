import {execFile} from 'node:child_process';
import {readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,resolve,parse,relative,sep} from 'node:path';

const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const expectedKeys=['arch','file','platform','schema','sha256','sourceSha256'].sort().join(',');
function regular(path){
  let part=parse(path).root;
  const names=relative(part,path).split(sep);
  for(let i=0;i<names.length;i++){
    part=join(part,names[i]);const stat=lstatSync(part);
    if(stat.isSymbolicLink()||(i===names.length-1?(!stat.isFile()||stat.nlink!==1):!stat.isDirectory()))throw Error('ATIVIDADE_INDISPONIVEL');
  }
}
export function criarColetorApps({platform=process.platform,arch=process.arch,bin}={}){
  const root=fileURLToPath(new URL('../native/app-activity/bin/',import.meta.url)).replace(/app\.asar([/\\])/u,'app.asar.unpacked$1');
  const dir=resolve(bin||root),path=join(dir,'lume-activity.exe'),manifestPath=join(dir,'manifest.json');
  let disponivel=false;
  function verificar(){try{
    regular(path);regular(manifestPath);
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    return Object.keys(manifest).sort().join(',')===expectedKeys&&manifest.schema===1&&manifest.file==='lume-activity.exe'&&manifest.platform==='win32'&&manifest.arch==='x64'&&/^[a-f0-9]{64}$/u.test(manifest.sourceSha256)&&manifest.sha256===hash(path);
  }catch{return false;}}
  if(platform==='win32'&&arch==='x64')disponivel=verificar();
  let running=null;
  const coletar=({signal}={})=>{
    if(!disponivel||signal?.aborted)return Promise.resolve({estado:'indisponivel'});
    if(running)return Promise.reject(Error('ATIVIDADE_OCUPADA'));
    if(!verificar())return Promise.resolve({estado:'indisponivel'});
    let child;
    const result=new Promise(resolveSample=>{
      // execFile's callback runs after child close, including cancellation/timeout.
      child=execFile(path,['--sample'],{windowsHide:true,timeout:2500,maxBuffer:2048,encoding:'utf8'},(error,stdout)=>{
        signal?.removeEventListener('abort',abort);
        if(error||signal?.aborted)return resolveSample({estado:'indisponivel'});
        try{resolveSample(JSON.parse(stdout.replace(/^\uFEFF/u,'')));}catch{resolveSample({estado:'indisponivel'});}
      });
      function abort(){child.kill();}
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
    running=result;
    return result.finally(()=>{if(running===result)running=null;});
  };
  return {disponivel,coletar};
}

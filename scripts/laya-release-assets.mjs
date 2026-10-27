// Fail-closed model transfer for signed builds. No model weights enter Git.
import {spawn} from 'node:child_process';
import {readFile,mkdir,readdir,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {MODEL_FILES,sha256,verificarModelo} from '../src/laya/integrity.js';
import {MODEL_REVISION} from '../src/laya/policy.js';
import {DOMAIN_POLICY} from '../src/laya/domain-policy.js';
import {carregarCabecaAprovada} from '../src/laya/domain-head.js';
import {prepararConfig} from './build-laya-bundled.mjs';

const root=resolve(import.meta.dirname,'..');
const lockPath=join(root,'docs','beta-06','laya-bundle-lock.json');
const manifestName='lume-laya-manifest.json';
const expectedAssets=[...MODEL_FILES,manifestName,...(DOMAIN_POLICY.approvedForActions?['domain-head.json']:[])].sort();

export async function lerTrava(path=lockPath){
  const lock=JSON.parse(await readFile(path,'utf8'));
  if(lock.schema!=='lume-laya-bundle-lock-v1'||lock.revision!==MODEL_REVISION||
    !/^[a-f0-9]{64}$/.test(lock.manifestSha256??'')||
    !/^laya-model-[a-z0-9-]+$/.test(lock.tag??'')||
    typeof lock.approvedForActions!=='boolean'||lock.approvedForActions!==DOMAIN_POLICY.approvedForActions||
    (lock.approvedForActions&&lock.domainHeadSha256!==DOMAIN_POLICY.modelSha256)||
    !Array.isArray(lock.assets)||
    JSON.stringify([...lock.assets].sort())!==JSON.stringify(expectedAssets))throw Error('LAYA_RELEASE_LOCK_INVALIDO');
  return lock;
}

export async function validarFonte(source,lock){
  source=resolve(source);
  const digest=await sha256(join(source,manifestName));
  if(digest!==lock.manifestSha256)throw Error('LAYA_RELEASE_MANIFEST_DIVERGENTE');
  const manifest=await verificarModelo(source);
  if(manifest.revision!==lock.revision)throw Error('LAYA_RELEASE_REVISAO_DIVERGENTE');
  if(lock.approvedForActions)await carregarCabecaAprovada(source,DOMAIN_POLICY,manifest.revision);
  return{source,revision:manifest.revision,manifestSha256:digest,files:expectedAssets};
}

async function baixarAtivos(lock,target,env){
  if(env.GITHUB_ACTIONS!=='true'||!env.GH_TOKEN||!env.GITHUB_REPOSITORY)throw Error('LAYA_RELEASE_ORIGEM_AUSENTE');
  await mkdir(target,{recursive:true});
  if((await readdir(target)).length)throw Error('LAYA_RELEASE_DESTINO_NAO_VAZIO');
  for(const name of expectedAssets){
    await new Promise((done,fail)=>{
      const child=spawn('gh',['release','download',lock.tag,'--repo',env.GITHUB_REPOSITORY,'--pattern',name,'--dir',target],{cwd:root,env,stdio:'inherit',shell:false});
      child.once('error',fail);
      child.once('exit',code=>code===0?done():fail(Error(`LAYA_RELEASE_DOWNLOAD_FALHOU:${name}`)));
    });
  }
}

export async function prepararReleaseBundle({source=process.env.LUME_LAYA_MODEL_DIR,env=process.env}={}){
  const lock=await lerTrava();
  if(env.GITHUB_ACTIONS==='true'&&env.LUME_RELEASE_APPROVED==='PUBLICAR'&&lock.approvedForActions!==true)throw Error('LAYA_RELEASE_QUALIDADE_NAO_APROVADA');
  if(!source){source=join(root,'work','laya-release-source');await baixarAtivos(lock,source,env);}
  const proof=await validarFonte(source,lock);
  const config=await prepararConfig({source:proof.source,outputDir:join(root,'dist','desktop')});
  if(env.GITHUB_ENV)await appendFile(env.GITHUB_ENV,`LUME_LAYA_BUILD_CONFIG=${config.configPath}\nLUME_LAYA_MODEL_DIR=${proof.source}\n`);
  return{...proof,configPath:config.configPath,tag:lock.tag};
}

export async function verificarReleaseBundle({platform,resources,outputDir=join(root,'dist','desktop')}={}){
  const lock=await lerTrava();
  if(!resources){
    if(platform==='windows')resources=join(outputDir,'win-unpacked','resources','laya');
    else if(platform==='macos')resources=join(outputDir,'mac-universal','Lume.app','Contents','Resources','laya');
    else throw Error('LAYA_RELEASE_PLATAFORMA_INVALIDA');
  }
  return validarFonte(resources,lock);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode=process.argv[2];
  const action=mode==='prepare'?prepararReleaseBundle():mode==='verify'?verificarReleaseBundle({platform:process.argv[3],resources:process.argv[4]}):Promise.reject(Error('Use prepare ou verify <windows|macos> [resources].'));
  action.then(result=>console.log('LAYA_RELEASE_BUNDLE_OK',JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}

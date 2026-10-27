// Internal offline candidate: include a verified Laya export in app resources.
// The export stays outside Git. This command does not sign or publish the app.
import {spawn} from 'node:child_process';
import {readFile, mkdir, writeFile, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verificarModelo} from '../src/laya/integrity.js';
import {DOMAIN_POLICY} from '../src/laya/domain-policy.js';
import {carregarCabecaAprovada} from '../src/laya/domain-head.js';
import {assertReleaseReady} from './release-readiness.mjs';
import {candidateBuildArgs} from './construir-candidato.mjs';

const root=resolve(import.meta.dirname,'..');
const names=['encoder.onnx','encoder.onnx.data','head.onnx','head.onnx.data','tokenizer.json','rl_agent_config.json','lume-laya-manifest.json','LICENSE','MODEL-CARD.md',...(DOMAIN_POLICY.approvedForActions?['domain-head.json']:[])];

export async function prepararConfig({source,outputDir=join(root,'work','laya-bundled-build')}={}){
  if(!source)throw Error('Defina LUME_LAYA_MODEL_DIR para a exportação ONNX local.');
  source=resolve(source);outputDir=resolve(outputDir);
  const manifest=await verificarModelo(source);
  if(DOMAIN_POLICY.approvedForActions)await carregarCabecaAprovada(source,DOMAIN_POLICY,manifest.revision);
  const fs=await import('node:fs/promises');
  for(const name of names)await fs.access(join(source,name));
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const config={...pkg.build,directories:{...pkg.build.directories,output:outputDir},extraResources:[{from:source,to:'laya',filter:names}]};
  await mkdir(join(root,'work'),{recursive:true});
  const configPath=join(root,'work','laya-bundled-electron-builder.json');
  await writeFile(configPath,JSON.stringify(config,null,2));
  return{configPath,outputDir,source,names};
}

export async function construirComLaya({source=process.env.LUME_LAYA_MODEL_DIR,platform=process.platform,arch=process.arch,dirOnly=false}={}){
  assertReleaseReady({mode:'candidate',root,env:process.env});
  // Keep unpacked developer candidates away from installer/update artifacts.
  const outputDir=join(root,'work',dirOnly?'laya-bundled-dir-candidate':'laya-bundled-build');
  const prepared=await prepararConfig({source,outputDir});
  const require=createRequire(import.meta.url);
  const args=[require.resolve('electron-builder/out/cli/cli.js'),...candidateBuildArgs({platform,arch}),'--config',prepared.configPath];
  if(!dirOnly)args.splice(args.indexOf('--dir'),1);
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:root,env:process.env,stdio:'inherit',shell:false});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(`electron-builder saiu com código ${code}`)));
  });
  const resources=platform==='win32'
    ?join(prepared.outputDir,'win-unpacked','resources','laya')
    :join(prepared.outputDir,`mac-${arch}`,'Lume.app','Contents','Resources','laya');
  const manifest=await verificarModelo(resources);
  const license=await stat(join(resources,'LICENSE')),card=await stat(join(resources,'MODEL-CARD.md'));
  if(!license.size||!card.size)throw Error('Licença ou ficha do modelo ausente no aplicativo.');
  const evidence={date:new Date().toISOString(),platform,arch,resources,revision:manifest.revision,verifiedFiles:Object.keys(manifest.sha256),licenseIncluded:true,modelCardIncluded:true,signed:false,nativeLaunchVerified:false,distributionReady:false};
  await writeFile(join(prepared.outputDir,'laya-bundle-evidence.json'),JSON.stringify(evidence,null,2));
  return{...prepared,evidence};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  construirComLaya({dirOnly:process.argv.includes('--dir')}).then(result=>console.log('LUME_LAYA_BUNDLE_CANDIDATE',JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}

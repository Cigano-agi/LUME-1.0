// Offline installation from a verified export; never downloads at runtime.
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { verificarModelo } from '../src/laya/integrity.js';
const [sourceArg,targetArg]=process.argv.slice(2);
if(!sourceArg||!targetArg)throw new Error('Uso: node scripts/laya-install.mjs <exportacao> <destino-vazio>');
const source=resolve(sourceArg),target=resolve(targetArg);
if(source===target)throw new Error('LAYA_DESTINO_IGUAL_ORIGEM');
const manifest=await verificarModelo(source);
await mkdir(target,{recursive:true});
if((await readdir(target)).length)throw new Error('LAYA_DESTINO_NAO_VAZIO');
for(const name of Object.keys(manifest.sha256)){
 if(!/^[a-zA-Z0-9_.-]+$/.test(name))throw new Error('LAYA_NOME_INVALIDO');
 await copyFile(join(source,name),join(target,name));
}
// Manifest last: incomplete copies are never advertised as installed.
await copyFile(join(source,'lume-laya-manifest.json'),join(target,'lume-laya-manifest.json'));
await verificarModelo(target);
console.log(JSON.stringify({installed:true,path:target,revision:manifest.revision,experimental:true}));

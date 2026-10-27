import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL_REVISION } from './policy.js';
export const MODEL_FILES=Object.freeze(['encoder.onnx','encoder.onnx.data','head.onnx','head.onnx.data','tokenizer.json','rl_agent_config.json','LICENSE','MODEL-CARD.md']);
export async function sha256(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function verificarModelo(dir){
 const manifest=JSON.parse(await readFile(join(dir,'lume-laya-manifest.json'),'utf8'));
 if(manifest.revision!==MODEL_REVISION||manifest.parityVerified!==true)throw new Error('LAYA_MODELO_NAO_VERIFICADO');
 if(!manifest.sha256||Object.keys(manifest.sha256).sort().join('|')!==[...MODEL_FILES].sort().join('|'))throw new Error('LAYA_INTEGRIDADE_FALHOU');
 for(const name of MODEL_FILES){
  if(!/^[a-f0-9]{64}$/.test(manifest.sha256[name]))throw new Error('LAYA_INTEGRIDADE_FALHOU');
  let actual;try{actual=await sha256(join(dir,name));}catch{throw new Error('LAYA_INTEGRIDADE_FALHOU');}
  if(actual!==manifest.sha256[name])throw new Error('LAYA_INTEGRIDADE_FALHOU');
 }
 return manifest;
}

// Local only. Never reads the WhatsApp database or sends data to a service.
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {dividirAnotacoes} from './laya-annotations-lib.mjs';

const args=process.argv.slice(2),[input,flag,output,confirm]=args;
if(!input||![1,4].includes(args.length)||flag&&flag!=='--out'||flag&&(!output||confirm!=='--confirm-local-write')){
  throw Error('Uso: node scripts/laya-annotations.mjs ENTRADA.json [--out work/laya-private/divisao.json --confirm-local-write]');
}
const data=JSON.parse(await readFile(resolve(input),'utf8'));
const result=dividirAnotacoes(data);
if(flag){
  const base=resolve('work/laya-private'),target=resolve(output),rel=relative(base,target);
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||!target.endsWith('.json'))throw Error('SAIDA_FORA_DO_WORK_PRIVADO');
  await mkdir(dirname(target),{recursive:true});
  const rootReal=await realpath('.'),baseReal=await realpath(base),dirReal=await realpath(dirname(target));
  const dentro=(parent,child)=>{const r=relative(parent,child);return r===''||!r.startsWith('..')&&!isAbsolute(r);};
  if(!dentro(rootReal,baseReal)||!dentro(baseReal,dirReal))throw Error('SAIDA_FORA_DO_WORK_PRIVADO');
  await writeFile(target,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
}
console.log(JSON.stringify({dataKind:result.dataKind,summary:result.summary,written:Boolean(flag),notice:'Revisão humana dos direitos e do texto continua obrigatória. Nenhum conteúdo foi impresso.'}));

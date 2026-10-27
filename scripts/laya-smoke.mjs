import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { criarLayaLocal } from '../src/laya/index.js';
const modelDir=resolve(process.argv[2]??'work/laya-onnx');
const laya=criarLayaLocal({modelDir,idleMs:1000});
const before=laya.status(),started=performance.now();
try{
 const result=await laya.classificar({texto:'Eu envio a procuração assinada amanhã.'});
 const elapsedMs=Math.round(performance.now()-started),ready=laya.status();
 const proof={date:new Date().toISOString(),before,result,ready,elapsedMs,rssLoadedMb:Math.round(process.memoryUsage().rss/1048576),synthetic:true};
 if(result.categoria!==null||result.motivo!=='validacao_pendente'||ready.aprovado!==false)throw new Error('Porta de qualidade falhou');
 await laya.close();proof.closed=laya.status();proof.rssAfterCloseMb=Math.round(process.memoryUsage().rss/1048576);
 await writeFile('work/laya-worker-smoke.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
}finally{await laya.close();}

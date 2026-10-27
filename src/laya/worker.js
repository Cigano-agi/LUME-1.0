import { parentPort, workerData } from 'node:worker_threads';
import { carregarRuntime } from './runtime.js';
let runtime;
try {
  const started = performance.now();
  runtime = await carregarRuntime(workerData.modelDir,{domainPolicy:workerData.domainPolicy});
  parentPort.postMessage({type:'ready',loadMs:Math.round(performance.now()-started)});
  parentPort.on('message',async ({id,texto,operation,input}) => {
    try { parentPort.postMessage({id,result:operation==='actions'?await runtime.inferirAcoes(input):await runtime.infer(texto)}); }
    catch (error) { parentPort.postMessage({id,error:/^LAYA_/.test(error.message)?error.message:'LAYA_INFERENCIA_FALHOU'}); }
  });
} catch (error) {
  parentPort.postMessage({type:'error',error:/^LAYA_/.test(error.message)?error.message:'LAYA_CARGA_FALHOU'});
  parentPort.close();
}

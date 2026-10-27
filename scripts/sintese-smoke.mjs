// Distinct fictitious plumbing check, not a quality evaluation or product path.
import {carregarSinteseLocal,sha256Arquivo} from './lib/sintese-local-runtime.mjs';
import {gravarAtomico} from './contexto-probe.mjs';
import {resolve} from 'node:path';
import {lstat} from 'node:fs/promises';
const [modelDir,lockPath,output]=process.argv.slice(2);
if(!modelDir||!lockPath||!output)throw Error('Informe pasta, manifesto e saída inédita.');
try{await lstat(output);throw Error('Saída já existe.');}catch(e){if(e.code!=='ENOENT')throw e;}
const fontes=[{id:'E1',autor:'Pessoa fictícia',data:'2026-09-26T12:00:00Z',texto:'Esta é uma mensagem fictícia para conferir a leitura local de texto.'}];
const result={schema:'lume-sintese-smoke-v1',data:new Date().toISOString(),aprovado:false,fontes,modeloLockSha256:await sha256Arquivo(lockPath)};
let motor;const started=performance.now();let rss=process.memoryUsage().rss;
const timer=setInterval(()=>{rss=Math.max(rss,process.memoryUsage().rss);},25);
try{
  motor=await carregarSinteseLocal(resolve(modelDir),resolve(lockPath),result.modeloLockSha256);
  result.cargaMs=performance.now()-started;result.entrada=motor.validar(fontes);result.saida=await motor.gerar(fontes);result.completo=true;
}catch(e){result.completo=false;result.erro=String(e.message).slice(0,2000);}
finally{
  try{await motor?.close();}catch(e){result.completo=false;result.erroFechamento=String(e.message).slice(0,1000);}
  clearInterval(timer);result.duracaoMs=performance.now()-started;result.rssAmostradoMaxBytes=Math.max(rss,process.memoryUsage().rss);
  result.maxRssSoBytes=process.resourceUsage().maxRSS*1024;
  result.medicaoMemoria='Máximo do SO para este processo; amostragem JS separada pode perder picos nativos. Não representa app instalado ou memória total da máquina.';
}
await gravarAtomico(resolve(output),result);
console.log(JSON.stringify(result));if(!result.completo)process.exitCode=1;

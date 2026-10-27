#!/usr/bin/env node
// One frozen local run. Raw generations are preserved even when rejected by the schema.
import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cpus,totalmem} from 'node:os';
import {carregarSinteseLocal,sha256Arquivo,dependenciasSintese,GERACAO,CPU} from './lib/sintese-local-runtime.mjs';
import {analisarRespostaSintese} from './lib/sintese-prompt.mjs';
import {validarFontes} from '../src/sintese-contexto/contrato.js';
import {gravarAtomico} from './contexto-probe.mjs';

const paths=['scripts/sintese-probe.mjs','scripts/lib/sintese-local-runtime.mjs','scripts/lib/sintese-prompt.mjs','scripts/lib/sintese-termino.mjs',
  'src/sintese-contexto/contrato.js','scripts/contexto-probe.mjs','scripts/sintese-supervisor.mjs','package.json','package-lock.json'];
const root=new URL('../',import.meta.url);
export function argumentosSintese(argv){
  const flags=['--model-dir','--model-lock','--lock-sha256','--cases','--cases-sha256','--output'],opts={};
  if(argv.length!==12)throw Error('SINTESE_ARGUMENTOS_INVALIDOS');
  for(let i=0;i<argv.length;i+=2){if(!flags.includes(argv[i])||Object.hasOwn(opts,argv[i])||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('SINTESE_ARGUMENTOS_INVALIDOS');opts[argv[i]]=argv[i+1];}
  for(const key of ['--lock-sha256','--cases-sha256'])if(!/^[a-f0-9]{64}$/.test(opts[key]))throw Error('SINTESE_HASH_INVALIDO');
  return opts;
}
export async function executarSinteseProbe(opts,{carregar=carregarSinteseLocal}={}){
  argumentosSintese(Object.entries(opts).flat());
  const output=resolve(opts['--output']);
  try{await lstat(output);throw Error('SINTESE_SAIDA_EXISTENTE');}catch(e){if(e.code!=='ENOENT')throw e;}
  const bytes=await readFile(opts['--cases']);if(bytes.length>1024**2)throw Error('SINTESE_CASOS_EXTENSOS');
  const hash=createHash('sha256').update(bytes).digest('hex');if(hash!==opts['--cases-sha256'])throw Error('SINTESE_CASOS_DIVERGENTES');
  const conjunto=JSON.parse(bytes),casos=conjunto.casos;
  if(conjunto.versao!==1||!Array.isArray(casos)||casos.length!==8||!conjunto.gabarito||typeof conjunto.gabarito!=='object')throw Error('SINTESE_OITO_CASOS_OBRIGATORIOS');
  const seen=new Set();
  // Only sources reach the generator; the rubric is retained solely in the receipt.
  const entradas=casos.map(c=>{if(typeof c.id!=='string'||!c.id||seen.has(c.id))throw Error('SINTESE_CASO_INVALIDO');seen.add(c.id);return {id:c.id,fontes:validarFontes(c.fontes)};});
  const code=Object.fromEntries(await Promise.all(paths.map(async p=>[p,await sha256Arquivo(new URL(p,root))])));
  const receipt={schema:'lume-sintese-probe-v1',data:new Date().toISOString(),research:true,aprovado:false,
    modeloLockSha256:opts['--lock-sha256'],casosSha256:hash,codigo:code,geracao:GERACAO,cpu:CPU,dependencias:await dependenciasSintese(),limiteGeracaoMs:90000,
    hardware:{cpu:cpus()[0]?.model,memoriaTotalBytes:totalmem(),node:process.version,plataforma:process.platform},
    casos,gabarito:conjunto.gabarito,resultados:[],completo:false,erros:[],rede:'Downloads desativados na biblioteca; gerador local. Não é isolamento global do SO.'};
  let motor,rss=process.memoryUsage().rss;const started=performance.now(),timer=setInterval(()=>{rss=Math.max(rss,process.memoryUsage().rss);},25);
  try{
    motor=await carregar(opts['--model-dir'],opts['--model-lock'],opts['--lock-sha256']);
    receipt.cargaMs=performance.now()-started;receipt.modelo=motor.modelo;
    for(const entrada of entradas)motor.validar(entrada.fontes);
    for(const entrada of entradas){
      const raw=await motor.gerar(entrada.fontes),row={id:entrada.id,...raw,valida:false};
      if(!raw.interrompida){try{row.cartao=analisarRespostaSintese(raw.texto,entrada.fontes);row.valida=true;}catch(e){row.erro=String(e.message).slice(0,240);}}
      else row.erro='SINTESE_GERACAO_INTERROMPIDA';
      receipt.resultados.push(row);console.log(JSON.stringify({id:row.id,valida:row.valida,tokens:row.tokensSaida,duracaoMs:Math.round(row.duracaoMs)}));
    }
    receipt.completo=true;
  }catch(e){receipt.erros.push({tipo:'execucao',mensagem:String(e.message).slice(0,400)});}
  finally{
    try{await motor?.close();}catch(e){receipt.completo=false;receipt.erros.push({tipo:'fechamento',mensagem:String(e.message).slice(0,400)});}
    clearInterval(timer);receipt.duracaoMs=performance.now()-started;receipt.rssAmostradoMaxBytes=Math.max(rss,process.memoryUsage().rss);
    receipt.maxRssSoBytes=process.resourceUsage().maxRSS*1024;
    receipt.medicaoMemoria='maxRssSoBytes é o máximo do processo informado pelo SO; amostragem JS pode perder picos durante ORT síncrono. Não mede o Electron nem o SO inteiro.';
  }
  for(const p of paths)if(await sha256Arquivo(new URL(p,root))!==code[p]){receipt.completo=false;receipt.erros.push({tipo:'codigo_alterado',arquivo:p});}
  await gravarAtomico(output,receipt);
  console.log(JSON.stringify({output,completo:receipt.completo,validas:receipt.resultados.filter(r=>r.valida).length,total:casos.length,aprovado:false}));
  return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const result=await executarSinteseProbe(argumentosSintese(process.argv.slice(2)));if(!result.completo)process.exitCode=1;}
  catch(e){console.error(String(e.message).slice(0,400));process.exitCode=1;}
}

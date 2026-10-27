#!/usr/bin/env node
// Offline research runner. Does not open a user profile or change a product gate.
import {readFile,stat,lstat,mkdir,open,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {cpus,totalmem,platform,arch,release} from 'node:os';
import {performance} from 'node:perf_hooks';
import {carregarContextoRuntime,validarEntrada,objetoFechado,validarTextoSeguro,LIMITES,OPCOES_CPU} from './lib/laya-contexto-runtime.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
export const ARQUIVOS_CODIGO=Object.freeze(['scripts/contexto-probe.mjs','scripts/lib/laya-contexto-runtime.mjs',
  'src/laya/integrity.js','src/laya/policy.js','src/laya/vendor/tokenizer.js','src/laya/vendor/common.js']);
const MAX_CASOS=256,MAX_BYTES=4*1024*1024;
const SENSIVEIS=['aceite','pagamento','conclusao'];
const falha=code=>new Error(code);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const identificador=s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(s);
const codigoSeguro=e=>/^(?:CONTEXTO|LAYA)_[A-Z0-9_]+$/.test(e?.message??'')?e.message:
  e?.code==='EEXIST'?'CONTEXTO_SAIDA_EXISTENTE':'CONTEXTO_FALHA_LOCAL';
export const USO='node scripts/contexto-probe.mjs --model-dir <diretorio> --cases <array.json> --output <recibo-novo.json> --expected-cases-sha256 <sha256-dos-bytes>';

export function argumentos(argv){
  const required=['--model-dir','--cases','--output','--expected-cases-sha256'],values={};
  if(argv.length!==8)throw falha('CONTEXTO_ARGUMENTOS_INVALIDOS');
  for(let i=0;i<argv.length;i+=2){
    const flag=argv[i],value=argv[i+1];
    if(!required.includes(flag)||Object.hasOwn(values,flag)||typeof value!=='string'||!value.trim()||value.startsWith('--')||value.includes('\0'))
      throw falha('CONTEXTO_ARGUMENTOS_INVALIDOS');
    values[flag]=value;
  }
  if(!/^[a-f0-9]{64}$/i.test(values['--expected-cases-sha256']))throw falha('CONTEXTO_HASH_OBRIGATORIO');
  const result={modelDir:resolve(values['--model-dir']),cases:resolve(values['--cases']),output:resolve(values['--output']),
    expectedCasesSha256:values['--expected-cases-sha256'].toLowerCase()};
  const canonical=p=>process.platform==='win32'?p.toLowerCase():p;
  const rel=relative(canonical(result.modelDir),canonical(result.output));
  if(canonical(result.output)===canonical(result.cases)||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')))
    throw falha('CONTEXTO_DESTINO_INVALIDO');
  return result;
}

export function validarCasos(casos){
  if(!Array.isArray(casos)||!casos.length||casos.length>MAX_CASOS)throw falha('CONTEXTO_CASOS_ARRAY_OBRIGATORIO');
  const ids=new Set();
  return casos.map(caso=>{
    objetoFechado(caso,['id','cenarioId','estado','pergunta','criterios','esperado','critico','justificativa'],['dimensao','classesSensiveis']);
    if(!identificador(caso.id)||!identificador(caso.cenarioId)||ids.has(caso.id)||typeof caso.critico!=='boolean')throw falha('CONTEXTO_CASO_INVALIDO');
    ids.add(caso.id);
    const entrada=validarEntrada({estado:caso.estado,pergunta:caso.pergunta,criterios:caso.criterios});
    if(typeof caso.esperado!=='string'||!Object.hasOwn(entrada.criterios,caso.esperado))throw falha('CONTEXTO_GABARITO_INVALIDO');
    validarTextoSeguro(caso.justificativa,4000);
    if(caso.dimensao!==undefined)validarTextoSeguro(caso.dimensao,80);
    let classesSensiveis=null;
    if(caso.classesSensiveis!==undefined){
      objetoFechado(caso.classesSensiveis,SENSIVEIS);
      classesSensiveis=Object.fromEntries(SENSIVEIS.map(tipo=>{
        const keys=caso.classesSensiveis[tipo];
        if(!Array.isArray(keys)||keys.length>4||new Set(keys).size!==keys.length||
          keys.some(key=>typeof key!=='string'||!Object.hasOwn(entrada.criterios,key)))throw falha('CONTEXTO_CLASSES_SENSIVEIS_INVALIDAS');
        return [tipo,Object.freeze([...keys])];
      }));
    }
    // Gabarito is never spread into the model input.
    return Object.freeze({id:caso.id,cenarioId:caso.cenarioId,entrada,
      gabarito:Object.freeze({esperado:caso.esperado,critico:caso.critico,justificativa:caso.justificativa,
        dimensao:caso.dimensao??'nao_informada',classesSensiveis:classesSensiveis&&Object.freeze(classesSensiveis)})});
  });
}

export function conferirDecisao(result,entrada,tokens){
  objetoFechado(result,['prevista','probabilidades','tokens','duracaoMs','local']);
  const keys=Object.keys(entrada.criterios);
  objetoFechado(result.probabilidades,keys);
  const values=keys.map(key=>result.probabilidades[key]);
  if(!keys.includes(result.prevista)||result.local!==true||!Number.isSafeInteger(result.tokens)||result.tokens!==tokens||
    result.tokens<1||result.tokens>LIMITES.tokens||!Number.isFinite(result.duracaoMs)||result.duracaoMs<0||
    values.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)||Math.abs(values.reduce((a,b)=>a+b,0)-1)>1e-6||
    result.probabilidades[result.prevista]!==Math.max(...values))throw falha('CONTEXTO_DECISAO_INVALIDA');
  return result;
}

const percentil=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
function grupo(rows){
  const executadas=rows.filter(r=>r.estado==='executado'),criticos=rows.filter(r=>r.critico);
  const certas=executadas.filter(r=>r.correta).length,criticasCertas=executadas.filter(r=>r.critico&&r.correta).length;
  return {total:rows.length,executadas:executadas.length,incompletas:rows.length-executadas.length,corretas:certas,
    acuracia:rows.length?certas/rows.length:null,criticas:criticos.length,criticasCorretas:criticasCertas,
    acuraciaCritica:criticos.length?criticasCertas/criticos.length:null,
    falsosEstados:Object.fromEntries(SENSIVEIS.map(tipo=>[tipo,executadas.filter(r=>!r.correta&&r.classesSensiveis?.[tipo]?.includes(r.decisao.prevista)).length])),
    casosSemClassesSensiveis:rows.filter(r=>!r.classesSensiveis).length};
}
export function metricas(resultados){
  const dimensoes=[...new Set(resultados.map(r=>r.dimensao))];
  return {global:grupo(resultados),porDimensao:Object.fromEntries(dimensoes.map(d=>[d,grupo(resultados.filter(r=>r.dimensao===d))]))};
}

export async function gravarAtomico(path,value){
  const dir=dirname(path);await mkdir(dir,{recursive:true});
  const temp=join(dir,`.contexto-probe-${randomUUID()}.tmp`);
  let handle,criado=false;
  try{
    handle=await open(temp,'wx',0o600);criado=true;
    await handle.writeFile(JSON.stringify(value,null,2)+'\n','utf8');await handle.sync();await handle.close();handle=null;
    // Same-directory hard link publishes a complete file and never replaces a receipt.
    await link(temp,path);
  }finally{
    if(handle)await handle.close();
    if(criado)await unlink(temp);
  }
}

async function hashesCodigo(){
  return Object.fromEntries(await Promise.all(ARQUIVOS_CODIGO.map(async path=>[path,digest(await readFile(resolve(ROOT,path)))])));
}
async function destinoLivre(path){
  try{await lstat(path);}catch(e){if(e.code==='ENOENT')return;throw e;}
  throw falha('CONTEXTO_SAIDA_EXISTENTE');
}

// Injectable loader/logger make orchestration testable without loading native ONNX.
export async function executarProbe(options,{carregar=carregarContextoRuntime,log=()=>{}}={}){
  await destinoLivre(options.output); // Refuse an existing receipt before touching model/cases.
  const started=performance.now(),cpuStart=process.cpuUsage(),rssInicial=process.memoryUsage().rss;
  let picoRss=rssInicial,stage='proveniencia',motor=null,fechado=false,casos=[],resultados=[],loadMs=null,primeiroResultadoMs=null;
  const erros=[],timings=[],timer=setInterval(()=>{picoRss=Math.max(picoRss,process.memoryUsage().rss);},20);timer.unref();
  const recibo={schema:'lume-contexto-probe-v1',criadoEm:new Date().toISOString(),research:true,passou:false,
    aprovacao:'requer_revisao_independente',completo:false,
    hashes:{casosEsperado:options.expectedCasesSha256,casos:null,codigo:null,modelo:null},
    hardware:{plataforma:platform(),arquitetura:arch(),sistema:release(),cpu:cpus()[0]?.model??null,
      cpusLogicas:cpus().length,memoriaTotalBytes:totalmem(),node:process.version,versions:process.versions,opcoesCpu:OPCOES_CPU},
    rede:{chamadasDoAdaptador:0,base:'Adaptador sem cliente de rede, download ou fallback; não é medição de tráfego global.'},
    limites:'Dados fornecidos pelo operador; estrutura/hash não provam anonimização, licença, qualidade ou execução instalada. Probabilidades não calibradas. Insuficiência é uma classe explícita, sem identificação por posição/texto.',
    entradas:[],resultados,erros};
  try{
    recibo.hashes.codigo=await hashesCodigo();
    recibo.hardware.onnxruntimeNode=JSON.parse(await readFile(resolve(ROOT,'node_modules/onnxruntime-node/package.json'),'utf8')).version;
    stage='casos';
    const info=await stat(options.cases);
    if(!info.isFile()||info.size<2||info.size>MAX_BYTES)throw falha('CONTEXTO_ARQUIVO_CASOS_INVALIDO');
    const bytes=await readFile(options.cases);
    if(bytes.length>MAX_BYTES)throw falha('CONTEXTO_ARQUIVO_CASOS_INVALIDO');
    recibo.hashes.casos=digest(bytes);
    if(recibo.hashes.casos!==options.expectedCasesSha256)throw falha('CONTEXTO_HASH_CASOS_DIVERGENTE');
    let parsed;try{parsed=JSON.parse(bytes.toString('utf8'));}catch{throw falha('CONTEXTO_JSON_INVALIDO');}
    casos=validarCasos(parsed);
    recibo.cenarios=new Set(casos.map(c=>c.cenarioId)).size;
    recibo.entradas=casos.map(c=>({id:c.id,cenarioId:c.cenarioId,...c.entrada,...c.gabarito}));
    stage='carga';const loadStart=performance.now();
    motor=await carregar(options.modelDir);loadMs=performance.now()-loadStart;
    recibo.hashes.modelo=motor.modelo;
    stage='validacao_tokens';
    const planos=casos.map(c=>motor.validar(c.entrada)); // Validate every complete window before first inference.
    stage='inferencia';
    for(const [i,caso] of casos.entries()){
      const itemStart=performance.now();
      const decisao=conferirDecisao(await motor.decidirPorCriterios(caso.entrada),caso.entrada,planos[i].tokens);
      const fimAFimMs=performance.now()-itemStart;timings.push(fimAFimMs);
      if(primeiroResultadoMs===null)primeiroResultadoMs=performance.now()-started;
      picoRss=Math.max(picoRss,process.memoryUsage().rss);
      resultados.push({id:caso.id,cenarioId:caso.cenarioId,...caso.gabarito,estado:'executado',
        decisao,correta:decisao.prevista===caso.gabarito.esperado,fimAFimMs});
      log({id:caso.id,duracaoMs:fimAFimMs}); // No text, criteria, answer or rationale in logs.
    }
  }catch(e){erros.push({etapa:stage,codigo:codigoSeguro(e)});}
  finally{
    if(motor){try{await motor.close();fechado=true;}catch(e){erros.push({etapa:'fechamento',codigo:codigoSeguro(e)});}}
    clearInterval(timer);picoRss=Math.max(picoRss,process.memoryUsage().rss);
  }
  for(const caso of casos.slice(resultados.length))resultados.push({id:caso.id,cenarioId:caso.cenarioId,...caso.gabarito,
    estado:'nao_executado',decisao:null,correta:false,fimAFimMs:null});
  try{
    const final=await hashesCodigo();
    if(JSON.stringify(final)!==JSON.stringify(recibo.hashes.codigo))erros.push({etapa:'proveniencia',codigo:'CONTEXTO_CODIGO_ALTERADO'});
  }catch(e){erros.push({etapa:'proveniencia',codigo:codigoSeguro(e)});}
  const cpu=process.cpuUsage(cpuStart),warm=timings.slice(1);
  recibo.completo=erros.length===0&&casos.length>0&&timings.length===casos.length&&fechado&&Boolean(recibo.hashes.modelo);
  recibo.execucao=recibo.completo?'completa':'incompleta';recibo.recursosFechados=fechado;
  recibo.metricas=metricas(resultados);
  recibo.tempos={totalMs:performance.now()-started,cargaComHashesMs:loadMs,frioAtePrimeiroResultadoMs:primeiroResultadoMs,
    quente:{quantidade:warm.length,p50Ms:percentil(warm,.5),p95Ms:percentil(warm,.95)},
    mensagens:{quantidade:timings.length,p50Ms:percentil(timings,.5),p95Ms:percentil(timings,.95)},cpuMs:(cpu.user+cpu.system)/1000};
  recibo.memoria={rssInicialBytes:rssInicial,picoRssAmostradoBytes:picoRss,amostragemMs:20,
    maxRssProcessoBytes:process.resourceUsage().maxRSS*1024,nota:'maxRssProcesso inclui toda a vida deste processo; nenhuma medida representa hardware piloto.'};
  await gravarAtomico(options.output,recibo);
  return recibo;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    if(process.argv.length===3&&process.argv[2]==='--help'){console.log(USO);}
    else{
      const opts=argumentos(process.argv.slice(2));
      const result=await executarProbe(opts,{log:value=>console.log(JSON.stringify(value))});
      console.log(JSON.stringify({output:opts.output,execucao:result.execucao,passou:false,
        total:result.metricas.global.total,corretas:result.metricas.global.corretas,erros:result.erros}));
      if(!result.completo)process.exitCode=1;
    }
  }catch(e){console.error(JSON.stringify({erro:codigoSeguro(e),passou:false}));process.exitCode=1;}
}

import {Worker} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {validarTexto,aplicarPortaDeQualidade} from './policy.js';
import {DOMAIN_POLICY} from './domain-policy.js';
import {verificarModelo} from './integrity.js';

const CODES=new Set(['LAYA_ENCERRADO','LAYA_NAO_INSTALADO','LAYA_OCUPADO','LAYA_CARGA_TIMEOUT','LAYA_TIMEOUT','LAYA_WORKER_FALHOU','LAYA_WORKER_ENCERROU','LAYA_MODELO_NAO_VERIFICADO','LAYA_TOKENIZADOR_INCOMPATIVEL','LAYA_TOKENIZADOR_DIVERGENTE','LAYA_PARIDADE_AUSENTE','LAYA_INTEGRIDADE_FALHOU','LAYA_CARGA_FALHOU','LAYA_INFERENCIA_FALHOU','LAYA_CONTEXTO_EXTENSO','LAYA_SEQUENCIA_INVALIDA','LAYA_TEXTO_INVALIDO','LAYA_RESULTADO_INVALIDO','LAYA_QUALIDADE_PENDENTE','LAYA_CABECA_DOMINIO_AUSENTE','LAYA_CABECA_DOMINIO_INVALIDA','LAYA_CABECA_DOMINIO_NAO_APROVADA','LAYA_ENTRADA_ACOES_INVALIDA','LAYA_VETOR_DOMINIO_INVALIDO']);
const safeError=error=>new Error(CODES.has(error?.message)?error.message:'LAYA_WORKER_FALHOU');

// Lazy, local, single-flight worker. A release-pinned domain head is required
// before action suggestions; the current release policy keeps that gate closed.
export function criarLayaLocal({modelDir,timeoutMs=15000,loadTimeoutMs=120000,idleMs=120000,domainPolicy=DOMAIN_POLICY,nomeDono=null,WorkerClass=Worker}={}){
  const selectedPolicy=Object.freeze({...domainPolicy});
  let worker=null,loading=null,stopping=null,busy=false,closed=false,loadMs=null,lastError=null,idle=null,counter=0,domainVerified=false;
  let integridade='aguardando_verificacao',erroIntegridade=null,verificacao=null,erroLiberacao=null;
  const installed=()=>Boolean(modelDir&&existsSync(join(modelDir,'lume-laya-manifest.json')));
  const configured=()=>selectedPolicy.approvedForActions===true&&/^[a-f0-9]{64}$/.test(selectedPolicy.modelSha256??'');
  const stop=()=>{
    clearTimeout(idle);const old=worker;worker=null;loading=null;
    if(!old)return stopping??(erroLiberacao?Promise.reject(erroLiberacao):Promise.resolve());
    const pending=Promise.resolve().then(()=>old.terminate()).catch(error=>{
      erroLiberacao=error;lastError='LAYA_WORKER_FALHOU';domainVerified=false;throw error;
    }).finally(()=>{if(stopping===pending)stopping=null;});
    stopping=pending;return pending;
  };
  const arm=()=>{clearTimeout(idle);idle=setTimeout(()=>{void stop().catch(()=>{});},idleMs);idle.unref();};
  const status=()=>{
    const presente=installed(),estadoIntegridade=presente?integridade:'ausente';
    const aprovado=!closed&&presente&&estadoIntegridade==='verificada'&&configured()&&domainVerified&&!lastError;
    return {instalado:presente,integridade:estadoIntegridade,estado:closed?'encerrado':!presente?'nao_instalado':estadoIntegridade==='falhou'?'erro':busy?'analisando':loading||estadoIntegridade==='verificando'?'carregando':worker?'pronto':'disponivel',experimental:true,local:true,
      aprovado,avaliacao:aprovado?'aprovada':'reprovada',modelo:'Laya multilíngue',
      finalidade:aprovado?'Sugestões locais com fonte; revise antes de decidir.':'Avaliação local. Ainda não aprovado para organizar mensagens.',loadMs,erro:lastError||erroIntegridade};
  };
  async function verificarInstalacao({force=false}={}){
    if(closed)throw Error('LAYA_ENCERRADO');
    if(!installed()){integridade='ausente';erroIntegridade=null;return false;}
    if(verificacao)return verificacao;
    if(!force&&integridade==='verificada')return true;
    if(!force&&integridade==='falhou')return false;
    integridade='verificando';erroIntegridade=null;
    verificacao=verificarModelo(modelDir).then(()=>{integridade='verificada';return true;},error=>{
      integridade='falhou';erroIntegridade=['LAYA_MODELO_NAO_VERIFICADO','LAYA_INTEGRIDADE_FALHOU'].includes(error?.message)?error.message:'LAYA_INTEGRIDADE_FALHOU';return false;
    }).finally(()=>{verificacao=null;});
    return verificacao;
  }
  async function ensure(){
    if(closed)throw Error('LAYA_ENCERRADO');
    // Native inference may finish asynchronously after terminate(). Wait for
    // the previous worker to release the model before starting another one.
    if(stopping)await stopping;
    if(erroLiberacao)throw erroLiberacao;
    if(closed)throw Error('LAYA_ENCERRADO');
    if(!installed())throw Error('LAYA_NAO_INSTALADO');
    if(worker&&!loading)return;
    if(loading)return loading;
    worker=new WorkerClass(new URL('./worker.js',import.meta.url),{workerData:{modelDir,domainPolicy:selectedPolicy}});
    const instance=worker;
    const invalidate=code=>{if(worker===instance){lastError=code;domainVerified=false;void stop().catch(()=>{});}};
    instance.on('error',()=>invalidate('LAYA_WORKER_FALHOU'));
    instance.on('exit',()=>invalidate('LAYA_WORKER_ENCERROU'));
    loading=new Promise((resolve,reject)=>{
      let finished=false;
      const timer=setTimeout(()=>done(Error('LAYA_CARGA_TIMEOUT')),loadTimeoutMs);
      function done(error){
        if(finished)return;finished=true;clearTimeout(timer);
        instance.off('message',message);instance.off('error',failed);instance.off('exit',exited);loading=null;
        if(error){error=safeError(error);lastError=error.message;domainVerified=false;if(['LAYA_MODELO_NAO_VERIFICADO','LAYA_INTEGRIDADE_FALHOU'].includes(error.message)){integridade='falhou';erroIntegridade=error.message;}void stop().catch(()=>{});reject(error);}
        else{domainVerified=configured();integridade='verificada';erroIntegridade=null;lastError=null;resolve();}
      }
      function message(value){if(value.type==='ready'){loadMs=value.loadMs;done();}else if(value.type==='error')done(Error(value.error));}
      function failed(){done(Error('LAYA_WORKER_FALHOU'));}
      function exited(){done(Error('LAYA_WORKER_ENCERROU'));}
      instance.on('message',message);instance.once('error',failed);instance.once('exit',exited);
    });
    return loading;
  }
  async function run(payload,transform=result=>result){
    if(busy)throw Error('LAYA_OCUPADO');
    busy=true;clearTimeout(idle);
    try{
      await ensure();
      const instance=worker,id=++counter;
      return await new Promise((resolve,reject)=>{
        let finished=false;
        const timer=setTimeout(()=>done(Error('LAYA_TIMEOUT')),timeoutMs);
        function done(error,result){
          if(finished)return;finished=true;clearTimeout(timer);
          instance.off('message',message);instance.off('error',failed);instance.off('exit',exited);
          if(error){error=safeError(error);lastError=error.message;domainVerified=false;void stop().catch(()=>{});reject(error);}
          else{lastError=null;resolve(transform(result));}
        }
        function message(value){if(value.id===id)done(value.error?Error(value.error):null,value.result);}
        function failed(){done(Error('LAYA_WORKER_FALHOU'));}
        function exited(){done(Error('LAYA_WORKER_ENCERROU'));}
        instance.on('message',message);instance.once('error',failed);instance.once('exit',exited);
        instance.postMessage({id,...payload});
      });
    }finally{busy=false;if(worker)arm();}
  }
  return {status,verificarInstalacao,
    async preparar(){if(!configured()){await verificarInstalacao();return false;}await ensure();if(worker)arm();return status().aprovado;},
    async classificar({texto}={}){return run({texto:validarTexto(texto)},aplicarPortaDeQualidade);},
    async extrairAcoes({texto,fonte,canal,autor}={}){
      if(!status().aprovado)throw Error('LAYA_QUALIDADE_PENDENTE');
      const owner=typeof nomeDono==='function'?nomeDono():nomeDono;
      return run({operation:'actions',input:{texto:validarTexto(texto),fonte,canal,autor,nomeDono:owner}});
    },
    async close(){closed=true;domainVerified=false;await stop();}
  };
}

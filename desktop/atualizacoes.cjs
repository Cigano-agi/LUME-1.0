const {readFileSync}=require('node:fs');
const {origemPermitida}=require('./origem-lume.cjs');

const ESTADOS=new Set(['indisponivel','em_dia','verificando','disponivel','baixando','pronta','erro']);
const CANAIS=new Set(['beta','estavel']);
const INTERVALO_PADRAO=6*60*60*1000;
const INICIO_PADRAO=20*1000;

function politicaDesligada(){return{schema:'lume-release-v1',enabled:false,channel:'beta',feedUrl:null};}
function carregarPoliticaRelease(arquivo){
 try{
  const p=JSON.parse(readFileSync(arquivo,'utf8'));
  if(!p||Object.keys(p).sort().join(',')!=='channel,enabled,feedUrl,schema'||p.schema!=='lume-release-v1'||typeof p.enabled!=='boolean'||!CANAIS.has(p.channel))return politicaDesligada();
  if(!p.enabled)return politicaDesligada();
  const url=new URL(p.feedUrl);
  if(!origemPermitida(url)||url.search||url.hash||url.pathname.replace(/\/$/,'')!==`/releases/${p.channel}`)return politicaDesligada();
  return{schema:p.schema,enabled:true,channel:p.channel,feedUrl:url.href.replace(/\/$/,'')};
 }catch{return politicaDesligada();}
}
function versaoSegura(valor){const v=String(valor||'');return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(v)?v:null;}
function codigoErro(erro){
 const texto=String(erro?.message||erro||'').toLowerCase();
 if(/signature|assinatura|publisher|certificate|certificado/.test(texto))return'ASSINATURA_INVALIDA';
 if(/404|yml|manifest|feed|channel/.test(texto))return'RELEASE_INDISPONIVEL';
 if(/timeout|network|net::|econn|enotfound|internet/.test(texto))return'REDE_INDISPONIVEL';
 return'ATUALIZACAO_FALHOU';
}
function criarAtualizador(autoUpdater,{versaoAtual,politica,onState=()=>{},setTimer=setTimeout,setRepeater=setInterval,clearTimer=clearTimeout,clearRepeater=clearInterval,inicioMs=INICIO_PADRAO,intervaloMs=INTERVALO_PADRAO}={}){
 const atual=versaoSegura(versaoAtual)||'0.0.0';
 const habilitado=Boolean(autoUpdater&&politica?.enabled);
 let estado={disponivel:habilitado,estado:habilitado?'em_dia':'indisponivel',canal:politica?.channel||'beta',versaoAtual:atual,versaoNova:null,progresso:null,codigoErro:null,verificadoEm:null};
 let operacao=null,inicio=null,repetidor=null,encerrado=false;
 const publicar=patch=>{if(encerrado)return estado;estado={...estado,...patch};onState({...estado,progresso:estado.progresso?{...estado.progresso}:null});return estado;};
 const falhar=erro=>publicar({estado:'erro',codigoErro:codigoErro(erro),progresso:null,verificadoEm:new Date().toISOString()});
 if(habilitado){
  autoUpdater.autoDownload=false;autoUpdater.autoInstallOnAppQuit=false;autoUpdater.allowPrerelease=politica.channel==='beta';autoUpdater.channel=politica.channel==='beta'?'beta':'latest';autoUpdater.allowDowngrade=false;
  autoUpdater.setFeedURL({provider:'generic',url:politica.feedUrl});
  autoUpdater.on('checking-for-update',()=>publicar({estado:'verificando',codigoErro:null,progresso:null}));
  autoUpdater.on('update-available',info=>{const v=versaoSegura(info?.version);if(!v)return falhar(new Error('manifest version'));publicar({estado:'disponivel',versaoNova:v,codigoErro:null,progresso:null,verificadoEm:new Date().toISOString()});});
  autoUpdater.on('update-not-available',()=>publicar({estado:'em_dia',versaoNova:null,codigoErro:null,progresso:null,verificadoEm:new Date().toISOString()}));
  autoUpdater.on('download-progress',p=>publicar({estado:'baixando',progresso:{percentual:Number.isFinite(p?.percent)?Math.max(0,Math.min(100,p.percent)):null,transferido:Number.isFinite(p?.transferred)?Math.max(0,p.transferred):null,total:Number.isFinite(p?.total)?Math.max(0,p.total):null},codigoErro:null}));
  autoUpdater.on('update-downloaded',info=>publicar({estado:'pronta',versaoNova:versaoSegura(info?.version)||estado.versaoNova,progresso:null,codigoErro:null}));
  autoUpdater.on('error',falhar);
 }
 const executar=async fn=>{
  if(!habilitado)throw Object.assign(new Error('Atualizações automáticas ainda não estão disponíveis nesta instalação.'),{code:'INDISPONIVEL'});
  if(operacao)return operacao;
  operacao=Promise.resolve().then(fn).catch(erro=>{falhar(erro);throw Object.assign(new Error('Não foi possível atualizar agora. O Lume continua funcionando.'),{code:codigoErro(erro)});}).finally(()=>{operacao=null;});
  return operacao;
 };
 const api={
  estado:()=>({...estado,progresso:estado.progresso?{...estado.progresso}:null}),
  verificar:()=>executar(async()=>{publicar({estado:'verificando',codigoErro:null,progresso:null});await autoUpdater.checkForUpdates();return api.estado();}),
  baixar:()=>executar(async()=>{if(estado.estado!=='disponivel')throw new Error('release indisponivel');publicar({estado:'baixando',codigoErro:null,progresso:null});await autoUpdater.downloadUpdate();return api.estado();}),
  prepararInstalacao(){if(!habilitado||estado.estado!=='pronta')throw new Error('A atualização ainda não está pronta para instalar.');return publicar({estado:'pronta'});},
  instalarAgora(){if(!habilitado||estado.estado!=='pronta')throw new Error('A atualização ainda não está pronta para instalar.');autoUpdater.quitAndInstall(false,true);},
  iniciarAutomatico(){if(!habilitado||inicio||repetidor||encerrado)return api.estado();inicio=setTimer(()=>{inicio=null;api.verificar().catch(()=>{});},inicioMs);inicio.unref?.();repetidor=setRepeater(()=>api.verificar().catch(()=>{}),intervaloMs);repetidor.unref?.();return api.estado();},
  encerrar(){encerrado=true;if(inicio)clearTimer(inicio);if(repetidor)clearRepeater(repetidor);inicio=null;repetidor=null;}
 };
 return api;
}

module.exports={criarAtualizador,carregarPoliticaRelease,politicaDesligada,codigoErro,ESTADOS};

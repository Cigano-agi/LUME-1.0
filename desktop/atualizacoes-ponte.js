import {randomUUID} from 'node:crypto';

const ESTADOS=new Set(['indisponivel','em_dia','verificando','disponivel','baixando','pronta','erro']);
const ACOES=new Set(['consultar','verificar','baixar','instalar']);
function numero(v){return Number.isFinite(v)&&v>=0?v:null;}
function limpar(valor,versao){
 const v=valor&&typeof valor==='object'?valor:{};
 const estado=ESTADOS.has(v.estado)?v.estado:'indisponivel';
 const progresso=v.progresso&&typeof v.progresso==='object'?{percentual:numero(v.progresso.percentual),transferido:numero(v.progresso.transferido),total:numero(v.progresso.total)}:null;
 return{disponivel:v.disponivel===true,estado,canal:v.canal==='estavel'?'estavel':'beta',versaoAtual:typeof v.versaoAtual==='string'?v.versaoAtual:versao,versaoNova:typeof v.versaoNova==='string'?v.versaoNova:null,progresso,codigoErro:typeof v.codigoErro==='string'?v.codigoErro:null,verificadoEm:typeof v.verificadoEm==='string'?v.verificadoEm:null};
}
export function criarPonteAtualizacoes(porta,{versao='0.0.0',suportado=false,timeout=120000}={}){
 let estado=limpar({disponivel:suportado,estado:suportado?'em_dia':'indisponivel',canal:'beta',versaoAtual:versao},versao),fechado=false;
 const pendentes=new Map();
 const receber=({data})=>{
  if(data?.tipo==='atualizacao-estado'){estado=limpar(data.estado,versao);return;}
  if(data?.tipo!=='atualizacao-resposta'||typeof data.id!=='string')return;
  const p=pendentes.get(data.id);if(!p)return;clearTimeout(p.timer);pendentes.delete(data.id);
  if(data.erro)p.reject(new Error('Não foi possível atualizar agora. O Lume continua funcionando.'));else{estado=limpar(data.estado,versao);p.resolve({...estado});}
 };
 porta?.on('message',receber);
 const executar=acao=>{
  if(fechado||!porta||!ACOES.has(acao))return Promise.reject(new Error('Atualizações automáticas indisponíveis.'));
  return new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pendentes.delete(id);reject(new Error('A verificação demorou demais. Tente novamente.'));},timeout);timer.unref?.();pendentes.set(id,{resolve,reject,timer});try{porta.postMessage({tipo:'atualizacao-comando',id,acao});}catch{clearTimeout(timer);pendentes.delete(id);reject(new Error('Atualizações automáticas indisponíveis.'));}});
 };
 return{estado:()=>({...estado,progresso:estado.progresso?{...estado.progresso}:null}),executar,encerrar(){if(fechado)return;fechado=true;porta?.off('message',receber);for(const p of pendentes.values()){clearTimeout(p.timer);p.reject(new Error('O Lume está encerrando.'));}pendentes.clear();}};
}

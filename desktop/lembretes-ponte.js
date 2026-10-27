import {randomUUID} from 'node:crypto';
const acaoIdValido=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export function criarPonteLembretes(porta,{suportado=false,timeout=20000}={}){
 const pendentes=new Map();let fechado=false;
 const receber=({data})=>{if(data?.tipo!=='lembrete-resposta')return;const p=pendentes.get(data.id);if(!p)return;clearTimeout(p.timer);pendentes.delete(data.id);p.resolve({resultado:['mostrado','falhou','cancelado','sem-confirmacao'].includes(data.resultado)?data.resultado:'sem-confirmacao'});};
 porta?.on('message',receber);
 const enviar=m=>{try{if(!fechado)porta?.postMessage(m);return !fechado;}catch{return false;}};
 const cancelar=()=>{for(const p of pendentes.values()){clearTimeout(p.timer);p.resolve({resultado:'cancelado'});}pendentes.clear();enviar({tipo:'lembrete-cancelar'});};
 return {
  disponivel:()=>!fechado&&suportado&&Boolean(porta),cancelar,
  mostrar({teste=false,categoria='contato',acaoId,som=true}={}){if(fechado||!suportado||!porta||!['contato','acao','captura'].includes(categoria)||categoria==='acao'&&!acaoIdValido(acaoId))return Promise.resolve({resultado:'falhou'});
   return new Promise(resolve=>{const id=randomUUID(),timer=setTimeout(()=>{pendentes.delete(id);enviar({tipo:'lembrete-cancelar'});resolve({resultado:'sem-confirmacao'});},timeout);timer.unref?.();pendentes.set(id,{resolve,timer});if(!enviar({tipo:'lembrete',id,teste:teste===true,categoria,...(categoria==='acao'?{acaoId,som:som===true}:{})})){clearTimeout(timer);pendentes.delete(id);resolve({resultado:'falhou'});}});
  },
  encerrar(){if(fechado)return;cancelar();fechado=true;porta?.off('message',receber);}
 };
}

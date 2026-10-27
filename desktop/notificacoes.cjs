// Fixed local reminder content. No conversation text, count, title, URL or money crosses this boundary.
const acaoIdValido=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
function criarNotificacoes(Notification,{focar=()=>{},timeout=15000}={}){
 let atual=null,fechado=false;
 const cancelar=()=>{if(!atual)return;const item=atual;atual=null;item.finalizar('cancelado');try{item.n.close();}catch{}};
 return {
  disponivel:()=>!fechado&&Notification.isSupported(),
  cancelar,
  encerrar:()=>{fechado=true;cancelar();},
  mostrar({teste=false,categoria='contato',acaoId,som=true}={}){
   if(fechado||!Notification.isSupported()||!['contato','acao','captura'].includes(categoria)||categoria==='acao'&&!acaoIdValido(acaoId))return Promise.resolve({resultado:'falhou'});
   if(categoria==='captura'&&atual)return Promise.resolve({resultado:'cancelado'});
   cancelar();
   return new Promise(resolve=>{
    let n,timer,concluido=false;
    const finalizar=resultado=>{if(concluido)return;concluido=true;clearTimeout(timer);resolve({resultado});};
    try{
     n=new Notification({title:'Lume',body:teste?'Este é um teste de lembrete do Lume.':categoria==='acao'?'Você tem uma ação para rever. Abra o Lume.':categoria==='captura'?'A chegada de mensagens ficou estável. Confira o andamento no Lume.':'Você tem contatos para retomar. Confira Hoje no Lume.',silent:teste||categoria!=='acao'||som!==true,timeoutType:'default'});
     atual={n,finalizar,categoria};
     n.once('show',()=>finalizar('mostrado'));
     n.once('failed',()=>{finalizar('falhou');if(atual?.n===n)atual=null;try{n.close();}catch{}});
     n.on('click',()=>{if(!fechado&&atual?.n===n)focar(categoria==='acao'?{acaoId}:{categoria});});
     timer=setTimeout(()=>{finalizar('sem-confirmacao');if(atual?.n===n)atual=null;try{n.close();}catch{}},timeout);timer.unref?.();
     n.show();
    }catch{finalizar('falhou');if(atual?.n===n)atual=null;try{n?.close();}catch{}}
   });
  }
 };
}
module.exports={criarNotificacoes,acaoIdValido};

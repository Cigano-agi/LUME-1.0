const {join}=require('node:path');
const {pathToFileURL}=require('node:url');
const ESTADOS=new Set(['aguardando','buscando','trabalhando','concluido','atencao','pausado','desconectado']);
function criarCompanheiro({BrowserWindow,ipcMain,screen,abrir,configurar,limites}){
  const file=join(__dirname,'companheiro.html'),url=pathToFileURL(file).href;
  const canal='lume-companheiro:acao';
  let janela=null,encerrado=false,enabled=false,expandido=false;
  let snapshot={estado:'pausado',mensagem:'Lume pausado.',notificacaoId:null,som:false};
  const origemValida=event=>Boolean(janela&&!janela.isDestroyed()&&event.sender===janela.webContents&&
    event.senderFrame===janela.webContents.mainFrame&&event.senderFrame?.url===url);
  ipcMain.handle(canal,async(event,data)=>{
    if(encerrado||!origemValida(event)||!data||typeof data!=='object'||Array.isArray(data))throw Error('Origem indisponível.');
    const keys=Object.keys(data).sort().join(',');
    if(keys==='acao'&&data.acao==='estado')return snapshot;
    if(keys==='acao'&&data.acao==='abrir'){abrir(snapshot.assunto?.id||null);return true;}
    if(keys==='acao'&&data.acao==='ocultar'){await configurar({enabled:false});return true;}
    if(keys==='acao'&&data.acao==='adiar'){if(!snapshot.assunto)throw Error('Nenhum assunto para adiar.');await configurar({adiadoId:snapshot.assunto.id,adiadoAte:new Date(Date.now()+1800000).toISOString()});return true;}
    if(keys==='acao,pausado'&&data.acao==='pausar'&&typeof data.pausado==='boolean'){await configurar({pausado:data.pausado});return true;}
    if(keys==='acao,expandido'&&data.acao==='expandir'&&typeof data.expandido==='boolean'){expandido=data.expandido;posicionar();return true;}
    if(keys==='acao,som'&&data.acao==='som'&&typeof data.som==='boolean'){await configurar({som:data.som});return true;}
    throw Error('Ação inválida.');
  });
  function posicionar(){
    if(!janela||janela.isDestroyed())return;
    const bounds=limites?.(),display=bounds?screen.getDisplayMatching(bounds):screen.getPrimaryDisplay();
    const area=display.workArea;
    const height=expandido?400:240;
    janela.setBounds({x:Math.round(area.x+Math.max(0,area.width-336)),y:Math.round(area.y+Math.max(0,area.height-height-16)),width:320,height});
  }
  async function mostrar(){
    if(encerrado||!enabled)return;
    if(janela&&!janela.isDestroyed()){janela.webContents.send('lume-companheiro:estado',snapshot);if(!janela.isVisible())janela.showInactive();return;}
    const atual=new BrowserWindow({width:320,height:240,show:false,transparent:true,frame:false,
      resizable:false,maximizable:false,minimizable:false,skipTaskbar:true,hasShadow:false,
      title:'Lume',icon:join(__dirname,'icon.png'),autoHideMenuBar:true,alwaysOnTop:true,
      webPreferences:{preload:join(__dirname,'companheiro-preload.cjs'),nodeIntegration:false,
        contextIsolation:true,sandbox:true,webviewTag:false,spellcheck:false}});
    janela=atual;posicionar();
    atual.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    atual.webContents.on('will-navigate',(event,destino)=>{if(destino!==url)event.preventDefault();});
    atual.webContents.on('will-attach-webview',event=>event.preventDefault());
    atual.on('close',event=>{if(encerrado)return;event.preventDefault();atual.hide();
      void Promise.resolve().then(()=>configurar({enabled:false})).catch(()=>{
        snapshot={...snapshot,estado:'atencao',mensagem:'Não consegui guardar essa preferência. Confira o Lume.'};
        if(!encerrado&&!atual.isDestroyed()){atual.webContents.send('lume-companheiro:estado',snapshot);}
      });});
    atual.on('closed',()=>{if(janela===atual)janela=null;});
    try{
      await atual.loadFile(file);
      if(!encerrado&&enabled&&!atual.isDestroyed()){atual.webContents.send('lume-companheiro:estado',snapshot);atual.showInactive();}
    }catch{if(!atual.isDestroyed())atual.destroy();}
  }
  screen.on('display-metrics-changed',posicionar);
  screen.on('display-removed',posicionar);
  return {
    atualizar(data){
      if(encerrado||!data||typeof data.enabled!=='boolean'||typeof data.som!=='boolean'||!ESTADOS.has(data.estado)||
        typeof data.mensagem!=='string'||data.mensagem.length>200||
        data.notificacaoId!==null&&(typeof data.notificacaoId!=='string'||data.notificacaoId.length>200))return false;
      const assunto=data.assunto;
      if(assunto!=null&&(!assunto||typeof assunto!=='object'||!/^acao:[0-9a-f-]{36}$/i.test(assunto.id)||typeof assunto.assunto!=='string'||assunto.assunto.length>160||typeof assunto.motivo!=='string'||assunto.motivo.length>300||!Number.isSafeInteger(assunto.fonteId)||assunto.fonteId<1))return false;
      enabled=data.enabled;snapshot={estado:data.estado,mensagem:data.mensagem,notificacaoId:data.notificacaoId,som:data.som,
        assunto:assunto?{id:assunto.id,assunto:assunto.assunto,motivo:assunto.motivo,pessoa:String(assunto.pessoa||'').slice(0,100),prazo:typeof assunto.prazo==='string'?assunto.prazo.slice(0,200):null,fonteId:assunto.fonteId,grupo:assunto.grupo,estado:assunto.estado}:null,
        tema:['light','dark','system'].includes(data.tema)?data.tema:'system',movimento:data.movimento==='reduce'?'reduce':'system',volume:Number.isFinite(data.volume)&&data.volume>=0&&data.volume<=1?data.volume:.35,pausado:data.pausado===true};
      if(enabled)void mostrar();else if(janela&&!janela.isDestroyed())janela.hide();
      return true;
    },
    encerrar(){encerrado=true;ipcMain.removeHandler(canal);screen.removeListener('display-metrics-changed',posicionar);
      screen.removeListener('display-removed',posicionar);if(janela&&!janela.isDestroyed())janela.destroy();janela=null;}
  };
}
module.exports={criarCompanheiro};

const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('lumeCompanheiro',{
  onState(callback){
    if(typeof callback!=='function')throw Error('Callback inválido.');
    let active=true,pushed=false;
    const receive=(_event,state)=>{pushed=true;if(active)callback(state);};
    ipcRenderer.on('lume-companheiro:estado',receive);
    void ipcRenderer.invoke('lume-companheiro:acao',{acao:'estado'}).then(state=>{if(active&&!pushed&&state)callback(state);}).catch(()=>{});
    return()=>{active=false;ipcRenderer.removeListener('lume-companheiro:estado',receive);};
  },
  abrir:()=>ipcRenderer.invoke('lume-companheiro:acao',{acao:'abrir'}),
  ocultar:()=>ipcRenderer.invoke('lume-companheiro:acao',{acao:'ocultar'}),
  adiar:()=>ipcRenderer.invoke('lume-companheiro:acao',{acao:'adiar'}),
  pausar:pausado=>ipcRenderer.invoke('lume-companheiro:acao',{acao:'pausar',pausado}),
  expandir:expandido=>ipcRenderer.invoke('lume-companheiro:acao',{acao:'expandir',expandido}),
  som:valor=>ipcRenderer.invoke('lume-companheiro:acao',{acao:'som',som:valor})
});

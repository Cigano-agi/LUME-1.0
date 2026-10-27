const {randomUUID}=require('node:crypto');

// A private, hidden Chromium audio decoder; no personal browser or network.
function criarConversorAudio({BrowserWindow}) {
  const windows=new Set();let busy=false;
  return {
    async converter(base64) {
      if(busy||typeof base64!=='string'||!base64||base64.length>28*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw Error('AUDIO_CONVERSAO_INDISPONIVEL');
      busy=true;let win,timer;
      try {
        win=new BrowserWindow({show:false,width:100,height:100,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,partition:'lume-audio-'+randomUUID()}});
        windows.add(win);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
        win.webContents.on('will-navigate',event=>event.preventDefault());
        win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!details.url.startsWith('data:')}));
        const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('AUDIO_CONVERSAO_TIMEOUT')),30000);});
        const operation=(async()=>{
          await win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'"><title>Lume áudio local</title>');
          const script=`(async()=>{
            const raw=Uint8Array.from(atob(${JSON.stringify(base64)}),c=>c.charCodeAt(0));
            const ctx=new AudioContext();let decoded;
            try{decoded=await ctx.decodeAudioData(raw.buffer);}finally{await ctx.close();}
            if(!Number.isFinite(decoded.duration)||decoded.duration<=0||decoded.duration>300)throw Error('duration');
            const render=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000),source=render.createBufferSource();
            source.buffer=decoded;source.connect(render.destination);source.start();
            const rendered=await render.startRendering(),samples=rendered.getChannelData(0),bytes=new Uint8Array(44+samples.length*2),view=new DataView(bytes.buffer);
            const text=(o,s)=>{for(let i=0;i<s.length;i++)bytes[o+i]=s.charCodeAt(i);};
            text(0,'RIFF');view.setUint32(4,bytes.length-8,true);text(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,samples.length*2,true);
            for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
            let result='';for(let i=0;i<bytes.length;i+=8192)result+=String.fromCharCode(...bytes.subarray(i,i+8192));
            return btoa(result);
          })()`;
          return {base64:await win.webContents.executeJavaScript(script)};
        })();
        return await Promise.race([operation,timeout]);
      }catch{throw Error('AUDIO_CONVERSAO_INDISPONIVEL');}
      finally{clearTimeout(timer);if(win){windows.delete(win);if(!win.isDestroyed())win.destroy();}busy=false;}
    },
    encerrar(){for(const win of windows)if(!win.isDestroyed())win.destroy();windows.clear();}
  };
}
module.exports={criarConversorAudio};

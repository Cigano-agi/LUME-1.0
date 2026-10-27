/* Local synthesis shared by panel and companion. Never starts on import. */
(() => {
  'use strict';
  function criar({estado=()=>({})}={}){
    let audio,epoch=0,pending=false,disposed=false;const active=new Set(),seen=new Set();
    const snapshot=()=>{const p=estado()||{};return {som:p.som===true,pausado:p.pausado===true,volume:Math.max(0,Math.min(1,Number.isFinite(p.volume)?p.volume:.35))};};
    const valid=p=>!disposed&&!document.hidden&&p.som&&!p.pausado&&p.volume>0;
    function parar(){epoch++;for(const o of active){try{o.stop();}catch{}}active.clear();}
    async function tocar(tipo,{assinatura,previa=false}={}){
      const no=texto=>({tocou:false,texto});
      if(!['decisao','conclusao'].includes(tipo))return no('Prévia indisponível.');
      const initial=snapshot();if(!valid(initial))return no(initial.pausado?'A companhia está pausada; o som permanece desligado.':!initial.volume?'O volume está em zero.':'Ligue o som para ouvir.');
      if(!previa&&(!assinatura||seen.has(assinatura)))return no('Evento já acompanhado.');
      if(pending||active.size)return no('Um som já está tocando.');
      if(!previa){seen.add(assinatura);if(seen.size>200)seen.delete(seen.values().next().value);}
      const own=epoch;pending=true;let timer;
      try{
        const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return no('Som indisponível neste ambiente.');audio ||=new Audio();
        if(audio.state!=='running'&&!await Promise.race([audio.resume().then(()=>true),new Promise(r=>timer=setTimeout(()=>r(false),400))]))return no('O áudio não foi liberado pelo aplicativo.');
        const latest=snapshot();if(own!==epoch||!valid(latest)||latest.volume!==initial.volume||audio.state!=='running')return no('Som cancelado.');
        const notes=tipo==='conclusao'?[523.25,659.25]:[620,930];
        for(const [i,frequency]of notes.entries()){
          const o=audio.createOscillator(),g=audio.createGain(),start=audio.currentTime+i*.07;
          o.type='sine';o.frequency.setValueAtTime(frequency,start);g.gain.setValueAtTime(.0001,start);g.gain.linearRampToValueAtTime(.06*latest.volume,start+.02);g.gain.exponentialRampToValueAtTime(.0001,start+.2);
          o.connect(g);g.connect(audio.destination);active.add(o);o.onended=()=>{active.delete(o);o.disconnect();g.disconnect();};o.start(start);o.stop(start+.22);
        }
        return {tocou:true,texto:'Prévia de '+(tipo==='conclusao'?'conclusão':'decisão')+'.'};
      }catch{return no('Som indisponível neste ambiente.');}finally{clearTimeout(timer);pending=false;}
    }
    function visibility(){if(document.hidden)parar();}
    function preferences(){parar();}
    function destruir(){if(disposed)return;disposed=true;parar();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('lume:preferences',preferences);window.removeEventListener('pagehide',destruir);try{void audio?.close().catch(()=>{});}catch{}}
    document.addEventListener('visibilitychange',visibility);window.addEventListener('lume:preferences',preferences);window.addEventListener('pagehide',destruir,{once:true});
    return Object.freeze({tocar,parar,destruir});
  }
  window.LumeAudio=Object.freeze({criar});
})();

(() => {
  'use strict';
  const bridge=window.lumeCompanheiro, $=id=>document.getElementById(id);
  const root=$('companheiro'), controls=[...document.querySelectorAll('button')];
  const labels={aguardando:'Por aqui',buscando:'Buscando',trabalhando:'Conferindo',concluido:'Concluído',atencao:'Precisa de você',pausado:'Em pausa',desconectado:'Sem conexão'};
  const systemTheme=matchMedia('(prefers-color-scheme: dark)');
  let current={},initialized=false,expanded=false,busy=false,disposed=false,silence=false,timer;
  const art=window.LumeMascote?.criar({estado:'desconectado'});
  if(art){art.setAttribute('aria-hidden','true');$('mascote-companhia').append(art);}
  const audio=window.LumeAudio?.criar({estado:()=>({som:current.som===true&&!silence,pausado:current.pausado||current.estado==='pausado',volume:current.volume})});
  let remembered=[];try{remembered=JSON.parse(sessionStorage.getItem('lume-companion-seen')||'[]');}catch{}
  const seen=new Set(Array.isArray(remembered)?remembered.filter(x=>typeof x==='string').slice(-200):[]);
  function stop(){audio?.parar();}
  function theme(){document.documentElement.dataset.theme=current.tema==='dark'||current.tema==='system'&&systemTheme.matches?'dark':'light';}
  systemTheme.addEventListener('change',theme);
  function field(id,value){$(id).textContent=typeof value==='string'?value:'';$(id).hidden=!$(id).textContent;}
  function soundKind(p){
    if(!p.assunto?.fonteId)return null;
    if(p.assunto.grupo==='precisa')return 'decisao';
    if(p.assunto.grupo==='mudou'&&['concluido','concluida','verificado','aceito'].includes(p.assunto.estado))return 'conclusao';
    return null;
  }
  async function chime(kind){await audio?.tocar(kind,{assinatura:current.notificacaoId});}
  function render(p){
    if(disposed)return;
    const valid=p&&Object.hasOwn(labels,p.estado), previous=current;
    current=valid?p:{estado:'desconectado',mensagem:'Abra o Lume para conferir.',som:false};
    if(previous.pausado&&!current.pausado)silence=false;
    if(previous.volume!==current.volume)stop();
    if(!current.som||current.pausado||current.estado==='pausado'){stop();silence=false;}
    theme();document.documentElement.dataset.motion=current.movimento==='reduce'?'reduce':'system';
    if(art&&previous.estado!==current.estado)window.LumeMascote.atualizar(art,current.estado);
    root.dataset.state=current.estado;$('estado').textContent=labels[current.estado];
    const item=current.assunto&&typeof current.assunto.assunto==='string'&&Number.isSafeInteger(current.assunto.fonteId)&&current.assunto.fonteId>0?current.assunto:null;
    $('mensagem').textContent=item?item.assunto:(current.mensagem||'Sua memória está por aqui.');
    field('assunto',item?.assunto);field('pessoa',item?.pessoa);field('motivo',item?.motivo);
    field('prazo',item?.prazo?'Prazo citado: '+item.prazo:'');
    field('fonte',item?'Fonte vinculada · confira no contexto':'');
    $('adiar').hidden=!item;$('abrir').textContent=item?'Abrir contexto':'Abrir Lume';
    $('pausar').textContent=current.pausado?'Retomar':'Pausar';
    $('pausar').setAttribute('aria-pressed',String(current.pausado===true));
    $('som').textContent=current.som?'Som ligado':'Som desligado';$('som').setAttribute('aria-pressed',String(current.som===true));
    const id=typeof current.notificacaoId==='string'?current.notificacaoId:null;
    const fresh=id&&!seen.has(id);
    if(id){seen.add(id);if(seen.size>200)seen.delete(seen.values().next().value);try{sessionStorage.setItem('lume-companion-seen',JSON.stringify([...seen]));}catch{}}
    if(initialized&&fresh&&soundKind(current))void chime(soundKind(current));
    if((previous.estado!==current.estado||previous.assunto?.id!==item?.id)&&!document.hidden){
      root.classList.remove('state-changed');clearTimeout(timer);void root.offsetWidth;root.classList.add('state-changed');
      timer=setTimeout(()=>root.classList.remove('state-changed'),480);
    }
    initialized=true;
  }
  async function command(job,success){
    if(busy||disposed)return;busy=true;controls.forEach(b=>b.disabled=true);$('control-status').textContent='';let timeout;
    try{await Promise.race([Promise.resolve().then(job),new Promise((_,reject)=>timeout=setTimeout(()=>reject(Error('timeout')),8000))]);if(!disposed)success?.();}
    catch{if(!disposed)$('control-status').textContent='Não consegui confirmar. Confira no Lume antes de repetir.';}
    finally{clearTimeout(timeout);busy=false;if(!disposed)controls.forEach(b=>b.disabled=false);}
  }
  if(!bridge||!['onState','abrir','ocultar','som','adiar','pausar','expandir'].every(k=>typeof bridge[k]==='function')){
    $('mensagem').textContent='Disponível no aplicativo Lume.';controls.forEach(b=>b.disabled=true);return;
  }
  $('expandir').onclick=()=>command(()=>bridge.expandir(!expanded),()=>{
    expanded=!expanded;root.dataset.expanded=String(expanded);$('assunto-detalhe').hidden=!expanded;$('expandir').setAttribute('aria-expanded',String(expanded));
    $('expandir').textContent=expanded?'Recolher':'Ver companhia';$('personagem').setAttribute('aria-expanded',String(expanded));
  });
  $('personagem').onclick=()=>$('expandir').click();
  $('abrir').onclick=()=>command(()=>bridge.abrir());
  $('adiar').onclick=()=>command(()=>bridge.adiar(),()=>{$('control-status').textContent='Assunto adiado por 30 minutos.';});
  $('pausar').onclick=()=>{silence=true;stop();return command(()=>bridge.pausar(!current.pausado));};
  $('ocultar').onclick=()=>{silence=true;stop();return command(()=>bridge.ocultar());};
  $('som').onclick=()=>{const next=!current.som;silence=!next;if(!next)stop();return command(()=>bridge.som(next));};
  document.addEventListener('keydown',async e=>{if(e.key==='Escape'&&expanded&&!busy){e.preventDefault();await $('expandir').onclick();if(!disposed)$('expandir').focus();}});
  function visibility(){document.documentElement.dataset.visible=String(!document.hidden);if(document.hidden){stop();if(art)window.LumeMascote.parar(art);root.classList.remove('state-changed');}}
  visibility();document.addEventListener('visibilitychange',visibility);
  let unsubscribe;try{unsubscribe=bridge.onState(render);}catch{$('mensagem').textContent='Não foi possível consultar a companhia.';}
  window.addEventListener('pagehide',()=>{disposed=true;clearTimeout(timer);stop();unsubscribe?.();systemTheme.removeEventListener('change',theme);audio?.destruir();},{once:true});
})();

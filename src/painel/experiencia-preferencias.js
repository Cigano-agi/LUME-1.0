(() => {
  'use strict';
  if (window.LumePreferencias) return;
  const endpoint='/api/v3/pessoal/companheiro', storageKey='lume-companion-preferences';
  const defaults={enabled:false,som:false,tema:'system',movimento:'system',volume:.35,pausado:false};
  let state={...defaults},dirty=false,busy=false,flight=null,disposed=false;
  const dirtyKeys=new Set();
  let sharedPlayer,previewSaved=false;
  const system=matchMedia('(prefers-color-scheme: dark)');
  const get=id=>document.getElementById(id), host=get('settings-group-appearance-cards');
  function store(key,value){try{localStorage.setItem(key,value);}catch{}}
  function normalize(data){return {enabled:data?.enabled===true,som:data?.som===true,pausado:data?.pausado===true,
    tema:['system','light','dark'].includes(data?.tema)?data.tema:'system',movimento:data?.movimento==='reduce'?'reduce':'system',
    volume:Number.isFinite(data?.volume)?Math.max(0,Math.min(1,data.volume)):.35,disponivel:data?.disponivel===true};}
  function apply(next){
    const html=document.documentElement;
    if(!next.som||next.pausado||html.dataset.soundVolume!==String(next.volume))stopPreview();
    html.dataset.themeChoice=next.tema;html.dataset.theme=next.tema==='system'?(system.matches?'dark':'light'):next.tema;
    html.dataset.motion=next.movimento;
    html.dataset.soundVolume=String(next.volume);html.dataset.companionPaused=String(next.pausado);
    store('lume-theme-choice',next.tema);store('lume-interface-sounds',next.som&&!next.pausado?'on':'off');
    store('lume-interface-volume',String(next.volume));store(storageKey,JSON.stringify(next));
    const theme=get('theme-mode');if(theme&&theme.value!==next.tema){theme.value=next.tema;theme.dispatchEvent(new Event('change',{bubbles:true}));}
    const sound=get('ui-sounds');if(sound)sound.checked=next.som&&!next.pausado;
    window.dispatchEvent(new CustomEvent('lume:preferences',{detail:{...next}}));
  }
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved)state=normalize(saved);else state.tema=['light','dark','system'].includes(localStorage.getItem('lume-theme-choice'))?localStorage.getItem('lume-theme-choice'):'system';}catch{}
  apply(state);system.addEventListener('change',()=>{if(state.tema==='system')apply(state);});
  if(!host)return;
  const box=document.createElement('section');box.id='lv-preferencias';box.className='settings-card lv-page';box.setAttribute('aria-labelledby','lv-preferences-title');
  box.innerHTML=`<h2 id="lv-preferences-title" tabindex="-1">Aparência e companhia</h2>
    <p>Seu Lume, no seu ritmo. Pausar a companhia não altera o atendimento.</p>
    <form id="lv-preferences-form" class="lv-section">
      <div class="lv-filters">
        <label for="lv-pref-tema">Tema<select id="lv-pref-tema"><option value="system">Acompanhar o sistema</option><option value="light">Claro</option><option value="dark">Escuro</option></select></label>
        <label for="lv-pref-movimento">Movimento<select id="lv-pref-movimento"><option value="system">Respeitar o sistema</option><option value="reduce">Reduzir movimento</option></select></label>
      </div>
      <label><input id="lv-pref-enabled" type="checkbox"> Mostrar companhia na área de trabalho</label>
      <label><input id="lv-pref-pausado" type="checkbox"> Pausar companhia e silenciar seus avisos</label>
      <label><input id="lv-pref-som" type="checkbox"> Sons de decisão e conclusão</label>
      <p>O som começa desligado. A prévia só toca quando você pedir; a pausa mantém silêncio.</p>
      <label for="lv-pref-volume">Volume <output id="lv-pref-volume-value" for="lv-pref-volume">35%</output><input id="lv-pref-volume" type="range" min="0" max="1" step="0.05" value="0.35"></label>
      <div class="lv-toolbar"><button id="lv-preview-decisao" class="lv-button" type="button">Ouvir decisão</button><button id="lv-preview-conclusao" class="lv-button" type="button">Ouvir conclusão</button></div>
      <div class="lv-toolbar"><button id="lv-pref-save" class="lv-button" data-variant="primary" type="submit">Salvar preferências</button><button id="lv-pref-refresh" class="lv-button" type="button">Atualizar estado</button></div>
    </form><p id="lv-pref-status" class="lv-status" role="status">Conferindo preferências…</p>`;
  host.prepend(box);
  const fields=Object.fromEntries(Object.keys(defaults).map(k=>[k,get('lv-pref-'+k)]));
  const form=get('lv-preferences-form'),status=get('lv-pref-status');
  function stopPreview(){sharedPlayer?.parar();}
  function controls(){
    const unavailable=state.disponivel!==true;
    Object.entries(fields).forEach(([key,f])=>f.disabled=busy||unavailable&&['enabled','pausado'].includes(key));
    get('lv-pref-save').disabled=busy||!dirty;get('lv-pref-refresh').disabled=busy;
    for(const kind of ['decisao','conclusao'])get('lv-preview-'+kind).disabled=busy||!fields.som.checked||fields.pausado.checked||state.pausado;
    form.setAttribute('aria-busy',String(busy));
  }
  function render(){
    for(const [key,input] of Object.entries(fields)){if(dirtyKeys.has(key))continue;if(input.type==='checkbox')input.checked=state[key];else input.value=state[key];}
    get('lv-pref-volume-value').textContent=Math.round(Number(fields.volume.value)*100)+'%';controls();
  }
  const request=patch=>{
    if(typeof window.lumeConnectionRequest!=='function')throw Error('Conexão de preferências indisponível.');
    return window.lumeConnectionRequest(endpoint,patch,{timeout:15000});
  };
  function carregar(){
    if(disposed||busy)return flight||Promise.resolve();
    busy=true;controls();status.textContent='Conferindo preferências…';
    flight=(async()=>{
      try{
        const result=await request();if(disposed)return;
        state=normalize(result);apply(state);render();
        status.textContent=!state.disponivel?'A companhia está disponível no aplicativo instalado. Aparência e som continuam disponíveis.':dirty?'Estado conferido. Suas alterações ainda não foram salvas.':'Preferências conferidas.';
      }catch(e){if(!disposed)status.textContent=e.message||'Não foi possível consultar. Tente atualizar.';}
      finally{busy=false;flight=null;if(!disposed)controls();}
    })();return flight;
  }
  for(const [key,input] of Object.entries(fields))input.addEventListener('input',()=>{
    dirtyKeys.add(key);dirty=true;get('lv-pref-volume-value').textContent=Math.round(Number(fields.volume.value)*100)+'%';
    if(key==='volume'||!fields.som.checked||fields.pausado.checked)stopPreview();controls();status.textContent='Alterações ainda não salvas.';
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!dirty)return;
    const patch={};for(const key of dirtyKeys){const input=fields[key];if(!state.disponivel&&['enabled','pausado'].includes(key))continue;const value=input.type==='checkbox'?input.checked:key==='volume'?Number(input.value):input.value;if(value!==state[key])patch[key]=value;}
    if(!Object.keys(patch).length){dirtyKeys.clear();dirty=false;render();status.textContent='Nenhuma alteração para salvar.';return;}
    busy=true;controls();stopPreview();status.textContent='Salvando preferências…';
    try{const result=await request(patch);if(disposed)return;state=normalize(result);dirtyKeys.clear();dirty=false;apply(state);render();status.textContent='Preferências salvas neste computador.';}
    catch(e){if(!disposed)status.textContent=(e.message||'Não foi possível confirmar a gravação.')+' Atualize o estado antes de repetir.';}
    finally{busy=false;if(!disposed)controls();}
  });
  async function preview(kind,{saved=false}={}){
    const result=(tocou,texto)=>{if(!disposed)status.textContent=texto;return {tocou,texto};};
    if(!['decisao','conclusao'].includes(kind))return result(false,'Prévia indisponível.');
    const allowed=()=>!disposed&&!busy&&!document.hidden&&!state.pausado&&!fields.pausado.checked&&fields.som.checked&&(!saved||state.som);
    if(!allowed())return result(false,state.pausado||fields.pausado.checked?'A companhia está pausada; a prévia permanece silenciosa.':'Ligue o som para ouvir a prévia.');
    const volume=saved?state.volume:Number(fields.volume.value);if(!volume)return result(false,'O volume está em zero.');
    if(window.LumeAudio){
      previewSaved=saved;
      sharedPlayer ||=window.LumeAudio.criar({estado:()=>({som:!disposed&&!busy&&fields.som.checked&&(!previewSaved||state.som),pausado:state.pausado||fields.pausado.checked,volume:previewSaved?state.volume:Number(fields.volume.value)})});
      const outcome=await sharedPlayer.tocar(kind,{previa:true});return result(outcome.tocou,outcome.texto);
    }
    return result(false,'Som indisponível neste ambiente.');
  }
  get('lv-preview-decisao').onclick=()=>preview('decisao');get('lv-preview-conclusao').onclick=()=>preview('conclusao');get('lv-pref-refresh').onclick=carregar;
  // Preserve the legacy box and its closures; only hide the duplicate entry points.
  for(const id of ['theme-mode','ui-sounds']){const label=get(id)?.closest('label');if(label)label.hidden=true;}
  const legacy=get('pessoal-companion');
  if(legacy){legacy.hidden=true;const shortcut=document.createElement('button');shortcut.type='button';shortcut.className='lv-button';shortcut.textContent='Aparência e companhia';legacy.after(shortcut);shortcut.onclick=async()=>{await window.abrirAjuste?.('settings-guide');get('lv-preferences-title').focus();void carregar();};}
  document.querySelector('[data-settings-group="appearance"].settings-choice')?.addEventListener('click',()=>void carregar());
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPreview();});
  async function atualizar(patch){
    if(disposed)throw Error('A janela foi encerrada.');
    if(busy)await flight;
    if(busy)throw Error('Aguarde a gravação das preferências.');
    busy=true;controls();stopPreview();status.textContent='Salvando preferências…';
    try{
      const result=await request(patch);if(disposed)return;
      state=normalize(result);
      for(const key of Object.keys(patch))dirtyKeys.delete(key);
      dirty=dirtyKeys.size>0;apply(state);render();status.textContent='Preferências salvas neste computador.';
      return {...state};
    }catch(error){status.textContent=error.message||'Não foi possível salvar.';throw error;}
    finally{busy=false;if(!disposed)controls();}
  }
  window.LumePreferencias=Object.freeze({carregar,atualizar,previa:kind=>preview(kind,{saved:true}),estado:()=>({...state})});render();
  window.addEventListener('pagehide',()=>{disposed=true;stopPreview();sharedPlayer?.destruir();},{once:true});
})();

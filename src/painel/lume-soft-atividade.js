/* Activity is a separate, explicit local permission, never inferred from companion state. */
(() => {
  'use strict';
  const endpoint='/api/v3/atividade-apps',host=document.getElementById('settings-group-data-cards');if(!host)return;
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
  const labels={desligado:'Desligado',pausado:'Pausado',indisponivel:'Indisponível neste dispositivo',suspenso:'Computador suspenso',aguardando:'Aguardando uma amostra',coletando:'Amostragem ativa',inativo:'Sem atividade recente',bloqueado:'Sessão bloqueada',excluido:'Aplicativo excluído',limite:'Limite local atingido'};
  const duration=ms=>{const minutes=Math.floor(Math.max(0,Number(ms)||0)/60000);return minutes<1?'menos de 1 min':minutes<60?minutes+' min':Math.floor(minutes/60)+' h '+minutes%60+' min';};
  const request=(path,body,signal)=>window.lumeConnectionRequest(path,body,{timeout:15000,signal});
  const box=el('section',null,'settings-card lv-page ls-activity');box.id='ls-activity';box.dataset.settingsCard='';box.dataset.settingsGroup='data';box.dataset.settingsOrder='15';host.prepend(box);
  let data,busy=false,controller,revision=0,summaryRevision=0;
  const title=el('h2','Seu ritmo');title.id='ls-activity-title';title.tabIndex=-1;box.setAttribute('aria-labelledby',title.id);
  const intro=el('p','Veja por quanto tempo cada aplicativo esteve em primeiro plano. É uma estimativa por amostragem, não uma medida de atenção ou produtividade.');
  const privacy=el('p','Somente o nome do executável e intervalos ficam neste computador. Sem títulos, URLs, conteúdo, capturas, áudio ou teclas; nada é enviado ao ChatGPT. Amostras a cada 5 segundos, sem acumular após 60 segundos de inatividade, bloqueio ou suspensão. Os registros de atividade não fazem parte do backup do acervo.','lv-card-meta');
  const state=el('p','Consulte o estado do acompanhamento.','lv-status');state.id='ls-activity-state';state.setAttribute('role','status');
  const controls=el('div',null,'lv-toolbar'),settings=el('form',null,'lv-filters'),list=el('div',null,'ls-activity-list'),feedback=el('p','','lv-status');feedback.setAttribute('role','status');
  const button=(text,fn)=>{const b=el('button',text,'lv-button');b.type='button';b.onclick=()=>Promise.resolve().then(fn).catch(error=>{feedback.textContent=error.message||'Não foi possível confirmar.';});return b;};
  const start=button('Iniciar acompanhamento',()=>patch({habilitado:true,consentimento:1,pausado:false}));start.id='ls-activity-start';start.dataset.variant='primary';
  const pause=button('Pausar acompanhamento',()=>patch({pausado:!data.config.pausado}));pause.id='ls-activity-pause';
  const stop=button('Desligar acompanhamento',()=>patch({habilitado:false}));stop.id='ls-activity-stop';
  const refresh=button('Atualizar atividade',()=>load());refresh.id='ls-activity-refresh';controls.append(start,pause,stop,refresh);
  const retentionLabel=el('label','Guardar registros por'),retention=el('select');retention.id='ls-activity-retention';for(const n of [1,7,14,30])retention.append(new Option(n+' dia'+(n===1?'':'s'),String(n)));retentionLabel.append(retention);
  const excludedLabel=el('label','Aplicativos excluídos (um executável por linha)'),excluded=el('textarea');excluded.id='ls-activity-excluded';excluded.rows=3;excluded.maxLength=26000;excluded.placeholder='nome.exe';excludedLabel.append(excluded);
  const save=el('button','Salvar limites','lv-button');save.type='submit';settings.append(retentionLabel,excludedLabel,save);
  settings.onsubmit=event=>{event.preventDefault();const apps=excluded.value.split(/[\n,]/).map(s=>s.trim().toLowerCase()).filter(Boolean);if(apps.length>100||apps.some(s=>!s.endsWith('.exe')||/[\\/:]/.test(s))){feedback.textContent='Informe até 100 nomes de executável, sem caminhos, como nome.exe.';return;}void patch({retencaoDias:Number(retention.value),excluidos:[...new Set(apps)]}).catch(error=>feedback.textContent=error.message);};
  const deleteArea=el('details',null,'ls-activity-delete'),summary=el('summary','Apagar registros de atividade');deleteArea.append(summary,el('p','Esta ação apaga os intervalos de aplicativos e desliga o acompanhamento. Suas conversas e fontes permanecem no acervo.'));
  const confirmLabel=el('label',null,'ls-delete-confirm'),confirm=el('input');confirm.type='checkbox';confirm.id='ls-activity-delete-confirm';confirmLabel.append(confirm,el('span','Quero apagar os registros de atividade deste computador.'));
  const remove=button('Apagar e desligar',async()=>{if(!confirm.checked)return;await mutate(endpoint+'/apagar',{});confirm.checked=false;deleteArea.open=false;});remove.id='ls-activity-delete';remove.disabled=true;confirm.onchange=()=>remove.disabled=busy||!confirm.checked;deleteArea.append(confirmLabel,remove);
  box.append(title,intro,privacy,state,controls,settings,list,feedback,deleteArea);
  function availability(){for(const n of box.querySelectorAll('button,input,select,textarea'))n.disabled=busy;start.disabled=busy||!data||!data.disponivel;pause.disabled=busy||!data?.config.habilitado;stop.disabled=busy||!data?.config.habilitado;save.disabled=busy||!data;remove.disabled=busy||!confirm.checked;start.hidden=data?.config.habilitado===true;pause.hidden=stop.hidden=!data?.config.habilitado;}
  function paint(value,{append=false}={}){
    data=value;state.textContent=(labels[data.estado]||'Estado não disponível')+' · '+(data.resumo?.amostras?duration(data.resumo.duracaoMs)+' estimados no período consultado.':'Nenhum intervalo registrado no período consultado.');
    if(!append){list.replaceChildren();retention.value=String(data.config.retencaoDias);if(!retention.value){retention.append(new Option(data.config.retencaoDias+' dias',String(data.config.retencaoDias)));retention.value=String(data.config.retencaoDias);}excluded.value=data.config.excluidos.join('\n');}
    pause.textContent=data.config.pausado?'Retomar acompanhamento':'Pausar acompanhamento';pause.setAttribute('aria-pressed',String(data.config.pausado));
    list.querySelector('[data-more]')?.remove();
    for(const app of data.apps||[]){const row=el('article',null,'ls-activity-row');row.append(el('strong',app.nome||app.appId),el('span',duration(app.duracaoMs)+' estimados'),button('Excluir '+(app.nome||app.appId),()=>patch({excluidos:[...new Set([...data.config.excluidos,app.appId])]})));list.append(row);}
    if(!list.children.length)list.append(el('p','Nenhum intervalo de aplicativo registrado neste período.','lv-empty'));
    if(data.proximaPagina!=null){const more=button('Mais aplicativos',()=>load(data.proximaPagina,true));more.dataset.more='true';list.append(more);}availability();
  }
  async function load(page=1,append=false){
    if(busy)return;busy=true;availability();controller?.abort();controller=new AbortController();const ticket=++revision;state.textContent='Consultando atividade local…';box.setAttribute('aria-busy','true');
    try{const value=await request(endpoint+'?dias=7&pagina='+page+'&limite=20',undefined,controller.signal);if(ticket===revision)paint(value,{append});}
    catch(error){if(ticket===revision&&!controller.signal.aborted){state.textContent='Não foi possível consultar a atividade.';feedback.textContent=error.message||'Tente atualizar novamente.';}}
    finally{if(ticket===revision){busy=false;availability();box.setAttribute('aria-busy','false');}}
  }
  async function mutate(path,body){if(busy)return;const ticket=revision;busy=true;availability();feedback.textContent='Salvando no computador…';try{await request(path,body);if(ticket!==revision)return;feedback.textContent='Estado salvo neste computador.';}finally{if(ticket===revision){busy=false;availability();}}if(ticket!==revision)return;await load();window.dispatchEvent(new Event('lume:activity-changed'));}
  const patch=body=>mutate(endpoint+'/config',body);
  async function abrir(){await window.abrirAjuste?.('ls-activity');await load();title.focus({preventScroll:true});}
  async function resumo(root){
    const ticket=++summaryRevision,card=el('section',null,'ls-rhythm-card');card.setAttribute('aria-labelledby','ls-rhythm-title');const heading=el('h2','Seu ritmo');heading.id='ls-rhythm-title';const copy=el('p','Consulte a atividade local dos aplicativos.');card.append(heading,copy,button('Ver meu ritmo',abrir));const board=root.querySelector('.lv-board');if(board)board.before(card);else root.append(card);
    try{const current=await request(endpoint+'?dias=7&limite=1');if(ticket!==summaryRevision||!card.isConnected)return;copy.textContent=(labels[current.estado]||'Estado não disponível')+' · '+(current.resumo?.amostras?duration(current.resumo.duracaoMs)+' estimados em aplicativos nos últimos 7 dias.':'Amostragem local, sob seu controle.');}
    catch{if(card.isConnected)copy.textContent='Estado não consultado. Abra o painel para conferir.';}
  }
  document.querySelector('[data-settings-group="data"].settings-choice')?.addEventListener('click',()=>void load());
  window.addEventListener('lume:invalidate',()=>{revision++;summaryRevision++;controller?.abort();data=null;list.replaceChildren();busy=false;state.textContent='Consulte o estado do acompanhamento.';availability();});
  availability();window.LumeAtividade=Object.freeze({resumo,abrir,carregar:load});
})();

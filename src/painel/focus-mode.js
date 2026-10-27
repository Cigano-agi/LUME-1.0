(() => {
  const today=$('today'),memory=$('memory');
  const dashboard=()=>[
    $('home-status'),
    today.querySelector('.home-snapshot'),
    today.querySelector('.content-grid')
  ].filter(Boolean);

  const moreActions=element('button','Ver todas as ações','secondary focus-more-actions');
  moreActions.type='button';moreActions.id='focus-more-actions';
  $('tasks').after(moreActions);
  moreActions.onclick=()=>{
    today.classList.toggle('focus-show-all-actions');
    const open=today.classList.contains('focus-show-all-actions');
    moreActions.textContent=open?'Mostrar só as 3 primeiras':'Ver todas as ações';
    moreActions.setAttribute('aria-expanded',String(open));
  };

  $('local-search-mode')?.closest('.filter-line')?.classList.add('mode-hidden');
  const querySettings=element('details',null,'query-settings');
  querySettings.append(element('summary','Ajustar pergunta'));
  const questionForm=$('ia-question-form'),questionButtons=questionForm.querySelector('.button-row');
  for(const node of [...questionForm.querySelectorAll('.ia-filters,.ia-context-choice')])querySettings.append(node);
  questionForm.insertBefore(querySettings,questionButtons);

  function todayMode(){
    today.classList.remove('focus-actions-only','focus-show-all-actions');
    dashboard().forEach(node=>node.hidden=false);
    moreActions.textContent='Ver todas as ações';moreActions.setAttribute('aria-expanded','false');
  }

  const peopleParts={
    contacts:$('contacts'),
    conversations:memory.querySelector('.conversation-workspace'),
    businesses:$('negocios-memory-shell')
  };

  const memoryParts={
    ask:()=>[memory.querySelector('.ia-panel')],
    search:()=>[
      $('search-form'),
      $('search-context')?.closest('.filter-line'),
      $('results'),
      $('more')
    ],
    contacts:()=>[peopleParts.contacts],
    conversations:()=>[peopleParts.conversations],
    businesses:()=>[peopleParts.businesses],
    projects:()=>[$('projects06')],
    commands:()=>[$('commands-panel')]
  };
  const allMemoryParts=()=>[...Object.values(memoryParts).flatMap(get=>get()),...Object.values(peopleParts)].filter(Boolean);
  const memoryCopy={search:'Nome, assunto ou palavra.',ask:'Pergunte e confira as mensagens usadas.',contacts:'Pessoas nas conversas salvas.',conversations:'Conversas com mensagens salvas.',businesses:'Negócios que você marcou.',projects:'Fontes que você reuniu por projeto.',commands:'Itens organizados pelo Lume.'};
  for(const [mode,id]of Object.entries({search:'search-form',ask:'ia-question-form',contacts:'contacts',conversations:'conversation-directory',businesses:'negocios-memory-shell',commands:'commands-panel'})){
    const node=$(id);if(!node)continue;node.setAttribute('role','tabpanel');node.setAttribute('aria-labelledby','memory-mode-'+mode);
  }
  let selectedMemoryMode='search',memoryModeRevision=0;
  window.revisaoModoMemoriaAtual=()=>memoryModeRevision;

  function memoryMode(mode='search'){
    const alias={people:'conversations'}[mode]||mode;
    const next=memoryParts[alias]?alias:'search',changed=next!==selectedMemoryMode;if(changed)memoryModeRevision++;selectedMemoryMode=next;
    memory.dataset.mode=selectedMemoryMode;
    allMemoryParts().forEach(node=>node.classList.add('mode-hidden'));
    memoryParts[selectedMemoryMode]().filter(Boolean).forEach(node=>node.classList.remove('mode-hidden'));
    if(changed&&page==='memory')run(()=>window.carregarModoMemoria?.());
    document.querySelectorAll('[data-memory-mode]').forEach(button=>{
      const active=button.dataset.memoryMode===selectedMemoryMode;
      button.setAttribute('aria-selected',String(active));
      button.classList.toggle('active',active);
      button.tabIndex=active?0:-1;
      const controlled={search:'search-form',ask:'ia-question-form',contacts:'contacts',conversations:'conversation-directory',businesses:'negocios-memory-shell',commands:'commands-panel'}[button.dataset.memoryMode];
      if(controlled)button.setAttribute('aria-controls',controlled);
    });
    $('memory-mode-help').textContent=memoryCopy[selectedMemoryMode];
    window.lumeSyncNavigation?.();
    window.lumeReveal?.(memoryParts[selectedMemoryMode]().find(Boolean));
  }
  window.lumeSetMemoryMode=memoryMode;
  window.lumeSetPeopleMode=mode=>memoryMode({contacts:'contacts',conversations:'conversations',businesses:'businesses'}[mode]||'contacts');

  async function openMemory(mode,focusId){
    memoryMode(mode);await show('memory');memoryMode(mode);
    const target=$(focusId);target?.focus();target?.scrollIntoView({block:'center'});
  }

  function showActions(){
    todayMode();
    const heading=today.querySelector('.content-grid h2');heading.tabIndex=-1;heading.focus();
    today.querySelector('.content-grid').scrollIntoView({block:'start'});
  }
  async function finishFirstUse(){
    if($('first-use').hidden)return;
    perfil=await api('/api/v3/guia',{dispensado:true});$('first-use').hidden=true;
  }
  $('focus-actions').onclick=showActions;
  $('focus-find').onclick=()=>run(()=>openMemory('search','search'),$('focus-find'));
  $('focus-ask').onclick=()=>run(()=>openMemory('ask','ia-question'),$('focus-ask'));
  $('first-actions').onclick=()=>run(async()=>{await finishFirstUse();showActions();},$('first-actions'));
  $('first-find').onclick=()=>run(async()=>{await finishFirstUse();await openMemory('search','search');},$('first-find'));
  $('guide-ai').onclick=()=>run(async()=>{await finishFirstUse();await openMemory('ask','ia-question');},$('guide-ai'));
  $('focus-all').onclick=todayMode;
  document.querySelectorAll('[data-memory-mode]').forEach(button=>{
    button.onclick=()=>memoryMode(button.dataset.memoryMode);
    button.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      event.preventDefault();const buttons=[...document.querySelectorAll('[data-memory-mode]')];let index=buttons.indexOf(button);
      if(event.key==='Home')index=0;else if(event.key==='End')index=buttons.length-1;else index=(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      buttons[index].focus();buttons[index].click();
    };
  });

  $('open-memory').onclick=()=>run(()=>openMemory('search','search'));
  const memoryNav=document.querySelector('nav [data-view="memory"]');
  memoryNav.onclick=()=>run(async()=>{conversa='';memoryMode('conversations');await show('memory',{focarTitulo:true});});

  const taskOptions=$('task-options');
  for(const node of [today.querySelector('.dashboard-tools')].filter(Boolean)){
    node.hidden=false;taskOptions.append(node);
  }
  today.querySelector('.recent-panel').hidden=false;

  todayMode();memoryMode('search');
})();

(() => {
  const stages=[
    ['01 · ENCONTRE','Onde ficou esse combinado?','Busque uma palavra da conversa, como “proposta”.','⌕  proposta'],
    ['02 · CONFIRA','A mensagem que dá contexto.','Leia o combinado antes de decidir o que fazer.','↗  Sua mensagem · Cliente Exemplo'],
    ['03 · GUARDE','Preparar a proposta revisada.','Crie uma nota ligada à fonte para retomar depois.','✓  Exemplo de nota · não foi salva']
  ];
  let step=0;
  document.getElementById('demo-next').onclick=()=>{
    step=(step+1)%stages.length;
    for(const [index,id]of ['demo-label','demo-title','demo-copy','demo-source'].entries())document.getElementById(id).textContent=stages[step][index];
    document.getElementById('demo-counter').textContent=`Exemplo fictício · ${step+1} de 3`;
    document.getElementById('demo-next').textContent=step===2?'Ver de novo ↻':'Continuar →';
    window.lumeReveal?.(document.getElementById('demo-card'));
  };
  const tabs=[...document.querySelectorAll('[data-tour]')];
  const mobile=matchMedia('(max-width: 740px)');
  const orient=()=>document.querySelector('.tour-sidebar [role=tablist]').setAttribute('aria-orientation',mobile.matches?'horizontal':'vertical');
  orient();mobile.addEventListener('change',orient);
  function selectTab(tab){
    for(const t of tabs){const active=t===tab;t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1;document.getElementById(t.getAttribute('aria-controls')).hidden=!active;}
    window.lumeReveal?.(document.getElementById(tab.getAttribute('aria-controls')));
  }
  for(const tab of tabs){tab.onclick=()=>selectTab(tab);tab.onkeydown=e=>{
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
    e.preventDefault();const i=tabs.indexOf(tab),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(['ArrowUp','ArrowLeft'].includes(e.key)?-1:1)+tabs.length)%tabs.length;
    tabs[next].focus();selectTab(tabs[next]);
  };}
  const dialog=document.getElementById('download-dialog');
  if(dialog){
    document.querySelectorAll('[data-download-open]').forEach(button=>button.onclick=()=>dialog.showModal());
    document.getElementById('download-close').onclick=()=>dialog.close();
    document.querySelectorAll('[data-platform]').forEach(button=>button.onclick=()=>{
      const mac=button.dataset.platform==='mac';
      document.querySelectorAll('[data-platform]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
      document.getElementById('install-title').textContent=mac?'Arraste para Aplicativos.':'Abra o instalador.';
      document.getElementById('install-copy').textContent=mac
        ?'A versão para Mac ainda está em preparação. Quando estiver validada, você vai baixar o .dmg, arrastar o Lume para Aplicativos e abrir pelo Dock.'
        :'Quando a versão estiver liberada: baixe o arquivo .exe, confira o nome do editor e siga os passos na tela. Depois, abra o Lume pelo menu Iniciar.';
      window.lumeReveal?.(document.getElementById('install-story'));
    });
  }
  if(window.Motion)Motion.inView('.feature-illustration, .story-heading, .business-drawing',element=>{window.lumeReveal?.(element);},{amount:.2});
})();

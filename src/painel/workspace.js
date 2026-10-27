(() => {
  $('quick-find-form').onsubmit=e=>{e.preventDefault();run(async()=>{
    conversa='';$('search').value=$('quick-find').value;$('local-search-mode').value='lexical';
    $('clear-filter').hidden=true;$('search-context').textContent='Todas as conversas permitidas · busca textual local';
    window.lumeSetMemoryMode?.('search');await show('memory');window.lumeSetMemoryMode?.('search');$('results').tabIndex=-1;$('results').focus();$('results').scrollIntoView({block:'start'});
  },e.submitter);};
  const abrirNota=()=>run(async()=>{
    await window.abrirAjuste('settings-note');$('note-title').focus();
  });
  $('quick-note').onclick=()=>{
    if($('note-title').value||$('note-text').value||(window.fontesDaNota||[]).length){
      $('draft-detail').textContent=(window.fontesDaNota||[]).length
        ? 'Seu rascunho está ligado a uma mensagem. Apagar essa mensagem também apagará a nota. Vamos continuar de onde você parou.'
        : 'Seu texto continua aqui. Vamos continuar de onde você parou.';
      $('draft-dialog').showModal();return;
    }
    abrirNota();
  };
  $('draft-close').onclick=()=>$('draft-dialog').close();
  $('draft-resume').onclick=()=>{$('draft-dialog').close();abrirNota();};
})();

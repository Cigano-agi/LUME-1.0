(() => {
  const box = element('section', null, 'panel settings-card central-panel');
  box.id = 'central-panel';
  box.setAttribute('aria-labelledby', 'central-title');
  box.innerHTML = `
    <p class="eyebrow">SUPORTE DO BETA</p>
    <h2 id="central-title">Feedback e acompanhamento</h2>
    <p>Você pode escrever e copiar um relato sem código do beta. O código habilita o envio pelo app. O acompanhamento técnico periódico é uma escolha separada.</p>
    <div class="central-privacy" aria-label="Dados do acompanhamento">
      <p><strong>Ao habilitar feedback:</strong> o código registra esta instalação com versão e plataforma. O relato escrito sai apenas quando você tocar em Enviar. Se ativar o acompanhamento, o Lume também enviará periodicamente estado da atualização, último contato e estado geral do WhatsApp.</p>
      <p><strong>Não envia automaticamente:</strong> mensagens, contatos, grupos, telefones, arquivos, buscas ou chaves. Um feedback escrito por você é enviado somente ao tocar em Enviar.</p>
    </div>
    <div id="central-state" class="central-state" role="status" aria-live="polite">
      <span class="central-dot" aria-hidden="true"></span>
      <span>Conferindo o acompanhamento…</span>
    </div>
    <form id="central-consent" class="central-consent" hidden>
      <label id="central-invite-label" for="central-invite">Código do beta para enviar feedback</label>
      <input id="central-invite" autocomplete="off" autocapitalize="characters" maxlength="96" placeholder="LUME-…" required>
      <label id="central-confirm-label" class="check central-check" hidden>
        <input id="central-confirm" type="checkbox">
        <span>Autorizo o envio automático dos dados técnicos descritos acima.<small>O feedback manual já funciona sem este acompanhamento. Você pode desligar quando quiser.</small></span>
      </label>
      <button class="primary" type="submit">Habilitar feedback</button>
    </form>
    <div id="central-active" hidden>
      <p id="central-last" class="muted"></p>
      <button id="central-stop-technical" class="secondary" type="button" hidden>Desligar acompanhamento técnico</button>
      <details id="central-stop" class="central-stop">
        <summary>Revogar esta instalação na Central</summary>
        <p>O Lume para de enviar dados técnicos e feedback. Suas conversas e seus arquivos continuam neste computador. Um novo convite será necessário para voltar.</p>
        <label class="check central-check">
          <input id="central-stop-confirm" type="checkbox">
          <span>Quero revogar o acesso desta instalação à Central.</span>
        </label>
        <button id="central-revoke" class="secondary" type="button" disabled>Confirmar revogação</button>
      </details>
    </div>
    <form id="central-feedback-form" class="central-feedback" hidden>
      <h3>Escrever feedback sobre o Lume</h3>
      <p class="muted">Conte o que aconteceu. Não incluímos conversas, captura de tela nem diagnóstico automaticamente. Confira o texto antes de enviar pelo app ou copiar para o canal do convite.</p>
      <p id="central-feedback-remote-note" class="muted" hidden>O envio pelo app associa o relato ao seu convite. A rotina diária planejada remove relatos com mais de 90 dias; você pode pedir a exclusão antes.</p>
      <div class="central-feedback-grid">
        <label>Tipo
          <select id="central-feedback-category" required><option value="erro">Algo falhou</option><option value="ideia">Ideia</option><option value="elogio">O que funcionou</option></select>
        </label>
        <label>Onde aconteceu
          <select id="central-feedback-stage" required><option value="ajustes">Ajustes</option><option value="onboarding">Primeiro acesso</option><option value="hoje">Hoje</option><option value="conexao">Conexão</option><option value="organiza">Organizar conversas</option></select>
        </label>
      </div>
      <label>Seu relato
        <textarea id="central-feedback-text" rows="4" minlength="8" maxlength="2000" required placeholder="O que você tentou fazer e o que aconteceu?"></textarea>
      </label>
      <label>Foi útil até aqui? <span class="muted">Opcional</span>
        <select id="central-feedback-utility"><option value="">Prefiro não responder</option><option value="util">Sim</option><option value="parcial">Em parte</option><option value="nao_util">Ainda não</option></select>
      </label>
      <label id="central-feedback-contact-label" class="check central-check" hidden><input id="central-feedback-contact" type="checkbox"><span>A equipe pode me procurar pelo canal do convite para conversar sobre este relato.<small>Opcional. Desmarcado por padrão. Não envia seu telefone ou e-mail.</small></span></label>
      <p id="central-feedback-status" class="muted" role="status" aria-live="polite">O Lume não envia seu texto automaticamente.</p>
      <div class="button-row"><button id="central-feedback-send" class="primary" type="submit" hidden>Enviar feedback</button><button id="central-feedback-copy" class="secondary" type="button">Copiar relato</button></div>
    </form>
    <button id="central-retry" class="secondary" type="button" hidden>Tentar novamente</button>`;

  window.registrarAjuste(box, 'central-panel', 'connections');

  const state = $('central-state');
  const stateText = state.querySelector('span:last-child');
  const consent = $('central-consent');
  const active = $('central-active');
  const last = $('central-last');
  const stopTechnical=$('central-stop-technical');
  const retry = $('central-retry');
  const invite = $('central-invite');
  const inviteLabel=$('central-invite-label');
  const confirm = $('central-confirm');
  const confirmLabel=$('central-confirm-label');
  const stopConfirm = $('central-stop-confirm');
  const revoke = $('central-revoke');
  const feedbackForm=$('central-feedback-form');
  const feedbackCategory=$('central-feedback-category');
  const feedbackStage=$('central-feedback-stage');
  const feedbackText=$('central-feedback-text');
  const feedbackUtility=$('central-feedback-utility');
  const feedbackContact=$('central-feedback-contact');
  const feedbackContactLabel=$('central-feedback-contact-label');
  const feedbackStatus=$('central-feedback-status');
  const feedbackSend=$('central-feedback-send');
  const feedbackCopy=$('central-feedback-copy');
  const feedbackRemoteNote=$('central-feedback-remote-note');
  feedbackForm.hidden=false;
  const draftKey='lume-feedback-draft-v1';
  let feedbackId=crypto.randomUUID();
  let draftLoaded=false,draftTimer=null,saveChain=Promise.resolve();
  let busy = false;
  let feedbackReady=false;

  function atalho(destino,etapa,rotulo='Enviar feedback'){
    const button=element('button',rotulo,'text-button central-feedback-shortcut');
    button.type='button';
    button.addEventListener('click',()=>window.abrirFeedbackLume(etapa));
    destino.append(button);
  }
  atalho($('first-use'),'onboarding','Precisa de ajuda? Enviar feedback');
  atalho($('today').querySelector('.page-heading'),'hoje');
  atalho($('home-status'),'conexao','Relatar problema de conexão');
  atalho($('settings-whatsapp'),'conexao','Relatar problema de conexão');
  window.abrirFeedbackLume=async etapa=>{
    if(!['onboarding','hoje','conexao','organiza','ajustes'].includes(etapa))return false;
    const abriu=await window.abrirAjuste('central-panel');
    if(!abriu)return false;
    if(!feedbackForm.hidden){
      if(!feedbackText.value.trim()){
        feedbackStage.value=etapa;
        guardarRascunho();
      }else{
        feedbackStatus.textContent='Seu rascunho anterior foi mantido. Confira a etapa antes de enviar.';
      }
      feedbackText.focus({preventScroll:true});
    }else if(!consent.hidden){
      feedback('Para enviar feedback, informe seu código do beta. O acompanhamento técnico é opcional.');
      invite.focus({preventScroll:true});
    }else{
      feedback('Não foi possível abrir o feedback agora. Tente novamente em Ajustes.');
      retry.focus({preventScroll:true});
    }
    return true;
  };

  try{
    const draft=JSON.parse(localStorage.getItem(draftKey)||'null');
    if(draft&&typeof draft==='object'&&/^[0-9a-f-]{36}$/i.test(draft.chaveCliente)&&typeof draft.relato==='string'&&draft.relato.length<=2000){
      feedbackId=draft.chaveCliente;
      feedbackCategory.value=draft.categoria;
      feedbackStage.value=draft.etapa;
      feedbackText.value=draft.relato;
      feedbackUtility.value=draft.utilidade||'';
      feedbackContact.checked=draft.contatoAutorizado===true;
      feedbackStatus.textContent='Rascunho guardado neste computador. Confira antes de enviar.';
    }
  }catch{}
  function rascunhoAtual(){return {chaveCliente:feedbackId,categoria:feedbackCategory.value,etapa:feedbackStage.value,relato:feedbackText.value,utilidade:feedbackUtility.value||null,contatoAutorizado:feedbackContact.checked};}
  function persistirRascunho(){
    const rascunho=rascunhoAtual();
    saveChain=saveChain.catch(()=>{}).then(()=>api('/api/v3/central/feedback-rascunho',{rascunho}));
    return saveChain;
  }
  function guardarRascunho(){
    let copiaNavegador=false;
    try{localStorage.setItem(draftKey,JSON.stringify(rascunhoAtual()));copiaNavegador=true;}catch{}
    clearTimeout(draftTimer);draftTimer=setTimeout(()=>{persistirRascunho().catch(()=>{feedbackStatus.textContent=copiaNavegador?'Rascunho guardado neste navegador; o Lume não confirmou a gravação no perfil.':'Não foi possível guardar o rascunho. Mantenha esta tela aberta.';});},300);
  }
  feedbackForm.addEventListener('input',guardarRascunho);
  feedbackForm.addEventListener('change',guardarRascunho);

  const formatDate = value => value
    ? new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : null;

  function setState(text, kind = '') {
    state.className = `central-state${kind ? ` is-${kind}` : ''}`;
    stateText.textContent = text;
  }

  function render(data) {
    const enabled = data?.consentido === true && data?.revogada !== true;
    feedbackReady=data?.feedbackHabilitado===true&&data?.revogada!==true;
    consent.hidden = enabled;
    invite.hidden=inviteLabel.hidden=feedbackReady;
    invite.required=!feedbackReady;
    confirmLabel.hidden=!feedbackReady;
    consent.querySelector('button[type="submit"]').textContent=feedbackReady?'Ativar acompanhamento técnico':'Habilitar feedback';
    active.hidden = !feedbackReady;
    stopTechnical.hidden=!enabled;
    feedbackForm.hidden = false;
    feedbackSend.hidden = !feedbackReady;
    feedbackContactLabel.hidden = !feedbackReady;
    feedbackRemoteNote.hidden = !feedbackReady;
    retry.hidden = true;
    if (!enabled) {
      setState(feedbackReady?'Feedback habilitado. Acompanhamento técnico desligado.':'Acompanhamento e feedback desligados.', 'off');
      last.textContent = '';
      return;
    }

    const connected = ['registrado', 'pulso_enviado', 'em_dia'].includes(data.situacao);
    if (connected) setState('Acompanhamento ativo.', 'ok');
    else if (data.situacao === 'central_indisponivel' || data.situacao === 'adiado') {
      setState('Acompanhamento ativo. A Central está sem conexão agora; o Lume continua funcionando.', 'waiting');
      retry.hidden = false;
    } else setState('Ativação salva. Aguardando o primeiro contato com a Central.', 'waiting');
    const lastSeen = formatDate(data.ultimoSucessoEm);
    last.textContent = lastSeen ? `Último contato: ${lastSeen}.` : 'O primeiro contato ainda não foi enviado.';
  }

  async function load() {
    if (busy) return;
    busy = true;
    retry.disabled = true;
    try {
      if(!draftLoaded){
        const remoto=await api('/api/v3/central/feedback-rascunho');
        if(remoto?.rascunho&&!feedbackText.value){
          const draft=remoto.rascunho;feedbackId=draft.chaveCliente;
          feedbackCategory.value=draft.categoria;feedbackStage.value=draft.etapa;feedbackText.value=draft.relato;feedbackUtility.value=draft.utilidade||'';feedbackContact.checked=draft.contatoAutorizado===true;
          feedbackStatus.textContent='Rascunho recuperado do Lume. Confira antes de enviar.';
        }
        draftLoaded=true;
      }
      render(await api('/api/v3/central'));
    } catch (error) {
      feedbackReady = false;
      consent.hidden = true;
      active.hidden = true;
      feedbackForm.hidden = false;
      feedbackSend.hidden = true;
      feedbackContactLabel.hidden = true;
      feedbackRemoteNote.hidden = true;
      retry.hidden = false;
      setState(error.message || 'Não foi possível conferir agora. O Lume continua funcionando.', 'waiting');
    } finally {
      busy = false;
      retry.disabled = false;
    }
  }

  consent.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (feedbackReady && !confirm.checked) {
      feedback('Marque a autorização para ativar o acompanhamento.');
      confirm.focus();
      return;
    }
    busy = true;
    const button = consent.querySelector('button[type="submit"]');
    button.disabled = true;
    const ativandoAcompanhamento=feedbackReady;
    setState(ativandoAcompanhamento?'Ativando acompanhamento…':'Habilitando feedback…', 'waiting');
    try {
      render(await (ativandoAcompanhamento?api('/api/v3/central/ativar-acompanhamento',{confirmar:true}):api('/api/v3/central/autorizar-feedback',{convite:invite.value.trim()})));
      invite.value = '';
      confirm.checked = false;
      feedback(ativandoAcompanhamento?'Acompanhamento ativado.':'Feedback habilitado. Acompanhamento técnico continua desligado.');
    } catch (error) {
      setState(error.message, 'off');
    } finally {
      busy = false;
      button.disabled = false;
    }
  });

  stopConfirm.addEventListener('change', () => { revoke.disabled = !stopConfirm.checked || busy; });
  stopTechnical.addEventListener('click',async()=>{
    if(busy)return;
    busy=true;stopTechnical.disabled=true;setState('Desligando acompanhamento técnico…','waiting');
    try{render(await api('/api/v3/central/desativar-acompanhamento',{confirmar:'DESLIGAR'}));feedback('Acompanhamento técnico desligado. Feedback continua disponível.');}
    catch(error){setState(error.message,'waiting');}
    finally{busy=false;stopTechnical.disabled=false;}
  });
  revoke.addEventListener('click', async () => {
    if (!stopConfirm.checked || busy) return;
    busy = true;
    revoke.disabled = true;
    setState('Desligando acompanhamento…', 'waiting');
    try {
      render(await api('/api/v3/central/revogar', { confirmar: 'REVOGAR' }));
      stopConfirm.checked = false;
      $('central-stop').open = false;
      feedback('Acesso à Central revogado.');
    } catch (error) {
      setState(error.message, 'waiting');
      retry.hidden = false;
    } finally {
      busy = false;
      revoke.disabled = !stopConfirm.checked;
    }
  });
  retry.addEventListener('click', load);
  feedbackCopy.addEventListener('click',async()=>{
    if(!feedbackForm.reportValidity())return;
    const relato=feedbackText.value.trim();
    if(relato.length<8){feedbackText.focus();return;}
    const partes=['Feedback sobre o Lume',`Tipo: ${feedbackCategory.selectedOptions[0].textContent}`,`Onde aconteceu: ${feedbackStage.selectedOptions[0].textContent}`,`Relato: ${relato}`];
    if(feedbackUtility.value)partes.push(`Foi útil até aqui? ${feedbackUtility.selectedOptions[0].textContent}`);
    try{await navigator.clipboard.writeText(partes.join('\n'));feedbackStatus.textContent='Relato copiado. Cole e envie pelo mesmo canal do convite; copiar não envia automaticamente.';}
    catch{feedbackStatus.textContent='Não consegui copiar. Selecione o texto do relato e envie pelo canal do convite.';feedbackText.focus();}
  });
  feedbackForm.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!feedbackReady){feedbackStatus.textContent='O envio pelo app ainda não está habilitado. Copie o relato e envie pelo canal do convite.';return;}
    if(!feedbackForm.reportValidity())return;
    const dados={chaveCliente:feedbackId,categoria:feedbackCategory.value,etapa:feedbackStage.value,relato:feedbackText.value.trim(),utilidade:feedbackUtility.value||null,contatoAutorizado:feedbackContact.checked};
    clearTimeout(draftTimer);feedbackSend.disabled=true;
    for(const field of feedbackForm.querySelectorAll('select,textarea,input'))field.disabled=true;
    feedbackStatus.textContent='Enviando…';
    let duravel=false;
    try{
      await saveChain.catch(()=>{});
      await persistirRascunho();duravel=true;
      const recibo=await api('/api/v3/central/feedback',dados);
      if(!/^[0-9a-f-]{36}$/i.test(String(recibo.id||''))||!Number.isFinite(Date.parse(recibo.recebidoEm)))throw new Error('A Central não confirmou o recebimento.');
      try{localStorage.removeItem(draftKey);}catch{}
      feedbackId=crypto.randomUUID();feedbackText.value='';feedbackUtility.value='';feedbackContact.checked=false;
      feedbackStatus.textContent=`Recebido em ${new Date(recibo.recebidoEm).toLocaleString('pt-BR')}. Protocolo ${recibo.id}.`;
    }catch(error){
      feedbackStatus.textContent=`Não recebido. ${duravel?'Seu rascunho ficou salvo no Lume.':'Mantenha esta tela aberta; o rascunho local não foi confirmado.'} ${error.message||'Tente novamente.'}`;
    }finally{
      for(const field of feedbackForm.querySelectorAll('select,textarea,input'))field.disabled=false;
      feedbackSend.disabled=false;
    }
  });
  window.carregarCentral = load;
})();

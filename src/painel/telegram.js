(() => {
  const request = (...args) => window.lumeConnectionRequest(...args);
  const box=element('section',null,'panel settings-card');
  box.setAttribute('aria-labelledby','telegram-hoje-title');
  box.innerHTML=`<p class="eyebrow">SUA CONVERSA COM O LUME</p>
    <h2 id="telegram-hoje-title">Telegram</h2>
    <p id="telegram-hoje-description">Envie <code>/hoje</code> numa conversa privada com seu bot para receber o resumo atual. O Lume responde enquanto estiver aberto neste computador.</p>
    <p id="telegram-hoje-status" role="status">Conferindo…</p>
    <div class="button-row"><a id="telegram-hoje-open" class="text-button" target="_blank" rel="noopener noreferrer" hidden>Abrir meu bot no Telegram →</a><button id="telegram-hoje-refresh" class="secondary" type="button">Atualizar estado</button></div>
    <details id="telegram-hoje-settings"><summary>Configurar meu bot e minha DM</summary>
    <p>Use o token do bot criado por você no BotFather e o ID numérico da sua DM com esse bot. O nome do bot abre a conversa, mas não substitui o ID de autorização.</p>
    <details><summary>O que sai deste computador</summary><p id="telegram-hoje-privacy">Contagens saem deste computador para o Telegram a cada pedido. Títulos só são enviados se você marcar essa opção. Mensagens de origem, valores e nomes das conversas ficam no aplicativo.</p></details>
    <form id="telegram-hoje-form">
      <label>Token do bot <input id="telegram-hoje-token" type="password" autocomplete="off" spellcheck="false" placeholder="Cole somente para ativar"></label>
      <label>ID numérico da sua conversa privada <input id="telegram-hoje-chat" inputmode="numeric" pattern="[1-9][0-9]*" autocomplete="off" required></label>
      <label>Nome do bot <input id="telegram-hoje-name" autocomplete="off" placeholder="ex.: MeuLumeBot"></label>
      <label class="check"><input id="telegram-hoje-titles" type="checkbox"><span>Incluir até três títulos de ações no resumo enviado</span></label>
      <label class="check"><input id="telegram-hoje-consent" type="checkbox" required><span id="telegram-hoje-consent-label">Autorizo o envio deste resumo ao Telegram quando eu pedir <code>/hoje</code>.</span></label>
      <div class="button-row"><button id="telegram-hoje-save" class="primary" type="submit" disabled>Ativar /hoje</button><button id="telegram-hoje-disable" class="secondary" type="button" disabled>Desativar e remover token</button></div>
    </form></details><button id="telegram-hoje-feedback" class="text-button" type="button">Preciso de ajuda com o Telegram</button>`;
  window.registrarAjuste(box,'telegram-hoje-panel','connections');
  const $=id=>box.querySelector('#'+id),status=$('telegram-hoje-status'),form=$('telegram-hoje-form');
  let loaded=false,pessoal=false,currentState=null,busy=false,refreshFlight=null,sequence=0,controller=null;
  const visible=()=>!document.hidden&&box.getClientRects().length>0;
  function controls(){
    const unavailable=currentState?.available===false||currentState?.secureStorageAvailable===false;
    $('telegram-hoje-save').disabled=busy||!currentState||unavailable||!$('telegram-hoje-consent').checked;
    $('telegram-hoje-disable').disabled=busy||!currentState?.enabled&&!currentState?.tokenConfigured;
    $('telegram-hoje-refresh').disabled=busy||Boolean(refreshFlight);
    form.querySelectorAll('input').forEach(input=>input.disabled=busy);
    box.setAttribute('aria-busy',String(busy));
  }
  function render(){
    const state=currentState;
    $('telegram-hoje-title').textContent=pessoal?'Conversar com o Lume pelo Telegram':'Consultar Hoje pelo Telegram';
    $('telegram-hoje-description').textContent=pessoal?'Converse com o assistente Lume na sua conversa privada com o bot. O comando /hoje continua disponível. O Lume responde enquanto estiver aberto neste computador.':'Envie /hoje numa conversa privada com seu bot para receber o resumo atual. O Lume responde enquanto estiver aberto neste computador.';
    $('telegram-hoje-privacy').textContent=pessoal?'Somente a DM com o identificador exato abaixo pode conversar com o Lume. O diálogo usa o ChatGPT conectado; recortes e resumos do WhatsApp dependem da autorização de cada conversa em Lume pessoal. Ativar o bot não libera envios a contatos.':'Contagens saem deste computador para o Telegram a cada pedido. Títulos só são enviados se você marcar essa opção. Mensagens de origem, valores e nomes das conversas ficam no aplicativo.';
    $('telegram-hoje-consent-label').textContent=pessoal?'Autorizo o diálogo com o assistente Lume nesta DM, processado pelo meu ChatGPT conectado, e o envio de resumos conforme as autorizações de cada conversa.':'Autorizo o envio deste resumo ao Telegram quando eu pedir /hoje.';
    $('telegram-hoje-save').textContent=state?.enabled?'Salvar configuração':pessoal?'Ativar nesta conversa privada':'Ativar /hoje';
    if(state)status.textContent=state.enabled?(state.running?(pessoal?'Bot ativo na DM autorizada. Confira a conexão ChatGPT em Lume pessoal.':'Ativo · responde a /hoje na DM autorizada.'):'Configurado · conexão ainda indisponível.')
      :state.available===false?'Disponível somente no aplicativo instalado.':state.secureStorageAvailable===false?'Proteção de credenciais indisponível neste computador.':'Desligado. Nenhuma conversa com o Telegram foi iniciada.';
    const username=String(state?.botUsername||'').replace(/^@/,'');
    const link=$('telegram-hoje-open');
    link.hidden=!state?.enabled||!/^[a-zA-Z0-9_]{5,32}$/.test(username);
    if(link.hidden)link.removeAttribute('href');else link.href='https://t.me/'+username;
    controls();
  }
  function refresh(){
    if(refreshFlight)return refreshFlight;
    const current=++sequence;controller=new AbortController();const signal=controller.signal;
    $('telegram-hoje-refresh').disabled=true;
    refreshFlight=(async()=>{try{
      const state=await request('/api/v3/telegram-hoje',undefined,{signal});
      if(current!==sequence)return;
      currentState=state;
      if(!loaded){$('telegram-hoje-chat').value=state.chatId||'';$('telegram-hoje-name').value=state.botUsername||'';$('telegram-hoje-titles').checked=state.shareTitles===true;$('telegram-hoje-settings').open=!state.enabled;loaded=true;}
      render();
    }catch(error){if(current===sequence)status.textContent=error.code==='CONNECTION_TIMEOUT'?error.message:'Não foi possível conferir o Telegram. Atualize o estado para tentar novamente.';}
    finally{if(current===sequence){refreshFlight=null;controller=null;controls();}}})();
    return refreshFlight;
  }
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!currentState||!$('telegram-hoje-consent').checked)return;
    busy=true;++sequence;controller?.abort();refreshFlight=null;controls();status.textContent='Salvando e conferindo o Telegram…';
    const secret=$('telegram-hoje-token').value;$('telegram-hoje-token').value='';
    try{
      const data={enabled:true,chatId:$('telegram-hoje-chat').value.trim(),botUsername:$('telegram-hoje-name').value.trim(),shareTitles:$('telegram-hoje-titles').checked};
      if(secret)data.token=secret;
      await request('/api/v3/telegram-hoje',data);$('telegram-hoje-consent').checked=false;await refresh();
    }catch(error){status.textContent=error.code==='CONNECTION_TIMEOUT'?error.message:'Não foi possível ativar o Telegram. Confira os dados do bot e da DM. O token precisa ser informado novamente.';}finally{busy=false;controls();}
  };
  $('telegram-hoje-disable').onclick=async()=>{
    if(busy)return;
    busy=true;++sequence;controller?.abort();refreshFlight=null;controls();status.textContent='Desativando o Telegram…';
    try{await request('/api/v3/telegram-hoje/desativar',{});$('telegram-hoje-consent').checked=false;await refresh();}
    catch(error){status.textContent=error.code==='CONNECTION_TIMEOUT'?error.message:'Não foi possível desativar. Atualize o estado para conferir.';}finally{busy=false;controls();}
  };
  $('telegram-hoje-consent').onchange=controls;
  $('telegram-hoje-refresh').onclick=()=>{if(!busy)void refresh();};
  $('telegram-hoje-feedback').onclick=()=>{void window.abrirFeedbackLume?.('conexao');};
  document.addEventListener('lume:pessoal-estado',event=>{
    const next=event.detail?.enabled===true;
    if(next!==pessoal)$('telegram-hoje-consent').checked=false;
    pessoal=next;render();
  });
  let wasVisible=false;
  function visibilityChanged(){const now=visible();if(now&&!wasVisible&&!busy)void refresh();wasVisible=now;}
  document.addEventListener('visibilitychange',visibilityChanged);
  const observer=new MutationObserver(visibilityChanged);
  for(let ancestor=box;ancestor;ancestor=ancestor.parentElement)observer.observe(ancestor,{attributes:true,attributeFilter:['hidden','class']});
  window.carregarTelegram=()=>visible()&&!busy?refresh():Promise.resolve();
  visibilityChanged();
})();

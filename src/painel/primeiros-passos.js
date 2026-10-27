// Guided first use over the user's available sources.
(() => {
  const guide=$('first-use');
  let connected=false,messageCount=0,organizationReady=false,lastModelCheck=0,modelChecking=null;
  const readiness=element('section',null,'first-readiness');readiness.id='first-readiness';readiness.setAttribute('aria-label','Preparação para organizar conversas');
  const title=element('h3','Disponível neste computador'),meter=element('progress');meter.id='first-ready-progress';meter.max=3;meter.value=1;meter.setAttribute('aria-label','Etapas verificadas para organizar conversas');
  const count=element('small','1 de 3 etapas verificadas');count.id='first-ready-count';
  const motor=element('p');motor.append(element('b','Organização · '));const motorState=element('span','Conferindo a organização das conversas…');motorState.id='first-organization-state';motorState.setAttribute('role','status');motor.append(motorState);
  const organizationHelp=element('p','Busca e histórico ficam neste computador. A organização automática usa recortes das conversas autorizadas na sua conta ChatGPT.','muted');
  const assistant=element('div',null,'first-assistant');assistant.append(element('p','Assistente externo: opcional. O Lume pode funcionar sem conta Claude, Codex ou AGY.'));
  const assistantButton=element('button','Ver conexão com ChatGPT','text-button');assistantButton.type='button';assistantButton.id='first-assistant';assistant.append(assistantButton);
  const promptBox=element('details',null,'first-assistant-prompt');promptBox.append(element('summary','Apresentar o Lume ao meu assistente'));
  promptBox.append(element('p','Copie este contexto para Claude Code, Codex ou AGY. Ele explica como usar o Lume; não instala acesso às suas conversas.','muted'));
  const prompt=element('textarea');prompt.id='first-assistant-prompt-text';prompt.readOnly=true;prompt.rows=8;prompt.setAttribute('aria-label','Contexto do Lume para copiar');
  prompt.value=[
    'Estou usando o Lume, um aplicativo local que guarda conversas autorizadas do meu WhatsApp neste computador e me ajuda a conferir próximos passos com a mensagem de origem.',
    'A organização automática usa minha conta ChatGPT somente nas conversas autorizadas e após avaliação de qualidade. Busca e histórico são locais. Sugestões trazem a mensagem de origem e podem ser corrigidas; não comprovam envio, conclusão ou aceite.',
    'Ajude-me a interpretar fontes que eu trouxer. Separe pedido, promessa, hipótese, aceite, pagamento e conclusão. Não invente responsáveis, prazos ou valores. Indique quando falta contexto.',
    'Este texto não conecta você ao Lume nem autoriza acesso ao WhatsApp, arquivos, repositórios ou credenciais. Se eu quiser integrar ferramentas, oriente-me a usar Ajustes no Lume e peça uma raiz de projeto e permissão de leitura específicas antes de consultar arquivos.',
    'Não envie mensagens, altere negociações nem configure serviços pagos sem minha autorização específica.'
  ].join('\n\n');
  const copyPrompt=element('button','Copiar contexto','secondary');copyPrompt.type='button';copyPrompt.id='first-assistant-prompt-copy';
  copyPrompt.onclick=async()=>{try{await navigator.clipboard.writeText(prompt.value);feedback('Contexto copiado. Cole no assistente que você usa.');}catch{prompt.focus();prompt.select();feedback('Selecione e copie o texto para seu assistente.');}};
  promptBox.append(prompt,copyPrompt);
  const optionalAssistant=element('details',null,'first-optional-assistant');
  optionalAssistant.append(element('summary','Usar com meu assistente · opcional'),assistant,promptBox);
  const organizationButton=element('button','Conferir organização','text-button');organizationButton.type='button';organizationButton.id='first-organization';organizationButton.onclick=()=>window.LumeUm?.central?.();
  readiness.append(title,meter,count,motor,organizationHelp,organizationButton,optionalAssistant);guide.querySelector('.first-focus-choices').before(readiness);
  function atualizarProgresso(){const value=1+Number(connected&&messageCount>0)+Number(organizationReady);meter.value=value;count.textContent=`${value} de 3 etapas verificadas`;readiness.dataset.ready=String(value===3);}
  async function conferirMotorLocal(force=false){
    if(modelChecking)return modelChecking;
    if(!force&&Date.now()-lastModelCheck<15000)return;
    lastModelCheck=Date.now();
    modelChecking=(async()=>{
      try{
        const [central,pessoal]=await Promise.all([api('/api/v3/lume-1/central'),api('/api/v3/pessoal')]);
        const state=central.organizacao,account=pessoal.chatgpt||{};
        const accountReady=account.connected===true&&account.planEnabled===true&&account.paused!==true&&Boolean(account.model);
        organizationReady=Boolean(state&&accountReady&&!state.limitacao&&['aguardando','processando'].includes(state.estado));
        motorState.textContent=!account.connected?'Conecte sua conta ChatGPT para organizar conversas autorizadas. A busca local continua disponível.':account.planEnabled!==true?'Confira o acesso pelo plano da sua conta ChatGPT. A busca local continua disponível.':account.paused===true?'A conta ChatGPT está pausada. Confira a conexão antes de retomar.':!account.model?'Selecione um modelo na conexão com ChatGPT.':!state?'O estado da organização não está disponível.':state.limitacao==='avaliacao_pendente'?'A organização aguarda a avaliação de qualidade. A busca local continua disponível.':state.limitacao==='conta_indisponivel'?'A conta precisa ser conferida antes de retomar.':state.limitacao?'A organização precisa de atenção. Confira o motivo na central.':state.estado==='pausado'?'A organização está pausada. Você pode retomá-la na central.':state.estado==='processando'?'Organizando um recorte autorizado.':'Aguardando novas mensagens autorizadas.';
        organizationButton.textContent=accountReady?'Conferir organização':account.connected?'Conferir ChatGPT':'Conectar ChatGPT';
        organizationButton.onclick=()=>accountReady?window.LumeUm?.central?.():run(()=>window.abrirAjuste('pessoal-panel'),organizationButton);
      }catch{organizationReady=false;motorState.textContent='Não foi possível conferir a organização. Tente novamente; a memória salva continua disponível.';organizationButton.textContent='Tentar novamente';organizationButton.onclick=()=>conferirMotorLocal(true);}
      finally{atualizarProgresso();modelChecking=null;}
    })();return modelChecking;
  }
  window.atualizarMotorPrimeiroUso=()=>conferirMotorLocal(true);
  assistantButton.onclick=()=>run(()=>window.abrirAjuste('pessoal-panel'),assistantButton);
  $('first-search-form').onsubmit=e=>{e.preventDefault();run(async()=>{
    conversa='';$('clear-filter').hidden=true;$('search-context').textContent='Todas as conversas permitidas · busca textual local';
    $('search').value=$('first-search').value;$('local-search-mode').value='lexical';
    window.lumeSetMemoryMode?.('search');await show('memory');window.lumeSetMemoryMode?.('search');$('results').tabIndex=-1;$('results').setAttribute('role','region');$('results').setAttribute('aria-label','Resultados da busca');$('results').focus();$('results').scrollIntoView({block:'start'});feedback('Confira a mensagem de origem. Use “Criar nota vinculada” para guardar o próximo passo.');
  },e.submitter);};
  $('first-connect').onclick=()=>{pairing();run(status);};
  $('first-hide').onclick=()=>run(async()=>{perfil=await api('/api/v3/guia',{dispensado:true});guide.hidden=true;feedback('Você pode reabrir os primeiros passos em Ajustes.');},$('first-hide'));
  $('guide-reopen').onclick=()=>run(async()=>{perfil=await api('/api/v3/guia',{dispensado:false});await show('today');guide.hidden=false;await conferirMotorLocal(true);guide.scrollIntoView({block:'start'});$('first-use-heading').focus();},$('guide-reopen'));
  $('guide-ai').onclick=()=>run(()=>window.abrirAjuste('settings-ai'));
  $('guide-pessoal').onclick=()=>run(()=>window.abrirAjuste('pessoal-panel'),$('guide-pessoal'));
  window.atualizarPrimeirosPassos=({conectada,mensagens}={})=>{
    guide.hidden=Boolean(perfil?.guiaDispensado);
    if(typeof conectada==='boolean'){
      connected=conectada;
      $('first-connection').textContent=conectada?messageCount?'WhatsApp conectado · mensagens salvas':'WhatsApp conectado · aguardando mensagens':'WhatsApp ainda não conectado';
      $('first-connect').hidden=conectada;
    }
    if(typeof mensagens==='number'){
      messageCount=mensagens;
      $('first-history').textContent=mensagens?`${number(mensagens)} ${mensagens===1?'mensagem pronta':'mensagens prontas'} para consultar.`:'As primeiras mensagens aparecerão aqui.';
      if(connected)$('first-connection').textContent=mensagens?'WhatsApp conectado · mensagens salvas':'WhatsApp conectado · aguardando mensagens';
    }
    atualizarProgresso();
    if(!guide.hidden)void conferirMotorLocal();
  };
  document.querySelectorAll('[data-phone]').forEach(button=>button.onclick=()=>{
    document.querySelectorAll('[data-phone]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    $('phone-instructions').textContent=button.dataset.phone==='iphone'
      ?'No iPhone: abra o WhatsApp → Ajustes → Aparelhos conectados → Conectar um aparelho.'
      :'No Android: abra o WhatsApp → menu ⋮ → Aparelhos conectados → Conectar um aparelho.';
  });
  $('read-terms').onclick=()=>{const target=$('terms-full');target.replaceChildren(document.querySelector('.privacy-copy').cloneNode(true));$('terms-dialog').showModal();};
  $('terms-close').onclick=()=>$('terms-dialog').close();
})();

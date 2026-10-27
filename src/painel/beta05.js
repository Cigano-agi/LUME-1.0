/* The daily desk is a view of authorized, persisted sources. No invented activity. */
(() => {
  let revision = 0, signature = '', snapshot, practiceDraft, pending;
  const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100);
  const node = (tag, text, cls) => element(tag, text, cls);
  // Put actionable work before secondary exploration. Keep original controls/IDs.
  const actions = $('today').querySelector('.content-grid');
  $('clarity-coverage').after(actions);
  const archiveDetails = $('today').querySelector('.clarity-history-details');
  archiveDetails.querySelector('summary').textContent = 'Mais detalhes: contatos marcados e mensagens';
  for (const section of [$('negocios-today'), $('today').querySelector('.recent-panel')].filter(Boolean)) archiveDetails.append(section);
  $('today').append(archiveDetails);
  const brand = document.querySelector('.workspace .sidebar .brand');
  brand.querySelector('.beta05-label')?.remove();
  $('settings-about').querySelector('h2').textContent = 'Sobre o Lume';
  const pairingHelp = $('settings-whatsapp')?.querySelector('.connection-pairing-role');
  if (pairingHelp) {
    const details = node('details'); details.append(node('summary', 'Como conectar pelo celular'));
    pairingHelp.replaceWith(details); details.append(pairingHelp);
  }
  const laya = node('details', null, 'clarity-local-helper');
  laya.id = 'clarity-local-helper';
  laya.append(node('summary', 'Avaliação local do Laya'));
  const layaForm = node('form'), layaLabel = node('label', 'Um trecho para testar a execução'), layaText = node('textarea'), layaButton = node('button', 'Testar execução local', 'secondary'), layaStatus = node('p', 'Conferindo o modelo local…', 'clarity-disclosure'), layaResult = node('p', '', 'clarity-helper-result');
  layaText.id = 'clarity-local-text'; layaText.maxLength = 1000; layaText.rows = 3; layaText.required = true;
  layaText.placeholder = 'Ex.: Pode separar os documentos para a nossa conversa?';
  layaLabel.htmlFor = layaText.id; layaButton.type = 'submit'; layaButton.disabled = true;
  layaResult.setAttribute('role', 'status'); layaResult.id = 'clarity-local-result';
  layaForm.append(layaLabel, layaText, layaButton);
  laya.append(node('p', 'O modelo ainda não atingiu a qualidade necessária em português. Resultados não são usados para organizar seu dia. O trecho fica neste computador; nenhuma tarefa é criada e nenhuma mensagem é enviada.'), layaStatus, layaForm, layaResult);
  $('clarity-content').append(laya);
  let layaRefresh = null;
  async function conferirLayaExperimental() {
    if (layaRefresh) { clearTimeout(layaRefresh); layaRefresh = null; }
    if (!laya.open) return;
    try {
      const state = await api('/api/v3/laya');
      if (!laya.open) return;
      layaButton.disabled = state.instalado !== true || state.integridade !== 'verificada';
      layaStatus.textContent = !state.instalado
        ? 'O modelo local ainda não está disponível neste computador.'
        : state.integridade === 'falhou'
          ? 'Arquivos do Laya incompletos ou alterados. O teste local está indisponível.'
          : state.integridade === 'verificando'
            ? 'Conferindo os arquivos do Laya neste computador…'
            : state.integridade !== 'verificada'
              ? 'Laya detectado. A conferência dos arquivos ainda não terminou.'
              : 'Arquivos do Laya conferidos · sugestões bloqueadas. O primeiro teste pode levar mais tempo.';
      if (state.integridade === 'verificando') layaRefresh = setTimeout(() => void conferirLayaExperimental(), 1500);
    } catch {
      layaStatus.textContent = 'Não consegui conferir o auxiliar. Feche e abra esta seção para tentar novamente.';
      layaButton.disabled = true;
    }
  }
  laya.addEventListener('toggle', () => {
    if (layaRefresh) { clearTimeout(layaRefresh); layaRefresh = null; }
    if (laya.open) void conferirLayaExperimental();
  });
  layaForm.onsubmit = event => {
    event.preventDefault();
    run(async () => {
      const text = layaText.value.trim(); if (!text) return;
      const activeRevision = revisaoDadosVisiveis;
      layaButton.disabled = true; layaText.readOnly = true; layaResult.textContent = 'Analisando neste computador…'; layaForm.setAttribute('aria-busy', 'true');
      try {
        const result = await api('/api/v3/laya/classificar', {texto:text});
        if (activeRevision !== revisaoDadosVisiveis) return;
        // Even a stale/misconfigured adapter returning a category cannot turn this lab into advice.
        layaResult.textContent = 'Executou neste computador. Sugestões permanecem bloqueadas até melhorar a precisão.';
        window.lumeReveal?.(layaResult);
      } catch (error) { if (activeRevision === revisaoDadosVisiveis) layaResult.textContent = 'Não foi possível analisar agora. ' + error.message; }
      finally { layaForm.setAttribute('aria-busy', 'false'); layaText.readOnly = false; await conferirLayaExperimental(); }
    });
  };
  function focusMemory(target) {
    const candidates = [target,$('conversation-heading'),$('conversation-directory-title'),$('negocios-memory')?.querySelector('h2'),$('memory').querySelector('.page-heading h1')];
    const visible = candidates.find(item => item && item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden');
    if (!visible) return; visible.tabIndex = -1; visible.focus({preventScroll:true}); window.lumeScrollIntoView?.(visible, {block:'start'});
  }
  const openSource = async id => { await window.abrirFonteTarefa(id); focusMemory($('results')); };
  async function openMemory(mode) {
    conversa = ''; $('search').value = ''; $('clear-filter').hidden = true; $('search-context').textContent = 'Todas as conversas permitidas · busca textual local';
    window.lumeSetMemoryMode?.(mode); await show('memory'); window.lumeSetMemoryMode?.(mode);
    focusMemory();
  }
  function metric(value, label, detail) {
    const box = node('div', null, 'clarity-metric');
    box.append(node('dt', label), node('dd', value), node('small', detail)); return box;
  }
  function render(d) {
    snapshot = d;
    $('clarity-title').textContent = d.foco.titulo;
    $('clarity-description').textContent = d.foco.descricao;
    $('clarity-main-action').textContent = d.foco.fonteId ? 'Conferir e dar o próximo passo →' : 'Explorar minhas conversas →';
    $('clarity-main-action').onclick = () => run(() => d.foco.fonteId ? openSource(d.foco.fonteId) : openMemory('conversations'));
    $('clarity-metrics').replaceChildren(
      metric(number(d.prioridades.total), 'Próximos passos', 'Registrados para revisar'),
      metric(d.oportunidades.total ? (d.oportunidades.semValor === d.oportunidades.total ? 'A combinar' : money(d.oportunidades.valorCentavos)) : '—', 'Em negociação', d.oportunidades.total ? `${number(d.oportunidades.total)} negócios · valor potencial` : 'Seus negócios aparecerão aqui'),
      metric(number(d.conversas.total), 'Conversas salvas', 'Dentro da sua leitura permitida')
    );
    $('clarity-coverage').textContent = d.cobertura.aviso + (d.cobertura.ultimaMensagemEm ? ' Última mensagem: ' + date(d.cobertura.ultimaMensagemEm) + '.' : '');
    $('clarity-coverage').dataset.state = d.cobertura.estado;
    const opportunities = $('clarity-opportunities'); opportunities.replaceChildren();
    if (!d.oportunidades.itens.length) opportunities.append(node('p', 'Ao encontrar uma proposta, abra a mensagem e escolha “Acompanhar negócio”. Você registra o valor e quando retomar.', 'clarity-empty'));
    for (const item of d.oportunidades.itens) {
      const row = node('article', null, 'clarity-deal');
      const detail = node('div'); detail.append(node('h3', item.titulo), node('p', `${item.conversaNome} · ${item.etapaNome}`));
      const amount = node('div', null, 'clarity-deal-amount'); amount.append(node('strong', item.valorCentavos == null ? 'Sem valor' : money(item.valorCentavos)), action('Rever negócio →', () => window.abrirNegocio(item.fonteId)));
      row.append(detail, amount); opportunities.append(row);
    }
    $('clarity-money-disclosure').textContent = d.oportunidades.aviso + (d.oportunidades.semValor ? ` ${number(d.oportunidades.semValor)} sem valor informado.` : '');
    const review = $('clarity-review'); review.hidden = !d.oportunidades.totalRevisoes;
    review.textContent = `${number(d.oportunidades.totalRevisoes)} ${d.oportunidades.totalRevisoes === 1 ? 'negócio precisa' : 'negócios precisam'} de conferência. Abra Negócios para rever as fontes.`;
    const practice = practiceDraft || d.pratica;
    $('clarity-practice-title').textContent = practice.titulo;
    $('clarity-practice-question').textContent = practice.pergunta;
    $('clarity-practice-help').textContent = practice.apoio;
    $('clarity-practice-source').hidden = !practice.fonteId;
    $('clarity-practice-source').onclick = () => run(() => openSource(practice.fonteId));
    const conversations = $('clarity-conversations'); conversations.replaceChildren();
    if (!d.conversas.itens.length) conversations.append(node('p', 'Suas conversas recentes aparecerão aqui depois de conectar o WhatsApp. Você também pode começar guardando uma nota.', 'clarity-empty'));
    for (const item of d.conversas.itens) {
      const row = node('article', null, 'clarity-conversation');
      const initial = node('span', (item.nome || '?').trim().slice(0, 1).toUpperCase(), 'clarity-person'); initial.setAttribute('aria-hidden', 'true');
      const content = node('div'); content.append(action(item.nome, async () => { await openConversation(item.id, item.nome); focusMemory(); }, 'clarity-conversation-title'), node('p', item.trecho || 'Mensagem sem texto.'), node('time', date(item.ultimaMensagemEm)));
      row.append(initial, content); conversations.append(row);
    }
  }
  window.carregarClareza = () => {
    if(pending?.dataRevision===revisaoDadosVisiveis)return pending.promise;
    const current={dataRevision:revisaoDadosVisiveis};
    current.promise=loadClarity().finally(()=>{if(pending===current)pending=null;});
    pending=current;return current.promise;
  };
  const loadClarity = async () => {
    const request = ++revision, dataRevision = revisaoDadosVisiveis;
    try {
      const d = await api('/api/v3/clareza');
      if (request !== revision || dataRevision !== revisaoDadosVisiveis) return;
      const next = JSON.stringify({ ...d, geradoEm: null });
      if (next !== signature) { render(d); window.lumeChanged?.($('clarity-metrics'), next); signature = next; }
      $('clarity-error').hidden = true; $('clarity-content').hidden = false;
      return d;
    } catch {
      if (request !== revision || dataRevision !== revisaoDadosVisiveis) return;
      snapshot = null; signature = ''; $('clarity-content').hidden = true; $('clarity-error').hidden = false;
    }
  };
  window.limparClareza = () => { revision++; pending=null; signature = ''; snapshot = null; practiceDraft = null; layaForm.reset(); layaResult.textContent = ''; $('clarity-practice-form').reset(); $('clarity-practice-feedback').textContent = ''; $('clarity-content').hidden = true; };
  $('clarity-retry').onclick = () => run(window.carregarClareza);
  $('clarity-businesses').onclick = () => run(() => openMemory('businesses'));
  $('clarity-all-conversations').onclick = () => run(() => openMemory('conversations'));
  $('clarity-add-note').onclick = () => $('quick-note').click();
  $('clarity-practice-text').addEventListener('input', () => { if (!practiceDraft && snapshot) practiceDraft = { ...snapshot.pratica }; });
  $('clarity-practice-form').onsubmit = event => {
    event.preventDefault();
    run(async () => {
      const text = $('clarity-practice-text').value.trim(); if (!text) return;
      if (!snapshot) throw new Error('Atualize o resumo antes de guardar esta reflexão.');
      const context = practiceDraft || snapshot.pratica;
      // Revalidate the source at save time. The note uses the existing deletion/ACL contract.
      const sources = context.fonteId ? [context.fonteId] : [];
      await api('/api/v3/nota', { titulo: 'Minha revisão · ' + new Date().toLocaleDateString('pt-BR'), texto: context.pergunta + '\n\n' + text, fontes: sources });
      $('clarity-practice-form').reset(); practiceDraft = null; signature = ''; $('clarity-practice-feedback').textContent = 'Reflexão guardada. Um aprendizado para levar ao próximo atendimento.';
      window.lumeSound?.('success'); window.lumeReveal?.($('clarity-practice-feedback'));
      feedback('Reflexão guardada na sua memória.'); await overview();
    }, event.submitter);
  };
  const observer = new MutationObserver(() => {
    if (!$('onboarding').hidden) window.lumeReveal?.($('terms-step').hidden ? $('connect-step') : $('terms-step'));
  });
  observer.observe($('onboarding'), { attributes: true, attributeFilter: ['hidden'] });
})();

// Keep Hoje honest across the independent connection, saved-message and analysis APIs.
(() => {
  const pipeline = document.createElement('section');
  pipeline.id = 'today-pipeline';
  pipeline.className = 'today-pipeline';
  pipeline.setAttribute('aria-labelledby', 'today-pipeline-title');
  pipeline.innerHTML = '<div class="today-pipeline-heading"><div><p class="eyebrow">ACOMPANHAMENTO</p><h2 id="today-pipeline-title">Seu contexto hoje</h2></div><button type="button" class="text-button" data-pipeline-retry>Conferir estados novamente</button></div><div class="today-pipeline-grid"><article data-pipeline="connection"><h3>Conexão</h3><p>Conferindo…</p><span></span></article><article data-pipeline="messages"><h3>Mensagens salvas</h3><p>Conferindo…</p><span></span></article><article data-pipeline="analysis"><h3>Análise</h3><p>Conferindo…</p><span></span></article></div><p class="today-pipeline-live" role="status" aria-live="polite"></p>';
  $('home-status').after(pipeline);
  let generation = 0, lastAnnouncement = '';
  const cell = name => pipeline.querySelector(`[data-pipeline="${name}"]`);
  const set = (name, title, detail, state) => {
    const item = cell(name);
    const label = item.querySelector('p'), description = item.querySelector('span');
    if (item.dataset.state === state && label.textContent === title && description.textContent === detail) return;
    item.dataset.state = state;
    label.textContent = title;
    description.textContent = detail;
    const existing = item.querySelector('[data-pipeline-retry-dimension]');
    if (state === 'error' && !existing) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button';
      button.dataset.pipelineRetryDimension = ''; button.textContent = `Tentar novamente · ${name === 'analysis' ? 'análise' : name === 'messages' ? 'mensagens' : 'conexão'}`;
      button.onclick = retry; item.append(button);
    } else if (state !== 'error' && existing) {
      if (existing === document.activeElement) pipeline.querySelector('[data-pipeline-retry]').focus({preventScroll:true});
      existing.remove();
    }
  };
  const retry = () => window.carregarAcoes06?.();
  pipeline.querySelector('[data-pipeline-retry]').onclick = retry;
  const carregar = async () => {
    const current = ++generation, dataRevision = revisaoDadosVisiveis;
    // A first route can still be painting its independent action list; let that
    // request finish before this status becomes the user's first visible read.
    const waitStarted = Date.now();
    while ($('tasks').getAttribute('aria-busy') === 'true' && Date.now() - waitStarted < 4000) {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (current !== generation || dataRevision !== revisaoDadosVisiveis) return;
    }
    const requests = await Promise.allSettled([
      api('/api/estado'), api('/api/v3/resumo'), api('/api/v3/acoes/analise')
    ]);
    if (current !== generation || dataRevision !== revisaoDadosVisiveis) return;
    const [connection, messages, analysis] = requests;
    if (connection.status === 'fulfilled') {
      const state = connection.value?.conexao?.estado;
      if (state === 'conectada') set('connection','WhatsApp conectado','A conexão ativa não comprova captura completa do histórico.','ready');
      else if (['conectando','reconectando','aguardando_qr'].includes(state)) set('connection','WhatsApp conectando','Acompanhe o pareamento em Ajustes.','working');
      else if (['desconectada','erro','falha','auth_invalida','substituida'].includes(state)) set('connection','WhatsApp desconectado','Conecte para receber novas mensagens.','off');
      else set('connection','Não foi possível consultar a conexão','O estado atual não está disponível. Tente novamente.','error');
    } else set('connection','Não foi possível consultar a conexão','Tente novamente para conferir o estado atual.','error');
    if (messages.status === 'fulfilled') {
      const count = messages.value?.mensagensWhatsapp;
      const countLabel = Number.isSafeInteger(count) && count >= 0 ? `${new Intl.NumberFormat('pt-BR').format(count)} ${count === 1 ? 'mensagem do WhatsApp permitida salva' : 'mensagens do WhatsApp permitidas salvas'}.` : 'Quantidade de mensagens do WhatsApp indisponível.';
      set('messages',countLabel,'Cobertura do histórico anterior desconhecida. A captura integral ainda não foi comprovada.','ready');
    } else set('messages','Não foi possível consultar as mensagens salvas','A cobertura do histórico continua desconhecida. Tente novamente.','error');
    if (analysis.status === 'fulfilled') {
      const a = analysis.value || {}, keys = ['pendentes','analisando','aguardandoModelo','aguardandoValidacao','erros'];
      const valid = keys.every(key => Number.isSafeInteger(a[key]) && a[key] >= 0);
      if (a.disponivel === false) set('analysis','Análise local indisponível','O serviço de análise não está ativo neste aplicativo. Nenhuma conclusão foi inferida.','off');
      else if (!valid) set('analysis','Não foi possível consultar a análise','A fila atual é desconhecida. Tente novamente.','error');
      else {
        const waiting = a.pendentes + a.analisando, blocked = a.aguardandoModelo + a.aguardandoValidacao + a.erros;
        const waitingLabel = `${new Intl.NumberFormat('pt-BR').format(waiting)} ${waiting === 1 ? 'mensagem na fila' : 'mensagens na fila'}`;
        const other = [['aguardandoModelo','aguardando o modelo'],['aguardandoValidacao','aguardando validação'],['erros','com erro']]
          .filter(([key]) => Number(a[key]) > 0).map(([key,label]) => `${a[key]} ${label}`);
        const title = waiting ? waitingLabel : blocked ? `${blocked} ${blocked === 1 ? 'item aguarda atenção na análise' : 'itens aguardam atenção na análise'}` : 'Nenhuma análise pendente agora';
        const detail = `${other.length ? other.join(' · ') + '. ' : ''}${waiting || blocked ? 'Há trabalho local sem conclusão; a contagem não confirma sugestões revisadas.' : 'Fila vazia não confirma que todo o histórico foi analisado.'}`;
        set('analysis',title,detail,blocked ? 'working' : 'ready');
      }
    } else set('analysis','Não foi possível consultar a análise','A fila atual é desconhecida. Tente novamente.','error');
    const disconnected = connection.status === 'fulfilled' && ['desconectada','erro','falha','auth_invalida','substituida'].includes(connection.value?.conexao?.estado);
    const action = pipeline.querySelector('[data-pipeline-connect]');
    if (disconnected && !action) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary today-pipeline-connect'; button.dataset.pipelineConnect = '';
      button.textContent = 'Conectar WhatsApp'; button.onclick = () => window.abrirAjuste?.('settings-whatsapp');
      pipeline.append(button);
    } else if (!disconnected) action?.remove();
    const announcement = ['connection','messages','analysis'].map(name => cell(name).querySelector('p').textContent).join(' · ');
    if (announcement !== lastAnnouncement) {
      pipeline.querySelector('.today-pipeline-live').textContent = announcement;
      lastAnnouncement = announcement;
    }
  };
  if (typeof window.carregarAcoes06 === 'function') {
    const carregarAcoesOriginal = window.carregarAcoes06;
    window.carregarAcoes06 = async options => {
      const update = options?.automatico && pipeline.contains(document.activeElement) ? Promise.resolve() : carregar();
      const results = await Promise.allSettled([carregarAcoesOriginal(options), update]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      return results[0].value;
    };
  }
  const clear = window.limparDadosVisiveis;
  if (clear) window.limparDadosVisiveis = (...args) => {
    generation++;
    for (const name of ['connection','messages','analysis']) set(name,'Conferindo novamente…','Os dados visíveis foram alterados. Aguardando a fonte local.','loading');
    pipeline.querySelector('[data-pipeline-connect]')?.remove();
    lastAnnouncement = '';
    const result = clear(...args);
    void carregar();
    return result;
  };
})();

/* Beta 0.6: the same app, with a readable route for each kind of work. */
(() => {
  const workspace=$('workspace'),nav=workspace.querySelector('.sidebar nav');
  nav.id='primary-navigation';
  const descriptions={
    contacts:['PESSOAS','Quem está na conversa.','Encontre uma pessoa e retome o contexto que vocês já têm.'],
    businesses:['VENDAS','Boas conversas, próximos negócios.','Acompanhe o pipeline. Interesse avaliado não é previsão de venda.'],
    projects:['PROJETOS','O que vocês estão construindo.','Contexto e combinados reunidos por projeto.'],
    conversations:['CONVERSAS','Toda conversa tem um fio.','Encontre o contexto. Confira o que ficou combinado.'],
    search:['CONVERSAS','Encontre aquele detalhe.','Busque um nome, um assunto ou as palavras que você lembra.'],
    ask:['CONVERSAS','Comece por uma boa pergunta.','Consulte o contexto e confira as mensagens usadas.'],
    commands:['CONVERSAS','O que ficou registrado.','Itens organizados a partir das suas conversas.']
  };
  window.lumeSyncNavigation=()=>{
    const mode=$('memory').dataset.mode||'conversations';
    for(const button of nav.querySelectorAll('button')){
      const active=page==='memory'
        ? (button.dataset.route?button.dataset.route===mode:button.dataset.view==='memory'&&!['contacts','businesses','projects'].includes(mode))
        : button.dataset.view===page;
      button.classList.toggle('active',active);
      if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    }
    if(page==='memory'){
      const copy=descriptions[mode]||descriptions.conversations,heading=$('memory').querySelector('.page-heading');
      heading.querySelector('.eyebrow').textContent=copy[0];heading.querySelector('h1').textContent=copy[1];heading.querySelector('p:last-child').textContent=copy[2];
      $('current-page').textContent=mode==='contacts'?'Pessoas':mode==='businesses'?'Vendas':mode==='projects'?'Projetos':'Conversas';
      if(mode==='contacts')$('contact-directory').open=true;
    }
  };
  for(const button of nav.querySelectorAll('[data-route]'))button.onclick=()=>run(async()=>{
    conversa='';$('search').value='';$('clear-filter').hidden=true;
    window.lumeSetMemoryMode(button.dataset.route);
    window.scrollTo({top:0,behavior:'instant'});
    await show('memory',{focarTitulo:true});
  },button);
  nav.querySelector('[data-view=memory]').addEventListener('click',()=>window.scrollTo({top:0,behavior:'instant'}));
  window.lumeSyncNavigation();
  $('today').querySelector('.page-heading>div>p:last-child').textContent='Retome o combinado. Cuide do próximo passo.';
  // Reuse the existing feedback flow in the daily heading, even after first use.
  const feedbackShortcut=$('today').querySelector('.today-heading>.central-feedback-shortcut');
  if(feedbackShortcut){feedbackShortcut.textContent='Como foi usar o Lume?';feedbackShortcut.classList.add('desk-feedback');}
  $('first-use-heading').textContent='Comece por uma conversa.';
  $('first-use-heading').nextElementSibling.textContent='Conecte o WhatsApp para reunir seu contexto. Você também pode explorar ou guardar uma nota.';
  $('memory-mode-businesses').querySelector('b').textContent='Vendas';

  // A useful search lives at the top of the desk; original IDs keep the same
  // local search contract. No hidden query, generated metrics or sample data.
  const quick=$('quick-find-form'),quickShell=element('div',null,'desk-find');
  quick.querySelector('label').textContent='Puxe o fio de uma conversa';
  $('quick-find').placeholder='Pessoa, assunto ou combinado…';
  quickShell.append(quick,action('+ Anotar',()=>$('quick-note').click(),'secondary desk-note'));
  $('first-use').after(quickShell);
  const archive=$('today').querySelector('.clarity-history-details');
  archive.querySelector('summary').textContent='Conferir histórico e números';
  archive.prepend($('clarity-metrics'));
  archive.prepend(archive.querySelector('summary'));
  // Keep source coverage visible, and move the secondary reflection below the
  // recent conversations so the first screen is about the next useful action.
  const columns=$('clarity-content').querySelector('.clarity-columns');
  const recent=$('clarity-content').querySelector('.clarity-conversations-section');
  if(columns&&recent)recent.after(columns);
  $('clarity-businesses').textContent='Ver vendas →';
  $('negocios-memory').querySelector('h2').textContent='Seu pipeline';
  const ghost=$('clarity-content').querySelector('.clarity-illustration');
  if(ghost){const art=ghost.cloneNode(true);art.classList.add('desk-companion');$('luminus-banner')?.append(art);}
  const process=element('ol',null,'desk-process');process.setAttribute('aria-label','Da conversa ao resultado');
  for(const [i,label]of ['Conversa','Combinado','Resolver com','Resultado'].entries()){
    const item=element('li');item.append(element('span',String(i+1)),element('b',label));process.append(item);
  }
  $('luminus-banner')?.prepend(process);

  // Native dialogs retain Escape and focus trapping. Add a brief, cancelable
  // entrance using the installed Motion spring; no wheel/scroll interception.
  const watchDialog=dialog=>new MutationObserver(()=>{
    if(!dialog.open||window.lumeReducedMotion?.())return;
    window.lumeSpringReveal?.(dialog,{from:28});
  }).observe(dialog,{attributes:true,attributeFilter:['open']});
  document.querySelectorAll('dialog').forEach(watchDialog);
  workspace.classList.add('desk06');
})();

/* Projeção somente de leitura. As ações continuam nos fluxos autorizados existentes. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const categories = {comercial: 'Vendas', entregas: 'Entregas', projetos: 'Projetos', combinados: 'Combinados', pessoas: 'Pessoas', memoria: 'Memória'};
  const states = {pendente: 'Pendente', em_andamento: 'Em andamento', executando: 'Em execução', aguardando_assistente: 'Aguardando executor', resultado_informado: 'Resultado informado · falta conferir', invalidada: 'Contexto alterado · confira', expirada: 'Autorização expirada', indisponivel: 'Indisponível', concluida: 'Conclusão informada', concluido: 'Conclusão informada', informado: 'Informado', verificado: 'Verificado', verificada: 'Verificado', enviado: 'Enviado', aceita: 'Aceito', aceito: 'Aceito', aguardando: 'Aguardando', revogada: 'Autorização revogada', falhou: 'Falhou', cancelada: 'Cancelada'};
  const connectionLabels = {conectada: 'conectada', desconectada: 'desconectada', conectando: 'conectando', indisponivel: 'indisponível', disponivel: 'disponível', pausada: 'pausada', em_andamento: 'em andamento', sem_execucao_observada: 'nenhum processamento em andamento observado'};
  const origins = {informado: 'Informado', corrigido: 'Corrigido por você', sugerido: 'Inferido · confira a fonte', confirmado: 'Confirmado'};
  const salesStages = {interesse: 'Interesse', proposta: 'Proposta', conversa: 'Conversa em andamento', fechado: 'Fechado', encerrado: 'Encerrado', insuficiente: 'Informação insuficiente'};
  const interests = {frio: 'frio', morno: 'morno', quente: 'quente', insuficiente: 'informação insuficiente'};
  const genericConsequences = new Set(['Confira o resultado e os registros deste assunto.', 'Acompanhe o andamento e a próxima verificação.', 'Confira o contexto para decidir o próximo passo.']);
  const aliases = {hoje: 'today', agora: 'today', comercial: 'sales', vendas: 'sales', entregas: 'deliveries', projetos: 'deliveries', memoria: 'memory', pessoas: 'contacts', relacoes: 'graph'};
  const pages = new Map();
  let revision = 0, pageController, detailController, detailRevision = 0, drawer, returnFocus, scrollSnapshot;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  };
  const shortText=(text,limit)=>String(text||'').length>limit?String(text).slice(0,limit).replace(/\s+\S*$/,'')+'…':String(text||'');
  const button = (label, handler, cls = 'lv-button') => {
    const node = el('button', label, cls); node.type = 'button';
    node.addEventListener('click', () => { Promise.resolve().then(handler).catch(error => {
      if (node.isConnected) node.after(el('p', error.message || 'Não foi possível abrir este destino.', 'lv-error'));
    }); });
    return node;
  };
  const date = value => {
    if (!value) return 'Data não informada';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('pt-BR');
  };
  const request = (path, signal) => {
    if (typeof window.lumeConnectionRequest !== 'function') return Promise.reject(new Error('A conexão local ainda não está disponível.'));
    return window.lumeConnectionRequest(path, undefined, {timeout: 15000, signal});
  };
  const denied = error => [401, 403, 404, 410].includes(error.status) || ['SOURCE_CHANGED', 'FORBIDDEN', 'SOURCE_UNAVAILABLE'].includes(error.code);
  function envelope(data) {
    if (data?.versao !== 1 || !Array.isArray(data.itens)) throw new Error('Não foi possível ler a resposta do Lume. Atualize e tente novamente.');
    const seen = new Set();
    for (const item of data.itens) {
      if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new Error('A lista recebida tem uma identidade inválida. Atualize para conferir.');
      seen.add(item.id);
    }
    return data;
  }
  function go(view) { return window.navegarLume?.(view); }
  function notice(text, cls = 'lv-status') { const node = el('p', text, cls); node.setAttribute('role', cls === 'lv-error' ? 'alert' : 'status'); return node; }
  function gaps(values, target) {
    if (!Array.isArray(values)) return;
    for (const value of values) if (typeof value === 'string') target.append(el('p', value, 'lv-status'));
  }
  function clearCards() {
    for (const root of pages.values()) { root.replaceChildren(); root.setAttribute('aria-busy', 'false'); }
  }
  function errorBox(target, error, retry) {
    target.replaceChildren(notice(denied(error) ? 'Este conteúdo não está disponível com a permissão atual. Confira as fontes e os limites em Pessoas.' : (error.message || 'Não foi possível carregar agora.'), 'lv-error'));
    target.append(button('Tentar novamente', retry));
  }
  function rootFor(view) {
    const section = $(view);
    if (!section) return null;
    let root = pages.get(view);
    if (!root?.isConnected) {
      section.querySelector(':scope > .lv-page-heading')?.remove();
      root = el('div', null, 'lv-page'); root.id = 'lv-' + view; root.dataset.view = view;
      const firstUse = view === 'today' && $('first-use');
      if (firstUse) firstUse.after(root); else section.prepend(root);
      pages.set(view, root);
    }
    return root;
  }
  function sourceId(source) { return source?.eventoId ?? source?.evento_id; }
  function sourceText(source) {
    if (!source) return 'Fonte não disponível';
    return [source.autor, source.conversa, source.recebidoEm ? date(source.recebidoEm) : null, source.tipo].filter(Boolean).join(' · ') || 'Conferir fonte original';
  }
  function commercialContext(item) {
    const context = el('div', null, 'lv-commercial-context');
    const confirmed = el('p', item.negocio?.etapa ? 'Etapa confirmada: ' + (salesStages[item.negocio.etapa] || 'Não disponível') : 'Etapa confirmada: sem registro', 'lv-commercial-fact');
    confirmed.dataset.evidence = item.negocio?.etapa ? 'confirmed' : 'missing';
    context.append(confirmed);
    if (item.avaliacao) {
      const manual = item.avaliacao.origem === 'manual';
      const assessment = el('div', null, 'lv-commercial-assessment');
      assessment.dataset.evidence = manual ? 'manual' : 'inferred';
      assessment.append(el('strong', manual ? 'Avaliação registrada por você' : 'Avaliação inferida · confira'),
        el('p', 'Etapa avaliada: ' + (salesStages[item.avaliacao.etapa] || 'Informação insuficiente')),
        el('p', 'Interesse: ' + (interests[item.avaliacao.temperatura] || 'informação insuficiente')));
      context.append(assessment);
    } else context.append(el('p', 'Avaliação comercial indisponível.', 'lv-card-meta'));
    return context;
  }
  function card(item) {
    const node = el('article', null, 'lv-card'); node.dataset.assuntoId = item.id;
    node.dataset.enter = 'true';
    if (item.grupo === 'precisa') node.dataset.decision = 'true';
    node.dataset.category = categories[item.categoria] ? item.categoria : 'memoria';
    const meta = el('div', null, 'lv-card-meta');
    const category = el('span', null, 'lv-category'), icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    icon.setAttribute('class', 'lv-icon'); icon.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', '/lume-vivo-icons.svg#lv-' + (node.dataset.category === 'projetos' ? 'entregas' : node.dataset.category)); icon.append(use);
    category.append(icon, el('span', categories[item.categoria] || 'Memória'));
    const state = el('span', item.estadoRotulo || states[item.estado] || item.estado || 'Estado não informado', 'lv-state'); state.dataset.state = item.estado;
    meta.append(category, state);
    const title = el('h3', null, 'lv-card-title');
    const open = button(shortText(item.assunto,96) || 'Assunto sem título', () => abrirAssunto(item.id));
    open.setAttribute('aria-label', 'Abrir assunto: ' + (item.assunto || 'Assunto sem título'));
    open.dataset.variant = 'quiet';
    title.append(open);
    node.append(meta, title);
    const people = (item.pessoas || []).map(p => typeof p === 'string' ? p : p.nome).filter(Boolean);
    if (item.acontecimento) node.append(el('p', item.acontecimento.length > 160 ? item.acontecimento.slice(0, 159) + '…' : item.acontecimento, 'lv-card-summary'));
    if (item.consequencia && !genericConsequences.has(item.consequencia)) node.append(el('p', item.consequencia, 'lv-card-summary'));
    if (item.categoria === 'comercial') node.append(commercialContext(item));
    if (item.categoria === 'entregas') {
      if (item.prazo) node.append(el('p', `Prazo citado: ${item.prazo}`, 'lv-card-meta'));
      if (item.acompanhamento?.proximaVerificacao) node.append(el('p', `Próxima verificação: ${date(item.acompanhamento.proximaVerificacao)}${item.acompanhamento.ativo ? '' : ' · acompanhamento pausado'}`, 'lv-card-meta'));
    }
    const footer = el('div', null, 'lv-card-footer');
    const origin = el('small', origins[item.origem] || 'Origem não informada', 'lv-card-meta'); origin.dataset.state = item.origem;
    const occurred = item.fonte?.recebidoEm && new Date(item.fonte.recebidoEm);
    const sourceLabel = [people.join(' · '), item.fonte?.autor && !people.includes(item.fonte.autor) ? item.fonte.autor : null, occurred && !Number.isNaN(occurred.getTime()) ? occurred.toLocaleDateString('pt-BR') : null].filter(Boolean).join(' · ') || 'Fonte não disponível';
    footer.append(el('small', sourceLabel, 'lv-card-meta'), origin);
    node.append(footer);
    return node;
  }
  function group(parent, title, entries, limited = false) {
    const section = el('section', null, 'lv-section');
    section.append(el('h2', title, 'lv-section-heading'));
    const list = el('div', null, 'lv-list'); section.append(list);
    if (!entries.length) list.append(el('p', 'Nenhum assunto neste recorte.', 'lv-empty'));
    const visible = limited ? entries.slice(0, 3) : entries;
    visible.forEach(item => list.append(card(item)));
    if (limited && entries.length > 3) {
      const remaining = el('div', null, 'lv-list'); remaining.hidden = true;
      remaining.id = `lv-extra-${title === 'Precisa de você' ? 'precisa' : title === 'Em acompanhamento' ? 'cuidando' : 'mudou'}`;
      entries.slice(3).forEach(item => remaining.append(card(item)));
      const more = button(`Ver mais ${entries.length - 3}`, () => {
        remaining.hidden = !remaining.hidden;
        more.setAttribute('aria-expanded', String(!remaining.hidden));
        more.textContent = remaining.hidden ? `Ver mais ${entries.length - 3}` : 'Mostrar menos';
      });
      more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', remaining.id);
      section.append(remaining, more);
    }
    parent.append(section);
  }
  function render(root, view, data, selection = {category: '', mode: 'list'}) {
    const heading = el('header', null, 'lv-page-heading');
    const introduction=el('div',null,'ls-heading-copy');
    introduction.append(el('h1', {today: 'Agora', sales: 'Vendas', deliveries: 'Projetos'}[view]),el('p', 'Consultado em ' + date(data.atualizadoEm), 'ls-consulted'));
    heading.append(introduction);
    const tools = el('div', null, 'lv-toolbar');
    tools.append(button('Atualizar', () => carregar(view)));
    if(view==='deliveries'&&window.LumeUm)tools.append(button('Timeline de projetos',()=>window.LumeUm.timeline()));
    heading.append(tools); root.replaceChildren(heading);
    if(view==='today'&&window.LumeUm)window.LumeUm.cobertura(root);
    const connection = data.conexao;
    if (connection) root.append(notice(typeof connection === 'string' ? connection : connection.mensagem || `Conexão: ${connectionLabels[connection.estado] || 'estado não informado'} · captura: ${connectionLabels[connection.captura] || 'estado não informado'} · processamento: ${connectionLabels[connection.processamento] || 'estado não informado'}. A memória salva continua disponível.`, 'lv-connection'));
    gaps(data.lacunas, root);
    const filters = el('div', null, 'lv-filters'), category = el('select'); category.setAttribute('aria-label', 'Filtrar categoria');
    for (const [value, label] of [['', 'Todas as categorias'], ...Object.entries(categories)]) { const option = el('option', label); option.value = value; category.append(option); }
    const content = el('div', null, view === 'today' ? 'lv-board' : 'lv-list');
    category.value = selection.category;
    let mode = selection.mode;
    function paint() {
      content.replaceChildren();
      const entries = data.itens.filter(item => (view !== 'sales' || item.categoria === 'comercial') && (view !== 'deliveries' || (['entregas', 'projetos'].includes(item.categoria) || item.projeto)) && (!category.value || item.categoria === category.value));
      if (view === 'today') {
        group(content, 'Precisa de você', entries.filter(item => item.grupo === 'precisa'), true);
        group(content, 'Em acompanhamento', entries.filter(item => item.grupo === 'cuidando'), true);
        group(content, 'Aconteceu', entries.filter(item => item.grupo === 'mudou'), true);
        if (entries.some(item => !['precisa', 'cuidando', 'mudou'].includes(item.grupo))) content.append(notice('Há assuntos sem agrupamento disponível. Consulte a memória para conferir o recorte.'));
      } else if (mode === 'board') {
        content.className = 'lv-board';
        content.append(el('p', 'Colunas por estado do acompanhamento.', 'lv-status'));
        for (const state of new Set(entries.map(item => item.estado || ''))) group(content, states[state] || state || 'Estado não informado', entries.filter(item => (item.estado || '') === state));
      } else {
        content.className = 'lv-list'; entries.forEach(item => content.append(card(item)));
      }
      if (!entries.length && view !== 'today') content.append(el('p', 'Nenhum assunto deste tipo no recorte autorizado. Consulte a memória ou confira suas conexões.', 'lv-empty'));
    }
    if (view === 'today') { tools.append(category); category.onchange = () => { selection.category = category.value; paint(); }; }
    if (view === 'sales') {
      root.append(el('p', 'Informações confirmadas e inferências mantêm sua origem visível. Interesse não é probabilidade de venda.', 'lv-status'));
      const list = button('Lista', () => setMode('list')), board = button('Kanban', () => setMode('board'));
      function setMode(value) { mode = value; selection.mode = value; list.setAttribute('aria-pressed', String(value === 'list')); board.setAttribute('aria-pressed', String(value === 'board')); paint(); }
      list.setAttribute('aria-pressed', String(mode === 'list')); board.setAttribute('aria-pressed', String(mode === 'board')); filters.append(list, board);
    }
    if (view === 'deliveries') root.append(el('p', 'Informado, verificado, enviado e aceito são etapas distintas. A conclusão relatada não comprova aceite.', 'lv-status'));
    if(filters.childNodes.length)root.append(filters);root.append(content); paint();
    window.LumePresenca?.montar(root,{estado:data.itens.some(item=>item.grupo==='precisa')?'atencao':'aguardando'});
    if(view==='today')window.LumeAtividade?.resumo(root);
    if (data.proximaPagina != null) {
      const ticket = revision, signal = pageController.signal, status = notice('Recorte parcial. Há mais assuntos disponíveis.');
      const more = button('Carregar mais assuntos', async () => {
        if (more.disabled) return; more.disabled = true; status.textContent = 'Buscando mais assuntos…';
        try {
          const next = envelope(await request('/api/v3/experiencia?' + new URLSearchParams({pagina: data.proximaPagina}), signal));
          if (ticket !== revision || signal.aborted) return;
          const merged = new Map(data.itens.map(item => [item.id, item]));
          for (const item of next.itens) merged.set(item.id, item);
          render(root, view, {...next, itens: [...merged.values()]}, selection);
          const focus = root.querySelector('[data-load-more]') || root.querySelector('h1'); if (focus.tagName !== 'BUTTON') focus.tabIndex = -1; focus.focus({preventScroll: true});
        } catch (error) {
          if (ticket !== revision || signal.aborted) return;
          if (denied(error)) { clearCards(); errorBox(root, error, () => carregar(view)); }
          else { status.textContent = error.message || 'Não foi possível carregar mais assuntos.'; more.disabled = false; }
        }
      });
      more.dataset.loadMore = 'true'; root.append(more, status);
    }
  }
  function enhanceExisting(view) {
    if (view === 'memory' && !$('lv-memory-links') && $('memory')) {
      const nav = el('div', null, 'lv-toolbar'); nav.id = 'lv-memory-links';
      nav.append(button('Relações · mapa e lista', () => go('graph')));
      $('memory').prepend(nav);
    }
    if (view === 'graph') { $('graph-list')?.classList.add('lv-relations'); $('graph')?.classList.add('lv-page'); }
  }
  async function carregar(input) {
    const view = aliases[String(input).toLowerCase()] || input;
    pageController?.abort(); closeDrawer();
    const ticket = ++revision;
    enhanceExisting(view);
    if (!['today', 'sales', 'deliveries'].includes(view)) return;
    const root = rootFor(view); if (!root) return;
    const controller = new AbortController(); pageController = controller;
    root.setAttribute('aria-busy', 'true'); root.replaceChildren(notice('Buscando assuntos e fontes…'));
    try {
      const data = envelope(await request('/api/v3/experiencia', controller.signal));
      if (ticket !== revision || controller.signal.aborted) return;
      render(root, view, data);
    } catch (error) {
      if (ticket !== revision || controller.signal.aborted) return;
      if (denied(error)) clearCards();
      errorBox(root, error, () => carregar(view));
    } finally { if (ticket === revision) root.setAttribute('aria-busy', 'false'); }
  }
  function closeDrawer({restore = true} = {}) {
    detailRevision++; detailController?.abort(); detailController = null;
    if (!drawer) return;
    const old = drawer; drawer = null; old.close(); old.remove();
    if (restore) {
      if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
      for (const [node, top, left] of scrollSnapshot || []) if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
    }
    returnFocus = null; scrollSnapshot = null;
  }
  function makeDrawer() {
    closeDrawer(); returnFocus = document.activeElement;
    scrollSnapshot = [...new Set([document.scrollingElement, ...document.querySelectorAll('main, .main, .content, .view')])].filter(Boolean).map(node => [node, node.scrollTop, node.scrollLeft]);
    drawer = el('dialog', null, 'lv-drawer'); drawer.dataset.enter = 'true'; drawer.setAttribute('aria-labelledby', 'lv-detail-title');
    const header = el('header', null, 'lv-drawer-header');
    const title = el('h2', 'Assunto', 'lv-card-title'); title.id = 'lv-detail-title';
    const close = button('Fechar assunto', () => closeDrawer()); header.append(title, close);
    const body = el('div', null, 'lv-drawer-body'); drawer.append(header, body);
    drawer.addEventListener('cancel', event => { event.preventDefault(); closeDrawer(); });
    drawer.addEventListener('click', event => { if (event.target === drawer) { const r = drawer.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDrawer(); } });
    drawer.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const focusables = [...drawer.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(node => node.getClientRects().length);
      const first = focusables[0], last = focusables.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    document.body.append(drawer); drawer.showModal(); close.focus({preventScroll: true});
    return body;
  }
  function detailSection(body, title, text) {
    const section = el('section', null, 'lv-detail-section'); section.append(el('h3', title));
    if (text) section.append(el('p', text)); body.append(section); return section;
  }
  async function timeline(execution, parent, signal, valid) {
    const section = detailSection(parent, 'Histórico da execução', states[execution.estado] || execution.estado || 'Estado não informado');
    const list = el('ol', null, 'lv-timeline'), status = notice(''), seen = new Set();
    let before = null, busy = false;
    const more = button('Carregar histórico', load); section.append(list, more, status);
    async function load() {
      if (busy) return; busy = true; more.disabled = true; status.textContent = 'Buscando histórico…';
      try {
        const data = await request('/api/v3/execucoes/timeline?' + new URLSearchParams({id: execution.id, limite: '20', ...(before != null ? {antes: before} : {})}), signal);
        if (!valid()) return;
        if (!Array.isArray(data.timeline)) throw new Error('Histórico indisponível. Tente novamente.');
        for (const event of data.timeline) {
          if (seen.has(event.id)) continue; seen.add(event.id);
          const row = el('li', null, 'lv-item');
          row.append(el('strong', {acao: 'Combinado registrado', autorizacao: 'Contexto autorizado', inicio: 'Execução iniciada', progresso: 'Progresso informado', resultado: 'Resultado informado', verificacao: 'Verificado por você', revogacao: 'Autorização revogada'}[event.tipo] || 'Registro'), el('time', date(event.em)), el('p', event.resumo || event.texto || event.nota || event.estado || ''));
          list.append(row);
        }
        before = data.antes; more.hidden = before == null; more.textContent = 'Ver registros anteriores';
        status.textContent = !seen.size ? 'Nenhum registro disponível nesta execução.' : before == null ? 'Início do histórico alcançado.' : 'Histórico parcial. Há registros anteriores.';
        if (more.hidden && document.activeElement === more) { status.tabIndex = -1; status.focus({preventScroll: true}); }
      } catch (error) {
        if (!valid()) return;
        if (denied(error)) {
          const id = parent.dataset.assuntoId;
          clearCards(); detailRevision++; detailController?.abort();
          $('lv-detail-title').textContent = 'Assunto indisponível';
          errorBox(parent, error, () => abrirAssunto(id));
          parent.querySelector('button')?.focus({preventScroll: true});
        }
        else status.textContent = error.message;
        more.textContent = 'Tentar histórico novamente';
      } finally { busy = false; if (valid()) more.disabled = false; }
    }
  }
  async function abrirAssunto(id) {
    if (typeof id !== 'string' || !id) return;
    const body = makeDrawer(), ticket = detailRevision;
    const controller = new AbortController(); detailController = controller;
    const valid = () => ticket === detailRevision && !controller.signal.aborted && body.isConnected;
    body.replaceChildren(notice('Conferindo assunto e permissão…')); body.setAttribute('aria-busy', 'true');
    try {
      // Re-read even for visible cards: a revoked/edited source must not survive in the drawer.
      const data = envelope(await request('/api/v3/experiencia?' + new URLSearchParams({id}), controller.signal));
      if (!valid()) return;
      const item = data.itens.find(entry => entry.id === id);
      if (!item) { const error = new Error('Assunto indisponível.'); error.status = 404; throw error; }
      let action, executions = [], executionError, executionUnavailable = false;
      if (item.acaoId) {
        const actionData = await request('/api/v3/acoes/item?' + new URLSearchParams({id: item.acaoId}), controller.signal);
        if (!valid()) return;
        action = actionData.acao;
        if (!action || action.id !== item.acaoId) throw new Error('A identidade da ação mudou. Atualize o assunto.');
        const executionState = action.execucao_ui?.estado || 'indisponivel';
        executionUnavailable = executionState === 'indisponivel';
        // Reading a personal action is not a grant to read the Resolver context.
        // With no existing execution there is no history endpoint to consult.
        if (!['nenhuma', 'indisponivel'].includes(executionState)) {
          try { executions = (await request('/api/v3/execucoes?' + new URLSearchParams({acao_id: item.acaoId}), controller.signal)).execucoes || []; }
          catch (error) { if (denied(error)) throw error; executionError = error; }
        }
        if (!valid()) return;
      }
      $('lv-detail-title').textContent = shortText(item.assunto,140) || 'Assunto sem título';
      body.replaceChildren(); body.dataset.assuntoId = item.id;
      if(item.assunto?.length>140)detailSection(body,'Assunto completo',item.assunto);
      detailSection(body, 'Contexto', item.acontecimento || action?.trecho || item.assunto);
      detailSection(body, 'Estado e origem', `${item.estadoRotulo || states[item.estado] || item.estado || 'Estado não informado'} · ${origins[item.origem] || 'Origem não informada'}`);
      if (item.categoria === 'comercial') detailSection(body, 'Contexto comercial').append(commercialContext(item));
      detailSection(body, 'Responsável', typeof item.responsavel === 'string' ? item.responsavel : item.responsavel?.nome || 'Responsável não informado');
      detailSection(body, 'Prazo', item.prazo || 'Prazo não informado');
      if (item.categoria === 'entregas') {
        detailSection(body, 'Projeto', item.projeto?.nome || 'Projeto não informado');
        detailSection(body, 'Dependências', 'Dependências não informadas neste recorte.');
        detailSection(body, 'Próxima verificação', item.acompanhamento?.proximaVerificacao ? `${date(item.acompanhamento.proximaVerificacao)}${item.acompanhamento.ativo ? '' : ' · acompanhamento pausado'}` : 'Próxima verificação não informada');
        const proof = detailSection(body, 'Evidência da entrega');
        for (const [key, label] of [['informada', 'Conclusão informada'], ['verificada', 'Resultado verificado'], ['enviada', 'Envio'], ['aceita', 'Aceite']]) proof.append(el('p', `${label}: ${item.entrega?.[key] === true ? 'registrado' : 'sem registro neste recorte'}`));
      }
      const source = detailSection(body, 'Fontes', sourceText(item.fonte));
      if (item.fonte?.trecho) source.append(el('blockquote', item.fonte.trecho));
      const eventId = sourceId(item.fonte);
      const permits = type => Array.isArray(item.acoes) && item.acoes.some(action => action.tipo === type);
      if (permits('fonte') && eventId != null && typeof window.abrirFonteTarefa === 'function') source.append(button('Conferir fonte', () => { closeDrawer({restore: false}); return window.abrirFonteTarefa(eventId); }, 'lv-button lv-source'));
      gaps(item.lacunas, body);
      const actions = detailSection(body, 'Próximo passo');
      if (item.consequencia) actions.append(el('p', item.consequencia));
      const executionState = action?.execucao_ui?.estado || 'indisponivel';
      const canOpenResolver = action && (executionState === 'verificado' || (!['resolvido', 'descartado'].includes(action.estado) && (['aguardando_assistente', 'em_andamento', 'resultado_informado', 'invalidada', 'revogada', 'expirada'].includes(executionState) || (executionState === 'nenhuma' && ['confirmado', 'estacionado'].includes(action.estado)))));
      if (permits('acao') && canOpenResolver && typeof window.abrirResolverLume === 'function') actions.append(button('Resolver', () => { const origem = returnFocus; closeDrawer(); return window.abrirResolverLume(action, {origem}); }));
      else if (permits('acao') && item.acaoId && typeof window.abrirAcaoDoAviso === 'function') actions.append(button('Abrir ação', () => { closeDrawer({restore: false}); return window.abrirAcaoDoAviso(item.acaoId); }));
      else actions.append(el('p', 'Confira a fonte para decidir o próximo passo. Nenhuma ação executável disponível neste assunto.'));
      if (permits('acao') && item.conversaId && typeof window.abrirAvaliacaoVenda === 'function') actions.append(button('Conferir classificação', () => { closeDrawer(); return window.abrirAvaliacaoVenda(item.conversaId, item.assunto); }, 'lv-button secondary'));
      if (permits('fonte') && eventId != null && typeof window.abrirProjetoDaFonte === 'function') actions.append(button('Rever vínculo com projeto', () => { closeDrawer(); return window.abrirProjetoDaFonte({id:eventId}); }, 'lv-button secondary'));
      if (item.projeto?.id && window.LumeUm) actions.append(button('Ver timeline do projeto', () => { closeDrawer(); return window.LumeUm.timeline({projeto:item.projeto.id,titulo:item.projeto.nome}); }, 'lv-button secondary'));
      if (permits('acompanhar')) {
        const follow=el('details');follow.append(el('summary','Acompanhar assunto'),el('p','O Lume confere este assunto enquanto o serviço pessoal está ativo. Atualizações seguem as conexões e permissões já configuradas.'));
        const status=notice('');const start=button('Confirmar acompanhamento',async()=>{
          start.disabled=true;
          try{await window.lumeConnectionRequest('/api/v3/pessoal/acompanhamento',{acaoId:item.acaoId,confirmar:true},{timeout:15000});if(valid())await abrirAssunto(id);}
          catch(e){if(valid()){status.textContent=e.message;start.disabled=false;}}
        });follow.append(start,status);actions.append(follow);
      }
      if (permits('preparar')) {
        const prepare=el('details');prepare.append(el('summary','Preparar resposta'),el('p',`Destinatário: ${item.pessoas?.[0]?.nome || 'Pessoa'} · ${item.conversaId}`));
        prepare.append(el('p','Escreva a resposta exata. Identifique Lume como assistente no primeiro parágrafo. Esta etapa guarda uma proposta pendente; a aprovação de envio permanece separada.'));
        const form=el('form',null,'lv-section'),label=el('label','Resposta exata'),text=el('textarea');text.required=true;text.maxLength=2200;text.rows=5;label.append(text);
        const reasonLabel=el('label','Motivo desta resposta'),reason=el('input');reason.required=true;reason.minLength=10;reason.maxLength=500;reasonLabel.append(reason);
        const save=el('button','Guardar resposta preparada','lv-button');save.type='submit';const status=notice('');form.append(label,reasonLabel,save,status);prepare.append(form);actions.append(prepare);
        form.onsubmit=async event=>{event.preventDefault();if(save.disabled)return;save.disabled=true;status.textContent='Conferindo destinatário e permissão…';
          try{const result=await window.lumeConnectionRequest('/api/v3/pessoal/mensagem/preparar',{conversaId:item.conversaId,baloes:[text.value],motivo:reason.value},{timeout:15000});if(!valid())return;status.textContent=result.estado==='pendente'?'Resposta preparada. Nenhum envio foi aprovado nesta tela.':'Resposta já registrada: '+result.estado+'. Confira o recibo antes de repetir.';text.readOnly=true;reason.readOnly=true;}
          catch(e){if(valid()){status.textContent=e.message;save.disabled=false;}}
        };
      }
      if (executionError) {
        const error = detailSection(body, 'Histórico'); error.append(notice('Não foi possível consultar as execuções. O estado do histórico não está confirmado.', 'lv-error'), button('Tentar histórico novamente', () => abrirAssunto(id)));
      } else if (executionUnavailable) detailSection(body, 'Histórico', 'Estado da execução indisponível. Confira a ação para revalidar o contexto.');
      else if (!executions.length) detailSection(body, 'Histórico', 'Nenhuma execução disponível neste recorte.');
      for (const execution of executions) await timeline(execution, body, controller.signal, valid);
    } catch (error) {
      if (!valid()) return;
      if (denied(error)) clearCards();
      $('lv-detail-title').textContent = 'Assunto indisponível';
      errorBox(body, error, () => abrirAssunto(id));
    } finally { if (valid()) body.setAttribute('aria-busy', 'false'); }
  }
  function limpar() {
    revision++; pageController?.abort(); pageController = null;
    closeDrawer(); clearCards();
  }
  window.addEventListener('lume:navigate', () => { revision++; pageController?.abort(); closeDrawer(); });
  window.addEventListener('lume:invalidate', limpar);
  window.LumeVivo = Object.freeze({carregar, abrirAssunto, limpar});
})();

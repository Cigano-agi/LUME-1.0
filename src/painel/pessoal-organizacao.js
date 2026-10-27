(() => {
  const section = document.getElementById('acoes06');
  if (!section || document.getElementById('pessoal-organizacao-filtros')) return;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const original = make('div'); original.id = 'pessoal-organizacao-original';
  const originalStatus = document.getElementById('acoes06-status');
  section.insertBefore(original, originalStatus);
  for (const id of ['acoes06-status', 'acoes06-target', 'acoes06-list', 'acoes06-pagination']) {
    const node = document.getElementById(id); if (node) original.append(node);
  }
  const filters = make('div', null, 'button-row acoes06-controls acoes06-view-switch');
  filters.id = 'pessoal-organizacao-filtros'; filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Organizar ações por assunto');
  const projection = make('section', null, 'acoes06-list'); projection.id = 'pessoal-organizacao'; projection.hidden = true;
  const heading = make('h3'); heading.id = 'pessoal-organizacao-titulo';
  projection.setAttribute('aria-labelledby', heading.id);
  const status = make('p', '', 'muted'); status.id = 'pessoal-organizacao-status'; status.setAttribute('role', 'status');
  const items = make('div', null, 'acoes06-list'); items.id = 'pessoal-organizacao-itens';
  const retry = make('button', 'Tentar novamente', 'secondary'); retry.type = 'button'; retry.hidden = true;
  projection.append(heading, status, items, retry);
  const controls = section.querySelector('.acoes06-controls');
  controls.before(filters); original.after(projection);
  const labels = {todas: 'Todas', comercial: 'Comercial', tarefas: 'Tarefas', projetos: 'Projetos'};
  const stateLabels = {sugerido: 'Para conferir', confirmado: 'Confirmada', estacionado: 'Estacionada', resolvido: 'Resolvida', descartado: 'Descartada'};
  const progressLabels = {planejado: 'Planejado', em_andamento: 'Em andamento', bloqueado: 'Bloqueado', concluido_informado: 'Conclusão informada, ainda por conferir', insuficiente: 'Andamento não identificado'};
  const subjectLabels = {comercial: 'Comercial', tarefa: 'Tarefa', projeto: 'Projeto', pessoal: 'Pessoal', insuficiente: 'Assunto não identificado'};
  const uncertainties = {classificacao_indisponivel: 'Classificação indisponível; a tarefa continua aqui.', assunto_insuficiente: 'Assunto ainda incerto.', andamento_insuficiente: 'Andamento ainda incerto.', continuidade_incerta: 'Não está claro se é o mesmo assunto.', revisao_sugerida: 'Classificação precisa de revisão.', escopo_da_demanda_ambiguo: 'Confira qual pedido pertence a este projeto.'};
  const buttons = new Map();
  let selected = 'todas', snapshot = null, fetchedAt = 0, attemptedAt = -Infinity, revision = 0, controller = null;
  const fresh = () => snapshot && Date.now() - fetchedAt < 30000;
  const visible = () => !document.hidden && !section.closest('[hidden]') && section.getClientRects().length > 0;
  const cancel = () => { revision++; controller?.abort(); controller = null; projection.removeAttribute('aria-busy'); };
  function action(text, callback) {
    const button = make('button', text, 'secondary'); button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true; const current = revision;
      try { await callback(); }
      catch { if (current === revision) status.textContent = 'Não foi possível abrir. Confira se a fonte continua disponível e tente novamente.'; }
      finally { button.disabled = false; }
    });
    return button;
  }
  function card(item, candidates) {
    // Existing text layout keeps long literal sources inside narrow viewports.
    const node = make('article', null, 'acoes06-card pessoal-conversation-copy'); node.dataset.acao = item.acaoId;
    const meta = make('div', null, 'acoes06-meta');
    meta.append(make('span', item.conversaNome || item.conversa_nome || 'Conversa', 'action-context'), make('span', stateLabels[item.estado] || 'Para conferir', 'action-type-label'));
    node.append(meta, make('h3', item.resumo || 'Pedido com fonte'));
    const assessment = item.avaliacao;
    if (!assessment) node.append(make('p', uncertainties.classificacao_indisponivel, 'muted'));
    else {
      const subject = subjectLabels[assessment.assunto?.valor] || 'Assunto não identificado';
      const progress = progressLabels[assessment.andamento?.valor] || 'Andamento não identificado';
      node.append(make('p', `${subject} · ${progress}`, 'muted'));
      node.append(make('p', assessment.origem === 'manual' ? 'Classificação corrigida por você.' : 'Classificação sugerida. Não confirma venda, entrega ou aceite.', 'muted'));
      const uncertain = [...new Set((item.incerteza || []).map(key => uncertainties[key]).filter(Boolean))];
      if (uncertain.length) node.append(make('p', uncertain.join(' '), 'muted'));
    }
    if (item.projeto) {
      const projectState = item.projeto.estado === 'rascunho' ? 'Rascunho de projeto · ainda não confirmado' : item.projeto.estado === 'arquivado' ? 'Projeto arquivado' : 'Projeto confirmado';
      node.append(make('p', `${projectState}: ${item.projeto.nome || 'Projeto'}`));
      if (item.projeto.natureza === 'incerto') node.append(make('p', 'Natureza do projeto ainda incerta.', 'muted'));
    } else if (candidates.some(candidate => candidate.acaoId === item.acaoId)) {
      node.append(make('p', 'Possível projeto · confira o pedido antes de organizar.', 'muted'));
    }
    if (item.fonte?.trecho) {
      node.append(make('p', 'Mensagem de origem', 'eyebrow'), make('blockquote', item.fonte.trecho));
    }
    const actions = make('div', null, 'button-row acoes06-controls acoes06-view-switch');
    if (Number.isSafeInteger(item.eventoId) && item.eventoId > 0 && typeof window.abrirFonteTarefa === 'function') actions.append(action('Ver fonte', () => window.abrirFonteTarefa(item.eventoId)));
    if (item.conversaId && typeof window.abrirAvaliacaoVenda === 'function') actions.append(action('Conferir classificação', () => window.abrirAvaliacaoVenda(item.conversaId, item.resumo)));
    if (item.acaoId && typeof window.abrirAcaoDoAviso === 'function') actions.append(action('Abrir ação', () => window.abrirAcaoDoAviso(item.acaoId)));
    node.append(actions); return node;
  }
  function render() {
    if (selected === 'todas' || !snapshot) return;
    const group = snapshot[selected];
    // The server revalidates sources/signatures; the browser never promotes or
    // reclassifies a demand and never creates a second queue.
    items.replaceChildren(...group.map(item => card(item, snapshot.candidatos)));
    status.textContent = group.length ? `${group.length} ${group.length === 1 ? 'ação com fonte' : 'ações com fonte'}${snapshot.truncada ? ' · Recorte de até 100 ações. Consulte Todas para ver as demais.' : '.'}` : `Nenhuma ação em ${labels[selected].toLocaleLowerCase('pt-BR')} neste recorte.${snapshot.truncada ? ' Consulte Todas para ver as demais.' : ''}`;
    retry.hidden = true;
  }
  async function refresh({force = false} = {}) {
    if (selected === 'todas' || !visible() || controller) return;
    if (!force && Date.now() - attemptedAt < 30000) return;
    cancel(); const current = revision, group = selected;
    controller = new AbortController(); attemptedAt = Date.now();
    projection.setAttribute('aria-busy', 'true'); status.textContent = 'Conferindo ações e fontes…';
    items.replaceChildren(); retry.hidden = true;
    try {
      const value = await window.lumeConnectionRequest('/api/v3/pessoal/organizacao', undefined, {timeout: 15000, signal: controller.signal});
      if (current !== revision || selected !== group) return;
      if (!value || !['comercial', 'tarefas', 'projetos', 'candidatos'].every(key => Array.isArray(value[key]))) throw new Error('Resposta incompleta');
      snapshot = value; fetchedAt = Date.now(); render();
    } catch (error) {
      if (current !== revision) return;
      snapshot = null; items.replaceChildren(); retry.hidden = false;
      status.textContent = error.code === 'CONNECTION_TIMEOUT' ? 'A consulta demorou mais que o esperado. Tente novamente para conferir as fontes.' : 'Não foi possível conferir as ações. Tente novamente ou volte a Todas.';
    } finally {
      if (current === revision) { controller = null; projection.removeAttribute('aria-busy'); }
    }
  }
  function choose(group) {
    if (selected === group) return;
    const pending = Boolean(controller); cancel();
    if (pending) attemptedAt = -Infinity;
    selected = group; original.hidden = group !== 'todas'; projection.hidden = group === 'todas';
    for (const [key, button] of buttons) {
      button.setAttribute('aria-pressed', String(group === key));
      button.textContent = `${group === key ? '✓ ' : ''}${labels[key]}`;
    }
    items.replaceChildren(); retry.hidden = true; status.textContent = ''; heading.textContent = labels[group];
    if (group !== 'todas') {
      if (fresh()) render();
      else { attemptedAt = -Infinity; void refresh(); }
    }
  }
  for (const [key, label] of Object.entries(labels)) {
    const button = make('button', `${key === selected ? '✓ ' : ''}${label}`, 'secondary'); button.type = 'button';
    button.setAttribute('aria-label', label);
    button.dataset.grupo = key; button.setAttribute('aria-pressed', String(key === selected));
    button.setAttribute('aria-controls', key === 'todas' ? original.id : projection.id);
    button.addEventListener('click', () => choose(key)); buttons.set(key, button); filters.append(button);
  }
  retry.addEventListener('click', () => void refresh({force: true}));
  // The original state/view controls retain their meaning and return to Todas.
  controls.addEventListener('change', () => choose('todas'));
  controls.addEventListener('click', event => { if (event.target.closest('button')) choose('todas'); }, true);
  const load = window.carregarAcoes06;
  if (load) window.carregarAcoes06 = async function (...args) {
    const result = await load.apply(this, args); void refresh(); return result;
  };
  const openAction = window.abrirAcaoDoAviso;
  if (openAction) window.abrirAcaoDoAviso = function (...args) { choose('todas'); return openAction.apply(this, args); };
  function clear() {
    cancel(); snapshot = null; fetchedAt = 0; attemptedAt = -Infinity;
    choose('todas'); items.replaceChildren(); status.textContent = ''; retry.hidden = true;
  }
  const reset = window.limparDadosVisiveis;
  if (reset) window.limparDadosVisiveis = function (...args) { clear(); return reset.apply(this, args); };
  const clearActions = window.limparAcoes06;
  if (clearActions) window.limparAcoes06 = function (...args) { clear(); return clearActions.apply(this, args); };
  // Observe navigation, not the message tree. No polling or background lookup.
  const suspend = () => { if (controller) attemptedAt = -Infinity; cancel(); };
  const observer = new MutationObserver(() => { if (!visible()) suspend(); else void refresh(); });
  for (let parent = section; parent; parent = parent.parentElement) observer.observe(parent, {attributes: true, attributeFilter: ['hidden', 'class']});
  document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(); else void refresh(); });
})();

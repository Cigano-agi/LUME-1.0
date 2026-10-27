/** Vista de apresentação. Recebe apenas snapshots; não acessa áudio, rede ou dispositivo. */
export const escaparHtml = valor => String(valor ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const h = escaparHtml;
const estados = new Set(['vazio', 'importando', 'gravando', 'pausado', 'interrompido', 'processando', 'modelo-ausente', 'revisavel', 'erro']);
const acoesLeitura = new Set(['ouvir', 'ouvir-trecho', 'ver-modelo', 'corrigir']);
const typeLabels = {pendency:'Pendência',project:'Projeto',person:'Pessoa',link:'Link',deal:'Venda',money:'Dinheiro'};

export function prepararVista(dto = {}) {
  const entradas = Array.isArray(dto.entradas) ? dto.entradas : [];
  let estado = estados.has(dto.estado) ? dto.estado : 'vazio';
  if (estado === 'gravando' && !entradas.some(e => e?.ativo === true)) estado = 'interrompido';
  return { ...dto, estado, entradas, opcoesEntrada: Array.isArray(dto.opcoesEntrada) ? dto.opcoesEntrada : [], trechos: Array.isArray(dto.trechos) ? dto.trechos : [], fonte: dto.fonte || {} };
}

const stateText = {
  vazio: ['Nada está sendo gravado.', 'Comece uma sessão escolhendo uma entrada, ou importe um áudio.'],
  importando: ['Importando áudio', 'O arquivo está sendo guardado neste dispositivo.'],
  gravando: ['Gravando', 'Confira as entradas ativas e o trecho já salvo.'],
  pausado: ['Pausada', 'A captura está em pausa.'],
  interrompido: ['Sessão interrompida', 'A captura parou. Confira o que foi salvo.'],
  processando: ['Processando localmente', 'O original pode estar disponível antes da transcrição.'],
  'modelo-ausente': ['Modelo local indisponível', 'O áudio pode ser ouvido; a transcrição aguarda um modelo local.'],
  revisavel: ['Pronta para revisar', 'Confira os trechos no áudio antes de criar um próximo passo.'],
  erro: ['A sessão precisa de atenção', 'Confira a causa e tente novamente.']
};
const btn = (acao, rotulo, extra = '') => `<button type="button" class="nt-button ${extra}" data-action="${acao}">${rotulo}</button>`;
const canPlay = v => v.fonte.disponivel === true && v.fonte.persistida === true;
const canProve = (v, t) => canPlay(v) && Boolean(t.id && t.inicio && t.texto) && t.coberto === true && t.tipo !== 'silencio' && t.tipo !== 'lacuna' && t.fonteDisponivel !== false;
const canCorrect = t => t?.podeCorrigir === true && Boolean(t.id && typeof t.texto === 'string' && t.texto.trim()) && t.tipo !== 'silencio' && t.tipo !== 'lacuna' && t.coberto !== false;

export function renderizarVista(input = {}) {
  const v = prepararVista(input);
  const [tituloEstado, subtitulo] = stateText[v.estado];
  const original = canPlay(v);
  const titulo = h(v.titulo || 'Nova reunião');
  const fato = v.estado === 'gravando' ? 'Captura ativa' : v.estado === 'pausado' ? 'Captura pausada' : v.estado === 'interrompido' ? 'Captura encerrada' : 'Sessão local';
  const primary = v.estado === 'vazio' ? (v.opcoesEntrada.some(e => e.selecionada === true && e.disponivel === true) && v.consentimento === true ? btn('iniciar', 'Iniciar gravação', 'nt-button--primary') : '') : v.estado === 'gravando' ? btn('pausar', 'Pausar', 'nt-button--primary') : v.estado === 'pausado' ? btn('retomar', 'Retomar', 'nt-button--primary') : v.estado === 'importando' ? btn('cancelar-importacao', 'Cancelar importação', 'nt-button--primary') : v.estado === 'erro' ? btn('tentar-novamente', 'Tentar novamente', 'nt-button--primary') : original ? btn('ouvir', 'Ouvir original', 'nt-button--primary') : '';
  const secondary = v.estado === 'vazio' ? btn('importar', 'Importar áudio') : v.estado === 'interrompido' ? btn('iniciar', 'Iniciar nova sessão') : v.estado === 'modelo-ausente' ? btn('ver-modelo', 'Ver modelo local') : v.estado === 'erro' ? btn('importar', 'Escolher outro arquivo') : '';
  const entradas = v.entradas.length ? `<div class="nt-inputs" aria-label="Entradas da sessão">${v.entradas.map(e => `<span class="nt-input"><span class="nt-dot" aria-hidden="true"></span>${h(e.nome || 'Entrada')} · ${v.estado === 'gravando' ? e.ativo === true ? 'captando' : 'não captando' : v.estado === 'pausado' ? 'pausada' : 'interrompida'}</span>`).join('')}</div>` : '';
  const consent = v.estado === 'vazio' && v.consentimento !== true ? btn('confirmar-consentimento', 'Confirmar consentimento desta sessão') : '';
  const opcoes = v.estado === 'vazio' ? `<div class="nt-setup"><p class="nt-setup-label">Entradas para esta sessão</p>${v.opcoesEntrada.length ? `<div class="nt-setup-options">${v.opcoesEntrada.map(e => `<button type="button" class="nt-choice" data-action="selecionar-entrada" data-input="${h(e.id)}" aria-pressed="${e.selecionada === true}" ${e.disponivel === true ? '' : 'disabled'}>${h(e.nome)} <span>${e.disponivel !== true ? 'indisponível' : e.selecionada === true ? 'selecionado' : 'desligado'}</span></button>`).join('')}</div>` : '<p>Entradas ainda não verificadas neste dispositivo.</p>'}<p class="nt-setup-note">${v.consentimento === true ? 'Consentimento desta sessão confirmado.' : 'Confirme que todos concordam com a gravação antes de iniciar.'}</p><p class="nt-setup-note">Para importar: WAV PCM16 mono, 16 kHz, até 2 h.</p></div>` : '';
  const confirmado = v.fonte.persistida === true || v.salvamentoConfirmado === true;
  const cobertura = confirmado && v.salvoAte ? `<p class="nt-coverage">Salvo até <strong>${h(v.salvoAte)}</strong>${v.cobertura ? ` · ${h(v.cobertura)}` : ''}</p>` : confirmado && v.cobertura ? `<p class="nt-coverage">${h(v.cobertura)}</p>` : '';
  const fonteAviso = v.fonte.disponivel === false ? `<p class="nt-alert nt-alert--error">Áudio indisponível${v.fonte.motivo ? ` · ${h(v.fonte.motivo)}` : ''}. Ação com fonte comprovada indisponível.</p>` : v.estado === 'gravando' && v.salvamentoConfirmado === true ? '<p class="nt-alert">Trecho salvo. O original completo ficará disponível após encerrar.</p>' : v.fonte.persistida !== true && v.estado !== 'vazio' ? `<p class="nt-alert">Original ainda sem confirmação de salvamento.</p>` : '';
  const aviso = v.causa ? `<p class="nt-alert">${h(v.causa)}</p>` : '';
  const lista = v.trechos.length ? v.trechos.map(t => {
    const lacuna = t.tipo === 'lacuna' || t.coberto === false;
    const silencio = t.tipo === 'silencio' && !lacuna;
    const texto = lacuna ? 'Trecho não salvo' : silencio ? 'Tempo coberto, sem fala identificada' : h(t.texto || 'Transcrição ainda não disponível');
    const tempo = [t.inicio, t.fim].filter(Boolean).map(h).join(' – ');
    const id = h(t.id);
    const play = original && !lacuna && t.fonteDisponivel !== false ? btn('ouvir-trecho', 'Ouvir trecho') : '';
    const create = canProve(v, t) ? btn('criar-acao', 'Criar ação') : '';
    const correct = canCorrect(t) ? btn('corrigir', 'Corrigir texto') : '';
    const correction = t.correcao ? `<p class="nt-correction"><span>Correção humana</span>${h(t.correcao)}</p>` : '';
    const source = lacuna ? 'Lacuna na fonte' : silencio ? 'Áudio salvo' : t.origem || 'Reunião local · autoria não identificada';
    return `<li class="nt-segment ${lacuna ? 'nt-segment--gap' : ''}" data-segment="${id}"><div class="nt-segment-time">${tempo || 'Tempo indisponível'}</div><div class="nt-segment-body"><p class="nt-segment-text">${texto}</p>${correction}<p class="nt-segment-source">${h(source)}</p><div class="nt-segment-actions">${play}${correct}${create}</div></div></li>`;
  }).join('') : `<li class="nt-empty-line">${v.estado === 'vazio' ? 'Os trechos aparecerão aqui depois da sessão.' : 'Nenhum trecho disponível para revisar.'}</li>`;
  const next = v.organizacaoAprovada === true ? (v.analiseConcluida !== true ? '<p>A análise ainda não terminou.</p>' : v.proximosPassos?.length ? `<ul class="nt-next-list">${v.proximosPassos.map(p => `<li><span class="nt-kind nt-kind--${Object.hasOwn(typeLabels,p.tipo) ? p.tipo : 'pendency'}">${h(p.rotulo || typeLabels[p.tipo] || 'Pendência')}</span><strong>${h(p.titulo)}</strong><small>${p.fonte ? `Fonte: ${h(p.fonte)}` : 'Fonte não informada · conferir antes de agir'}</small></li>`).join('')}</ul>` : '<p>Sem próximos passos encontrados na cobertura analisada.</p>') : `<p>${v.transcricaoConfirmada === true ? 'Transcrição disponível; ' : 'Transcrição ainda não disponível; '}organização automática indisponível.</p>`;
  const captureBar = v.estado === 'gravando' || v.estado === 'pausado' ? `<div class="nt-capture-bar" role="group" aria-label="Controle da sessão"><span><strong>${v.estado === 'gravando' ? 'Gravando' : 'Pausada'}</strong><small>${v.estado === 'pausado' ? 'Captura em pausa' : v.entradas.filter(e => e.ativo === true).map(e => h(e.nome)).join(' + ') || 'Nenhuma entrada ativa'}</small></span>${btn('parar', 'Parar', 'nt-button--stop')}</div>` : '';
  return `<section class="nt-view" data-state="${v.estado}" aria-label="Sessão de reunião"><header class="nt-header"><div class="nt-brand"><svg class="lume-mascot nt-mascot" data-mascot-state="${v.estado === 'erro' || v.estado === 'interrompido' ? 'alert' : v.estado === 'revisavel' ? 'success' : v.estado === 'processando' || v.estado === 'importando' ? 'processing' : 'idle'}" viewBox="0 0 64 72" aria-hidden="true"><path class="mascot-body" d="M32 6C20 6 11 15 11 31v25c0 5 5 8 9 4l5-5 5 5c1 1 3 2 5 0l5-5 5 5c4 4 9 1 9-4V31c0-16-9-25-21-25Z"/><g class="mascot-expression mascot-expression--idle"><circle cx="25" cy="34" r="2.6"/><circle cx="39" cy="34" r="2.6"/><path d="M27 43q5 5 10 0"/></g><g class="mascot-expression mascot-expression--processing"><path d="M21 34h7m8 0h7M29 44q3-2 6 0"/></g><g class="mascot-expression mascot-expression--success"><path d="M21 34q4-5 8 0m6 0q4-5 8 0M25 42q7 8 14 0"/></g><g class="mascot-expression mascot-expression--alert"><circle cx="24" cy="34" r="3.1"/><circle cx="40" cy="34" r="3.1"/><path d="M28 46q4-5 8 0"/></g></svg><span>LUME <em>REUNIÕES</em></span></div><span class="nt-local">● Neste dispositivo</span></header><div class="nt-hero"><div class="nt-hero-copy"><p class="nt-eyebrow">${fato}</p><h1>${titulo}</h1><p class="nt-state" role="status" tabindex="-1">${tituloEstado}</p><p class="nt-summary">${subtitulo}</p>${opcoes}${consent}${entradas}${cobertura}${aviso}${fonteAviso}</div><div class="nt-hero-actions">${primary}${secondary}<span class="nt-action-feedback" aria-live="polite"></span></div></div><div class="nt-grid"><section class="nt-panel nt-panel--source" aria-labelledby="nt-original-title"><div class="nt-panel-head"><span class="nt-index">01</span><div><p class="nt-eyebrow">FONTE</p><h2 id="nt-original-title">Original</h2></div></div><p>${original ? 'Áudio salvo neste dispositivo. Confira o trecho antes de agir.' : v.fonte.disponivel === false ? 'Áudio indisponível. Confira a causa acima.' : v.estado === 'gravando' ? 'Trecho em captura. Ouça o original completo após encerrar.' : 'O original aparece aqui após o salvamento confirmado.'}</p><div class="nt-rule"></div><div class="nt-panel-head"><span class="nt-index">02</span><div><p class="nt-eyebrow">TEXTO COM TEMPO</p><h2>Transcrição</h2></div></div><ol class="nt-timeline">${lista}</ol></section><aside class="nt-panel nt-panel--next" aria-labelledby="nt-next-title"><div class="nt-panel-head"><span class="nt-index">03</span><div><p class="nt-eyebrow">DEPOIS DA CONVERSA</p><h2 id="nt-next-title">Próximos passos</h2></div></div>${next}<p class="nt-footnote">Vínculos com pessoa e projeto são opcionais. Uma ação depende de trecho com áudio disponível.</p></aside></div>${captureBar}</section>`;
}

/** Monta a vista no contêiner e retorna { atualizar, destruir }. Callbacks não mudam o estado mostrado. */
export function montarVista(container, dto = {}, callbacks = {}) {
  if (!container || typeof container.addEventListener !== 'function') throw new TypeError('Contêiner DOM obrigatório');
  let current = prepararVista(dto);
  let serial = JSON.stringify(dto);
  let destroyed = false;
  let pendingFocus = null;
  let renderEpoch = 0;
  const pendingActions = new Set();
  const render = (animate = false) => {
    const active = container.contains(document.activeElement) ? document.activeElement : null;
    const action = active?.dataset?.action ?? pendingFocus?.action;
    const segmentId = active?.closest('[data-segment]')?.dataset.segment ?? pendingFocus?.segmentId;
    container.innerHTML = renderizarVista(current);
    renderEpoch += 1;
    pendingActions.clear();
    if (animate) container.querySelector('.nt-view')?.classList.add('nt-enter');
    else container.querySelector('.nt-state')?.setAttribute('aria-live', 'off');
    if (active || (pendingFocus && document.activeElement === document.body)) {
      const candidate = [...container.querySelectorAll('[data-action]')].find(node => node.dataset.action === action && node.closest('[data-segment]')?.dataset.segment === segmentId);
      (candidate || container.querySelector('.nt-state'))?.focus({preventScroll:true});
    }
    pendingFocus = null;
  };
  const handle = event => {
    const target = event.target.closest?.('[data-action]');
    if (!target || !container.contains(target) || target.disabled) return;
    const action = target.dataset.action;
    const segment = target.closest('[data-segment]');
    const item = current.trechos.find(t => String(t.id) === segment?.dataset.segment);
    if ((action === 'criar-acao' && !canProve(current, item || {})) || (action === 'corrigir' && !canCorrect(item)) || ((action === 'ouvir' || action === 'ouvir-trecho') && !canPlay(current))) return;
    const callback = callbacks[action];
    if (typeof callback !== 'function') return;
    const payload = Object.freeze({
      acao: action,
      sessaoId: current.id == null ? null : String(current.id),
      trechoId: item?.id == null ? null : String(item.id),
      inicio: item?.inicio == null ? null : String(item.inicio),
      entradaId: target.dataset.input ?? null
    });
    const epochAtClick = renderEpoch;
    const focusRequest = {action, segmentId: segment?.dataset.segment};
    pendingFocus = focusRequest;
    target.disabled = true;
    pendingActions.add(target);
    const feedback = container.querySelector('.nt-action-feedback');
    if (feedback) feedback.textContent = 'Aguardando atualização da sessão…';
    const isCurrent = () => !destroyed && renderEpoch === epochAtClick && container.contains(target);
    const finish = failed => {
      if (!isCurrent()) return;
      pendingActions.delete(target);
      target.disabled = false;
      if (pendingFocus === focusRequest) pendingFocus = null;
      if (document.activeElement === document.body) target.focus({preventScroll:true});
      if (feedback) feedback.textContent = failed ? 'Não foi possível concluir. Tente novamente.' : pendingActions.size ? 'Aguardando atualização da sessão…' : acoesLeitura.has(action) ? '' : 'Ainda sem confirmação da sessão. Você pode tentar novamente.';
    };
    Promise.resolve().then(() => { if (!destroyed) return callback(payload); }).then(() => finish(false), () => finish(true));
  };
  render();
  container.addEventListener('click', handle);
  return {
    atualizar(novoDto) {
      if (destroyed) return false;
      const novoSerial = JSON.stringify(novoDto);
      if (novoSerial === serial) return false;
      const previousState = current.estado;
      current = prepararVista(novoDto);
      serial = novoSerial;
      render(previousState !== current.estado);
      return true;
    },
    destruir() {
      if (destroyed) return;
      destroyed = true;
      pendingFocus = null;
      pendingActions.clear();
      container.removeEventListener('click', handle);
      container.replaceChildren();
    }
  };
}







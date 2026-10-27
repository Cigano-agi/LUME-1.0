(() => {
  const box = element('section', null, 'panel settings-card novidades-panel');
  box.id = 'novidades-panel';
  box.setAttribute('aria-labelledby', 'novidades-title');
  box.innerHTML = `
    <p class="eyebrow">OPCIONAL</p>
    <h2 id="novidades-title">Novidades do Lume</h2>
    <p>Receba avisos curtos sobre funções novas. Começa desligado.</p>
    <p class="novidades-separacao"><strong>Isso é separado do acompanhamento técnico.</strong> Não envia mensagens, contatos, buscas, aberturas ou cliques.</p>
    <div id="novidades-state" class="central-state" role="status" aria-live="polite">
      <span class="central-dot" aria-hidden="true"></span><span>Conferindo sua escolha…</span>
    </div>
    <form id="novidades-consent" class="novidades-consent" hidden>
      <label class="check central-check">
        <input id="novidades-confirm" type="checkbox">
        <span>Quero receber novidades dentro do Lume.<small>São no máximo avisos ocasionais. Você pode desligar quando quiser.</small></span>
      </label>
      <button class="primary" type="submit">Ativar novidades</button>
    </form>
    <div id="novidades-active" class="button-row" hidden>
      <button id="novidades-check" class="secondary" type="button">Conferir agora</button>
      <button id="novidades-off" class="text-button" type="button">Desligar novidades</button>
    </div>`;

  window.registrarAjuste(box, 'novidades-panel', 'data');

  const notice = element('aside', null, 'novidades-notice');
  notice.id = 'novidades-notice';
  notice.hidden = true;
  notice.setAttribute('role', 'region');
  notice.setAttribute('aria-labelledby', 'novidades-notice-title');
  notice.innerHTML = `<div><p class="eyebrow">NOVIDADE DO LUME</p><strong id="novidades-notice-title"></strong><p id="novidades-notice-text"></p></div><div class="button-row"><button id="novidades-action" class="primary" type="button" hidden>Ver atualizações</button><button id="novidades-dismiss" class="secondary" type="button">Entendi</button></div>`;
  document.body.append(notice);

  const state = $('novidades-state'), stateText = state.querySelector('span:last-child');
  const consent = $('novidades-consent'), active = $('novidades-active');
  const confirm = $('novidades-confirm'), check = $('novidades-check'), off = $('novidades-off');
  let busy = false, current = null;

  function setState(text, kind = '') {
    state.className = `central-state${kind ? ` is-${kind}` : ''}`;
    stateText.textContent = text;
  }

  function showNotice(comunicado) {
    if (!comunicado) return;
    $('novidades-notice-title').textContent = comunicado.titulo;
    $('novidades-notice-text').textContent = comunicado.texto;
    const action = $('novidades-action');
    action.hidden = comunicado.acao !== 'ver_atualizacoes';
    notice.hidden = false;
    window.lumeReveal?.(notice);
  }

  function render(data) {
    current = data;
    const enabled = data?.consentido === true;
    consent.hidden = enabled;
    active.hidden = !enabled;
    if (!enabled) setState('Novidades desligadas.', 'off');
    else if (!data.disponivel || data.situacao === 'indisponivel') setState('Sua escolha foi salva. Os avisos ainda não estão disponíveis nesta versão.', 'waiting');
    else if (data.situacao === 'comunicado') setState('Novidade recebida.', 'ok');
    else if (data.situacao === 'sem_novidades') setState('Tudo conferido. Nenhuma novidade agora.', 'ok');
    else setState('Novidades ativadas.', 'ok');
    showNotice(data?.comunicado);
  }

  async function load({ verify = false, silent = false } = {}) {
    if (busy) return;
    busy = true;
    check.disabled = off.disabled = true;
    try {
      let data = await api('/api/v3/novidades');
      if (verify && data.consentido && data.disponivel) data = await api('/api/v3/novidades/verificar', {});
      render(data);
    } catch (error) {
      if (!silent) setState(error.message || 'Não foi possível conferir agora. O Lume continua funcionando.', 'waiting');
    } finally {
      busy = false;
      check.disabled = off.disabled = false;
    }
  }

  consent.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (!confirm.checked) { feedback('Marque sua escolha para ativar as novidades.'); confirm.focus(); return; }
    busy = true;
    const button = consent.querySelector('button');
    button.disabled = true;
    try {
      let data = await api('/api/v3/novidades/ativar', { confirmar: true });
      if (data.consentido && data.disponivel) data = await api('/api/v3/novidades/verificar', {});
      render(data);
      confirm.checked = false;
      feedback('Novidades ativadas.');
    } catch (error) { setState(error.message, 'waiting'); }
    finally { busy = false; button.disabled = false; }
  });

  check.addEventListener('click', () => load({ verify: true }));
  off.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    off.disabled = true;
    try {
      render(await api('/api/v3/novidades/desativar', { confirmar: 'DESLIGAR' }));
      notice.hidden = true;
      feedback('Novidades desligadas.');
    } catch (error) { setState(error.message, 'waiting'); }
    finally { busy = false; off.disabled = false; }
  });
  $('novidades-dismiss').addEventListener('click', () => { notice.hidden = true; });
  $('novidades-action').addEventListener('click', () => {
    notice.hidden = true;
    run(() => window.abrirAjuste('atualizacoes-panel'));
  });

  window.carregarNovidades = () => load();
  setTimeout(() => load({ verify: true, silent: true }), 6000);
})();

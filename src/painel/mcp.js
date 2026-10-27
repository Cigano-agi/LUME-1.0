(() => {
  // Shared by the connection cards. A timeout never retries a mutation: its
  // server-side outcome may still need to be checked by the user.
  window.lumeConnectionRequest = async (path, body, {timeout = 15000, signal, raw = false} = {}) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', cancel, {once: true});
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('A resposta demorou mais que o esperado. O estado não foi confirmado. Atualize o estado antes de tentar novamente.');
        error.code = 'CONNECTION_TIMEOUT';
        reject(error); controller.abort();
      }, timeout);
    });
    try {
      return await Promise.race([expired, (async () => {
        const headers = token ? {'X-Assessor-Token': token} : {};
        const response = await fetch(path, {signal: controller.signal, headers: body === undefined ? headers : {...headers, 'Content-Type': 'application/json'}, ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)})});
        if (raw && response.ok) return {blob: await response.blob(), disposition: response.headers.get('Content-Disposition') || ''};
        const value = await response.json();
        if (!response.ok) {
          const error = new Error(value.erro || 'Não foi possível concluir. Tente novamente.');
          error.status = response.status; error.code = value.codigo; throw error;
        }
        return value;
      })()]);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    }
  };
  const request = (...args) => window.lumeConnectionRequest(...args);
  const TEST_PROMPT = 'Quais são minhas demandas de hoje?';
  const box = element('section', null, 'panel settings-card mcp-panel');
  box.id = 'mcp-panel';
  box.setAttribute('aria-labelledby', 'mcp-title');
  box.innerHTML = `
    <p class="eyebrow">CONEXÃO OPCIONAL</p>
    <h2 id="mcp-title">Claude Desktop</h2>
    <p>Para quem já usa o Claude. O Lume pessoal funciona com ChatGPT e Telegram, sem precisar desta conexão.</p>
    <details id="mcp-optional"><summary>Configurar acesso no Claude</summary>
    <p>Você pergunta no Claude Desktop. O Lume procura somente nas conversas de hoje e devolve as fontes.</p>
    <div class="mcp-privacy">
      <b>O que o Claude pode ver</b>
      <p>Somente resultados das conversas de hoje, quando você fizer uma pergunta. O acesso é de leitura e pode ser desligado aqui.</p>
    </div>
    <div class="mcp-privacy mcp-status-card">
      <div><h3>Claude Desktop</h3><p id="mcp-claude-status" role="status" aria-live="polite">Conferindo…</p></div>
      <span id="mcp-claude-pill" class="pill">CONFERINDO</span>
    </div>
    <label id="mcp-confirm-row" class="check mcp-confirm" hidden>
      <input id="mcp-confirm" type="checkbox">
      <span>Autorizo o Claude a consultar as conversas de hoje.<small>O Claude processa os trechos consultados conforme a conta usada nele.</small></span>
    </label>
    <div id="mcp-prepare-actions" class="button-row mcp-actions" hidden>
      <button id="mcp-activate" class="primary mcp-primary-next" type="button">Preparar acesso</button>
    </div>
    <div id="mcp-code-box" class="mcp-code-box" hidden>
      <p><strong>1. Copie este código agora.</strong> Ele aparece uma vez e será pedido durante a instalação.</p>
      <div><code id="mcp-code"></code><button id="mcp-copy" class="secondary" type="button">Copiar código</button></div>
    </div>
    <div id="mcp-download-actions" class="button-row mcp-actions" hidden>
      <button id="mcp-download" class="primary mcp-primary-next" type="button">2. Baixar extensão</button>
    </div>
    <details id="mcp-steps" class="mcp-steps" hidden>
      <summary>3. Instalar no Claude</summary>
      <ol>
        <li>No Claude Desktop, abra <strong>Configurações → Extensões → Configurações avançadas</strong>.</li>
        <li>Escolha <strong>Instalar extensão</strong> e abra o arquivo que acabou de baixar.</li>
        <li>Quando o Claude pedir, cole o código mostrado acima.</li>
        <li>Volte aqui e copie a pergunta de teste.</li>
      </ol>
      <p class="muted">O pacote está preparado para Windows e macOS. A instalação no Mac ainda precisa ser validada em um Mac.</p>
    </details>
    <div id="mcp-test-actions" class="button-row mcp-actions" hidden>
      <button id="mcp-test-prompt" class="primary mcp-primary-next" type="button">Copiar pergunta de teste</button>
    </div>
    <div id="mcp-help-actions" class="button-row mcp-actions" hidden>
      <button id="mcp-open-help" class="primary mcp-primary-next" type="button">Ver o que fazer</button>
    </div>
    <details id="mcp-troubleshoot" class="mcp-steps">
      <summary>Resolver problema</summary>
      <p id="mcp-compat-note" class="mcp-compat-note" role="status" aria-live="polite"></p>
      <p id="mcp-test-caveat" class="muted">O teste local verifica apenas o Lume neste computador. Ele não confirma uma conexão com o Claude Desktop.</p>
      <button id="mcp-self-test" class="secondary" type="button" hidden>Testar o Lume neste computador</button>
      <p id="mcp-test-result" class="mcp-test-result" role="status" aria-live="polite" hidden></p>
    </details>
    <details id="mcp-stop" class="mcp-stop" hidden>
      <summary>Desligar acesso do Claude</summary>
      <label class="check"><input id="mcp-stop-confirm" type="checkbox"><span>Quero desligar o acesso às minhas conversas.</span></label>
      <button id="mcp-revoke" class="secondary" type="button" disabled>Confirmar e desligar</button>
    </details>
    <div class="mcp-privacy">
      <div><h3>ChatGPT no Lume pessoal</h3><p>Conecte sua conta na seção Lume pessoal para conversar com o assistente pelo Telegram.</p></div><button id="mcp-open-pessoal" type="button" class="secondary">Abrir Lume pessoal</button>
    </div></details>`;

  window.registrarAjuste(box, 'mcp-panel', 'connections');
  $('mcp-open-pessoal').onclick=()=>{void window.abrirAjuste('pessoal-panel');};

  const status = $('mcp-claude-status');
  const pill = $('mcp-claude-pill');
  const compatNote = $('mcp-compat-note');
  const confirmRow = $('mcp-confirm-row');
  const confirm = $('mcp-confirm');
  const prepareActions = $('mcp-prepare-actions');
  const activate = $('mcp-activate');
  const codeBox = $('mcp-code-box');
  const code = $('mcp-code');
  const copy = $('mcp-copy');
  const downloadActions = $('mcp-download-actions');
  const download = $('mcp-download');
  const steps = $('mcp-steps');
  const testActions = $('mcp-test-actions');
  const testPrompt = $('mcp-test-prompt');
  const helpActions = $('mcp-help-actions');
  const openHelp = $('mcp-open-help');
  const troubleshoot = $('mcp-troubleshoot');
  const selfTest = $('mcp-self-test');
  const testResult = $('mcp-test-result');
  const stop = $('mcp-stop');
  const stopConfirm = $('mcp-stop-confirm');
  const revoke = $('mcp-revoke');
  let busy = false;
  let currentData = null;
  let activationCode = '';
  let packageDownloaded = false;
  let runtimeProblem = '';
  let retryAction = '';
  let loadFlight = null;

  function showOnlyPrimary(action) {
    prepareActions.hidden = action !== 'prepare';
    downloadActions.hidden = action !== 'download';
    testActions.hidden = action !== 'test';
    helpActions.hidden = action !== 'help';
  }

  function clearLocalTest() {
    testResult.hidden = true;
    testResult.className = 'mcp-test-result';
    testResult.textContent = '';
  }

  function render(data = currentData) {
    currentData = data;
    const claude = data?.clientes?.find(client => client.id === 'claude-desktop');
    const prepared = claude?.estado === 'preparado';
    const broken = claude?.estado === 'erro';
    const packageAvailable = claude?.pacote_disponivel === true;
    const compatible = claude?.sistema_compativel === true;
    const detected = claude?.instalacao === 'detectado';
    const canPrepare = packageAvailable && compatible;
    if (data?.activation_code) activationCode = data.activation_code;
    if (!prepared) {
      activationCode = '';
      packageDownloaded = false;
    }

    let uiState = 'desligado';
    if (broken || runtimeProblem || !claude || !canPrepare) uiState = 'erro';
    else if (prepared && packageDownloaded) uiState = 'pronto-para-teste';
    else if (prepared) uiState = 'preparado';
    else if (confirm.checked) uiState = 'autorizado';
    box.dataset.mcpState = uiState;

    if (uiState === 'erro') {
      status.textContent = broken ? 'O acesso precisa ser preparado de novo.' : 'O acesso precisa de atenção.';
      pill.textContent = 'PRECISA DE ATENÇÃO';
    } else if (uiState === 'pronto-para-teste') {
      status.textContent = 'Extensão baixada. Siga a instalação e teste no Claude.';
      pill.textContent = 'PRONTO PARA TESTAR';
    } else if (uiState === 'preparado') {
      status.textContent = activationCode ? 'Acesso preparado. Agora baixe a extensão.' : 'Acesso preparado. Gere um novo código para continuar.';
      pill.textContent = 'ACESSO PREPARADO';
    } else if (uiState === 'autorizado') {
      status.textContent = 'Autorização confirmada. Prepare o acesso.';
      pill.textContent = 'AUTORIZADO';
    } else {
      status.textContent = 'Acesso desligado.';
      pill.textContent = 'DESLIGADO';
    }
    pill.className = `pill${prepared ? ' is-active' : ''}`;

    if (runtimeProblem) {compatNote.textContent = runtimeProblem; troubleshoot.open = true;}
    else if (broken) compatNote.textContent = claude.problema || 'O acesso salvo não pôde ser lido. Prepare-o novamente.';
    else if (!claude) compatNote.textContent = 'Não foi possível conferir o acesso agora. Tente novamente.';
    else if (!packageAvailable) compatNote.textContent = 'A extensão do Lume não está disponível nesta instalação.';
    else if (!compatible) compatNote.textContent = 'Este sistema ainda não é compatível com a extensão do Lume.';
    else if (!detected) compatNote.textContent = 'O Claude Desktop não foi confirmado neste computador. Você pode preparar o acesso e instalar o Claude depois.';
    else compatNote.textContent = 'O Lume encontrou o Claude Desktop. A conexão só pode ser confirmada por um teste feito dentro do Claude.';

    confirmRow.hidden = prepared || !canPrepare;
    showOnlyPrimary(null);
    codeBox.hidden = !prepared || !activationCode;
    code.textContent = prepared ? activationCode : '';
    steps.hidden = !prepared || !packageDownloaded;
    if (steps.hidden) steps.open = false;
    stop.hidden = !prepared && !broken;
    selfTest.hidden = !prepared || !canPrepare;

    if (runtimeProblem && retryAction === 'prepare') showOnlyPrimary('prepare');
    else if (runtimeProblem && retryAction === 'download') showOnlyPrimary('download');
    else if (runtimeProblem || !claude || !canPrepare) showOnlyPrimary('help');
    else if (broken) showOnlyPrimary('prepare');
    else if (!prepared) showOnlyPrimary('prepare');
    else if (!activationCode) showOnlyPrimary('prepare');
    else if (!packageDownloaded) showOnlyPrimary('download');
    else showOnlyPrimary('test');

    activate.textContent = retryAction === 'prepare' ? 'Tentar preparar novamente' : broken ? 'Refazer acesso' : prepared ? 'Gerar novo código' : 'Preparar acesso';
    download.textContent = retryAction === 'download' ? 'Tentar baixar novamente' : '2. Baixar extensão';
    activate.disabled = busy || (!prepared && !confirm.checked);
    download.disabled = busy;
    testPrompt.disabled = busy;
    selfTest.disabled = busy;
    revoke.disabled = busy || !stopConfirm.checked;
  }

  function load() {
    if (loadFlight) return loadFlight;
    if (busy || document.hidden || !box.getClientRects().length || !$('mcp-optional').open) return Promise.resolve();
    busy = true;
    loadFlight = (async () => { try {
      runtimeProblem = '';
      retryAction = '';
      currentData = await request('/api/v3/mcp');
    } catch (error) {
      runtimeProblem = error.message;
      currentData = null;
    } finally {
      busy = false;
      render(currentData);
      loadFlight = null;
    } })();
    return loadFlight;
  }

  confirm.addEventListener('change', () => render());
  activate.addEventListener('click', async () => {
    if (busy) return;
    const claude = currentData?.clientes?.find(client => client.id === 'claude-desktop');
    const renew = claude?.estado === 'preparado' || claude?.estado === 'erro';
    if (!renew && !confirm.checked) return;
    busy = true;
    render();
    status.textContent = renew ? 'Gerando um novo código…' : 'Preparando acesso…';
    try {
      const data = await request('/api/v3/mcp/ativar-claude', { confirmar: true, renovar: renew });
      activationCode = data.activation_code || '';
      packageDownloaded = false;
      runtimeProblem = '';
      retryAction = '';
      confirm.checked = false;
      currentData = data;
      clearLocalTest();
      feedback(renew ? 'Novo código criado.' : 'Acesso preparado para hoje.');
    } catch (error) {
      runtimeProblem = error.message;
      retryAction = 'prepare';
    } finally {
      busy = false;
      render(currentData);
      if (activationCode) window.lumeScrollIntoView?.(codeBox, { smooth: true, block: 'nearest' });
    }
  });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code.textContent);
      feedback('Código copiado.');
    } catch {
      feedback('Não consegui copiar. Selecione o código e copie.');
    }
  });

  download.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render();
    try {
      const {blob, disposition} = await request('/api/v3/mcp/pacote', undefined, {raw: true, timeout: 30000});
      const name = disposition.match(/filename="(Lume-[0-9A-Za-z.-]+\.mcpb)"/)?.[1] || 'Lume.mcpb';
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      packageDownloaded = true;
      runtimeProblem = '';
      retryAction = '';
      feedback('Extensão pronta. Siga a instalação abaixo.');
    } catch (error) {
      runtimeProblem = error.message;
      retryAction = 'download';
    } finally {
      busy = false;
      render();
      if (packageDownloaded) {
        steps.open = true;
        window.lumeScrollIntoView?.(steps, { smooth: true, block: 'nearest' });
      }
    }
  });

  testPrompt.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(TEST_PROMPT);
      steps.open = true;
      feedback('Pergunta copiada. Cole no Claude para testar a conexão.');
    } catch {
      feedback(`Copie e envie no Claude: ${TEST_PROMPT}`);
    }
  });

  openHelp.addEventListener('click', () => {
    troubleshoot.open = true;
    if (runtimeProblem) void load();
    window.lumeScrollIntoView?.(troubleshoot, { smooth: true, block: 'nearest' });
  });

  selfTest.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    render();
    testResult.hidden = false;
    testResult.className = 'mcp-test-result';
    testResult.textContent = 'Testando pacote, configuração e leitura local…';
    try {
      const result = await request('/api/v3/mcp/testar-local', {}, {timeout: 30000});
      if (result?.ok !== true) throw new Error('O teste local não passou.');
      testResult.className = 'mcp-test-result is-ok';
      testResult.textContent = 'Teste local aprovado. Pacote, configuração e leitura local funcionam. Isso não confirma conexão com o Claude Desktop.';
    } catch (error) {
      testResult.className = 'mcp-test-result is-error';
      testResult.textContent = error.message;
    } finally {
      busy = false;
      render();
    }
  });

  stopConfirm.addEventListener('change', () => render());
  revoke.addEventListener('click', async () => {
    if (!stopConfirm.checked || busy) return;
    busy = true;
    render();
    try {
      const data = await request('/api/v3/mcp/revogar-claude', { confirmar: 'DESLIGAR' });
      activationCode = '';
      packageDownloaded = false;
      runtimeProblem = '';
      retryAction = '';
      stopConfirm.checked = false;
      stop.open = false;
      currentData = data;
      clearLocalTest();
      feedback('Acesso do Claude desligado.');
    } catch (error) {
      runtimeProblem = error.message;
      retryAction = 'revoke';
    } finally {
      busy = false;
      render(currentData);
    }
  });

  window.carregarMcp = load;
  $('mcp-optional').addEventListener('toggle', () => {if ($('mcp-optional').open) void load();});
})();

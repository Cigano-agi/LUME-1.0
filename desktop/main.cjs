const { app, BrowserWindow, utilityProcess, dialog, session, safeStorage, Notification, shell, ipcMain, screen, powerMonitor } = require('electron');
const identidadeLume = require('./identidade.cjs');
app.setAboutPanelOptions({applicationName:identidadeLume.TITULO,applicationVersion:identidadeLume.VERSAO_COMERCIAL,version:identidadeLume.VERSAO_TECNICA,iconPath:require('node:path').join(__dirname,'icon.png')});
const {criarCompanheiro}=require('./companheiro-window.cjs');
const { criarConversorAudio } = require('./audio-converter.cjs');
const { linkChatGPTPermitido } = require('./chatgpt-links.cjs');
const { join, parse, relative, sep, isAbsolute, normalize } = require('node:path');
const { pathToFileURL } = require('node:url');
const { existsSync, lstatSync, mkdirSync } = require('node:fs');
const { criarCofre } = require('./segredos.cjs');
const { downloadPermitido } = require('./downloads.cjs');
const { criarNotificacoes, acaoIdValido } = require('./notificacoes.cjs');
const { autoUpdater } = require('electron-updater');
const { criarAtualizador, carregarPoliticaRelease, politicaDesligada } = require('./atualizacoes.cjs');
const { criarClienteCentral } = require('./central-pulso.cjs');
const { criarCofreCentral, criarTransporteCentral, executarComandoCentral } = require('./central-runtime.cjs');
const { criarUtilityLifecycle } = require('./utility-lifecycle.cjs');
const { criarControladorManutencao } = require('./maintenance-controller.cjs');
const { brokerBlockedByLocalPolicy } = require('./sac-fallback.cjs');

app.setName('Lume');
app.setAppUserModelId('com.readyworks.assessor');
function prepararRaiz(userData) {
  if (!isAbsolute(userData) || normalize(userData) !== userData)
    throw Object.assign(new Error('PERFIL_CAMINHO_INVALIDO'), { code: 'PERFIL_CAMINHO_INVALIDO' });
  const root = parse(userData).root, segments = relative(root, userData).split(sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || i !== segments.length - 1)
        throw Object.assign(new Error('PERFIL_CAMINHO_INVALIDO'), { code: 'PERFIL_CAMINHO_INVALIDO' });
      mkdirSync(current); info = lstatSync(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw Object.assign(new Error('PERFIL_CAMINHO_INVALIDO'), { code: 'PERFIL_CAMINHO_INVALIDO' });
  }
}
const userData = process.env.ASSESSOR_DESKTOP_TEST_PROFILE || join(app.getPath('appData'), 'AssessorDesktop');
let rootReady = false;
try { prepararRaiz(userData); app.setPath('userData', userData); rootReady = true; }
catch (error) {
  dialog.showErrorBox('Falha ao abrir o Lume', error?.code === 'PERFIL_CAMINHO_INVALIDO'
    ? 'PERFIL_CAMINHO_INVALIDO: A seleção do perfil precisa ser verificada.'
    : 'PERFIL_VERIFICACAO_FALHOU: O Lume não conseguiu verificar o perfil.');
  app.quit();
}

const maintenanceFile = join(__dirname, 'maintenance.html');
const maintenanceURL = pathToFileURL(maintenanceFile).href;
const brokerModulePromise = import('../src/mcp/desktop-broker.js');
const perfilBootPromise = import('../src/perfil-boot.js');
let janela, active, controller, selection, cofre, avisos, atualizador, central, companheiro;
const conversorAudio = criarConversorAudio({BrowserWindow});
let decision = 'idle', saindo = false, liberarSaida = false, encerrado = false;
let shutdownPromise, shutdownGate, viewMode = 'web', generationNumber = 0;
let whatsappEstadoCentral = 'nao_informado';
const estadosWhatsappCentral = new Set(['nao_informado','conectado','pareando','pausado','erro']);
const current = gen => active === gen;
const canAnswer = gen => current(gen) && decision === 'idle' && !saindo;

function reserve(reason) {
  if (decision !== 'idle') return false;
  decision = reason;
  return true;
}
function allowedNavigation(raw) {
  if (viewMode === 'local') return raw === maintenanceURL;
  if (!active?.origin) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      !url.username && !url.password && url.origin === active.origin;
  } catch { return false; }
}
function ensureWindow() {
  if (janela && !janela.isDestroyed()) return janela;
  janela = new BrowserWindow({ width: 1320, height: 880, minWidth: 820, minHeight: 650, show: false,
    title: identidadeLume.TITULO, icon: join(__dirname, 'icon.png'), backgroundColor: '#101310', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: false } });
  janela.webContents.setWindowOpenHandler(({url}) => {
    // Explicit user navigation in the product. Automation never opens a personal browser.
    if (canAnswer(active) && allowedNavigation(janela.webContents.getURL()) && linkChatGPTPermitido(url))
      void shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  janela.webContents.on('will-navigate', (event, url) => { if (!allowedNavigation(url)) event.preventDefault(); });
  janela.webContents.on('will-attach-webview', event => event.preventDefault());
  janela.once('ready-to-show', () => { if (!saindo && janela && !janela.isDestroyed()) janela.show(); });
  janela.on('close', event => {
    if (decision === 'manutencao' && !liberarSaida) {
      event.preventDefault(); controller?.requestQuit();
    }
  });
  janela.on('closed', () => { janela = null; if (!liberarSaida) app.quit(); });
  return janela;
}
async function mostrarLocal() {
  const window = ensureWindow();
  viewMode = 'local';
  await window.loadFile(maintenanceFile);
  if (window.isDestroyed() || window.webContents.getURL() !== maintenanceURL)
    throw new Error('MANUTENCAO_PAGINA_LOCAL_FALHOU');
  renderMaintenanceState(controller?.state());
}
function renderMaintenanceState(phase) {
  if (viewMode !== 'local' || !janela || janela.isDestroyed()) return;
  const script = phase === 'incerto'
    ? "document.documentElement.dataset.maintenanceState='incerto'"
    : "document.documentElement.dataset.maintenanceState='working'";
  try { const result = janela.webContents.executeJavaScript?.(script); void result?.catch(() => {}); } catch {}
}
function installSessionGuards() {
  session.defaultSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event, item, webContents) => {
    const origin = viewMode === 'web' ? active?.origin : null;
    if (!origin || !downloadPermitido({ janelaCorreta: Boolean(janela && webContents === janela.webContents),
      url: item.getURL(), nome: item.getFilename(), origem: origin })) { event.preventDefault(); return; }
    const mcpb = item.getFilename().endsWith('.mcpb');
    const backupV10 = item.getFilename().endsWith('.lumebak');
    item.setSaveDialogOptions({ title: 'Salvar arquivo do Lume',
      defaultPath: join(app.getPath('downloads'), item.getFilename()),
      filters: [mcpb ? { name: 'Extensão do Claude', extensions: ['mcpb'] }
        : backupV10 ? { name: 'Backup Lume', extensions: ['lumebak'] }
          : { name: 'Arquivo JSON', extensions: ['json'] }] });
  });
}
function estadoOperacionalCentral() {
  const atual = atualizador?.estado?.() || {}, estados = new Set(['em_dia','disponivel','baixando','pronta','erro']);
  const estadoAtualizacao = estados.has(atual.estado) ? atual.estado : 'em_dia';
  const codigos = { REDE_INDISPONIVEL:'SEM_REDE', ASSINATURA_INVALIDA:'ASSINATURA_INVALIDA',
    DOWNLOAD_FALHOU:'DOWNLOAD_FALHOU', INSTALACAO_FALHOU:'INSTALACAO_FALHOU' };
  return { estadoAtualizacao, whatsappEstado: whatsappEstadoCentral,
    ...(estadoAtualizacao === 'erro' ? { codigoErro: codigos[atual.codigoErro] || 'ATUALIZADOR_INDISPONIVEL' } : {}) };
}
function setupShared() {
  cofre = criarCofre(join(userData, 'credenciais'), safeStorage);
  const politica = app.isPackaged && !process.env.ASSESSOR_DESKTOP_TEST_PROFILE
    ? carregarPoliticaRelease(join(__dirname, 'release-policy.json')) : politicaDesligada();
  atualizador = criarAtualizador(autoUpdater, { versaoAtual: app.getVersion(), politica,
    onState: estado => { if (canAnswer(active)) try { active.worker?.postMessage({ tipo:'atualizacao-estado', estado }); } catch {} } });
  try {
    central = criarClienteCentral({
      cofre: criarCofreCentral(join(userData, 'credenciais'), safeStorage),
      enviar: criarTransporteCentral(), versao: app.getVersion(), canal: politica.channel || 'beta',
      plataforma: process.platform, arquitetura: process.arch, lerEstado: estadoOperacionalCentral
    });
  } catch { central = null; }
}
function environment() {
  const env = Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PATH','HOME']
    .filter(k => process.env[k]).map(k => [k, process.env[k]]));
  // The selected profile remains fixed across every generation.
  return perfilBootPromise.then(({ envelopeLegado }) => {
    Object.assign(env, envelopeLegado(userData, selection));
    const laya = join(process.resourcesPath, 'laya');
    if (app.isPackaged && existsSync(join(laya, 'lume-laya-manifest.json'))) env.LUME_LAYA_BUNDLED_DIR = laya;
    if (app.isPackaged) env.LUME_AUDIO_BUNDLED_DIR = join(process.resourcesPath, 'audio-local');
    env.LUME_NOTIFICACOES_SUPORTADAS = avisos.disponivel() ? '1' : '0';
    env.LUME_ATUALIZACOES_SUPORTADAS = atualizador.estado().disponivel ? '1' : '0';
    return env;
  });
}
function rejeitarPreferencias(gen){for(const p of gen?.preferenciasCompanheiro?.values()||[]){clearTimeout(p.timer);p.reject(Error('Lume indisponível.'));}gen?.preferenciasCompanheiro?.clear();}
function stopSideEffects() { avisos?.encerrar(); central?.encerrar(); conversorAudio.encerrar(); companheiro?.encerrar(); rejeitarPreferencias(active); }

function iniciarEncerramento(reason, alreadyReserved = false) {
  if (decision === 'manutencao') { controller?.requestQuit(); return Promise.resolve(false); }
  if (shutdownPromise) return shutdownPromise;
  if (!alreadyReserved && !reserve(reason)) return Promise.resolve(false);
  if (alreadyReserved && decision !== reason) return Promise.resolve(false);
  saindo = true;
  const gen = active;
  gen?.broker?.stopAdmission();
  gen?.lifecycle?.iniciar(reason);
  stopSideEffects(); atualizador?.encerrar();
  shutdownPromise = (async () => {
    const { createShutdownGate } = await brokerModulePromise;
    shutdownGate = createShutdownGate({ install: () => atualizador.instalarAgora(),
      onDone: ({ reason: ended, confirmed }) => {
        encerrado = true; liberarSaida = true;
        if (ended === 'instalar' && !confirmed)
          dialog.showErrorBox('Não foi possível atualizar', 'Abra o Lume novamente e tente a atualização em Ajustes.');
        app.quit();
      } });
    const settled = shutdownGate.request(reason);
    if (!gen) { shutdownGate.report('utility', true); shutdownGate.report('broker', true); return settled; }
    void gen.terminal.then(result => shutdownGate.report('utility', result.confirmado === true && result.code === 0));
    void (async () => {
      try { await gen.startPromise; } catch {}
      try { shutdownGate.report('broker', gen.broker ? (await gen.broker.shutdown()).confirmed : true); }
      catch { shutdownGate.report('broker', false); }
    })();
    return settled;
  })().catch(() => { liberarSaida = true; app.quit(); return false; });
  return shutdownPromise;
}

function answer(gen, message) { if (current(gen)) try { gen.worker.postMessage(message); } catch {} }
function rejectLate(gen, message) {
  if (message?.tipo === 'selecionar-projeto' && typeof message.id === 'string')
    answer(gen, { tipo:'selecionar-projeto-resposta', id:message.id, erro:'SELETOR_INDISPONIVEL' });
  if (message?.tipo === 'central-comando' && typeof message.id === 'string')
    answer(gen, { tipo:'central-resposta', id:message.id, erro:'CENTRAL_INDISPONIVEL' });
  if (message?.tipo === 'atualizacao-comando' && typeof message.id === 'string')
    answer(gen, { tipo:'atualizacao-resposta', id:message.id, erro:'ATUALIZACAO_FALHOU' });
  if (message?.tipo === 'segredo' && typeof message.id === 'string')
    answer(gen, { tipo:'segredo-resposta', id:message.id, erro:'O Lume está encerrando.' });
}
let atividadeSuspensa=false;
function publicarSistemaAtividade(){
  try{const bloqueado=powerMonitor.getSystemIdleState(60)==='locked';
    if(active?.worker)active.worker.postMessage({tipo:'atividade-sistema',pausado:atividadeSuspensa||bloqueado});
  }catch{try{active?.worker?.postMessage({tipo:'atividade-sistema',pausado:true});}catch{}}
}
function handleMessage(gen, message) {
  if (!current(gen)) return;
  if(message?.tipo==='companheiro-estado'){
    if(!saindo){gen.companheiroEstado=message.estado;if(canAnswer(gen)&&gen.ready)companheiro?.atualizar(message.estado);}
    return;
  }
  if(message?.tipo==='companheiro-preferencia-resposta'){
    const pending=gen.preferenciasCompanheiro?.get(message.id);
    if(pending){clearTimeout(pending.timer);gen.preferenciasCompanheiro.delete(message.id);
      if(canAnswer(gen)&&message.ok===true)pending.resolve(true);else pending.reject(Error('Não foi possível salvar a preferência.'));}
    return;
  }
  if (gen.lifecycle.receber(message)) return;
  if (message?.tipo === 'perfil-erro') {
    gen.profileError = true;
    answer(gen, { tipo:'perfil-erro-recebido' });
    if (!gen.ready) gen.rejectReady(new Error('PERFIL_UTILITY_ERRO'));
    gen.lifecycle.iniciar('normal');
    void perfilBootPromise.then(({ erroPublicoPerfil }) => {
      if (!current(gen)) return;
      const safe = erroPublicoPerfil({ code: message.codigo });
      dialog.showErrorBox('Falha ao abrir o Lume', `${safe.code}: ${safe.message}`);
      void iniciarEncerramento('normal');
    });
    return;
  }
  if (message?.tipo === 'pronto' && Number.isInteger(message.porta) && message.porta >= 1 &&
      message.porta <= 65535 && !gen.ready) {
    gen.ready = true; clearTimeout(gen.bootTimer);
    gen.origin = `http://127.0.0.1:${message.porta}`;
    publicarSistemaAtividade();
    gen.resolveReady();
    return;
  }
  if (!canAnswer(gen)) { rejectLate(gen, message); return; }
  if (message?.tipo === 'selecionar-projeto' && typeof message.id === 'string' && /^[0-9a-f-]{36}$/i.test(message.id)) {
    const window = ensureWindow();
    void dialog.showOpenDialog(window, { title: 'Escolha a pasta do projeto', properties: ['openDirectory'] })
      .then(result => { if (canAnswer(gen)) answer(gen, { tipo:'selecionar-projeto-resposta', id:message.id,
        caminho: result.canceled ? null : result.filePaths[0] || null }); })
      .catch(() => { if (canAnswer(gen)) answer(gen, { tipo:'selecionar-projeto-resposta', id:message.id, erro:'SELETOR_INDISPONIVEL' }); });
    return;
  }
  if (message?.tipo === 'central-operacional' && estadosWhatsappCentral.has(message.whatsappEstado)) {
    whatsappEstadoCentral = message.whatsappEstado; return;
  }
  if (message?.tipo === 'central-comando' && typeof message.id === 'string') {
    if (!central) { rejectLate(gen, message); return; }
    executarComandoCentral(central, message).then(response => {
      if (canAnswer(gen) && response) answer(gen, response);
    }).catch(() => { if (canAnswer(gen)) answer(gen, { tipo:'central-resposta', id:message.id, erro:'CENTRAL_INDISPONIVEL' }); });
    return;
  }
  if (message?.tipo === 'atualizacao-comando' && typeof message.id === 'string') {
    const responder = (estado, erro) => { if (current(gen)) answer(gen, { tipo:'atualizacao-resposta', id:message.id, estado, erro }); };
    if (message.acao === 'consultar') { responder(atualizador.estado()); return; }
    if (message.acao === 'instalar') {
      if (!reserve('instalar')) { responder(atualizador.estado(), 'ATUALIZACAO_FALHOU'); return; }
      try { const estado = atualizador.prepararInstalacao(); responder(estado); void iniciarEncerramento('instalar', true); }
      catch { decision = 'idle'; responder(atualizador.estado(), 'ATUALIZACAO_FALHOU'); }
      return;
    }
    if (!['verificar','baixar'].includes(message.acao)) { responder(atualizador.estado(), 'ACAO_INVALIDA'); return; }
    atualizador[message.acao]().then(estado => { if (canAnswer(gen)) responder(estado); })
      .catch(() => { if (canAnswer(gen)) responder(atualizador.estado(), 'ATUALIZACAO_FALHOU'); });
    return;
  }
  if (message?.tipo === 'lembrete-cancelar') { avisos.cancelar(); return; }
  if (message?.tipo === 'lembrete' && typeof message.id === 'string' && message.id.length <= 64 &&
      ['contato','acao','captura'].includes(message.categoria) &&
      (message.categoria !== 'acao' || acaoIdValido(message.acaoId) && typeof message.som === 'boolean')) {
    avisos.mostrar({ teste:message.teste === true, categoria:message.categoria,
      acaoId:message.acaoId, som:message.som !== false }).then(result => {
      if (canAnswer(gen) && !encerrado) answer(gen, { tipo:'lembrete-resposta', id:message.id, resultado:result.resultado });
    }).catch(() => {});
    return;
  }
  if (message?.tipo === 'segredo' && typeof message.id === 'string') {
    if (message.operacao === 'audio-converter') {
      void conversorAudio.converter(message.valor).then(valor => {
        if (canAnswer(gen)) answer(gen, {tipo:'segredo-resposta',id:message.id,valor});
      }).catch(() => {
        if (canAnswer(gen)) answer(gen, {tipo:'segredo-resposta',id:message.id,erro:'AUDIO_CONVERSAO_INDISPONIVEL'});
      });
      return;
    }
    try { answer(gen, { tipo:'segredo-resposta', id:message.id, valor:cofre.executar(message.operacao, message.valor) }); }
    catch { answer(gen, { tipo:'segredo-resposta', id:message.id, erro:String(message.operacao).startsWith('f10-')
      ? 'Não foi possível acessar a identidade protegida. Confira a proteção do sistema.'
      : 'Não foi possível acessar a credencial protegida. Configure sua chave ou confira a proteção do sistema.' }); }
    return;
  }
}

async function startGeneration({ abortSignal } = {}) {
  const gen = { id: ++generationNumber, broker:null, worker:null, lifecycle:null,
    origin:null, ready:false, terminalResult:null, bootTimer:null,preferenciasCompanheiro:new Map(),sequenciaPreferencia:0,companheiroEstado:null };
  active = gen;
  companheiro=criarCompanheiro({BrowserWindow,ipcMain,screen,
    limites:()=>janela&&!janela.isDestroyed()?janela.getBounds():null,
    abrir:assuntoId=>{if(!canAnswer(gen))return;const window=ensureWindow();if(window.isMinimized())window.restore();window.show();window.focus();
      if(typeof assuntoId!=='string'||!/^acao:[0-9a-f-]{36}$/i.test(assuntoId)||!acaoIdValido(assuntoId.slice(5)))return;
      const abrir=()=>{if(canAnswer(gen)&&!window.isDestroyed())window.webContents.executeJavaScript(`window.LumeVivo?.abrirAssunto(${JSON.stringify(assuntoId)})`).catch(()=>{});};
      if(window.webContents.isLoading())window.webContents.once('did-finish-load',abrir);else abrir();},
    configurar:config=>{
      if(!canAnswer(gen)||!gen.worker)throw Error('Lume indisponível.');
      return new Promise((resolve,reject)=>{
        const id=String(gen.id)+':'+String(++gen.sequenciaPreferencia);
        const timer=setTimeout(()=>{gen.preferenciasCompanheiro.delete(id);reject(Error('Não foi possível confirmar a preferência.'));},10000);timer.unref?.();
        gen.preferenciasCompanheiro.set(id,{resolve,reject,timer});
        try{gen.worker.postMessage({tipo:'companheiro-preferencia',id,config});}
        catch{clearTimeout(timer);gen.preferenciasCompanheiro.delete(id);reject(Error('Lume indisponível.'));}
      });
    }
  });
  avisos = criarNotificacoes(Notification, { focar: destino => {
    if (!canAnswer(gen) || !janela) return;
    if (janela.isMinimized()) janela.restore(); janela.show(); janela.focus();
    if (!acaoIdValido(destino?.acaoId)) return;
    const abrir = () => { if (canAnswer(gen)) janela?.webContents.executeJavaScript(
      `window.abrirAcaoDoAviso(${JSON.stringify(destino.acaoId)})`).catch(() => {}); };
    if (janela.webContents.isLoading()) janela.webContents.once('did-finish-load', abrir); else abrir();
  } });
  const ready = new Promise((resolve, reject) => { gen.resolveReady = resolve; gen.rejectReady = reject; });
  gen.terminal = new Promise(resolve => { gen.resolveTerminal = resolve; });
  const abort = () => {
    gen.broker?.stopAdmission();
    gen.lifecycle?.iniciar('normal');
    if (gen.worker && !gen.ready) gen.rejectReady(new Error('BOOT_CANCELADO'));
  };
  abortSignal?.addEventListener('abort', abort, { once:true });
  gen.startPromise = (async () => {
    try {
      const env = await environment();
      if (abortSignal?.aborted || !current(gen) || (decision !== 'idle' && decision !== 'manutencao')) throw Error('BOOT_CANCELADO');
      gen.worker = utilityProcess.fork(join(__dirname, 'service.js'), [],
        { env, stdio:'pipe', serviceName:'Lume — memória local' });
      gen.lifecycle = criarUtilityLifecycle({ worker:gen.worker, selection,
        onTerminal: result => {
          rejeitarPreferencias(gen);
          clearTimeout(gen.bootTimer);
          gen.terminalResult = result;
          gen.resolveTerminal(result);
          if (!gen.ready) gen.rejectReady(new Error('UTILITY_BOOT_TERMINAL'));
          if (!current(gen)) return;
          if (decision === 'idle' && !gen.profileError) {
            dialog.showErrorBox('A captura foi interrompida',
              `O núcleo encerrou (código ${result.code}). Abra o Lume novamente para retomar.`);
            void iniciarEncerramento('normal');
          }
        } });
      gen.worker.on('message', message => handleMessage(gen, message));
      gen.worker.on('exit', code => gen.lifecycle.sair(code));
      gen.worker.stderr?.on('data', data => process.stderr.write(data));
      gen.bootTimer = setTimeout(() => {
        if (!current(gen) || gen.ready) return;
        try { gen.worker.kill(); } catch {}
        gen.lifecycle.falhar('boot-timeout');
      }, 30000);
      await ready;
      if (abortSignal?.aborted || !current(gen) || (decision !== 'idle' && decision !== 'manutencao')) throw Error('BOOT_CANCELADO');
      if (brokerBlockedByLocalPolicy(process.resourcesPath)) {
        // No port or descriptor is created. Maintenance still needs a shutdown receipt.
        gen.broker = { stopAdmission() {}, shutdown: async () => ({ confirmed:true }) };
        process.stderr.write('Lume: conector MCP indisponivel neste PC por bloqueio do Windows.\n');
      } else {
        const { createDesktopBroker } = await brokerModulePromise;
        gen.broker = createDesktopBroker({ userData, selection });
        await gen.broker.start();
      }
      if (abortSignal?.aborted || !current(gen) || (decision !== 'idle' && decision !== 'manutencao')) throw Error('BOOT_CANCELADO');
      viewMode = 'web';
      await ensureWindow().loadURL(gen.origin + '/app');
      if (abortSignal?.aborted || !current(gen) || decision === 'normal' || decision === 'instalar') throw Error('BOOT_CANCELADO');
      if (decision === 'idle') {
        if(gen.companheiroEstado)companheiro?.atualizar(gen.companheiroEstado);
        central?.iniciar();
        atualizador.iniciarAutomatico();
      }
      // This controller is local to the generation. There is deliberately no renderer trigger.
      controller = criarControladorManutencao({ userData, selection,
        getBroker: () => gen.broker,
        getUtility: () => ({ lifecycle:gen.lifecycle, terminal:gen.terminal }),
        reserve: reason => {
          if (!current(gen) || !reserve(reason)) return false;
          stopSideEffects();
          return true;
        },
        mostrarLocal,
        onState:renderMaintenanceState,
        restart: async ({ quitSignal } = {}) => {
          const restarted = await startGeneration({ abortSignal:quitSignal });
          if (restarted?.aborted) return;
          if (quitSignal?.aborted) {
            restarted.broker.stopAdmission();
            restarted.lifecycle.iniciar('normal');
            const [brokerEnd, utilityEnd] = await Promise.all([restarted.broker.shutdown(), restarted.terminal]);
            if (brokerEnd.confirmed !== true || utilityEnd.confirmado !== true)
              throw Error('QUIT_FECHAMENTO_INCERTO');
            await mostrarLocal();
            return;
          }
          decision = 'idle';
          if(restarted.companheiroEstado)companheiro?.atualizar(restarted.companheiroEstado);
          central?.iniciar();
          atualizador.iniciarAutomatico();
        },
        onQuitReady: () => { liberarSaida = true; app.quit(); } });
      return gen;
    } catch (error) {
      gen.broker?.stopAdmission();
      if (gen.worker && !gen.lifecycle) {
        try { gen.worker.kill(); } catch {}
        gen.terminalResult = { confirmado:false, code:null };
        gen.resolveTerminal(gen.terminalResult);
      } else if (!gen.worker) {
        gen.terminalResult = { confirmado:true, code:0, absent:true };
        gen.resolveTerminal(gen.terminalResult);
      }
      if (gen.lifecycle && !gen.terminalResult) gen.lifecycle.iniciar('normal');
      const [brokerEnd, utilityEnd] = await Promise.allSettled([
        gen.broker ? gen.broker.shutdown() : Promise.resolve({ confirmed:true }), gen.terminal
      ]);
      if (decision === 'manutencao') await mostrarLocal().catch(() => {});
      if (abortSignal?.aborted && brokerEnd.status === 'fulfilled' && brokerEnd.value?.confirmed === true &&
          utilityEnd.status === 'fulfilled' && utilityEnd.value?.confirmado === true) return { aborted:true };
      throw error;
    } finally {
      abortSignal?.removeEventListener('abort', abort);
    }
  })();
  return gen.startPromise;
}

// Kept private for the later content operation. It has no IPC, HTTP, or environment entry point.
function iniciarManutencaoInterna(opId) {
  if (!controller || decision !== 'idle') return Promise.reject(new Error('MANUTENCAO_INDISPONIVEL'));
  return controller.beginMaintenance({ opId, kind:'notetaker-delete' });
}
void iniciarManutencaoInterna;

const first = rootReady && app.requestSingleInstanceLock();
if (!first) app.quit();
else {
  app.on('second-instance', () => {
    if (decision === 'idle' && janela) {
      if (janela.isMinimized()) janela.restore(); janela.show(); janela.focus();
    }
  });
  app.whenReady().then(async () => {
    for(const event of ['suspend','lock-screen'])powerMonitor.on(event,()=>{atividadeSuspensa=true;publicarSistemaAtividade();});
    for(const event of ['resume','unlock-screen'])powerMonitor.on(event,()=>{atividadeSuspensa=false;publicarSistemaAtividade();});
    const { selecionarPerfilBoot } = await perfilBootPromise;
    selection = await selecionarPerfilBoot(userData);
    if (saindo) return;
    installSessionGuards();
    setupShared();
    await startGeneration();
  }).catch(async error => {
    if (decision === 'manutencao') return; // The local page remains, with no automatic restart.
    if (saindo) return;
    let safe = { code:'PERFIL_VERIFICACAO_FALHOU', message:'O Lume não conseguiu verificar o perfil.' };
    try { const { erroPublicoPerfil } = await perfilBootPromise; safe = erroPublicoPerfil(error); } catch {}
    dialog.showErrorBox('Falha ao abrir o Lume', `${safe.code}: ${safe.message}`);
    void iniciarEncerramento('normal');
  });
  app.on('before-quit', event => {
    if (liberarSaida || encerrado) return;
    event.preventDefault();
    void iniciarEncerramento('normal');
  });
}

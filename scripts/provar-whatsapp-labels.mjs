import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONFIRMACAO_LITERAL = 'CONTA BUSINESS DE TESTE - ACEITO MUTACOES TEMPORARIAS';
export const STATUS_PROVA = Object.freeze({
  APROVADO: 'APROVADO',
  REPROVADO: 'REPROVADO',
  INCONCLUSIVO: 'INCONCLUSIVO',
  NAO_EXECUTADO: 'NAO EXECUTADO'
});

export const EVIDENCIA_INICIO = '<!-- LUME:WHATSAPP-LABELS-PROOF:BEGIN -->';
export const EVIDENCIA_FIM = '<!-- LUME:WHATSAPP-LABELS-PROOF:END -->';

const CODIGOS_PERMITIDOS = new Set([
  'CONNECTION_OPEN', 'CONNECTION_TIMEOUT', 'CONNECTION_CANCELED', 'CONNECTION_FAILED',
  'CREATE_CALL_OK', 'CREATE_CALL_FAILED', 'DEFINITION_EVENT_OK', 'DEFINITION_EVENT_MISSING',
  'ASSOCIATE_CALL_OK', 'ASSOCIATE_CALL_FAILED', 'ASSOCIATION_EVENT_OK', 'ASSOCIATION_EVENT_MISSING',
  'PHONE_VISIBLE_OK', 'PHONE_VISIBLE_NO', 'PHONE_VISIBLE_UNCONFIRMED',
  'REMOVE_ASSOCIATION_CALL_OK', 'REMOVE_ASSOCIATION_CALL_FAILED',
  'ASSOCIATION_CLEANUP_EVENT_OK', 'ASSOCIATION_CLEANUP_EVENT_MISSING',
  'REMOVE_DEFINITION_CALL_OK', 'REMOVE_DEFINITION_CALL_FAILED',
  'DEFINITION_CLEANUP_EVENT_OK', 'DEFINITION_CLEANUP_EVENT_MISSING',
  'PHONE_CLEAN_OK', 'PHONE_CLEAN_NO', 'PHONE_CLEAN_UNCONFIRMED',
  'OPERATION_TIMEOUT', 'OPERATION_CANCELED', 'TRIAL_ERROR', 'PROFILE_RETAINED', 'PROFILE_REMOVED'
]);

const PRODUTOS_PROTEGIDOS = ['data', 'wa-auth'];
const MARCADOR_PERFIL = '.lume-label-proof-owner';
const DEFAULT_CONNECTION_TIMEOUT_MS = 120_000;
const DEFAULT_EVENT_TIMEOUT_MS = 30_000;

export class ProvaLabelsErro extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProvaLabelsErro';
    this.code = code;
  }
}

const abortError = () => Object.assign(new Error('Operacao cancelada.'), { name: 'AbortError' });

function caminhoDentro(caminho, raiz) {
  const trecho = relative(raiz, caminho);
  return trecho === '' || (!trecho.startsWith('..') && !isAbsolute(trecho));
}

function caminhoNormalizado(caminho) {
  const absoluto = resolve(caminho);
  return process.platform === 'win32' ? absoluto.toLowerCase() : absoluto;
}

async function existe(fs, caminho) {
  try { await fs.lstat(caminho); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

/**
 * Cria e toma posse de um perfil descartavel. O destino precisa ser um filho
 * direto, ainda inexistente, do diretorio temporario fisico do sistema.
 */
export async function prepararPerfilIsolado(caminho, {
  fs = fsPromises,
  tempRoot = tmpdir(),
  cwd = process.cwd(),
  env = process.env
} = {}) {
  if (typeof caminho !== 'string' || !isAbsolute(caminho)) {
    throw new ProvaLabelsErro('PROFILE_NOT_ABSOLUTE', 'Informe um caminho absoluto para um perfil temporario novo.');
  }
  const raizTemp = await fs.realpath(resolve(tempRoot));
  const destino = resolve(caminho);
  if (caminhoNormalizado(dirname(destino)) !== caminhoNormalizado(raizTemp) || parse(destino).root === destino) {
    throw new ProvaLabelsErro('PROFILE_OUTSIDE_TEMP', 'O perfil precisa ser um diretorio novo diretamente sob a pasta temporaria do sistema.');
  }
  if (!/^lume-label-proof-[a-z0-9][a-z0-9_-]{5,80}$/i.test(basename(destino))) {
    throw new ProvaLabelsErro('PROFILE_NAME', 'Use um nome exclusivo iniciado por lume-label-proof-.');
  }
  if (PRODUTOS_PROTEGIDOS.includes(basename(destino).toLowerCase())) {
    throw new ProvaLabelsErro('PROFILE_LIVE_PATH', 'O caminho informado pertence a um perfil vivo.');
  }

  const protegidos = [
    resolve(cwd, 'data'),
    resolve(cwd, 'wa-auth'),
    env.ASSESSOR_DATA_DIR,
    env.ASSESSOR_DESKTOP_DATA
  ].filter(Boolean).map(item => resolve(item));
  const candidato = caminhoNormalizado(destino);
  const protegidosLexicos = protegidos.map(caminhoNormalizado);
  const protegidosFisicos = [];
  for (const item of protegidos) {
    try { protegidosFisicos.push(caminhoNormalizado(await fs.realpath(item))); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  if ([...protegidosLexicos, ...protegidosFisicos].some(item => caminhoDentro(candidato, item) || caminhoDentro(item, candidato))) {
    throw new ProvaLabelsErro('PROFILE_LIVE_PATH', 'O caminho informado coincide com dados usados pelo Lume.');
  }
  if (await existe(fs, destino)) {
    const stat = await fs.lstat(destino);
    if (stat.isSymbolicLink()) throw new ProvaLabelsErro('PROFILE_ALIAS', 'Atalhos, links e junctions nao sao aceitos.');
    throw new ProvaLabelsErro('PROFILE_EXISTS', 'O perfil de ensaio precisa ser novo e ainda inexistente.');
  }

  await fs.mkdir(destino, { recursive: false, mode: 0o700 });
  const fisico = await fs.realpath(destino);
  if (caminhoNormalizado(dirname(fisico)) !== caminhoNormalizado(raizTemp) || caminhoNormalizado(fisico) !== caminhoNormalizado(destino)) {
    await fs.rm(destino, { recursive: true, force: true });
    throw new ProvaLabelsErro('PROFILE_ALIAS', 'O destino fisico nao corresponde ao perfil solicitado.');
  }
  const nonce = randomBytes(24).toString('hex');
  await fs.writeFile(join(destino, MARCADOR_PERFIL), nonce, { flag: 'wx', mode: 0o600 });
  return { caminho: destino, nonce };
}

export async function removerPerfilIsolado(perfil, { fs = fsPromises, tempRoot = tmpdir() } = {}) {
  if (!perfil?.caminho || !perfil?.nonce) throw new ProvaLabelsErro('PROFILE_OWNERSHIP', 'Perfil sem prova de posse.');
  const raizTemp = await fs.realpath(resolve(tempRoot));
  const fisico = await fs.realpath(perfil.caminho);
  if (caminhoNormalizado(dirname(fisico)) !== caminhoNormalizado(raizTemp) || caminhoNormalizado(fisico) !== caminhoNormalizado(perfil.caminho)) throw new ProvaLabelsErro('PROFILE_ALIAS', 'O perfil mudou de destino.');
  const nonce = await fs.readFile(join(fisico, MARCADOR_PERFIL), 'utf8');
  if (nonce !== perfil.nonce) throw new ProvaLabelsErro('PROFILE_OWNERSHIP', 'A posse do perfil nao pôde ser confirmada.');
  await fs.rm(fisico, { recursive: true, force: true });
}

function valorSeguro(valor, regex, fallback) {
  return typeof valor === 'string' && regex.test(valor) ? valor : fallback;
}

export function blocoEvidencia(resultado) {
  const status = Object.values(STATUS_PROVA).includes(resultado?.status) ? resultado.status : STATUS_PROVA.INCONCLUSIVO;
  const inicio = valorSeguro(resultado?.inicio, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'nao registrado');
  const fim = valorSeguro(resultado?.fim, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'nao registrado');
  const baileys = valorSeguro(resultado?.baileys, /^[0-9A-Za-z.+-]{1,40}$/, 'nao registrado');
  const modalidade = ['CHAT', 'MENSAGEM', 'NAO DEFINIDA'].includes(resultado?.modalidade) ? resultado.modalidade : 'NAO DEFINIDA';
  const codigos = [...new Set(Array.isArray(resultado?.codigos) ? resultado.codigos : [])]
    .filter(codigo => CODIGOS_PERMITIDOS.has(codigo)).sort();
  return [
    EVIDENCIA_INICIO,
    `**Status:** ${status}`,
    `**Inicio UTC:** ${inicio}`,
    `**Fim UTC:** ${fim}`,
    `**Baileys instalado:** ${baileys}`,
    `**Modalidade:** ${modalidade}`,
    `**Codigos:** ${codigos.length ? codigos.join(', ') : 'nenhum'}`,
    EVIDENCIA_FIM
  ].join('\n');
}

export async function atualizarEvidencia(resultado, {
  destino,
  destinoEsperado = destino,
  fs = fsPromises
} = {}) {
  if (!destino || resolve(destino) !== resolve(destinoEsperado)) {
    throw new ProvaLabelsErro('EVIDENCE_DESTINATION', 'O destino da evidencia nao corresponde ao documento previsto.');
  }
  const stat = await fs.lstat(destino);
  const pai = dirname(resolve(destino)), paiFisico = await fs.realpath(pai);
  if (!stat.isFile() || stat.isSymbolicLink() || caminhoNormalizado(pai) !== caminhoNormalizado(paiFisico)) {
    throw new ProvaLabelsErro('EVIDENCE_ALIAS', 'A evidencia prevista precisa ser um arquivo regular em diretorio fisico.');
  }
  const original = await fs.readFile(destino, 'utf8');
  const inicio = original.indexOf(EVIDENCIA_INICIO), fim = original.indexOf(EVIDENCIA_FIM);
  if (inicio < 0 || fim < inicio || original.indexOf(EVIDENCIA_INICIO, inicio + 1) >= 0 || original.indexOf(EVIDENCIA_FIM, fim + 1) >= 0) {
    throw new ProvaLabelsErro('EVIDENCE_MARKERS', 'O documento de prova nao possui um bloco unico e valido.');
  }
  const final = original.slice(0, inicio) + blocoEvidencia(resultado) + original.slice(fim + EVIDENCIA_FIM.length);
  const temporario = join(dirname(destino), `.${basename(destino)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporario, final, { flag: 'wx', mode: stat.mode & 0o777 });
  try { await fs.rename(temporario, destino); }
  catch (error) { await fs.rm(temporario, { force: true }); throw error; }
}

function addListener(emitter, event, listener) {
  emitter.on(event, listener);
  return () => {
    if (typeof emitter.off === 'function') emitter.off(event, listener);
    else emitter.removeListener(event, listener);
  };
}

function awaitFlag(read, {
  emitter,
  event = 'changed',
  timeoutMs,
  signal,
  timers = { setTimeout, clearTimeout }
}) {
  if (read()) return Promise.resolve(true);
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (kind, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      kind === 'resolve' ? resolvePromise(value) : rejectPromise(value);
    };
    const check = () => { if (read()) finish('resolve', true); };
    const cancel = () => finish('reject', abortError());
    const timer = timers.setTimeout(() => finish('resolve', false), timeoutMs);
    const remove = addListener(emitter, event, check);
    const cleanup = () => {
      timers.clearTimeout(timer);
      remove();
      signal?.removeEventListener('abort', cancel);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function executarComPrazo(action, {
  timeoutMs,
  signal,
  timers = { setTimeout, clearTimeout }
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (kind, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      kind === 'resolve' ? resolvePromise(value) : rejectPromise(value);
    };
    const cancel = () => finish('reject', abortError());
    const timer = timers.setTimeout(
      () => finish('reject', new ProvaLabelsErro('OPERATION_TIMEOUT', 'Uma operacao externa excedeu o prazo.')),
      timeoutMs
    );
    const cleanup = () => {
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    Promise.resolve().then(action).then(
      value => finish('resolve', value),
      error => finish('reject', error)
    );
  });
}

export function criarQrTTY(output, { renderQr } = {}) {
  let exibido = false, geracao = 0;
  const limpar = () => {
    geracao++;
    if (exibido && output?.isTTY) output.write('\x1b[2J\x1b[H');
    exibido = false;
  };
  return {
    async mostrar(qr) {
      if (!output?.isTTY) return false;
      limpar();
      const atual = geracao;
      const render = renderQr || (async value => {
        const modulo = await import('qrcode');
        return modulo.default.toString(value, { type: 'terminal', small: true });
      });
      const desenho = await render(qr);
      if (atual !== geracao) return false;
      output.write('Leia este QR apenas com a conta Business de teste:\n');
      output.write(desenho);
      output.write('\n');
      exibido = true;
      return true;
    },
    limpar
  };
}

function aguardarConexao(socket, {
  qr,
  timeoutMs,
  signal,
  timers = { setTimeout, clearTimeout }
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (kind, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      qr.limpar();
      kind === 'resolve' ? resolvePromise(value) : rejectPromise(value);
    };
    const update = value => {
      if (typeof value?.qr === 'string' && value.qr) void qr.mostrar(value.qr).catch(error => finish('reject', error));
      if (value?.connection === 'open') finish('resolve', 'open');
      else if (value?.connection === 'close') {
        const code = value?.lastDisconnect?.error?.output?.statusCode ?? value?.lastDisconnect?.error?.statusCode;
        if (code === 515) finish('resolve', 'restart');
        else finish('reject', new ProvaLabelsErro('CONNECTION_FAILED', 'A conexao foi encerrada antes de abrir.'));
      }
    };
    const cancel = () => finish('reject', abortError());
    const timer = timers.setTimeout(() => finish('reject', new ProvaLabelsErro('CONNECTION_TIMEOUT', 'A conexao nao abriu dentro do prazo.')), timeoutMs);
    const remove = addListener(socket.ev, 'connection.update', update);
    const cleanup = () => {
      timers.clearTimeout(timer);
      remove();
      signal?.removeEventListener('abort', cancel);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function rastrearEventos(socket, { labelId, alvo, modalidade }) {
  const state = { definitionAdd: false, associationAdd: false, associationRemove: false, definitionRemove: false };
  const changes = new EventEmitter();
  const definition = label => {
    if (label?.id !== labelId) return;
    if (label.deleted === true) state.definitionRemove = true;
    else if (label.deleted === false) state.definitionAdd = true;
    changes.emit('changed');
  };
  const association = event => {
    const item = event?.association;
    const tipo = modalidade === 'CHAT' ? 'label_jid' : 'label_message';
    if (item?.type !== tipo || item?.labelId !== labelId || item?.chatId !== alvo.chatId) return;
    if (modalidade === 'MENSAGEM' && item?.messageId !== alvo.messageId) return;
    if (event?.type === 'add') state.associationAdd = true;
    if (event?.type === 'remove') state.associationRemove = true;
    changes.emit('changed');
  };
  const removeDefinition = addListener(socket.ev, 'labels.edit', definition);
  const removeAssociation = addListener(socket.ev, 'labels.association', association);
  return { state, changes, remover: () => { removeDefinition(); removeAssociation(); changes.removeAllListeners(); } };
}

async function carregarBaileysPadrao() {
  const [baileys, pinoModule] = await Promise.all([import('@whiskeysockets/baileys'), import('pino')]);
  const packagePath = resolve(dirname(fileURLToPath(import.meta.resolve('@whiskeysockets/baileys'))), '..', 'package.json');
  let version = 'desconhecida';
  try { version = JSON.parse(await fsPromises.readFile(packagePath, 'utf8')).version; } catch {}
  return {
    version,
    async auth(profilePath) { return baileys.useMultiFileAuthState(profilePath); },
    makeSocket({ state }) {
      return baileys.makeWASocket({
        auth: state,
        logger: pinoModule.default({ level: 'silent' }),
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false
      });
    }
  };
}

function controladorCancelamento({ input, processLike = process, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else {
    input?.once?.('end', abort);
    processLike?.once?.('SIGINT', abort);
    signal?.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: controller.signal,
    remover() {
      input?.off?.('end', abort);
      processLike?.off?.('SIGINT', abort);
      signal?.removeEventListener('abort', forward);
    }
  };
}

export function perguntarSemEco(input, output, pergunta, { signal } = {}) {
  if (!input?.isTTY || !output?.isTTY) return Promise.reject(new ProvaLabelsErro('TTY_REQUIRED', 'A prova exige um terminal interativo.'));
  return new Promise((resolvePromise, rejectPromise) => {
    let texto = '', anterior = Boolean(input.isRaw), settled = false;
    const finish = (kind, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write('\n');
      kind === 'resolve' ? resolvePromise(value) : rejectPromise(value);
    };
    const data = chunk => {
      const value = chunk.toString('utf8');
      if (value.includes('\u0003')) return finish('reject', abortError());
      for (const char of value) {
        if (char === '\r' || char === '\n') return finish('resolve', texto.trim());
        if (char === '\u007f' || char === '\b') texto = texto.slice(0, -1);
        else if (char >= ' ' && char !== '\u007f') texto += char;
      }
    };
    const end = () => finish('reject', abortError());
    const error = err => finish('reject', err);
    const cleanup = () => {
      input.off('data', data); input.off('end', end); input.off('error', error);
      signal?.removeEventListener('abort', end);
      if (typeof input.setRawMode === 'function') input.setRawMode(anterior);
      input.pause?.();
    };
    output.write(pergunta);
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.on('data', data); input.once('end', end); input.once('error', error);
    signal?.addEventListener('abort', end, { once: true });
    input.resume?.();
    if (signal?.aborted) end();
  });
}

export function criarPromptsTTY(input, output) {
  const ask = (question, signal) => perguntarSemEco(input, output, question, { signal });
  return {
    confirmarConta: signal => ask(`Digite exatamente \"${CONFIRMACAO_LITERAL}\": `, signal),
    modalidade: signal => ask('Modalidade (CHAT ou MENSAGEM): ', signal),
    chatId: signal => ask('Identificador do chat de teste (nao sera registrado): ', signal),
    messageId: signal => ask('Identificador da mensagem descartavel (nao sera registrado): ', signal),
    telefoneVisivel: signal => ask('A label apareceu no telefone? (SIM ou NAO): ', signal),
    telefoneLimpo: signal => ask('A label e a associacao sumiram do telefone? (SIM ou NAO): ', signal)
  };
}

function validarIdentificador(value, nome) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 256 || /[\s\u0000-\u001f]/u.test(value)) {
    throw new ProvaLabelsErro('TARGET_INVALID', `${nome} invalido para o ensaio.`);
  }
  return value;
}

function classificar(codigos) {
  const required = [
    'CREATE_CALL_OK', 'DEFINITION_EVENT_OK', 'ASSOCIATE_CALL_OK', 'ASSOCIATION_EVENT_OK',
    'PHONE_VISIBLE_OK', 'REMOVE_ASSOCIATION_CALL_OK', 'ASSOCIATION_CLEANUP_EVENT_OK',
    'REMOVE_DEFINITION_CALL_OK', 'DEFINITION_CLEANUP_EVENT_OK', 'PHONE_CLEAN_OK'
  ];
  if (required.every(code => codigos.has(code)) && !codigos.has('PROFILE_RETAINED')) return STATUS_PROVA.APROVADO;
  if ([...codigos].some(code => code.endsWith('_FAILED') || code === 'PHONE_VISIBLE_NO' || code === 'PHONE_CLEAN_NO')) return STATUS_PROVA.REPROVADO;
  return STATUS_PROVA.INCONCLUSIVO;
}

/**
 * Executa o ensaio. Adaptadores e prompts sao injetaveis para que a automacao
 * exercite todos os guardrails sem abrir rede nem tocar uma conta real.
 */
export async function executarProvaManual({
  profileDir,
  evidencePath,
  expectedEvidencePath = evidencePath,
  input = process.stdin,
  output = process.stdout,
  prompts = criarPromptsTTY(input, output),
  loadAdapters = carregarBaileysPadrao,
  qrSink,
  connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
  eventTimeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
  timers = { setTimeout, clearTimeout },
  now = () => new Date(),
  timeNow = () => Date.now(),
  signal,
  processLike = process,
  fs = fsPromises,
  tempRoot = tmpdir(),
  cwd = process.cwd(),
  env = process.env
} = {}) {
  if (!input?.isTTY || !output?.isTTY) throw new ProvaLabelsErro('TTY_REQUIRED', 'A prova real so pode rodar em um terminal interativo.');
  const inicio = now().toISOString(), codigos = new Set();
  const cancelamento = controladorCancelamento({ input, processLike, signal });
  if (cancelamento.signal.aborted) {
    cancelamento.remover();
    throw abortError();
  }
  let perfil, socket, tracker, labelTentada = false, associacaoTentada = false;
  let remocaoAssociacaoTentada = false, remocaoDefinicaoTentada = false;
  let associacaoRemovida = false, labelRemovida = false, limpezaTelefone = false;
  let modalidade = 'NAO DEFINIDA', baileysVersion = 'nao registrado';
  const qr = qrSink || criarQrTTY(output);
  const sockets = [];

  const fecharSocket = async registro => {
    if (!registro || registro.fechado) return;
    registro.fechado = true;
    registro.removerCreds?.();
    try { await registro.socket?.end?.(new Error('Lume label proof finished')); } catch {}
  };
  const removerAssociacao = async alvo => {
    if (!socket || !associacaoTentada || remocaoAssociacaoTentada) return;
    remocaoAssociacaoTentada = true;
    try {
      await executarComPrazo(
        () => modalidade === 'CHAT'
          ? socket.removeChatLabel(alvo.chatId, alvo.labelId)
          : socket.removeMessageLabel(alvo.chatId, alvo.messageId, alvo.labelId),
        { timeoutMs: eventTimeoutMs, timers }
      );
      associacaoRemovida = true; codigos.add('REMOVE_ASSOCIATION_CALL_OK');
    } catch (error) { codigos.add(error?.code === 'OPERATION_TIMEOUT' ? 'OPERATION_TIMEOUT' : 'REMOVE_ASSOCIATION_CALL_FAILED'); }
  };
  const removerDefinicao = async alvo => {
    if (!socket || !labelTentada || remocaoDefinicaoTentada) return;
    remocaoDefinicaoTentada = true;
    try {
      await executarComPrazo(
        () => socket.addLabel(alvo.chatId, { id: alvo.labelId, name: alvo.labelName, color: 0, deleted: true }),
        { timeoutMs: eventTimeoutMs, timers }
      );
      labelRemovida = true; codigos.add('REMOVE_DEFINITION_CALL_OK');
    } catch (error) { codigos.add(error?.code === 'OPERATION_TIMEOUT' ? 'OPERATION_TIMEOUT' : 'REMOVE_DEFINITION_CALL_FAILED'); }
  };

  let alvo;
  try {
    perfil = await prepararPerfilIsolado(profileDir, { fs, tempRoot, cwd, env });
    const confirmacao = await prompts.confirmarConta(cancelamento.signal);
    if (confirmacao !== CONFIRMACAO_LITERAL) throw new ProvaLabelsErro('CONFIRMATION_REQUIRED', 'A frase de confirmacao nao corresponde ao contrato.');
    modalidade = String(await prompts.modalidade(cancelamento.signal)).toUpperCase();
    if (!['CHAT', 'MENSAGEM'].includes(modalidade)) throw new ProvaLabelsErro('MODE_INVALID', 'Escolha CHAT ou MENSAGEM.');
    const chatId = validarIdentificador(await prompts.chatId(cancelamento.signal), 'Chat');
    const messageId = modalidade === 'MENSAGEM' ? validarIdentificador(await prompts.messageId(cancelamento.signal), 'Mensagem') : undefined;
    const labelId = randomUUID(), labelName = `Lume prova ${inicio.replace(/[-:.TZ]/g, '').slice(0, 14)} ${randomBytes(3).toString('hex')}`;
    alvo = { chatId, messageId, labelId, labelName };

    const adapters = await loadAdapters();
    baileysVersion = valorSeguro(adapters?.version, /^[0-9A-Za-z.+-]{1,40}$/, 'nao registrado');
    const auth = await adapters.auth(perfil.caminho);
    const deadline = timeNow() + connectionTimeoutMs;
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      socket = await adapters.makeSocket({ state: auth.state });
      const socketCriado = socket;
      const registro = { socket: socketCriado, fechado: false, removerCreds: null };
      sockets.push(registro);
      if (!socketCriado?.ev || typeof socketCriado.ev.on !== 'function') throw new ProvaLabelsErro('SOCKET_INVALID', 'O adaptador nao retornou um socket valido.');
      if (typeof auth.saveCreds === 'function') {
        socketCriado.ev.on('creds.update', auth.saveCreds);
        registro.removerCreds = () => socketCriado.ev.off?.('creds.update', auth.saveCreds);
      }
      try {
        const restante = Math.max(1, deadline - timeNow());
        const estado = await aguardarConexao(socket, { qr, timeoutMs: restante, signal: cancelamento.signal, timers });
        if (estado === 'open') { codigos.add('CONNECTION_OPEN'); break; }
        await fecharSocket(registro);
        if (tentativa === 2 || timeNow() >= deadline) throw new ProvaLabelsErro('CONNECTION_FAILED', 'A conexao pediu reinicio repetidas vezes.');
      } catch (error) {
        if (error?.code === 'CONNECTION_TIMEOUT') codigos.add('CONNECTION_TIMEOUT');
        else if (error?.name === 'AbortError') codigos.add('CONNECTION_CANCELED');
        else codigos.add('CONNECTION_FAILED');
        throw error;
      }
    }

    tracker = rastrearEventos(socket, { labelId, alvo, modalidade });
    const wait = key => awaitFlag(() => tracker.state[key], { emitter: tracker.changes, timeoutMs: eventTimeoutMs, signal: cancelamento.signal, timers });

    try {
      labelTentada = true;
      await executarComPrazo(
        () => socket.addLabel(chatId, { id: labelId, name: labelName, color: 0, deleted: false }),
        { timeoutMs: eventTimeoutMs, signal: cancelamento.signal, timers }
      );
      codigos.add('CREATE_CALL_OK');
    } catch (error) {
      if (error?.code === 'OPERATION_TIMEOUT') codigos.add('OPERATION_TIMEOUT');
      else if (error?.name === 'AbortError') codigos.add('OPERATION_CANCELED');
      else codigos.add('CREATE_CALL_FAILED');
      throw error;
    }
    codigos.add(await wait('definitionAdd') ? 'DEFINITION_EVENT_OK' : 'DEFINITION_EVENT_MISSING');

    try {
      associacaoTentada = true;
      await executarComPrazo(
        () => modalidade === 'CHAT' ? socket.addChatLabel(chatId, labelId) : socket.addMessageLabel(chatId, messageId, labelId),
        { timeoutMs: eventTimeoutMs, signal: cancelamento.signal, timers }
      );
      codigos.add('ASSOCIATE_CALL_OK');
    } catch (error) {
      if (error?.code === 'OPERATION_TIMEOUT') codigos.add('OPERATION_TIMEOUT');
      else if (error?.name === 'AbortError') codigos.add('OPERATION_CANCELED');
      else codigos.add('ASSOCIATE_CALL_FAILED');
      throw error;
    }
    codigos.add(await wait('associationAdd') ? 'ASSOCIATION_EVENT_OK' : 'ASSOCIATION_EVENT_MISSING');

    const visivel = String(await prompts.telefoneVisivel(cancelamento.signal)).toUpperCase();
    codigos.add(visivel === 'SIM' ? 'PHONE_VISIBLE_OK' : visivel === 'NAO' ? 'PHONE_VISIBLE_NO' : 'PHONE_VISIBLE_UNCONFIRMED');
  } catch (error) {
    if (!['CONNECTION_TIMEOUT', 'CONNECTION_CANCELED', 'CONNECTION_FAILED', 'CREATE_CALL_FAILED', 'ASSOCIATE_CALL_FAILED', 'OPERATION_TIMEOUT', 'OPERATION_CANCELED'].some(code => codigos.has(code))) {
      codigos.add(error?.name === 'AbortError' ? (codigos.has('CONNECTION_OPEN') ? 'OPERATION_CANCELED' : 'CONNECTION_CANCELED') : 'TRIAL_ERROR');
    }
  } finally {
    if (alvo) {
      const limparAssociacao = associacaoTentada;
      await removerAssociacao(alvo);
      if (limparAssociacao && tracker) {
        const observada = associacaoRemovida
          ? await awaitFlag(() => tracker.state.associationRemove, { emitter: tracker.changes, timeoutMs: eventTimeoutMs, timers })
          : false;
        codigos.add(observada ? 'ASSOCIATION_CLEANUP_EVENT_OK' : 'ASSOCIATION_CLEANUP_EVENT_MISSING');
      }
      const limparDefinicao = labelTentada;
      await removerDefinicao(alvo);
      if (limparDefinicao && tracker) {
        const observada = labelRemovida
          ? await awaitFlag(() => tracker.state.definitionRemove, { emitter: tracker.changes, timeoutMs: eventTimeoutMs, timers })
          : false;
        codigos.add(observada ? 'DEFINITION_CLEANUP_EVENT_OK' : 'DEFINITION_CLEANUP_EVENT_MISSING');
      }
      if (codigos.has('CONNECTION_OPEN') && (limparAssociacao || limparDefinicao) && !cancelamento.signal.aborted) {
        try {
          const limpa = String(await prompts.telefoneLimpo(cancelamento.signal)).toUpperCase();
          limpezaTelefone = limpa === 'SIM';
          codigos.add(limpezaTelefone ? 'PHONE_CLEAN_OK' : limpa === 'NAO' ? 'PHONE_CLEAN_NO' : 'PHONE_CLEAN_UNCONFIRMED');
        } catch { codigos.add('PHONE_CLEAN_UNCONFIRMED'); }
      } else if (limparAssociacao || limparDefinicao) codigos.add('PHONE_CLEAN_UNCONFIRMED');
    }
    tracker?.remover();
    qr.limpar();
    for (const registro of sockets) await fecharSocket(registro);
    cancelamento.remover();
    const limpezaAplicavelConcluida = (!associacaoTentada || associacaoRemovida) && (!labelTentada || labelRemovida);
    if (perfil && limpezaTelefone && limpezaAplicavelConcluida) {
      try { await removerPerfilIsolado(perfil, { fs, tempRoot }); codigos.add('PROFILE_REMOVED'); }
      catch { codigos.add('PROFILE_RETAINED'); limpezaTelefone = false; }
    } else if (perfil) codigos.add('PROFILE_RETAINED');
  }

  const resultado = {
    status: classificar(codigos),
    inicio,
    fim: now().toISOString(),
    baileys: baileysVersion,
    modalidade,
    codigos: [...codigos]
  };
  if (evidencePath) await atualizarEvidencia(resultado, { destino: evidencePath, destinoEsperado: expectedEvidencePath, fs });
  return resultado;
}

function lerArgs(argv) {
  let profileDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') profileDir = argv[++i];
    else throw new ProvaLabelsErro('ARGUMENT', `Argumento desconhecido: ${argv[i]}`);
  }
  if (!profileDir) throw new ProvaLabelsErro('ARGUMENT', 'Use --profile com um caminho temporario novo e absoluto.');
  return { profileDir };
}

export async function main(argv = process.argv.slice(2)) {
  const options = lerArgs(argv);
  const evidencePath = resolve(import.meta.dirname, '..', 'docs', 'LUME-3.2-LABELS-PROVA.md');
  const resultado = await executarProvaManual({ ...options, evidencePath, expectedEvidencePath: evidencePath });
  process.stdout.write(`Resultado: ${resultado.status}\nCodigos: ${resultado.codigos.sort().join(', ')}\n`);
  if (resultado.status !== STATUS_PROVA.APROVADO) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`Ensaio interrompido (${error?.code || 'ERRO'}). Nenhum identificador foi registrado.\n`);
    process.exitCode = 1;
  });
}

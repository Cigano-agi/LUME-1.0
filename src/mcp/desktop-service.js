import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyClaudeActivation,
  authorizeClaudeBrokerBegin,
  authorizeClaudeBrokerHello,
  getClaudeActivationState,
  getClaudeActivationRevision,
  listMcpClients,
  revokeClaudeActivation
} from './activation.js';
import { buildLumeMcpb, inspectStoredMcpb } from '../../scripts/build-lume-mcpb.mjs';
import { assertVersionContract } from '../../scripts/version-contract.mjs';
import { assertLumeAppPresence, lumePresencePath, startLumeAppPresence } from './presence.js';
import { createBootIdentity } from './broker-identity.js';
import { createProfileBroker } from './profile-broker.js';
import { publishBrokerDescriptor } from './broker-bootstrap.js';
import { criarSnapshot } from '../backup-snapshot.js';

const TODAY = 'today';
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function detectClaudeDesktop({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const candidates = platform === 'darwin'
    ? ['/Applications/Claude.app', env.HOME && join(env.HOME, 'Applications', 'Claude.app')]
    : platform === 'win32'
      ? [
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Claude', 'Claude.exe'),
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'AnthropicClaude', 'Claude.exe'),
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Claude.exe')
        ]
      : [];
  if (!['darwin', 'win32'].includes(platform)) return { estado: 'sistema_incompativel' };
  let detected = false;
  for (const path of candidates.filter(Boolean)) {
    try { if (exists(path)) { detected = true; break; } } catch {}
  }
  return { estado: detected ? 'detectado' : 'nao_confirmado' };
}

export function packageShapeForRoot(root) {
  return String(root).split(/[\\/]+/).some(part => part.toLowerCase() === 'app.asar') ? 'packaged' : 'checkout';
}

function packageInfo(root, platform, shape) {
  try {
    const contract = assertVersionContract({root, shape});
    const manifest = contract.manifest;
    const supported = Array.isArray(manifest.compatibility?.platforms) && manifest.compatibility.platforms.includes(platform);
    if (manifest.name !== 'com.readyworks.lume.local-memory' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error('manifest');
    // Claude não publica um contrato para ler a versão de uma extensão privada instalada.
    // Expomos apenas a versão disponível e mantemos atualização manual, sem inferir instalação.
    return { disponivel: true, versao_disponivel: manifest.version, sistema_compativel: supported, atualizacao: 'manual', versao_instalada: null };
  } catch { return { disponivel: false, versao_disponivel: null, sistema_compativel: false, atualizacao: 'manual', versao_instalada: null }; }
}

function localDay(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function publicClaudeState(activationPath) {
  const state = getClaudeActivationState({ activationPath });
  return {
    id: 'claude-desktop',
    nome: 'Claude Desktop',
    // A credencial pronta nao prova que o Claude importou ou abriu a extensao.
    estado: state.problem ? 'erro' : state.enabled ? 'preparado' : 'desligado',
    escopo: state.enabled && state.scope?.kind === TODAY ? 'Hoje' : null,
    problema: state.problem
  };
}

function selfTestError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

function extractPackage(bytes, destination) {
  const base = resolve(destination) + sep;
  for (const entry of inspectStoredMcpb(bytes)) {
    const target = resolve(destination, entry.name);
    if (!target.startsWith(base)) throw new Error('SELF_TEST_PACKAGE');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data, { flag: 'wx' });
  }
}

function removeOwnStage(stage, packageDir, created) {
  const base = resolve(packageDir), target = resolve(stage);
  if (!target.startsWith(base + sep) || target === base) throw new Error('SELF_TEST_CLEANUP_UNTRUSTED');
  const actualBase = realpathSync(base), actualTarget = realpathSync(target);
  if (!actualTarget.startsWith(actualBase + sep)) throw new Error('SELF_TEST_CLEANUP_UNTRUSTED');
  const current = lstatSync(target);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino)
    throw new Error('SELF_TEST_CLEANUP_UNTRUSTED');
  rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}

export function neutralizarAutoridadeSnapshot(snapshotDb) {
  const tables = new Set(snapshotDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  snapshotDb.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
  try {
    for (const table of ['lume_execucao_eventos', 'lume_execucao_contexto_grants', 'lume_execucoes', 'lume_execucao_contexto_guardas', 'lume_execucao_contextos', 'autorizacoes']) {
      if (tables.has(table)) snapshotDb.exec(`DELETE FROM ${table}`);
    }
    for (const table of ['lume_execucao_contexto_grants', 'lume_execucoes', 'autorizacoes']) {
      if (tables.has(table) && snapshotDb.prepare(`SELECT COUNT(*) total FROM ${table}`).get().total !== 0) throw new Error('SELF_TEST_AUTHORITY');
    }
    snapshotDb.exec('COMMIT;');
  } catch (error) { snapshotDb.exec('ROLLBACK;'); throw error; }
}

export function runPackagedStdio({ entry, profileEnv, credential, timeoutMs = 10000 }) {
  return new Promise((resolveTest, rejectTest) => {
    const inherited = {};
    for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      if (typeof process.env[name] === 'string') inherited[name] = process.env[name];
    }
    let child;
    try { child = spawn(process.execPath, [entry], {
      cwd: dirname(dirname(entry)),
      env: {
        ...inherited,
        ...profileEnv,
        ELECTRON_RUN_AS_NODE: '1',
        LUME_MCP_SELF_TEST_READ_ONLY: '1',
        LUME_MCP_CREDENTIAL: credential
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    }); } catch { rejectTest(new Error('SELF_TEST_PROCESS')); return; }
    let buffer = '', outputBytes = 0, settled = false, failed = null, timedOut = false;
    let initialized = false, readPassed = false, toolsPassed = false, executionDenied = false;
    const namesExpected = ['lume_resumo_do_dia', 'lume_buscar_contexto', 'lume_abrir_fonte', 'lume_listar_pendencias', 'lume_listar_negocios'];
    const fail = code => {
      if (!failed) failed = new Error(code);
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        try { child.stdin.end(); } catch {}
      }
    };
    const settle = (error, closed) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(killTimer);
      if (error) { error.childClosed = closed; error.uncertain = timedOut || !closed; rejectTest(error); }
      else resolveTest(true);
    };
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true; fail('SELF_TEST_TIMEOUT');
      try { child.kill(); } catch {}
      killTimer = setTimeout(() => settle(failed, false), 2000);
    }, timeoutMs);
    child.once('error', () => fail('SELF_TEST_PROCESS'));
    child.stdin.on('error', () => fail('SELF_TEST_PROCESS'));
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      if (failed) return;
      outputBytes += chunk.length;
      if (outputBytes > 128 * 1024) { fail('SELF_TEST_PROTOCOL'); return; }
      buffer += chunk.toString('utf8');
      if (buffer.length > 64 * 1024) { fail('SELF_TEST_PROTOCOL'); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message; try { message = JSON.parse(line); } catch { fail('SELF_TEST_PROTOCOL'); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { fail('SELF_TEST_PROTOCOL'); return; }
        if (message.id === 1) {
          if (message.result?.serverInfo?.name !== 'lume') { fail('SELF_TEST_PROTOCOL'); return; }
          initialized = true;
        }
        if (message.id === 2) {
          const result = message.result?.structuredContent;
          if (result?.ok !== true || !Array.isArray(result.items)) { fail('SELF_TEST_READ'); return; }
          readPassed = true;
        }
        if (message.id === 3) {
          const names = message.result?.tools?.map(tool => tool.name);
          if (JSON.stringify(names) !== JSON.stringify(namesExpected)) { fail('SELF_TEST_CAPABILITIES'); return; }
          toolsPassed = true;
        }
        if (message.id === 4) {
          if (message.error?.code !== -32602) { fail('SELF_TEST_EXECUTION'); return; }
          executionDenied = true;
        }
        if (initialized && readPassed && toolsPassed && executionDenied && !child.stdin.writableEnded) child.stdin.end();
      }
    });
    child.once('close', code => {
      if (failed) settle(failed, true);
      else if (code !== 0) settle(new Error('SELF_TEST_PROCESS'), true);
      else if (!child.stdin.writableFinished || !initialized || !readPassed || !toolsPassed || !executionDenied) settle(new Error('SELF_TEST_EARLY_EXIT'), true);
      else settle(null, true);
    });
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lume-autoteste', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lume_resumo_do_dia', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lume_iniciar_execucao', arguments: {} } }
    ];
    for (const message of messages) {
      try { child.stdin.write(JSON.stringify(message) + '\n'); }
      catch { fail('SELF_TEST_PROCESS'); break; }
    }
  });
}

export class LumeMcpDesktopService {
  constructor({ dataDir, now = () => new Date(), packageRoot = DEFAULT_ROOT, platform = process.platform, env = process.env, exists = existsSync } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Diretório de dados obrigatório.');
    this.activationPath = join(dataDir, 'mcp', 'claude-desktop.json');
    this.packageDir = join(dataDir, 'mcp', 'packages');
    this.packageRoot = packageRoot;
    this.packageShape = packageShapeForRoot(packageRoot);
    this.platform = platform;
    this.env = env;
    this.exists = exists;
    this.now = now;
    this.dataDir = dataDir;
    this.selfTest = null;
  }

  revisaoConector(clientId) {
    return clientId==='claude-desktop'?getClaudeActivationRevision({activationPath:this.activationPath}):null;
  }

  estado() {
    const claude = publicClaudeState(this.activationPath);
    const chatgpt = listMcpClients().find(client => client.id === 'chatgpt');
    const pacote = packageInfo(this.packageRoot, this.platform, this.packageShape);
    const instalacao = detectClaudeDesktop({ platform: this.platform, env: this.env, exists: this.exists });
    return {
      clientes: [
        { ...claude, pacote_disponivel: pacote.disponivel, instalacao: instalacao.estado, sistema_compativel: pacote.sistema_compativel },
        { id: 'chatgpt', nome: chatgpt?.name || 'ChatGPT', estado: 'em_breve', escopo: null }
      ],
      pacote,
      mac_validado: false
    };
  }

  ativarClaudeHoje({ confirmar = false, renovar = false } = {}) {
    if (confirmar !== true) throw new TypeError('Confirme o acesso do Claude às conversas de hoje.');
    const result = applyClaudeActivation({
      activationPath: this.activationPath,
      scope: { kind: TODAY, date: localDay(this.now()) },
      rotate: renovar === true
    });
    return {
      ...this.estado(),
      activation_code: result.activation_code,
      codigo_exibido_uma_vez: Boolean(result.activation_code)
    };
  }

  revogarClaude({ confirmar } = {}) {
    if (confirmar !== 'DESLIGAR') throw new TypeError('Confirme que deseja desligar o acesso.');
    revokeClaudeActivation({ activationPath: this.activationPath });
    return this.estado();
  }

  pacoteClaude() {
    const state = getClaudeActivationState({ activationPath: this.activationPath });
    if (!state.enabled) throw new Error('Prepare o acesso antes de baixar a extensão.');
    const built = buildLumeMcpb({ root: this.packageRoot, outputDir: this.packageDir, shape: this.packageShape });
    return { bytes: readFileSync(built.artifact), name: built.file };
  }

  async testarClaudeLocal() {
    if (this.selfTest) return this.selfTest;
    this.selfTest = this.#testarClaudeLocal().finally(() => { this.selfTest = null; });
    return this.selfTest;
  }

  async #testarClaudeLocal() {
    if (this.platform !== process.platform) throw selfTestError('SISTEMA_INCOMPATIVEL', 'Este sistema ainda n\u00e3o \u00e9 compat\u00edvel com a extens\u00e3o do Lume.');
    const activation = getClaudeActivationState({ activationPath: this.activationPath });
    if (!activation.enabled) throw selfTestError('NAO_PREPARADO', 'Prepare o acesso antes de fazer o teste local.');
    const pacote = packageInfo(this.packageRoot, this.platform, this.packageShape);
    if (!pacote.disponivel) throw selfTestError('PACOTE_INDISPONIVEL', 'A extens\u00e3o do Lume n\u00e3o est\u00e1 dispon\u00edvel nesta instala\u00e7\u00e3o.');
    if (!pacote.sistema_compativel) throw selfTestError('SISTEMA_INCOMPATIVEL', 'Este sistema ainda n\u00e3o \u00e9 compat\u00edvel com a extens\u00e3o do Lume.');
    const database = join(this.dataDir, 'assessor.db'), presencePath = lumePresencePath(this.dataDir);
    if (!existsSync(database)) throw selfTestError('MEMORIA_INDISPONIVEL', 'A mem\u00f3ria local do Lume n\u00e3o est\u00e1 dispon\u00edvel.');
    try { assertLumeAppPresence({ presencePath }); }
    catch { throw selfTestError('LUME_FECHADO', 'Mantenha o Lume aberto para fazer o teste local.'); }

    mkdirSync(this.packageDir, { recursive: true });
    const temporary = mkdtempSync(join(this.packageDir, 'autoteste-'));
    const createdStage = lstatSync(temporary);
    let broker = null, published = null, copiedPresence = null;
    let childClosed = true, brokerClosed = true, descriptorReleased = true, stageUncertain = false, confirmed = false;
    try {
      const built = buildLumeMcpb({ root: this.packageRoot, outputDir: temporary, shape: this.packageShape });
      extractPackage(readFileSync(built.artifact), temporary);
      const credential = randomBytes(32).toString('base64url');
      const profileEnv = process.platform === 'darwin' ? { HOME: join(temporary, 'home') } : { APPDATA: join(temporary, 'appdata') };
      const testUserData = process.platform === 'darwin'
        ? join(profileEnv.HOME, 'Library', 'Application Support', 'AssessorDesktop')
        : join(profileEnv.APPDATA, 'AssessorDesktop');
      const testDataDir = join(testUserData, 'data');
      mkdirSync(join(testDataDir, 'mcp'), { recursive: true });
      await criarSnapshot({ caminhoOrigem: database, caminhoDestino: join(testDataDir, 'assessor.db'), gerarManifesto: false });
      const snapshotDb = new DatabaseSync(join(testDataDir, 'assessor.db'));
      try {
        neutralizarAutoridadeSnapshot(snapshotDb);
      } finally {
        try { snapshotDb.close(); }
        catch { stageUncertain = true; throw new Error('SELF_TEST_SNAPSHOT_CLOSE'); }
      }
      const temporaryActivation = join(testDataDir, 'mcp', 'claude-desktop.json');
      applyClaudeActivation({ activationPath: temporaryActivation, scope: { kind: TODAY, date: localDay(this.now()) }, credential });
      copiedPresence = startLumeAppPresence({ dataDir: testDataDir });
      if (!copiedPresence.active) throw new Error('SELF_TEST_PRESENCE');
      const selection = { tipo: 'legado', id: 'legado', geracao: null };
      const identity = await createBootIdentity(), boot = randomUUID();
      let helloCount = 0, beginCount = 0;
      broker = createProfileBroker({ selection, boot, identity,
        authorizeHello: request => {
          const granted = authorizeClaudeBrokerHello({ activationPath: temporaryActivation, ...request });
          if (granted) helloCount++;
          return granted;
        },
        authorizeBegin: request => {
          const granted = authorizeClaudeBrokerBegin({ activationPath: temporaryActivation, ...request });
          if (granted) beginCount++;
          return granted;
        }
      });
      brokerClosed = false;
      const { port } = await broker.start();
      // A publish failure may leave an uncertain owned temporary descriptor.
      descriptorReleased = false;
      published = await publishBrokerDescriptor({ userData: testUserData, selection, boot, port, identity });
      broker.admit();
      childClosed = false;
      try { await runPackagedStdio({
        entry: join(temporary, 'server', 'index.js'),
        profileEnv,
        credential
      }); childClosed = true; }
      catch (error) { childClosed = error?.childClosed === true; stageUncertain ||= error?.uncertain === true; throw error; }
      if (helloCount < 1 || beginCount < 1) throw new Error('SELF_TEST_BROKER_UNUSED');
      let drained;
      try { drained = await broker.drain(); }
      catch { stageUncertain = true; throw new Error('SELF_TEST_BROKER_UNCERTAIN'); }
      if (drained?.closed !== true) { stageUncertain = true; throw new Error('SELF_TEST_BROKER_UNCERTAIN'); }
      await broker.close(); brokerClosed = true;
      await published.release(); descriptorReleased = true;
      confirmed = true;
      return {
        ok: true,
        estado: 'aprovado',
        provas: { pacote: true, configuracao: true, leitura_local: true, transporte_stdio: true },
        claude_conectado: false,
        testado_em: this.now().toISOString()
      };
    } catch {
      throw selfTestError('FALHA_INTERNA', 'O teste local n\u00e3o passou. Feche e abra o Lume e tente novamente.');
    } finally {
      if (broker && !brokerClosed) { try { await broker.close(); brokerClosed = true; } catch {} }
      if (published && !descriptorReleased && brokerClosed) { try { await published.release(); descriptorReleased = true; } catch {} }
      copiedPresence?.stop();
      if (!stageUncertain && childClosed && brokerClosed && descriptorReleased) {
        try { removeOwnStage(temporary, this.packageDir, createdStage); }
        catch { if (confirmed) throw selfTestError('FALHA_INTERNA', 'O teste local n\u00e3o passou. Feche e abra o Lume e tente novamente.'); }
      }
    }
  }
}

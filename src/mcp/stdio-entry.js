import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assinaturaFonte } from '../tarefas-esquema.js';
import { createLumeMcpCore } from './core.js';
import { startLumeMcpStdio } from './stdio-server.js';
import { assertLumeAppPresence } from './presence.js';
import { readBrokerDescriptor } from './broker-bootstrap.js';
import { connectProfileBroker } from './profile-broker-client.js';
import { readClaudeActivationForClient } from './activation.js';
import { ExecucoesLume } from '../execucao/servico.js';
import { selecionarPerfilBoot, validarSelecaoEsperada, erroPublicoPerfil } from '../perfil-boot.js';

const required = name => {
  const value = process.env[name];
  if (typeof value !== 'string' || !value) throw new Error('MCP_NOT_CONFIGURED');
  return value;
};
const denied = () => new Error('MCP_BROKER_UNAVAILABLE');
const sameActivation = (a, b) => Boolean(a && b && a.revision === b.revision && a.credentialHash === b.credentialHash &&
  JSON.stringify(a.scope) === JSON.stringify(b.scope) && a.secret.equals(b.secret));

export async function startFromEnvironment({ input = process.stdin, output = process.stdout, version, userData, expectedSelection } = {}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw new Error('MCP_PACKAGE_INVALID');
  if (typeof userData !== 'string' || !expectedSelection) throw Object.assign(new Error('PERFIL_SELECAO_INVALIDA'), { code: 'PERFIL_SELECAO_INVALIDA' });
  let cut = false, lost = false, server = null, stopStarted = false, client = null;
  const stopServer = () => {
    if (server && !stopStarted) { stopStarted = true; void server.stop().catch(() => {}); }
  };
  const onDrain = () => { cut = true; stopServer(); };
  const onLost = () => { cut = true; lost = true; stopServer(); };
  const assertLive = () => { if (cut || lost) throw denied(); };
  const selection = validarSelecaoEsperada(await selecionarPerfilBoot(userData), expectedSelection);
  assertLive();
  const database = join(selection.dataDir, 'assessor.db');
  const activationPath = join(selection.dataDir, 'mcp', 'claude-desktop.json');
  const presencePath = join(selection.dataDir, 'mcp', 'app-presence.json');
  for (const [name, expected] of [['LUME_MCP_DATA_DIR', selection.dataDir], ['LUME_MCP_DATABASE', database], ['LUME_MCP_ACTIVATION_FILE', activationPath], ['LUME_MCP_PRESENCE_FILE', presencePath]]) {
    if (process.env[name] !== undefined && process.env[name] !== expected) throw Object.assign(new Error('PERFIL_CAMINHO_DIVERGENTE'), { code: 'PERFIL_CAMINHO_DIVERGENTE' });
  }
  const clientId = required('LUME_MCP_CLIENT_ID');
  if (clientId !== 'claude-desktop') throw new Error('MCP_NOT_CONFIGURED');
  const credential = required('LUME_MCP_CREDENTIAL');
  let db = null, execDb = null, dbOpened = false, execOpened = false, dbClosed = false, execClosed = false;
  const closeDatabases = () => {
    let failed = false;
    if (execOpened && !execClosed) { try { execDb.close(); execClosed = true; } catch { failed = true; } }
    if (dbOpened && !dbClosed) { try { db.close(); dbClosed = true; } catch { failed = true; } }
    return !failed && (!execOpened || execClosed) && (!dbOpened || dbClosed);
  };
  try {
    // Protected descriptor and TLS GRANT are mandatory before any DatabaseSync.
    const descriptor = await readBrokerDescriptor({ userData, selection });
    assertLive();
    const first = readClaudeActivationForClient({ activationPath, clientId, credential });
    if (!first) throw denied();
    assertLive();
    client = await connectProfileBroker({ descriptor, selection, clientId, credential, onDrain, onLost });
    assertLive();
    if (client.grant.revision !== first.revision) throw denied();
    const reread = await readBrokerDescriptor({ userData, selection });
    assertLive();
    if (JSON.stringify(reread) !== JSON.stringify(descriptor)) throw denied();
    const selectedAgain = validarSelecaoEsperada(await selecionarPerfilBoot(userData), expectedSelection);
    assertLive();
    if (selectedAgain.dataDir !== selection.dataDir) throw denied();
    const current = readClaudeActivationForClient({ activationPath, clientId, credential, revision: client.grant.revision });
    if (!sameActivation(first, current) || !existsSync(database)) throw denied();
    assertLive();
    dbOpened = true;
    db = new DatabaseSync(database, { readOnly: true });
    assertLive();
    db.function('desktop_tarefa_hash', { deterministic: true }, (texto, permissao, conversa_id, origem_id, recebido_em, projeto_id, origem_compartilhamento, autor_id, autor_e_dono, transcricao_meta) => assinaturaFonte({ texto, permissao, conversa_id, origem_id, recebido_em, projeto_id, origem_compartilhamento, autor_id, autor_e_dono, transcricao_meta }));
    const authorize = async ({ clientId: requestedClient, credential: requestedCredential }) => {
      if (cut || lost) return { enabled: false, revoked: true };
      let selectedNow;
      try { selectedNow = validarSelecaoEsperada(await selecionarPerfilBoot(userData), expectedSelection); }
      catch { return { enabled: false, revoked: true }; }
      if (cut || lost || selectedNow.dataDir !== selection.dataDir) return { enabled: false, revoked: true };
      assertLumeAppPresence({ presencePath });
      const latest = readClaudeActivationForClient({ activationPath, clientId: requestedClient, credential: requestedCredential, revision: client.grant.revision });
      return sameActivation(first, latest) ? { enabled: true, revoked: false, revision: latest.revision, scope: latest.scope } : { enabled: false, revoked: true };
    };
    let execucoes;
    if (process.env.LUME_MCP_SELF_TEST_READ_ONLY !== '1' && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lume_execucoes'").get()) {
      assertLive();
      execOpened = true;
      execDb = new DatabaseSync(database, { timeout: 5000 });
      assertLive();
      execDb.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      execDb.function('desktop_tarefa_hash', { deterministic: true }, (texto, permissao, conversa_id, origem_id, recebido_em, projeto_id, origem_compartilhamento, autor_id, autor_e_dono, transcricao_meta) => assinaturaFonte({ texto, permissao, conversa_id, origem_id, recebido_em, projeto_id, origem_compartilhamento, autor_id, autor_e_dono, transcricao_meta }));
      execucoes = new ExecucoesLume(execDb, { migrar: false });
    }
    assertLive();
    const core = createLumeMcpCore({ db, authorize, secret: first.secret, execucoes });
    assertLive();
    server = startLumeMcpStdio({ core, clientId, credential, version, input, output,
      operationGate: { begin: client.begin, end: client.end },
      onClose: async () => {
        if (!closeDatabases()) { client.abort(); throw denied(); }
        if (lost || server.drainFailed || server.outputState.failed) { client.abort(); throw denied(); }
        try { await client.closeAfterDb(); } catch { client.abort(); throw denied(); }
      } });
    assertLive();
    return server;
  } catch (error) {
    stopServer();
    if (!server) closeDatabases();
    client?.abort();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
    if (manifest?.name !== 'com.readyworks.lume.local-memory' || manifest.manifest_version !== '0.3' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(manifest.version)) throw new Error('MCP_PACKAGE_INVALID');
    const server = await startFromEnvironment({ version: manifest.version });
    server.closed.catch(() => { process.exitCode = 1; });
    const close = () => { server.stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  } catch (error) { const safe = erroPublicoPerfil(error); process.stderr.write(`${safe.code}: ${safe.message}\n`); process.exitCode = 1; }
}

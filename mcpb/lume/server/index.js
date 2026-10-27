import { readFileSync } from 'node:fs';

function packageVersion() {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  if (manifest.manifest_version !== '0.3' || manifest.name !== 'com.readyworks.lume.local-memory' || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(manifest.version)) throw new Error('LUME_PACKAGE_INVALID');
  return manifest.version;
}

let erroPublicoPerfil;
try {
  const { userDataMcp, selecionarPerfilBoot, erroPublicoPerfil: publicError } = await import('../src/perfil-boot.js');
  erroPublicoPerfil = publicError;
  const { startFromEnvironment } = await import('../src/mcp/stdio-entry.js');
  const userData = userDataMcp();
  const version = packageVersion();
  const selection = await selecionarPerfilBoot(userData);
  process.env.LUME_MCP_CLIENT_ID = 'claude-desktop';
  const server = await startFromEnvironment({ userData, expectedSelection: { tipo: selection.tipo, id: selection.id, geracao: selection.geracao }, version });
  const close = () => { void server.stop().catch(() => {}); };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  try { await server.closed; }
  finally {
    process.off('SIGTERM', close);
    process.off('SIGINT', close);
  }
} catch (error) {
  const safe = typeof erroPublicoPerfil === 'function' ? erroPublicoPerfil(error) : { code: 'PERFIL_VERIFICACAO_FALHOU', message: 'O Lume não conseguiu verificar o perfil.' };
  process.stderr.write(`${safe.code}: ${safe.message}\n`);
  process.exitCode = 1;
}

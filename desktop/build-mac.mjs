import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {assertUniversalDependencies, universalDependencyPlan} from '../scripts/prepare-macos-universal-deps.mjs';

// Pré-requisitos do candidato de distribuição; não existe opção para omitir assinatura.
export function prepararBuildMac({ platform = process.platform, arch = process.arch, env = process.env, args = process.argv.slice(2) } = {}) {
  const allowed = new Set(['--check', '--universal']);
  if (args.some(a => !allowed.has(a)) || new Set(args).size !== args.length) throw Error('Use apenas os argumentos --check e/ou --universal.');
  if (platform !== 'darwin') throw Error('O instalador Mac deve ser produzido em um Mac autorizado. Nenhum build iniciado.');
  if (!['arm64', 'x64'].includes(arch)) throw Error('Arquitetura Mac não suportada nesta preparação.');
  if (env.CSC_IDENTITY_AUTO_DISCOVERY?.trim() === 'false' || env.CSC_NAME?.trim() === '-') throw Error('O candidato exige identidade Developer ID; assinatura desativada ou ad-hoc não é aceita.');
  const groups = [['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'], ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'], ['APPLE_KEYCHAIN_PROFILE']];
  if (!groups.some(keys => keys.every(k => typeof env[k] === 'string' && env[k].trim()))) throw Error('Configure um conjunto completo de credenciais de notarização no ambiente seguro do Mac. Nenhum build iniciado.');
  if (env.GITHUB_ACTIONS === 'true' && env.LUME_RELEASE_APPROVED === 'PUBLICAR' && !env.LUME_LAYA_BUILD_CONFIG?.trim()) throw Error('Release Mac exige configuração com modelo Laya verificado. Nenhum build iniciado.');
  const targetArch = args.includes('--universal') ? 'universal' : arch;
  const builderArgs = ['--mac', 'dmg', 'zip', `--${targetArch}`, '--publish', 'never', '--config.forceCodeSigning=true', '--config.mac.notarize=true'];
  if (env.LUME_LAYA_BUILD_CONFIG?.trim()) builderArgs.push('--config', env.LUME_LAYA_BUILD_CONFIG.trim());
  return { arch: targetArch, hostArch: arch, check: args.includes('--check'), args: builderArgs };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const plan = prepararBuildMac();
    if (plan.check) console.log(JSON.stringify({ plataforma: 'macOS', arquitetura: plan.arch, ambienteNotarizacao: 'configurado', identidade: 'será conferida pelo builder', buildIniciado: false }));
    else {
      const require = createRequire(import.meta.url);
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      if (plan.arch === 'universal') assertUniversalDependencies(universalDependencyPlan({root}));
      const child = spawn(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...plan.args], { cwd: root, env: process.env, stdio: 'inherit', shell: false });
      child.on('error', () => { console.error('Não foi possível iniciar o empacotador Mac.'); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

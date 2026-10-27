import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertReleaseReady} from './release-readiness.mjs';

export function candidateBuildArgs({platform = process.platform, arch = process.arch} = {}) {
  if (platform === 'win32' && arch === 'x64') return ['--dir', '--win', '--x64', '--publish', 'never'];
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return ['--dir', '--mac', `--${arch}`, '--publish', 'never', '--config.mac.identity=null', '--config.mac.forceCodeSigning=false', '--config.mac.notarize=false'];
  throw Error('O candidato interno pode ser empacotado somente em Windows x64 ou macOS arm64/x64.');
}

export function construirCandidato({platform = process.platform, arch = process.arch, env = process.env, spawnProcess = spawn} = {}) {
  const root = resolve(import.meta.dirname, '..');
  const readiness = assertReleaseReady({mode: 'candidate', root, env});
  const require = createRequire(import.meta.url);
  const command = process.execPath;
  const args = [require.resolve('electron-builder/out/cli/cli.js'), ...candidateBuildArgs({platform, arch})];
  const child = spawnProcess(command, args, {cwd: root, env, stdio: 'inherit', shell: false});
  child.on('error', () => { console.error('Não foi possível iniciar o empacotamento interno.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  return {readiness, child};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { construirCandidato(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

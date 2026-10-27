import { join } from 'node:path';

export function caminhosPacote({ output, platform, arch, metadata }) {
  if (!['win32', 'darwin'].includes(platform) || !['x64', 'arm64', 'universal'].includes(arch)) throw Error('Plataforma ou arquitetura de pacote não suportada.');
  if (platform === 'win32' && arch !== 'x64') throw Error('O candidato Windows atual é x64.');
  const config = metadata.build[platform === 'darwin' ? 'mac' : 'win'];
  const ext = platform === 'darwin' ? 'dmg' : 'exe';
  const vars = { version: metadata.version, arch, ext };
  const artifact = config.artifactName.replace(/\$\{(version|arch|ext)\}/g, (_, key) => vars[key]);
  if (/[\\/]|\$\{/.test(artifact)) throw Error('Nome de artefato não resolvido.');
  const macDirectory = arch === 'arm64' ? 'mac-arm64' : arch === 'universal' ? 'mac-universal' : 'mac';
  const archive = platform === 'darwin'
    ? join(output, macDirectory, `${metadata.build.productName}.app`, 'Contents', 'Resources', 'app.asar')
    : join(output, 'win-unpacked', 'resources', 'app.asar');
  return { archive, artifact: join(output, artifact) };
}

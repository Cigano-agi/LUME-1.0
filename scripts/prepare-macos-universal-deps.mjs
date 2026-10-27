import {cpSync, existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ARCHITECTURES = ['arm64', 'x64'];
const packageNames = architecture => [
  `@img/sharp-darwin-${architecture}`,
  `@img/sharp-libvips-darwin-${architecture}`
];

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function packagePath(root, name) {
  return join(root, 'node_modules', ...name.split('/'));
}

function packageVersion(path) {
  try { return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).version; }
  catch { return null; }
}

function npmCliPath(env = process.env) {
  const candidates = [
    env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ].filter(Boolean);
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('CLI oficial do npm não foi encontrada junto ao Node.');
  return found;
}

export function universalDependencyPlan({root, platform = process.platform, architecture = process.arch} = {}) {
  if (platform !== 'darwin') throw new Error('A preparação universal exige macOS.');
  if (!ARCHITECTURES.includes(architecture)) throw new Error('Arquitetura macOS inválida.');
  const project = resolve(root || join(dirname(fileURLToPath(import.meta.url)), '..'));
  const lock = JSON.parse(readFileSync(join(project, 'package-lock.json'), 'utf8'));
  const expected = Object.fromEntries(ARCHITECTURES.flatMap(arch => packageNames(arch).map(name => {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry?.version || !entry?.integrity || !entry?.optional) throw new Error(`Dependência ${name} ausente do lock reproduzível.`);
    return [name, {architecture: arch, version: entry.version, integrity: entry.integrity}];
  })));
  return {
    root: project,
    architecture,
    expected,
    npmArgsByArchitecture: Object.fromEntries(ARCHITECTURES.map(arch => [arch, ['ci', '--ignore-scripts', '--omit=dev', '--include=optional', '--os=darwin', `--cpu=${arch}`, '--no-audit', '--no-fund']]))
  };
}

export function assertUniversalDependencies({root, expected} = {}) {
  const project = resolve(root);
  for (const [name, contract] of Object.entries(expected)) {
    const installed = packagePath(project, name);
    if (packageVersion(installed) !== contract.version) throw new Error(`Dependência universal ${name}@${contract.version} ausente.`);
  }
  return true;
}

export function prepareUniversalDependencies({root, platform = process.platform, architecture = process.arch, run = spawnSync} = {}) {
  const plan = universalDependencyPlan({root, platform, architecture});
  const workRoot = resolve(plan.root, 'work');
  mkdirSync(workRoot, {recursive: true});
  const npmCli = npmCliPath();
  for (const targetArchitecture of ARCHITECTURES) {
    const staging = resolve(workRoot, `macos-universal-deps-${process.pid}-${targetArchitecture}`);
    if (!inside(workRoot, staging)) throw new Error('Diretório temporário fora da área de trabalho.');
    rmSync(staging, {recursive: true, force: true});
    mkdirSync(staging, {recursive: true});
    try {
      cpSync(join(plan.root, 'package.json'), join(staging, 'package.json'));
      cpSync(join(plan.root, 'package-lock.json'), join(staging, 'package-lock.json'));
      const result = run(process.execPath, [npmCli, ...plan.npmArgsByArchitecture[targetArchitecture], '--prefix', staging], {cwd: plan.root, env: {...process.env, npm_config_update_notifier: 'false'}, stdio: 'inherit', shell: false});
      if (result?.error || result?.status !== 0) throw new Error(`npm ci isolado não conseguiu preparar macOS ${targetArchitecture}.`);
      for (const name of packageNames(targetArchitecture)) {
        const source = packagePath(staging, name);
        const target = packagePath(plan.root, name);
        const expectedVersion = plan.expected[name].version;
        if (packageVersion(source) !== expectedVersion) throw new Error(`npm ci não entregou ${name}@${expectedVersion}.`);
        rmSync(target, {recursive: true, force: true});
        mkdirSync(dirname(target), {recursive: true});
        cpSync(source, target, {recursive: true, force: false, errorOnExist: true});
      }
    } finally {
      rmSync(staging, {recursive: true, force: true});
    }
  }
  assertUniversalDependencies(plan);
  return plan;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const plan = prepareUniversalDependencies();
    console.log(JSON.stringify({prepared: true, hostArchitecture: plan.architecture, preparedArchitectures: ARCHITECTURES}));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

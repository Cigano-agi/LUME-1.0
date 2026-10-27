import assert from 'node:assert/strict';
import { extractAll } from '@electron/asar';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Argumentos invalidos.');
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

const input = options(process.argv.slice(2));
if (!input.app || !['arm64', 'x64'].includes(input.architecture)) throw new Error('Use --app e --architecture arm64|x64.');
if (process.platform !== 'darwin' || process.arch !== input.architecture) throw new Error('A prova exige a arquitetura macOS nativa declarada.');

const app = resolve(input.app);
const archive = join(app, 'Contents', 'Resources', 'app.asar');
assert.equal(existsSync(archive), true, 'app.asar universal ausente.');
const extracted = join(resolve(process.env.RUNNER_TEMP || tmpdir()), `lume-universal-native-${process.pid}`);
rmSync(extracted, { recursive: true, force: true });

try {
  extractAll(archive, extracted);
  const transformerRoot = join(extracted, 'node_modules', '@huggingface', 'transformers');
  const ortRoot = [
    join(extracted, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'darwin'),
    join(transformerRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'darwin')
  ].find(candidate => existsSync(candidate));
  assert.ok(ortRoot, 'ONNX Runtime não foi empacotado.');
  for (const architecture of ['arm64', 'x64']) {
    assert.equal(existsSync(join(ortRoot, architecture, 'onnxruntime_binding.node')), true, `ONNX Runtime ${architecture} ausente.`);
    const sharpDir = join(extracted, 'node_modules', '@img', `sharp-darwin-${architecture}`, 'lib');
    assert.equal(existsSync(sharpDir) && readdirSync(sharpDir).some(name => name.endsWith('.node')), true, `Sharp ${architecture} ausente.`);
    assert.equal(existsSync(join(extracted, 'node_modules', '@img', `sharp-libvips-darwin-${architecture}`, 'lib')), true, `libvips ${architecture} ausente.`);
  }
  const transformers = await import(pathToFileURL(join(transformerRoot, 'dist', 'transformers.node.mjs')).href);
  assert.equal(typeof transformers.pipeline, 'function', 'Transformers não carregou no pacote universal.');
  const evidence = {
    platform: process.platform,
    architecture: process.arch,
    universalDependencies: ['onnxruntime-node', 'sharp', 'sharp-libvips'],
    transformersImported: true
  };
  const output = resolve('work', 'desktop-qa', `native-dependencies-${process.arch}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log('MACOS_UNIVERSAL_NATIVE_OK', JSON.stringify(evidence));
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

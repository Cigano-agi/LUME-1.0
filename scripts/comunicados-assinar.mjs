import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validarCampanha } from '../src/novidades.js';

const INPUT_SCHEMA = 'lume-comunicados-input-v1';
const OUTPUT_SCHEMA = 'lume-comunicados-v1';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const INPUT_KEYS = ['schema', 'geradoEm', 'campanhas'];
const CHANNEL_ORDER = ['beta', 'estavel'];
const PLATFORM_ORDER = ['win32', 'darwin'];

function exactObject(value, keys) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('ENTRADA_INVALIDA');
  return new Date(value).toISOString();
}

function byCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCampaign(value) {
  let campaign;
  try { campaign = validarCampanha(value); }
  catch { fail('CAMPANHA_INVALIDA'); }
  return {
    ...campaign,
    canais: CHANNEL_ORDER.filter(channel => campaign.canais.includes(channel)),
    plataformas: PLATFORM_ORDER.filter(platform => campaign.plataformas.includes(platform))
  };
}

export function construirCorpoComunicados(input) {
  if (!exactObject(input, INPUT_KEYS) || input.schema !== INPUT_SCHEMA || !Array.isArray(input.campanhas) || input.campanhas.length > 20) fail('ENTRADA_INVALIDA');
  const campaigns = input.campanhas.map(normalizeCampaign).sort((left, right) => byCodePoint(left.id, right.id));
  if (new Set(campaigns.map(campaign => campaign.id)).size !== campaigns.length) fail('CAMPANHA_INVALIDA');
  return { schema: OUTPUT_SCHEMA, geradoEm: normalizeDate(input.geradoEm), campanhas: campaigns };
}

export function assinarCorpoComunicados(body, privateKey) {
  if (!exactObject(body, ['schema', 'geradoEm', 'campanhas']) || body.schema !== OUTPUT_SCHEMA) fail('ENTRADA_INVALIDA');
  const normalized = construirCorpoComunicados({ schema: INPUT_SCHEMA, geradoEm: body.geradoEm, campanhas: body.campanhas });
  if (JSON.stringify(normalized) !== JSON.stringify(body)) fail('ENTRADA_INVALIDA');
  let key;
  try { key = createPrivateKey(privateKey); }
  catch { fail('CHAVE_INVALIDA'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('CHAVE_INVALIDA');
  const signature = sign(null, Buffer.from(JSON.stringify(normalized), 'utf8'), key).toString('base64');
  return { ...normalized, assinatura: signature };
}

function inspectRegularFile(path, maximumBytes, invalidCode) {
  let info;
  try { info = lstatSync(path); }
  catch { fail(invalidCode); }
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) fail(invalidCode);
  return info;
}

function readInput(path) {
  inspectRegularFile(path, MAX_INPUT_BYTES, 'ENTRADA_INVALIDA');
  try { return JSON.parse(readFileSync(path, 'utf8'));
  } catch { fail('ENTRADA_INVALIDA'); }
}

function readPrivateKey(path) {
  const info = inspectRegularFile(path, MAX_KEY_BYTES, 'CHAVE_INVALIDA');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('CHAVE_PERMISSOES_INSEGURAS');
  try { return readFileSync(path); }
  catch { fail('CHAVE_INVALIDA'); }
}

function samePath(left, right) {
  const a = resolve(left), b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function escreverAtomicamente(outputPath, contents) {
  const output = resolve(outputPath);
  const parent = dirname(output);
  let parentInfo;
  try { parentInfo = lstatSync(parent); }
  catch { fail('SAIDA_INVALIDA'); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('SAIDA_INVALIDA');
  if (existsSync(output)) {
    let outputInfo;
    try { outputInfo = lstatSync(output); }
    catch { fail('SAIDA_INVALIDA'); }
    if (!outputInfo.isFile() || outputInfo.isSymbolicLink()) fail('SAIDA_INVALIDA');
  }

  const temporary = resolve(parent, `.${basename(output)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, output);
  } catch {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { rmSync(temporary, { force: true }); } catch {}
    fail('SAIDA_INVALIDA');
  }
}

export function assinarArquivoComunicados({ inputPath, keyPath, outputPath }) {
  if (![inputPath, keyPath, outputPath].every(value => typeof value === 'string' && value.trim())) fail('ARGUMENTOS_INVALIDOS');
  if (samePath(inputPath, keyPath) || samePath(inputPath, outputPath) || samePath(keyPath, outputPath)) fail('CAMINHOS_INVALIDOS');

  const input = readInput(resolve(inputPath));
  const body = construirCorpoComunicados(input);
  const privateKey = readPrivateKey(resolve(keyPath));
  try {
    const envelope = assinarCorpoComunicados(body, privateKey);
    escreverAtomicamente(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
    return { outputPath: resolve(outputPath), campanhas: envelope.campanhas.length, geradoEm: envelope.geradoEm };
  } finally {
    privateKey.fill(0);
  }
}

function parseArguments(argv) {
  const allowed = new Set(['--input', '--key-file', '--output']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index], value = argv[index + 1];
    if (!allowed.has(option) || typeof value !== 'string' || value.startsWith('--') || Object.hasOwn(values, option)) fail('ARGUMENTOS_INVALIDOS');
    values[option] = value;
  }
  if (argv.length !== 6 || !values['--input'] || !values['--key-file'] || !values['--output']) fail('ARGUMENTOS_INVALIDOS');
  return { inputPath: values['--input'], keyPath: values['--key-file'], outputPath: values['--output'] };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  try {
    const result = assinarArquivoComunicados(parseArguments(process.argv.slice(2)));
    process.stdout.write(`Comunicados assinados: ${result.campanhas}\nArquivo: ${result.outputPath}\n`);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'FALHA_INTERNA';
    process.stderr.write(`Falha ao assinar comunicados: ${code}\n`);
    process.exitCode = 1;
  }
}

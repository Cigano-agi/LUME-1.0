import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assinarArquivoComunicados, assinarCorpoComunicados, construirCorpoComunicados } from '../scripts/comunicados-assinar.mjs';
import { validarEnvelopeComunicados } from '../src/novidades.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CLI = join(PROJECT_ROOT, 'scripts', 'comunicados-assinar.mjs');

function workspace(t) {
  const path = mkdtempSync(join(tmpdir(), 'lume-comunicados-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privatePem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    publicDer: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  };
}

function campaign(patch = {}) {
  return {
    id: 'melhor-busca',
    titulo: '  Busca mais simples  ',
    texto: '  Encontre a conversa certa sem perder tempo.  ',
    inicioEm: '2026-09-19T09:00:00-03:00',
    expiraEm: '2026-10-19T09:00:00-03:00',
    canais: ['estavel', 'beta'],
    plataformas: ['darwin', 'win32'],
    versaoMin: '3.1.0-beta.1',
    versaoMax: '3.2.0',
    repetirAposHoras: 0,
    acao: 'ver_atualizacoes',
    ...patch
  };
}

function input(campaigns = [campaign()]) {
  return { schema: 'lume-comunicados-input-v1', geradoEm: '2026-09-19T09:30:00-03:00', campanhas: campaigns };
}

test('normaliza a entrada em corpo deterministico e produz assinatura Ed25519 aceita pelo aplicativo', () => {
  const { privatePem, publicDer } = keys();
  const first = construirCorpoComunicados(input([
    campaign({ id: 'z-final' }),
    campaign({ id: 'a-inicio', canais: ['beta', 'estavel'], plataformas: ['win32', 'darwin'] })
  ]));
  const second = construirCorpoComunicados(input([
    campaign({ id: 'a-inicio', canais: ['estavel', 'beta'], plataformas: ['darwin', 'win32'] }),
    campaign({ id: 'z-final' })
  ]));

  assert.deepEqual(first, second);
  assert.equal(first.geradoEm, '2026-09-19T12:30:00.000Z');
  assert.deepEqual(first.campanhas.map(item => item.id), ['a-inicio', 'z-final']);
  assert.deepEqual(first.campanhas[0].canais, ['beta', 'estavel']);
  assert.deepEqual(first.campanhas[0].plataformas, ['win32', 'darwin']);
  assert.equal(first.campanhas[0].titulo, 'Busca mais simples');

  const signedFirst = assinarCorpoComunicados(first, privatePem);
  const signedSecond = assinarCorpoComunicados(second, privatePem);
  assert.equal(signedFirst.assinatura, signedSecond.assinatura);
  assert.deepEqual(validarEnvelopeComunicados(signedFirst, publicDer), first);
});

test('CLI le a chave somente de arquivo, grava envelope atomico e nao imprime segredo', t => {
  const dir = workspace(t), { privatePem, publicDer } = keys();
  const inputPath = join(dir, 'entrada.json'), keyPath = join(dir, 'chave.pem'), outputPath = join(dir, 'beta.json');
  writeFileSync(inputPath, JSON.stringify(input()), { mode: 0o600 });
  writeFileSync(keyPath, privatePem, { mode: 0o600 });

  const result = spawnSync(process.execPath, [CLI, '--input', inputPath, '--key-file', keyPath, '--output', outputPath], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Comunicados assinados: 1/);
  assert.equal(result.stdout.includes(privatePem.toString()), false);
  assert.equal(result.stderr.includes(privatePem.toString()), false);
  const envelope = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(validarEnvelopeComunicados(envelope, publicDer).campanhas.length, 1);
  assert.deepEqual(readdirSync(dir).sort(), ['beta.json', 'chave.pem', 'entrada.json']);
  if (process.platform !== 'win32') assert.equal(statSync(outputPath).mode & 0o077, 0);

  const marker = 'SEGREDO-QUE-NAO-PODE-APARECER';
  writeFileSync(keyPath, marker, { mode: 0o600 });
  const failed = spawnSync(process.execPath, [CLI, '--input', inputPath, '--key-file', keyPath, '--output', outputPath], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /CHAVE_INVALIDA/);
  assert.equal(`${failed.stdout}${failed.stderr}`.includes(marker), false);
  assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), envelope);
});

test('entrada, chave e saida invalidas falham fechadas sem alterar arquivo anterior', t => {
  const dir = workspace(t), { privatePem } = keys();
  const inputPath = join(dir, 'entrada.json'), keyPath = join(dir, 'chave.pem'), outputPath = join(dir, 'beta.json');
  writeFileSync(inputPath, JSON.stringify({ ...input(), extra: true }), { mode: 0o600 });
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  writeFileSync(outputPath, 'CONTEUDO ANTERIOR', { mode: 0o600 });

  assert.throws(() => assinarArquivoComunicados({ inputPath, keyPath, outputPath }), /ENTRADA_INVALIDA/);
  assert.equal(readFileSync(outputPath, 'utf8'), 'CONTEUDO ANTERIOR');

  writeFileSync(inputPath, JSON.stringify(input()), { mode: 0o600 });
  assinarArquivoComunicados({ inputPath, keyPath, outputPath });
  const signedOutput = readFileSync(outputPath, 'utf8');
  assert.equal(JSON.parse(signedOutput).schema, 'lume-comunicados-v1');

  writeFileSync(keyPath, 'NAO E UMA CHAVE', { mode: 0o600 });
  assert.throws(() => assinarArquivoComunicados({ inputPath, keyPath, outputPath }), /CHAVE_INVALIDA/);
  assert.equal(readFileSync(outputPath, 'utf8'), signedOutput);
  assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);

  assert.throws(() => assinarArquivoComunicados({ inputPath, keyPath: outputPath, outputPath }), /CAMINHOS_INVALIDOS/);
  assert.equal(existsSync(outputPath), true);
});

test('recusa campanha ambigua e chave de algoritmo diferente', () => {
  const duplicate = input([campaign(), campaign()]);
  assert.throws(() => construirCorpoComunicados(duplicate), /CAMPANHA_INVALIDA/);
  assert.throws(() => construirCorpoComunicados(input([campaign({ codigo: 'executar' })])), /CAMPANHA_INVALIDA/);
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecPem = ec.privateKey.export({ format: 'pem', type: 'pkcs8' });
  assert.throws(() => assinarCorpoComunicados(construirCorpoComunicados(input()), ecPem), /CHAVE_INVALIDA/);
});

test('em sistemas POSIX recusa chave privada acessivel por outros usuarios', { skip: process.platform === 'win32' }, t => {
  const dir = workspace(t), { privatePem } = keys();
  const inputPath = join(dir, 'entrada.json'), keyPath = join(dir, 'chave.pem'), outputPath = join(dir, 'beta.json');
  writeFileSync(inputPath, JSON.stringify(input()), { mode: 0o600 });
  writeFileSync(keyPath, privatePem, { mode: 0o644 });
  assert.throws(() => assinarArquivoComunicados({ inputPath, keyPath, outputPath }), /CHAVE_PERMISSOES_INSEGURAS/);
  assert.equal(existsSync(outputPath), false);
});

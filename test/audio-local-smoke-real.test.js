import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonicalWav, wordErrorRate, verifyFile, verifyBundle, runSmoke, WORK} from '../scripts/audio-local-smoke-real.mjs';

function wav() {
  const out = Buffer.alloc(44 + 32000);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(32000, 40);
  return out;
}

test('SAPI RIFF: canonicaliza chunk extra com padding preservando PCM', () => {
  const original = wav();
  const extra = Buffer.from([...'JUNK'].map(x => x.charCodeAt(0)).concat([3, 0, 0, 0, 5, 6, 7, 0]));
  const input = Buffer.concat([original.subarray(0, 36), extra, original.subarray(36)]);
  input.writeUInt32LE(input.length - 8, 4);
  assert.deepEqual(canonicalWav(input), original);
});

test('SAPI RIFF: recusa truncamento, chunks duplicados e frequência errada', () => {
  const truncated = wav(); truncated.writeUInt32LE(32001, 40);
  assert.throws(() => canonicalWav(truncated), /truncado/);
  const wrongRate = wav(); wrongRate.writeUInt32LE(44100, 24);
  assert.throws(() => canonicalWav(wrongRate), /Áudio inválido/);
  const duplicated = Buffer.concat([wav(), wav().subarray(36)]);
  duplicated.writeUInt32LE(duplicated.length - 8, 4);
  assert.throws(() => canonicalWav(duplicated), /duplicado/);
});

test('WER explicita erros de nome e número, sem normalização que esconda troca', () => {
  assert.equal(wordErrorRate('Marina, terça-feira!', 'marina terça feira').rate, 0);
  assert.equal(wordErrorRate('Marina confirmou dez horas', 'Maria confirmou duas horas').rate, 0.5);
  assert.equal(wordErrorRate('duzentos e cinquenta reais', '250 reais').edits, 3);
  assert.equal(wordErrorRate('uma palavra', '').rate, 1);
  assert.throws(() => wordErrorRate('', 'texto'), /sem palavras/);
});

test('arquivos alterados e DLL extra bloqueiam execução do harness', async () => {
  await mkdir(WORK, {recursive: true});
  const directory = await mkdtemp(join(WORK, 'test-integrity-'));
  const file = join(directory, 'bytes.bin');
  const original = Buffer.from('abcd');
  const pin = {name: 'bytes.bin', bytes: 4, sha256: createHash('sha256').update(original).digest('hex')};
  await writeFile(file, original);
  await verifyFile(file, pin);
  await writeFile(file, 'abce');
  await assert.rejects(verifyFile(file, pin), /SHA-256 divergente/);
  await assert.rejects(verifyBundle(directory), /extras ou ausentes/);
});

// This test is never replaced with stub JSON. Explicit opt-in uses downloaded,
// pinned native files; missing files/voice fail and there is no network fallback.
test('ASR nativo PT-BR: transcrição, processo, limpeza, cancelamento e gate do app', {
  skip: process.env.LUME_AUDIO_REAL_SMOKE !== '1' ? 'requer LUME_AUDIO_REAL_SMOKE=1 e bundle oficial local' : false,
  timeout: 400000,
}, async () => {
  const result = await runSmoke();
  assert.equal(result.status, 'smoke-passed-quality-unvalidated');
  assert.equal(result.qualityApproved, false);
  assert.equal(result.appIntegrated, false);
  assert.equal(result.defaultAdapter.idioma, 'pt');
  assert.ok(result.defaultAdapter.transcricao.length > 10);
  assert.equal(result.defaultAdapter.noNewTempDirectories, true);
  assert.equal(result.defaultAdapter.qualidade, 'nao_validada');
  assert.equal(result.observed.processClosed, true);
  assert.equal(result.observed.exitCode, 0);
  assert.equal(result.observed.tempRemoved, true);
  assert.ok(result.observed.memory.samples > 0);
  assert.ok(result.observed.memory.peakWorkingSetBytes > 0);
  assert.equal(result.cancel.processClosed, true);
  assert.equal(result.cancel.tempRemoved, true);
  assert.equal(result.defaultCancel.noNewTempDirectories, true);
  assert.equal(result.defaultTimeout.noNewTempDirectories, true);
  assert.ok(result.defaultTimeout.wallMs >= 1000);
  assert.equal(result.appRuntime.disponivel, false);
});

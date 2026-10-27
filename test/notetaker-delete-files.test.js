import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, renameSync, symlinkSync, unlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cabecalhoWav, MAX_PARTE_PCM } from '../src/notetaker/contrato.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const childSource = String.raw`
import { writeFileSync, renameSync, openSync, writeSync, closeSync } from 'node:fs';
const { inventariarArquivosExclusao } = await import(process.argv[1]);
const input = JSON.parse(process.argv[2]);
const frozen = value => !value || typeof value !== 'object' ||
  (Object.isFrozen(value) && Object.values(value).every(frozen));
async function call(partes = input.partes, signal) {
  return inventariarArquivosExclusao({ perfil: input.perfil, sessaoId: input.sessaoId, partes, signal });
}
try {
  let result;
  if (input.mode === 'stable') {
    result = await call();
    const second = await call();
    process.stdout.write(JSON.stringify({ ok: true, result, same: JSON.stringify(result) === JSON.stringify(second), frozen: frozen(result) }));
  } else if (input.mode === 'zero') {
    result = await call([]);
    process.stdout.write(JSON.stringify({ ok: true, result, frozen: frozen(result) }));
  } else if (input.mode === 'abort') {
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    try { await call(input.partes, controller.signal); process.stdout.write(JSON.stringify({ ok: true, unexpected: true })); }
    catch (error) {
      let fdReleased = false;
      try { renameSync(input.harnessPath, input.harnessPath + '.closed'); renameSync(input.harnessPath + '.closed', input.harnessPath); fdReleased = true; }
      catch {}
      process.stdout.write(JSON.stringify({ ok: false, code: error.code, fdReleased }));
    }
  } else if (input.mode === 'mutate-during-read') {
    const originalPath = input.harnessPath;
    setImmediate(() => {
      try {
        const fd = openSync(originalPath, 'r+');
        try { writeSync(fd, Buffer.from([input.replacementByte]), 0, 1, 44); }
        finally { closeSync(fd); }
      }
      catch {}
    });
    try { await call(); process.stdout.write(JSON.stringify({ ok: true, unexpected: true })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })); }
  } else if (input.mode === 'mutate-first-after-read') {
    let ticks = 0;
    const mutate = () => {
      if (++ticks < 6) { setImmediate(mutate); return; }
      try {
        const fd = openSync(input.harnessPath, 'r+');
        try { writeSync(fd, Buffer.from([input.replacementByte]), 0, 1, 44); }
        finally { closeSync(fd); }
      } catch {}
    };
    setImmediate(mutate);
    try { await call(); process.stdout.write(JSON.stringify({ ok: true, unexpected: true })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code })); }
  } else if (input.mode === 'mutate-input-after-call') {
    const pending = call(input.partes);
    input.partes[0].nome = 'changed-after-call.wav';
    result = await pending;
    process.stdout.write(JSON.stringify({ ok: true, result, frozen: frozen(result) }));
  } else if (input.mode === 'add-sidecar-during-read') {
    setImmediate(() => { try { writeFileSync(input.harnessPath, 'pending', { flag: 'wx' }); } catch {} });
    try { await call(); process.stdout.write(JSON.stringify({ ok: true, unexpected: true })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message })); }
  } else {
    try { await call(input.partes, input.abort ? AbortSignal.abort() : undefined); process.stdout.write(JSON.stringify({ ok: true, unexpected: true })); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message })); }
  }
} catch (error) {
  process.stderr.write(String(error.code ?? error.name) + ': ' + error.message);
  process.exitCode = 1;
}
`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'lume-notetaker-files-'));
  const canonical = realpathSync(root), marker = randomUUID();
  const temp = realpathSync(tmpdir()), rel = relative(temp, canonical);
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep));
  assert.match(canonical.split(/[\\/]/).at(-1), /^lume-notetaker-/);
  writeFileSync(join(canonical, '.lume-notetaker-test'), marker, { flag: 'wx' });
  const audioRoot = join(canonical, 'notetaker-audio');
  mkdirSync(audioRoot);
  t.after(() => {
    const again = realpathSync(canonical);
    assert.equal(again, canonical);
    assert.equal(readFileSync(join(again, '.lume-notetaker-test'), 'utf8'), marker);
    assert.ok(relative(temp, again) && !relative(temp, again).startsWith('..' + sep));
    assert.match(again.split(/[\\/]/).at(-1), /^lume-notetaker-files-/);
    rmSync(again, { recursive: true, force: false });
  });
  return {
    root: canonical,
    audioRoot,
    perfil: { notetakerExperimento: true, testProfileRoot: canonical, testMarker: marker },
    sessaoId: randomUUID(),
  };
}

function makePart(f, pcmBytes = 32000, fill = 7, parteId = randomUUID()) {
  const wav = Buffer.concat([cabecalhoWav(pcmBytes), Buffer.alloc(pcmBytes, fill)]);
  const nome = parteId + '.wav';
  writeFileSync(join(f.audioRoot, nome), wav, { flag: 'wx' });
  return { row: { parteId, nome, sha256: sha(wav) }, wav, path: join(f.audioRoot, nome) };
}

function runChild(f, partes, mode = 'error', extra = {}) {
  const modulePath = pathToFileURL(join(process.cwd(), 'src/notetaker/exclusao-arquivos.js')).href;
  const input = { perfil: f.perfil, sessaoId: f.sessaoId, partes, mode, ...extra };
  const childEnv = { ...process.env, ASSESSOR_DESKTOP_TEST_PROFILE: f.root };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, modulePath, JSON.stringify(input)], {
    cwd: process.cwd(), env: childEnv, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  return result;
}

function resultOf(child) {
  assert.equal(child.status, 0, child.stderr || `child exit=${child.status}, signal=${child.signal}`);
  return JSON.parse(child.stdout);
}

test('inventario vazio e WAV canonico sao estaveis, ordenados e profundamente imutaveis', t => {
  const f = fixture(t), part = makePart(f), other = makePart(f, 64000, 8);
  const filesBefore = readdirSync(f.audioRoot).sort();
  const empty = resultOf(runChild(f, [], 'zero'));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.result.arquivos, []);
  assert.equal(empty.result.bytesTotal, 0);
  assert.equal(empty.frozen, true);

  const found = resultOf(runChild(f, [other.row, part.row], 'stable'));
  assert.equal(found.same, true);
  assert.equal(found.frozen, true);
  assert.deepEqual(found.result.arquivos.map(file => file.parteId), [part.row.parteId, other.row.parteId].sort());
  assert.equal(found.result.bytesTotal, part.wav.length + other.wav.length);
  assert.deepEqual(Object.keys(found.result.raiz).sort(), ['dev', 'ino']);
  assert.deepEqual(Object.keys(found.result.pasta).sort(), ['dev', 'ino']);
  assert.deepEqual(Object.keys(found.result.arquivos[0].identidade).sort(), ['ctimeNs', 'dev', 'ino', 'mtimeNs']);
  assert.equal(JSON.stringify(found.result).includes(f.root), false);
  assert.deepEqual(readdirSync(f.audioRoot).sort(), filesBefore);
  assert.deepEqual(readFileSync(part.path), part.wav);
  assert.deepEqual(readFileSync(other.path), other.wav);
});

test('entrada fecha UUID, duplicatas, caminho nao derivado, hash e teto de 120 partes', t => {
  const f = fixture(t), part = makePart(f);
  const cases = [
    [{ ...part.row, parteId: 'not-a-uuid' }],
    [{ ...part.row, nome: '../escape.wav' }],
    [{ ...part.row, sha256: part.row.sha256.toUpperCase() }],
    [part.row, part.row],
    Array.from({ length: 121 }, (_, i) => ({ parteId: randomUUID(), nome: `${i}.wav`, sha256: 'a'.repeat(64) })),
  ];
  for (const partes of cases) assert.equal(resultOf(runChild(f, partes)).code, 'ENTRADA');
  const invalidProfile = { ...f.perfil, testMarker: randomUUID() };
  const closed = runChild({ ...f, perfil: invalidProfile }, [part.row]);
  assert.equal(resultOf(closed).code, 'FECHADO');
});

test('rejeita WAV nao canonico, hash divergente e tamanho fora dos limites sem alterar arquivos', t => {
  const f = fixture(t), part = makePart(f), before = readFileSync(part.path);
  const wrongHash = { ...part.row, sha256: 'b'.repeat(64) };
  const hashFailure = resultOf(runChild(f, [wrongHash]));
  assert.equal(hashFailure.code, 'INTEGRIDADE');
  assert.equal(hashFailure.message.includes(f.root), false);

  const malformed = Buffer.from(part.wav); malformed[0] = 0;
  writeFileSync(part.path, malformed);
  assert.equal(resultOf(runChild(f, [part.row])).code, 'INTEGRIDADE');
  writeFileSync(part.path, before);

  const oddPart = makePart(f, 31999, 3);
  assert.equal(resultOf(runChild(f, [oddPart.row])).code, 'INTEGRIDADE');
  const tooLarge = Buffer.concat([cabecalhoWav(MAX_PARTE_PCM), Buffer.alloc(MAX_PARTE_PCM), Buffer.alloc(1)]);
  const largeId = randomUUID(), largeName = largeId + '.wav';
  writeFileSync(join(f.audioRoot, largeName), tooLarge);
  assert.equal(resultOf(runChild(f, [{ parteId: largeId, nome: largeName, sha256: sha(tooLarge) }])).code, 'LIMITE');
});

test('sidecar selecionado sempre conflita e bytes de outras sessoes ficam intocados', t => {
  for (const suffix of ['.tmp', '.journal']) {
    const f = fixture(t), selected = makePart(f), unrelated = makePart(f, 32000, 9);
    const unrelatedPath = unrelated.path, unrelatedBytes = readFileSync(unrelatedPath);
    const sidecar = selected.path + suffix;
    writeFileSync(sidecar, suffix === '.journal' ? '{malformed}' : Buffer.from([1, 2, 3]), { flag: 'wx' });
    assert.equal(resultOf(runChild(f, [selected.row])).code, 'CONFLITO');
    assert.deepEqual(readFileSync(sidecar), suffix === '.journal' ? Buffer.from('{malformed}') : Buffer.from([1, 2, 3]));
    assert.deepEqual(readFileSync(unrelatedPath), unrelatedBytes);
  }
});

test('cancelamento durante leitura fecha handles e preserva a arvore sintetica', t => {
  const f = fixture(t), part = makePart(f, MAX_PARTE_PCM, 4), snapshot = readdirSync(f.audioRoot).sort();
  const cancelled = resultOf(runChild(f, [part.row], 'abort', { harnessPath: part.path }));
  assert.equal(cancelled.code, 'CANCELADO');
  assert.equal(cancelled.fdReleased, true);
  assert.deepEqual(readdirSync(f.audioRoot).sort(), snapshot);
});

test('mudanca concorrente durante leitura e recusada', t => {
  const f = fixture(t), part = makePart(f, MAX_PARTE_PCM, 2);
  const replacement = Buffer.concat([cabecalhoWav(MAX_PARTE_PCM), Buffer.from([3]), Buffer.alloc(MAX_PARTE_PCM - 1, 2)]);
  const changed = resultOf(runChild(f, [part.row], 'mutate-during-read', { harnessPath: part.path, replacementByte: 3 }));
  assert.deepEqual(readFileSync(part.path), replacement);
  assert.notEqual(changed.ok, true);
  assert.ok(['INTEGRIDADE', 'CONFLITO'].includes(changed.code));
});

test('revalida a parte anterior depois que outra termina de ler', t => {
  const f = fixture(t);
  const first = makePart(f, 32000, 1, '00000000-0000-4000-8000-000000000001');
  const second = makePart(f, MAX_PARTE_PCM, 2, '00000000-0000-4000-8000-000000000002');
  const changed = resultOf(runChild(f, [first.row, second.row], 'mutate-first-after-read', {
    harnessPath: first.path, replacementByte: 3,
  }));
  assert.notEqual(changed.ok, true);
  assert.ok(['INTEGRIDADE', 'CONFLITO'].includes(changed.code));
  const expected = Buffer.concat([cabecalhoWav(32000), Buffer.from([3]), Buffer.alloc(31999, 1)]);
  assert.deepEqual(readFileSync(first.path), expected);
});

test('copia a lista antes do primeiro await', t => {
  const f = fixture(t), part = makePart(f);
  const found = resultOf(runChild(f, [part.row], 'mutate-input-after-call'));
  assert.equal(found.ok, true);
  assert.equal(found.frozen, true);
  assert.equal(found.result.arquivos[0].nome, part.row.nome);
});

test('sidecar surgido durante leitura recusa sem altera-lo', t => {
  const g = fixture(t), next = makePart(g, MAX_PARTE_PCM, 6), sidecar = next.path + '.tmp';
  const conflict = resultOf(runChild(g, [next.row], 'add-sidecar-during-read', { harnessPath: sidecar }));
  assert.equal(conflict.code, 'CONFLITO');
  assert.equal(readFileSync(sidecar, 'utf8'), 'pending');
});

test('link simbolico para WAV selecionado e recusado', t => {
  const f = fixture(t), part = makePart(f);
  const linkId = randomUUID(), linkPath = join(f.audioRoot, linkId + '.wav');
  try { symlinkSync(part.path, linkPath); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`symlink indisponivel: ${error.code}`);
    throw error;
  }
  assert.equal(resultOf(runChild(f, [{ parteId: linkId, nome: linkId + '.wav', sha256: part.row.sha256 }])).code, 'INTEGRIDADE');

});

test('hardlink de WAV selecionado e recusado', t => {
  const f = fixture(t), part = makePart(f), alias = part.path + '.hardlink';
  try { linkSync(part.path, alias); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV'].includes(error.code)) return t.skip(`hardlink unavailable: ${error.code}`);
    throw error;
  }
  assert.equal(resultOf(runChild(f, [part.row])).code, 'INTEGRIDADE');
});

test('perfil-raiz por link simbolico e recusado pelo guard existente', t => {
  const f = fixture(t), part = makePart(f);
  const alias = join(realpathSync(tmpdir()), `lume-notetaker-alias-${randomUUID()}`);
  try { symlinkSync(f.root, alias, 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip(`directory symlink unavailable: ${error.code}`);
    throw error;
  }
  try {
    const linkedProfile = { ...f.perfil, testProfileRoot: alias };
    assert.equal(resultOf(runChild({ ...f, perfil: linkedProfile }, [part.row])).code, 'FECHADO');
  } finally { unlinkSync(alias); }
});

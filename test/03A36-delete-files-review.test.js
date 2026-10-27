import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cabecalhoWav, MAX_PARTE_PCM } from '../src/notetaker/contrato.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const childSource = String.raw`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const input = JSON.parse(process.argv[2]);
const originalOpenSync = fs.openSync;
const originalFstatSync = fs.fstatSync;
const originalRealpathSync = fs.realpathSync;
const originalCloseSync = fs.closeSync;
let openedFd, fdClosed = false, realpathCalls = 0, injected = false, folderSwapped = false, swapError;
if (input.mode === 'fstat-error' || input.mode === 'realpath-error' ||
    input.mode === 'folder-swap-before-open' || input.mode === 'root-swap-before-open' ||
    input.mode === 'abort-after-first-chunk') {
  fs.openSync = (path, ...args) => {
    if (input.mode === 'root-swap-before-open' && path === input.targetPath && !folderSwapped) {
      try {
        fs.renameSync(input.root, input.root + '.review-saved');
        fs.mkdirSync(input.root);
        fs.writeFileSync(input.root + '/.lume-notetaker-test', input.perfil.testMarker, { flag: 'wx' });
        fs.mkdirSync(input.audioRoot);
        const name = path.split(/[\\/]/).at(-1);
        fs.copyFileSync(input.root + '.review-saved/notetaker-audio/' + name, path);
        folderSwapped = true;
      } catch (error) { swapError = error.code ?? error.name; }
    }
    if (input.mode === 'folder-swap-before-open' && path === input.targetPath && !folderSwapped) {
      try {
        fs.renameSync(input.audioRoot, input.audioRoot + '.review-saved');
        fs.mkdirSync(input.audioRoot);
        const name = path.split(/[\\/]/).at(-1);
        fs.copyFileSync(input.audioRoot + '.review-saved/' + name, path);
        folderSwapped = true;
      } catch (error) { swapError = error.code ?? error.name; }
    }
    const fd = originalOpenSync(path, ...args);
    if (path === input.targetPath) openedFd = fd;
    return fd;
  };
  fs.closeSync = (fd, ...args) => {
    if (fd === openedFd) fdClosed = true;
    return originalCloseSync(fd, ...args);
  };
  if (input.mode === 'fstat-error') fs.fstatSync = (fd, ...args) => {
    if (fd === openedFd && !injected) {
      injected = true;
      const error = new Error('synthetic fs failure ' + input.targetPath);
      error.code = 'EACCES';
      throw error;
    }
    return originalFstatSync(fd, ...args);
  };
  if (input.mode === 'realpath-error') fs.realpathSync = (path, ...args) => {
    if (path === input.targetPath && ++realpathCalls === 2) {
      injected = true;
      const error = new Error('synthetic fs failure ' + path);
      error.code = 'EACCES';
      throw error;
    }
    return originalRealpathSync(path, ...args);
  };
  syncBuiltinESMExports();
}
const { inventariarArquivosExclusao } = await import(process.argv[1]);
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
const run = signal => inventariarArquivosExclusao({
  perfil: input.perfil, sessaoId: input.sessaoId, partes: input.partes,
  signal: signal ?? (input.abort ? AbortSignal.abort() : undefined),
});
async function turns(count, action) {
  await new Promise((resolve, reject) => {
    const tick = n => {
      if (n === 0) {
        try { action(); resolve(); } catch (error) { reject(error); }
      } else setImmediate(() => tick(n - 1));
    };
    tick(count);
  });
}
try {
  let mutation, mutated = false, mutationError;
  if (input.mode === 'first-changed-while-second-runs') mutation = turns(4, () => {
    try { writeFileSync(input.firstPath, Buffer.from(input.replacement, 'base64')); } catch {}
  });
  if (input.mode === 'sidecar-appears-during-read') mutation = turns(4, () => {
    try { writeFileSync(input.sidecarPath, Buffer.from('born-during-read'), { flag: 'wx' }); } catch {}
  });
  if (input.mode === 'audio-folder-changed-during-read') mutation = turns(4, () => {
    const transient = input.audioRoot + '/.review-transient';
    try { writeFileSync(transient, 'synthetic'); unlinkSync(transient); mutated = true; }
    catch (error) { mutationError = error.code ?? error.name; }
  });
  if (input.mode === 'abort-after-first-chunk') {
    const controller = new AbortController();
    mutation = turns(2, () => controller.abort());
    try {
      const result = await run(controller.signal);
      await mutation;
      process.stdout.write(JSON.stringify({ ok: true, unexpected: true, result }));
    } catch (error) {
      await mutation;
      process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? error.name,
        fdOpened: openedFd !== undefined, fdClosed }));
    }
  } else if (input.mode === 'selection-copy-before-await') {
    mutation = turns(1, () => { input.partes[0].sha256 = 'f'.repeat(64); input.partes.push(input.partes[0]); });
    try {
      const result = await run();
      await mutation;
      process.stdout.write(JSON.stringify({ ok: true, result, mutated: input.partes.length === 2 }));
    } catch (error) {
      await mutation;
      process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? error.name }));
    }
  } else if (input.mode === 'fstat-error' || input.mode === 'realpath-error' ||
             input.mode === 'folder-swap-before-open' || input.mode === 'root-swap-before-open') {
    try {
      const result = await run();
      process.stdout.write(JSON.stringify({ ok: true, unexpected: true, result, injected, folderSwapped, swapError }));
    } catch (error) {
      let leaked = false;
      if (openedFd !== undefined) {
        try { originalFstatSync(openedFd); leaked = true; } catch {}
        if (leaked) originalCloseSync(openedFd);
      }
      process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? error.name,
        message: error.message, leaked, injected, folderSwapped, swapError }));
    }
  } else {
    try {
      const result = await run();
      await mutation;
      process.stdout.write(JSON.stringify({ ok: true, result, mutated, mutationError }));
    } catch (error) {
      await mutation;
      process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? error.name, mutated, mutationError }));
    }
  }
} catch (error) {
  process.stderr.write(String(error.code ?? error.name) + ': ' + error.message);
  process.exitCode = 1;
}
`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lume-notetaker-03a36-review-')));
  const marker = randomUUID(), temp = realpathSync(tmpdir());
  const rel = relative(temp, root);
  assert.ok(rel && rel !== '..' && !rel.startsWith('..' + sep));
  assert.match(root.split(/[\\/]/).at(-1), /^lume-notetaker-/);
  writeFileSync(join(root, '.lume-notetaker-test'), marker, { flag: 'wx' });
  const audioRoot = join(root, 'notetaker-audio');
  mkdirSync(audioRoot);
  t.after(() => {
    const resolved = realpathSync(root);
    assert.equal(resolved, root);
    assert.ok(relative(temp, resolved) && !relative(temp, resolved).startsWith('..' + sep));
    assert.match(resolved.split(/[\\/]/).at(-1), /^lume-notetaker-03a36-review-/);
    rmSync(resolved, { recursive: true, force: false });
    const saved = root + '.review-saved';
    try {
      const savedReal = realpathSync(saved);
      assert.equal(savedReal, saved);
      assert.ok(relative(temp, savedReal) && !relative(temp, savedReal).startsWith('..' + sep));
      assert.match(savedReal.split(/[\\/]/).at(-1), /^lume-notetaker-03a36-review-.*\.review-saved$/);
      assert.equal(readFileSync(join(savedReal, '.lume-notetaker-test'), 'utf8'), marker);
      rmSync(savedReal, { recursive: true, force: false });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  });
  return { root, audioRoot, perfil: { notetakerExperimento: true, testProfileRoot: root, testMarker: marker }, sessaoId: randomUUID() };
}

function makePart(f, { parteId = randomUUID(), pcmBytes = 32000, fill = 5 } = {}) {
  const wav = Buffer.concat([cabecalhoWav(pcmBytes), Buffer.alloc(pcmBytes, fill)]);
  const nome = parteId + '.wav', path = join(f.audioRoot, nome);
  writeFileSync(path, wav, { flag: 'wx' });
  return { row: { parteId, nome, sha256: sha(wav) }, wav, path };
}

function runChild(f, partes, mode = 'plain', extra = {}) {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/notetaker/exclusao-arquivos.js')).href;
  const input = { root: f.root, perfil: f.perfil, sessaoId: f.sessaoId, audioRoot: f.audioRoot, partes, mode, ...extra };
  const env = { ...process.env, ASSESSOR_DESKTOP_TEST_PROFILE: f.root };
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource, moduleUrl, JSON.stringify(input)], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || `child exit=${result.status}, signal=${result.signal}`);
  return JSON.parse(result.stdout);
}

test('revalida a primeira parte se ela mudar enquanto a leitura avança para a segunda', t => {
  const f = fixture(t);
  const first = makePart(f, { parteId: '00000000-0000-4000-8000-000000000001', pcmBytes: 2, fill: 1 });
  const second = makePart(f, { parteId: '00000000-0000-4000-8000-000000000002', pcmBytes: MAX_PARTE_PCM, fill: 2 });
  const replacement = Buffer.concat([cabecalhoWav(2), Buffer.alloc(2, 9)]);
  const firstStat = lstatSync(first.path);
  const before = readdirSync(f.audioRoot).sort();
  const result = runChild(f, [first.row, second.row], 'first-changed-while-second-runs', {
    firstPath: first.path, replacement: replacement.toString('base64'),
  });
  assert.equal(result.ok, false, 'inventário não pode devolver observação obsoleta da primeira parte');
  assert.ok(['INTEGRIDADE', 'CONFLITO'].includes(result.code));
  assert.deepEqual(readFileSync(first.path), replacement);
  assert.equal(lstatSync(first.path).ino, firstStat.ino, 'teste substitui bytes in place, mantendo o inode');
  assert.deepEqual(readFileSync(second.path), second.wav);
  assert.deepEqual(readdirSync(f.audioRoot).sort(), before);
});

test('copia a selecao antes do primeiro await e não observa mutacao posterior do chamador', t => {
  const f = fixture(t), part = makePart(f, { pcmBytes: MAX_PARTE_PCM, fill: 3 });
  const result = runChild(f, [part.row], 'selection-copy-before-await');
  assert.equal(result.ok, true, 'a mutação posterior da entrada não deve invalidar a cópia já validada');
  assert.equal(result.mutated, true);
  assert.equal(result.result.arquivos.length, 1);
  assert.equal(result.result.arquivos[0].sha256, part.row.sha256);
  assert.deepEqual(readFileSync(part.path), part.wav);
});

test('detecta sidecar selecionado que surge durante a leitura, sem removê-lo', t => {
  const f = fixture(t), first = makePart(f, { parteId: '00000000-0000-4000-8000-000000000001', pcmBytes: 2 });
  const second = makePart(f, { parteId: '00000000-0000-4000-8000-000000000002', pcmBytes: MAX_PARTE_PCM });
  const sidecarPath = first.path + '.journal';
  const result = runChild(f, [first.row, second.row], 'sidecar-appears-during-read', { sidecarPath });
  assert.equal(result.ok, false, 'sidecar deve ser rechecado antes do retorno');
  assert.equal(result.code, 'CONFLITO');
  assert.deepEqual(readFileSync(sidecarPath), Buffer.from('born-during-read'));
  assert.deepEqual(readFileSync(first.path), first.wav);
  assert.deepEqual(readFileSync(second.path), second.wav);
});

test('recusa mudança de metadados da pasta durante a leitura', t => {
  const f = fixture(t), first = makePart(f, { parteId: '00000000-0000-4000-8000-000000000001', pcmBytes: 2 });
  const second = makePart(f, { parteId: '00000000-0000-4000-8000-000000000002', pcmBytes: MAX_PARTE_PCM });
  const result = runChild(f, [first.row, second.row], 'audio-folder-changed-during-read');
  assert.equal(result.mutated, true, `fixture root swap não ocorreu: ${result.mutationError}`);
  assert.equal(result.ok, false, 'não aceitar inventário após a pasta validada ser trocada');
  assert.ok(['FECHADO', 'INTEGRIDADE', 'CONFLITO', 'IO'].includes(result.code));
  assert.deepEqual(readFileSync(first.path), first.wav);
  assert.deepEqual(readFileSync(second.path), second.wav);
  assert.deepEqual(readdirSync(f.audioRoot).sort(), [first.row.nome, second.row.nome].sort());
});

test('recusa pasta de audio substituida entre lstat e open, sem perder WAVs', t => {
  const f = fixture(t), part = makePart(f, { pcmBytes: MAX_PARTE_PCM, fill: 7 });
  const result = runChild(f, [part.row], 'folder-swap-before-open', { targetPath: part.path });
  assert.equal(result.folderSwapped, true, `a troca física da fixture não ocorreu: ${result.swapError}`);
  assert.equal(result.ok, false);
  assert.ok(['CONFLITO', 'INTEGRIDADE'].includes(result.code));
  assert.deepEqual(readFileSync(join(f.audioRoot + '.review-saved', part.row.nome)), part.wav);
  assert.deepEqual(readFileSync(part.path), part.wav);
});

test('recusa raiz de perfil substituida entre validacao e open, preservando origem e substituta', t => {
  const f = fixture(t), part = makePart(f, { pcmBytes: MAX_PARTE_PCM, fill: 8 });
  const result = runChild(f, [part.row], 'root-swap-before-open', { targetPath: part.path });
  assert.equal(result.folderSwapped, true, `a troca física da raiz não ocorreu: ${result.swapError}`);
  assert.equal(result.ok, false);
  assert.ok(['CONFLITO', 'INTEGRIDADE'].includes(result.code));
  assert.deepEqual(readFileSync(join(f.root + '.review-saved', 'notetaker-audio', part.row.nome)), part.wav);
  assert.deepEqual(readFileSync(part.path), part.wav);
});

test('recusa hardlink selecionado sem alterar original nem nome alheio', t => {
  const f = fixture(t), original = makePart(f), linkedId = randomUUID(), linkedPath = join(f.audioRoot, linkedId + '.wav');
  try { linkSync(original.path, linkedPath); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'EMLINK'].includes(error.code)) return t.skip(`hardlink indisponivel: ${error.code}`);
    throw error;
  }
  assert.equal(lstatSync(original.path).nlink, 2);
  const before = readFileSync(original.path);
  const linked = { parteId: linkedId, nome: linkedId + '.wav', sha256: original.row.sha256 };
  const result = runChild(f, [linked]);
  assert.equal(result.ok, false);
  assert.ok(['INTEGRIDADE', 'CONFLITO'].includes(result.code));
  assert.deepEqual(readFileSync(original.path), before);
  assert.deepEqual(readFileSync(linkedPath), before);
});

test('sanitiza falha FS e fecha FD se fstat ou realpath falha logo apos abrir', t => {
  const f = fixture(t), part = makePart(f);
  for (const mode of ['fstat-error', 'realpath-error']) {
    const result = runChild(f, [part.row], mode, { targetPath: part.path });
    assert.equal(result.ok, false);
    assert.equal(result.injected, true);
    assert.ok(['FECHADO', 'INTEGRIDADE', 'IO'].includes(result.code), `código FS vazou: ${result.code}`);
    assert.equal(result.message.includes(part.path), false, 'mensagem não deve expor caminho privado');
    assert.equal(result.leaked, false, 'FD aberto precisa fechar se a validação falhar');
  }
  assert.deepEqual(readFileSync(part.path), part.wav);
});

test('cancelamento depois de iniciar um chunk fecha a leitura sem alterar o WAV', t => {
  const f = fixture(t), part = makePart(f, { pcmBytes: MAX_PARTE_PCM, fill: 6 });
  const before = readFileSync(part.path);
  const result = runChild(f, [part.row], 'abort-after-first-chunk', { targetPath: part.path });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CANCELADO');
  assert.equal(result.fdOpened, true, 'o cancelamento ocorre depois que o WAV foi aberto');
  assert.equal(result.fdClosed, true, 'FD precisa fechar antes da API rejeitar');
  assert.deepEqual(readFileSync(part.path), before);
  // A implementação também é inspecionada para garantir closeSync no finally;
  // este teste prova cancelamento durante o fluxo e deixa a fixture removível.
  renameSync(part.path, part.path + '.closed-after-abort');
  renameSync(part.path + '.closed-after-abort', part.path);
});

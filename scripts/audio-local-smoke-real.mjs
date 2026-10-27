// Development evidence only. Does not install, approve or change the app policy.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {cpus, freemem, totalmem, release, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {transcreverWhisperLocal} from '../src/audio-whisper-local.js';
import {criarAudioLocalRuntime} from '../src/audio-local-runtime.js';
import {validarAudioWav} from '../src/audio-desktop-contrato.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORK = join(ROOT, 'work', 'audio-local-real');
export const SOURCES = Object.freeze({
  engineCommit: '927cfce34f31707e17f2bff35c349632fb9e2c3a',
  engineRelease: 'https://github.com/ggml-org/whisper.cpp/releases/tag/b5130',
  archive: {name: 'whisper-bin-x64.zip', bytes: 8573270,
    sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip'},
  model: {name: 'ggml-base.bin', bytes: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin'},
});

// Per-file hashes derived from the archive whose digest GitHub publishes.
// CPU variants are intentionally enumerated: ggml selects one at runtime.
export const BUNDLE = Object.freeze([
  ['ggml-base.dll', 689664, 'a5241b52206f61c9dfd6f0f53a8ef19076f9528ead2db1e039a66d7e03817bfc'],
  ['ggml-cpu-alderlake.dll', 864256, '5a5b11dcd38e321b13f85c95414940db9eab1132be3da6342f03dfb1d8e51bd5'],
  ['ggml-cpu-cannonlake.dll', 908288, '2c858781450b52eda95c381232cc65c9e19cbf621cc7b254d8c44fdbab77791e'],
  ['ggml-cpu-cascadelake.dll', 904704, 'ddf49bb749b34800afcb3d6224544966a05c5d00f1d0b6565bee9f3b010dd53c'],
  ['ggml-cpu-haswell.dll', 866304, '6b772e094b8976e22b4c043be86a1a8deda4b50511dc803a693b652c51b24944'],
  ['ggml-cpu-icelake.dll', 904704, 'bbd87ea5920edc401054848071ad2ef8c96bbf8007c4e4cd0ea82ba9b9e3bd10'],
  ['ggml-cpu-sandybridge.dll', 860672, 'de2ad5f84c7dfa557d515b3678d6452ce0216590268b2ca79cc537fe87cf239d'],
  ['ggml-cpu-skylakex.dll', 908288, '9fa3f9d984ca42d568181dd345072299db2978b328800343218c2c7f000b7152'],
  ['ggml-cpu-sse42.dll', 846848, '740fc769ef433985dfdb24a609a42d5acf188abda52287a4d89b89b567507c19'],
  ['ggml-cpu-x64.dll', 850432, '43ccf32b9b70aa4c47d0a12ac2ed3c241e0045571acdad565ecd9d1f99ffc08b'],
  ['ggml.dll', 62464, 'c6e88687d6aa0238f2e834a87958f38d2dc96075a6a7bf6fb8b9cd728a0faed2'],
  ['whisper-cli.exe', 479232, '19b976e037c02c0de712fa26096842d4ebafca03c976b12e8e6123215e7aab58'],
  ['whisper.dll', 1368576, 'b7bb4ba92bd36b8afe0c00059ca6a0f69c6767193bfb5f0761e9ed27b1087803'],
].map(([name, bytes, sha256]) => Object.freeze({name, bytes, sha256})));

export const REFERENCE = 'Olá. Este é um teste fictício de transcrição local. A reunião com Marina será na terça-feira, às dez horas. O orçamento é de duzentos e cinquenta reais. Envie a proposta amanhã.';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const psExe = () => join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export async function verifyFile(path, expected) {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.size !== expected.bytes || await realpath(path) !== resolve(path)) throw new Error(`Arquivo incompatível: ${expected.name}`);
  const h = createHash('sha256');
  for await (const bytes of createReadStream(path)) h.update(bytes);
  if (h.digest('hex') !== expected.sha256) throw new Error(`SHA-256 divergente: ${expected.name}`);
}

export async function verifyBundle(directory) {
  const names = (await readdir(directory)).sort();
  if (names.join('\n') !== BUNDLE.map(x => x.name).sort().join('\n')) throw new Error('Bundle contém arquivos extras ou ausentes.');
  for (const item of BUNDLE) await verifyFile(join(directory, item.name), item);
}

// SAPI may write extra RIFF chunks. Parse them; never assume a 44-byte header.
export function canonicalWav(input) {
  if (!Buffer.isBuffer(input) || input.length < 44 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WAVE' || input.readUInt32LE(4) !== input.length - 8) throw new Error('RIFF inválido.');
  let fmt, pcm;
  let offset = 12;
  while (offset + 8 <= input.length) {
    const tag = input.toString('ascii', offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > input.length) throw new Error('RIFF truncado.');
    if (tag === 'fmt ') { if (fmt) throw new Error('fmt duplicado.'); fmt = input.subarray(offset + 8, end); }
    if (tag === 'data') { if (pcm) throw new Error('data duplicado.'); pcm = input.subarray(offset + 8, end); }
    offset = end + size % 2;
  }
  if (offset !== input.length || !fmt || fmt.length < 16 || !pcm || !pcm.length) throw new Error('WAV incompleto.');
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); fmt.copy(out, 20, 0, 16);
  out.write('data', 36); out.writeUInt32LE(pcm.length, 40); pcm.copy(out, 44);
  validarAudioWav(out);
  return out;
}

export function wordErrorRate(reference, hypothesis) {
  const tokens = text => text.normalize('NFC').toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]+/gu) || [];
  const r = tokens(reference), h = tokens(hypothesis);
  if (!r.length) throw new Error('Referência sem palavras.');
  let row = h.map((_, i) => i + 1); row.unshift(0);
  for (let i = 1; i <= r.length; i++) {
    const next = [i];
    for (let j = 1; j <= h.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + Number(r[i - 1] !== h[j - 1]));
    row = next;
  }
  return {referenceWords: r.length, hypothesisWords: h.length, edits: row[h.length], rate: row[h.length] / r.length,
    normalization: 'NFC, minúsculas pt-BR, palavras/números; números escritos e dígitos não são equivalentes'};
}

function subprocess(command, args, {cwd = WORK, timeoutMs = 60000} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd, shell: false, windowsHide: true});
    let stdout = '', stderr = '', expired = false;
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 && !expired ? resolvePromise({stdout, stderr}) : reject(new Error(`Subprocesso falhou (${code}, timeout=${expired}): ${stderr.slice(-1500)}`)); });
  });
}

async function powershell(command, options) {
  return subprocess(psExe(), ['-NoProfile', '-NonInteractive', '-Command', command], options);
}

async function downloadFile(item) {
  const path = join(WORK, 'downloads', item.name);
  try { await lstat(path); await verifyFile(path, item); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch(item.url, {signal: AbortSignal.timeout(300000)});
  if (!response.ok) throw new Error(`Download oficial retornou HTTP ${response.status}`);
  const parts = []; let length = 0;
  for await (const bytes of response.body) {
    length += bytes.length;
    if (length > item.bytes) throw new Error('Download excedeu o tamanho fixado.');
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  if (length !== item.bytes || digest(bytes) !== item.sha256) throw new Error('Integridade do download divergente.');
  await writeFile(path, bytes, {flag: 'wx'});
}

async function prepare() {
  await mkdir(join(WORK, 'downloads'), {recursive: true});
  for (const item of [SOURCES.archive, SOURCES.model]) await downloadFile(item);
  const directory = join(WORK, 'bundle');
  await mkdir(directory, {recursive: true});
  // Extract only explicit entries from the verified official archive, no other EXEs.
  await powershell(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $z=[IO.Compression.ZipFile]::OpenRead(${psQuote(join(WORK, 'downloads', SOURCES.archive.name))});
    try { foreach($n in @(${BUNDLE.map(x => psQuote(x.name)).join(',')})) {
      $target=Join-Path ${psQuote(directory)} $n;
      if (!(Test-Path -LiteralPath $target)) { $e=$z.GetEntry('Release/'+$n); if (!$e) {throw 'Missing entry'}; [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$target,$false) }
    } } finally {$z.Dispose()}`);
  await verifyBundle(directory);
}

async function synthesize(run) {
  const target = join(run, 'sapi-original.wav');
  const {stdout} = await powershell(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;
    Add-Type -AssemblyName System.Speech;
    $s=New-Object System.Speech.Synthesis.SpeechSynthesizer;
    try { $v=$s.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'pt-BR'} | Select-Object -First 1;
      if (!$v) {throw 'No installed pt-BR SAPI voice'};
      $s.SelectVoice($v.VoiceInfo.Name); $s.Rate=0;
      $f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);
      $s.SetOutputToWaveFile(${psQuote(target)},$f); $s.Speak(${psQuote(REFERENCE)}); $s.SetOutputToNull();
      @{name=$v.VoiceInfo.Name; culture=$v.VoiceInfo.Culture.Name; type='synthetic-local-SAPI'} | ConvertTo-Json -Compress
    } finally {$s.Dispose()}`);
  const bytes = canonicalWav(await readFile(target));
  await writeFile(join(run, 'speech.wav'), bytes, {flag: 'wx'});
  return {bytes, voice: JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))};
}

function memoryMonitor(pid) {
  return powershell(`$ErrorActionPreference='Stop'; $peak=0L; $private=0L; $samples=0; $cpu=0; $modules=@();
    try {$p=[Diagnostics.Process]::GetProcessById(${pid});
      while (!$p.HasExited) {$p.Refresh(); $peak=[Math]::Max($peak,$p.PeakWorkingSet64); $private=[Math]::Max($private,$p.PrivateMemorySize64); $cpu=$p.TotalProcessorTime.TotalMilliseconds; $samples++;
        if ($samples -eq 1) {$modules=@($p.Modules | ForEach-Object {$_.FileName})}; Start-Sleep -Milliseconds 50}
    } catch {};
    @{peakWorkingSetBytes=$peak; sampledPrivateBytes=$private; samples=$samples; cpuMs=$cpu; modules=$modules; intervalMs=50} | ConvertTo-Json -Compress`, {timeoutMs: 370000});
}

function observedRunner(observation) {
  return async (command, args, {signal, timeoutMs, cwd}) => {
    observation.args = args; observation.cwd = cwd;
    const started = performance.now();
    let child, logs = '', monitor;
    try {
      await new Promise((resolvePromise, reject) => {
        child = spawn(command, args, {cwd, shell: false, windowsHide: true,
          env: {SystemRoot: process.env.SystemRoot, TMP: cwd, TEMP: cwd, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2'}});
        observation.pid = child.pid;
        monitor = child.pid ? memoryMonitor(child.pid).then(x => JSON.parse(x.stdout.trim()), e => ({unavailable: e.message})) : Promise.resolve({unavailable: 'spawn failed'});
        let reason;
        const cancel = () => { reason = new Error('Transcrição local cancelada.'); child.kill(); };
        const timer = setTimeout(() => { reason = new Error('Motor local excedeu o tempo limite.'); child.kill(); }, timeoutMs);
        signal?.addEventListener('abort', cancel, {once: true});
        child.stderr.on('data', b => { if (logs.length < 1048576) logs += b; });
        child.stdout.resume();
        child.once('error', error => { reason = error; });
        child.once('close', (code, closedSignal) => {
          clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          observation.exitCode = code; observation.signal = closedSignal; observation.processClosed = true;
          reason || code !== 0 ? reject(reason || new Error(`whisper exit ${code}`)) : resolvePromise();
        });
        if (signal?.aborted) cancel();
      });
    } finally {
      observation.wallMs = Math.round(performance.now() - started);
      observation.stderr = logs;
      observation.memory = await monitor;
    }
  };
}

async function missing(path) { try { await lstat(path); return false; } catch(e) { if(e.code === 'ENOENT') return true; throw e; } }
const tempDirectories = async () => (await readdir(tmpdir())).filter(n => n.startsWith('lume-whisper-'));

export async function runSmoke({download = false} = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Prova disponível somente para Windows x64.');
  if (download) await prepare();
  await verifyBundle(join(WORK, 'bundle'));
  await verifyFile(join(WORK, 'downloads', SOURCES.archive.name), SOURCES.archive);
  const model = join(WORK, 'downloads', SOURCES.model.name);
  await verifyFile(model, SOURCES.model);
  const run = join(WORK, `run-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}`);
  await mkdir(run, {recursive: true});
  const report = {createdAt: new Date().toISOString(), kind: 'real-ASR-synthetic-speech-development-only',
    qualityApproved: false, appIntegrated: false, sources: SOURCES, bundle: BUNDLE,
    host: {platform: process.platform, arch: process.arch, release: release(), node: process.version,
      cpu: cpus()[0]?.model, logicalCPUs: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem()},
    network: 'No fetch during inference; no OS network capture, offline isolation not established.'};
  const config = {executavel: join(WORK, 'bundle', 'whisper-cli.exe'), modelo: model, threads: 2, timeoutMs: 360000};
  try {
    const {bytes, voice} = await synthesize(run);
    report.audio = {voice, reference: REFERENCE, ...validarAudioWav(bytes), sha256: digest(bytes)};
    // Unmodified adapter and its default production runner: no injected JSON/stub.
    const tempsBefore = await tempDirectories();
    report.defaultAdapter = await transcreverWhisperLocal(bytes, config);
    report.defaultAdapter.noNewTempDirectories = (await tempDirectories()).every(n => tempsBefore.includes(n));
    if (!report.defaultAdapter.transcricao) throw new Error('ASR real não retornou fala.');
    report.defaultAdapter.wer = wordErrorRate(REFERENCE, report.defaultAdapter.transcricao);
    report.observed = {};
    report.observed.result = await transcreverWhisperLocal(bytes, {...config, runner: observedRunner(report.observed)});
    report.observed.tempRemoved = await missing(report.observed.cwd);
    report.observed.realtimeFactor = report.observed.wallMs / (report.audio.segundos * 1000);
    // Longer local PCM for cancellation; no new data, no arbitrary input accepted.
    const repeated = Buffer.concat([bytes.subarray(0, 44), ...Array(6).fill(bytes.subarray(44))]);
    repeated.writeUInt32LE(repeated.length - 8, 4); repeated.writeUInt32LE(repeated.length - 44, 40);
    validarAudioWav(repeated);
    report.cancel = {};
    const controller = new AbortController();
    let cancelAt;
    const timer = setTimeout(() => { cancelAt = performance.now(); controller.abort(); }, 1500);
    try { await transcreverWhisperLocal(repeated, {...config, signal: controller.signal, runner: observedRunner(report.cancel)}); throw new Error('Cancelamento não interrompeu a transcrição.'); }
    catch (error) {
      if (!controller.signal.aborted || !/cancelada/.test(error.message)) throw error;
      report.cancel.error = error.message; report.cancel.afterAbortMs = Math.round(performance.now() - cancelAt);
    } finally { clearTimeout(timer); }
    report.cancel.tempRemoved = await missing(report.cancel.cwd);
    const defaultAbort = new AbortController();
    const beforeCancel = await tempDirectories();
    const defaultTimer = setTimeout(() => defaultAbort.abort(), 1500);
    try { await transcreverWhisperLocal(repeated, {...config, signal: defaultAbort.signal}); throw new Error('Cancelamento default falhou.'); }
    catch (error) { if (!defaultAbort.signal.aborted || !/cancelada/.test(error.message)) throw error; report.defaultCancel = {error: error.message, noNewTempDirectories: (await tempDirectories()).every(n => beforeCancel.includes(n))}; }
    finally { clearTimeout(defaultTimer); }
    const beforeTimeout = await tempDirectories();
    const timeoutStarted = performance.now();
    try { await transcreverWhisperLocal(repeated, {...config, timeoutMs: 1000}); throw new Error('Timeout default falhou.'); }
    catch (error) {
      if (!/excedeu o tempo limite/.test(error.message)) throw error;
      report.defaultTimeout = {error: error.message, wallMs: Math.round(performance.now() - timeoutStarted),
        noNewTempDirectories: (await tempDirectories()).every(n => beforeTimeout.includes(n))};
    }
    const silence = Buffer.alloc(44 + 3 * 32000); bytes.copy(silence, 0, 0, 44);
    silence.writeUInt32LE(silence.length - 8, 4); silence.writeUInt32LE(silence.length - 44, 40);
    // Silence is a quality observation, never fabricated as an empty transcript.
    try { report.silence = await transcreverWhisperLocal(silence, config); }
    catch (error) { report.silence = {rejected: true, error: error.message}; }
    // Raw cache is not an app package: it lacks the signed manifest and model.
    report.appRuntime = await criarAudioLocalRuntime({raiz: join(WORK, 'bundle'), manifestoSha256: '0'.repeat(64)}).estado();
    if (report.appRuntime.disponivel || !/ausentes|incompatíveis/.test(report.appRuntime.motivo)) throw new Error('O runtime não preservou o bloqueio esperado do cache cru.');
    await verifyBundle(join(WORK, 'bundle')); await verifyFile(model, SOURCES.model);
    report.status = 'smoke-passed-quality-unvalidated';
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error; }
  finally {
    await writeFile(join(run, 'evidence.json'), JSON.stringify(report, null, 2));
    await writeFile(join(WORK, 'latest-run.json'), JSON.stringify({run, status: report.status}, null, 2));
    console.log(JSON.stringify({run, status: report.status, error: report.error}));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--download')) throw new Error('Uso: node scripts/audio-local-smoke-real.mjs [--download]');
  await runSmoke({download: args.includes('--download')});
}

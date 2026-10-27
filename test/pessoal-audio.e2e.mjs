// Native Electron decoder proof: synthetic WAV/Ogg, private hidden BrowserWindow, no installed profile or remote ASR.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {_electron as electron} from 'playwright';

const output = resolve('work/pessoal-20261026'); mkdirSync(output, {recursive: true});
const temporary = mkdtempSync(join(tmpdir(), 'lume-audio-electron-'));
const profile = join(temporary, 'isolated-profile'), entry = join(temporary, 'main.cjs'); mkdirSync(profile);
const decoder = fileURLToPath(new URL('../desktop/audio-converter.cjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const input = Buffer.alloc(44 + 12000 * 4);
input.write('RIFF'); input.writeUInt32LE(input.length - 8, 4); input.write('WAVEfmt ', 8);
input.writeUInt32LE(16, 16); input.writeUInt16LE(1, 20); input.writeUInt16LE(2, 22);
input.writeUInt32LE(48000, 24); input.writeUInt32LE(192000, 28); input.writeUInt16LE(4, 32); input.writeUInt16LE(16, 34);
input.write('data', 36); input.writeUInt32LE(input.length - 44, 40);
for (let n = 0; n < 12000; n++) {
  input.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * 440 * n / 48000)), 44 + n * 4);
  input.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 660 * n / 48000)), 46 + n * 4);
}
const wavPath = join(output, 'audio-fixture-stereo48k.wav'), oggPath = join(output, 'audio-fixture-opus.ogg');
writeFileSync(wavPath, input);
const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', oggPath], {encoding: 'utf8', windowsHide: true});
assert.equal(encoded.status, 0, 'Local FFmpeg must generate the synthetic Ogg fixture: ' + (encoded.error?.message || encoded.stderr));
const ogg = readFileSync(oggPath); assert.equal(ogg.toString('ascii', 0, 4), 'OggS');
writeFileSync(entry, `const {app,BrowserWindow}=require('electron');
  app.setPath('userData',${JSON.stringify(profile)});
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('no-proxy-server');
  app.on('window-all-closed',()=>{});
  global.audioProof={created:[],network:[],ready:false};
  app.whenReady().then(()=>{
    const {criarConversorAudio}=require(${JSON.stringify(decoder)});
    function ObservedWindow(options){
      const win=new BrowserWindow(options);
      global.audioProof.created.push({show:options.show,visible:win.isVisible(),sandbox:options.webPreferences.sandbox,nodeIntegration:options.webPreferences.nodeIntegration,contextIsolation:options.webPreferences.contextIsolation,partition:options.webPreferences.partition});
      win.webContents.session.webRequest.onBeforeSendHeaders((details,callback)=>{
        if(!details.url.startsWith('data:'))global.audioProof.network.push(details.url);
        callback({cancel:!details.url.startsWith('data:')});
      });
      return win;
    }
    global.audioProof.converter=criarConversorAudio({BrowserWindow:ObservedWindow});
    global.audioProof.ready=true;
  });`);

let application;
const results = [], stderr = [];
try {
  application = await electron.launch({args: [entry], timeout: 30000, env: {...process.env}});
  application.process().stderr.on('data', chunk => stderr.push(String(chunk)));
  await application.evaluate(async ({app}) => {await app.whenReady(); if (!global.audioProof?.ready) throw Error('Isolated decoder not initialized');});
  const runtime = await application.evaluate(({app}) => ({electron: process.versions.electron, node: process.versions.node, userData: app.getPath('userData')}));
  assert.equal(runtime.userData, profile);
  for (const [kind, source] of [['wav', input], ['ogg', ogg]]) {
    const converted = await application.evaluate(async (_, base64) => global.audioProof.converter.converter(base64), source.toString('base64'));
    const bytes = Buffer.from(converted.base64, 'base64');
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt16LE(20), 1); assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readUInt32LE(24), 16000); assert.equal(bytes.readUInt16LE(34), 16);
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
    const duration = (bytes.length - 44) / 32000;
    assert.ok(Math.abs(duration - 0.25) < 0.03, `Duration preserved for ${kind}: ${duration}`);
    let peak = 0; for (let index = 44; index < bytes.length; index += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(index)));
    assert.ok(peak > 100, 'Decoded tone is not silently replaced with zeros');
    writeFileSync(join(output, `audio-converted-${kind}-pcm16k.wav`), bytes);
    results.push({input: kind, sourceBytes: source.length, sourceSha256: digest(source), pcmBytes: bytes.length, pcmSha256: digest(bytes), sampleRate: 16000, channels: 1, bits: 16, durationSeconds: duration, peak});
  }
  for (const invalid of ['', '!invalid!', Buffer.from('invalid synthetic media').toString('base64')]) {
    const message = await application.evaluate(async (_, base64) => {try {await global.audioProof.converter.converter(base64); return null;} catch (error) {return error.message;}}, invalid);
    assert.equal(message, 'AUDIO_CONVERSAO_INDISPONIVEL');
  }
  const race = await application.evaluate(async (_, base64) => (await Promise.allSettled([global.audioProof.converter.converter(base64), global.audioProof.converter.converter(base64)])).map(result => ({status: result.status, error: result.reason?.message})), input.toString('base64'));
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(race.find(result => result.status === 'rejected').error, 'AUDIO_CONVERSAO_INDISPONIVEL');
  const safety = await application.evaluate(({BrowserWindow}) => ({created: global.audioProof.created, network: global.audioProof.network, remainingWindows: BrowserWindow.getAllWindows().length}));
  assert.deepEqual(safety.network, []); assert.equal(safety.remainingWindows, 0);
  assert.ok(safety.created.every(window => !window.show && !window.visible && window.sandbox && !window.nodeIntegration && window.contextIsolation && window.partition.startsWith('lume-audio-')));
  assert.equal(new Set(safety.created.map(window => window.partition)).size, safety.created.length);
  writeFileSync(join(output, 'pessoal-audio-electron-proof.json'), JSON.stringify({date: new Date().toISOString(), synthetic: true, nativeElectron: true, realLogin: false, remoteAsr: false, runtime, results, safety, stderr, checks: ['real WAV stereo48k to PCM mono16k', 'real Ogg Opus to PCM mono16k', 'invalid input rejected', 'single concurrent decoder', 'private nonpersistent partition', 'hidden sandboxed windows', 'windows destroyed after conversion', 'no external renderer requests']}, null, 2));
  console.log('PASS pessoal audio Electron — real decoder, synthetic WAV/Ogg, PCM16 mono 16kHz; isolated hidden windows, no remote ASR or login.');
} finally {
  if (application) {await application.evaluate(() => global.audioProof?.converter?.encerrar()).catch(() => {}); await application.close();}
  rmSync(temporary, {recursive: true, force: true});
}

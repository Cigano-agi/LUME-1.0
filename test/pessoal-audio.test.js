// Managed local media + SQLite are real. Conversion/ASR are explicit synthetic boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {abrirBanco} from '../src/banco.js';
import {ContextoApp} from '../src/contexto-app.js';
import {Desktop} from '../src/desktop.js';
import {DesktopIA} from '../src/desktop-ia.js';
import {ArquivosDados} from '../src/arquivos-dados.js';
import {MidiaArquivos, processarUmaMidiaCiclo} from '../src/ciclo-midia-worker.js';
import {AudioPessoal} from '../src/pessoal/audio.js';
import {wav} from './fixtures/audio-wav.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const DM = '551100000001@s.whatsapp.net';
const STATE = {disponivel: true, motor: 'local', modelo: 'fixture', modeloSha256: 'a'.repeat(64), manifestoSha256: 'b'.repeat(64), versaoMotor: 'synthetic-1'};
const asrResult = bytes => ({audioSha256: hash(bytes), modeloSha256: STATE.modeloSha256, manifestoSha256: STATE.manifestoSha256, versaoMotor: STATE.versaoMotor,
  idioma: 'pt', duracaoMs: 20, transcricao: 'Conferir o relatório sintético.', trechos: [{inicioMs: 0, fimMs: 900, texto: 'Conferir o relatório sintético.'}]});
async function fixture(t, {convert, asr, state} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lume-pessoal-audio-')), db = abrirBanco();
  t.after(() => {db.close(); rmSync(dir, {recursive: true, force: true});});
  const contexto = new ContextoApp(db); new Desktop(db); const ia = new DesktopIA(db);
  const arquivos = new ArquivosDados(dir), midias = new MidiaArquivos(db, arquivos);
  const pcm = wav(1); for (let n = 0; n < 16000; n++) pcm.writeInt16LE(Math.round(1500 * Math.sin(2 * Math.PI * 440 * n / 16000)), 44 + n * 2);
  const f = {db, arquivos, midias, pcm, ia, conversions: 0, inferences: 0, active: true};
  contexto.receber({type: 'notify', messages: [{key: {id: 'audio-synthetic', remoteJid: DM, fromMe: false}, message: {audioMessage: {mimetype: 'audio/wav'}}, messageTimestamp: Math.floor(Date.now() / 1000)}]});
  f.id = db.prepare("SELECT id FROM eventos WHERE origem_id='audio-synthetic'").get().id;
  await processarUmaMidiaCiclo(db, {arquivos: midias, baixar: async () => ({base64: pcm.toString('base64'), mime: 'audio/wav', nome: 'sintetico.wav'}), agora: new Date(Date.now() + 1000)});
  f.original = db.prepare('SELECT * FROM ciclo_midias WHERE evento_id=?').get(f.id);
  assert.ok(f.original, 'Fixture original must pass the real managed-media worker');
  f.audio = new AudioPessoal(db, {arquivos, ativo: () => f.active,
    converter: async input => {f.conversions++; assert.equal(input, pcm.toString('base64')); return convert ? convert(f, input) : {base64: input};},
    audioLocal: {estado: async () => state ? state(f) : STATE, transcrever: async (bytes, options) => {
      f.inferences++; assert.deepEqual(bytes, pcm);
      if (asr) return asr(f, bytes, options);
      return asrResult(bytes);
    }}
  });
  return f;
}

test('áudio pessoal: original gerenciado → PCM → ASR local, proveniência e etapa sem permissão remota', async t => {
  const f = await fixture(t);
  const result = await f.audio.transcrever(f.id);
  assert.equal(result.fonte, f.id); assert.equal(result.qualidade, 'nao_validada');
  assert.equal(f.conversions, 1); assert.equal(f.inferences, 1);
  const row = f.db.prepare('SELECT * FROM transcricoes').get(), meta = JSON.parse(row.audio_metadados_json);
  assert.equal(row.texto, 'Conferir o relatório sintético.');
  assert.equal(meta.audioSha256, hash(f.pcm)); assert.equal(meta.consentimento.tipo, 'processamento_local');
  assert.equal(meta.fonte.origemId, 'audio-synthetic'); assert.equal(meta.qualidade, 'nao_validada');
  assert.deepEqual(readFileSync(row.arquivo), f.pcm);
  assert.deepEqual(readFileSync(f.original.caminho), f.pcm, 'Managed original is preserved');
  assert.equal(f.db.prepare('SELECT texto FROM desktop_fontes WHERE id=?').get(f.id).texto, row.texto);
  const stage = f.db.prepare("SELECT estado,resultado FROM etapas WHERE evento_id=? AND etapa='transcricao'").get(f.id);
  assert.equal(stage.estado, 'concluida'); assert.equal(JSON.parse(stage.resultado).motor, 'local');
  assert.equal(f.ia.gasto(), 0);
  assert.equal(f.db.prepare('SELECT habilitada FROM desktop_ia_config').get().habilitada, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM desktop_ia_conversas WHERE permitida=1').get().n, 0);
  assert.deepEqual(await f.audio.transcrever(f.id), {existente: true});
  assert.equal(f.conversions, 1); assert.equal(f.inferences, 1);
});

test('áudio pessoal: desativado ou abortado não converte nem executa ASR', async t => {
  const f = await fixture(t); f.active = false;
  await assert.rejects(() => f.audio.transcrever(f.id), /AUDIO_LOCAL_INDISPONIVEL/);
  f.active = true; const controller = new AbortController(); controller.abort();
  await assert.rejects(() => f.audio.transcrever(f.id, {signal: controller.signal}), /AUDIO_LOCAL_INDISPONIVEL/);
  assert.equal(f.conversions, 0); assert.equal(f.inferences, 0);
});

test('áudio pessoal: arquivo adulterado ou tamanho divergente impede conversão', async t => {
  for (const mutation of ['hash', 'tamanho']) await t.test(mutation, async child => {
    const f = await fixture(child);
    if (mutation === 'hash') {const bytes = Buffer.from(f.pcm); bytes[100] ^= 1; writeFileSync(f.original.caminho, bytes);}
    else f.db.prepare('UPDATE ciclo_midias SET tamanho=tamanho+1 WHERE evento_id=?').run(f.id);
    await assert.rejects(() => f.audio.transcrever(f.id), /AUDIO_ORIGINAL_INVALIDO/);
    assert.equal(f.conversions, 0); assert.equal(f.inferences, 0);
  });
});

test('áudio pessoal: fonte revogada ou abortada durante conversão não chega ao ASR', async t => {
  for (const mutation of ['fonte', 'abort']) await t.test(mutation, async child => {
    const controller = new AbortController();
    const f = await fixture(child, {convert: current => {
      if (mutation === 'fonte') current.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(current.id);
      else controller.abort();
      return {base64: current.pcm.toString('base64')};
    }});
    await assert.rejects(() => f.audio.transcrever(f.id, {signal: controller.signal}), /AUDIO_FONTE_ALTERADA/);
    assert.equal(f.inferences, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n, 0);
  });
});

test('áudio pessoal: falha no conversor libera ocupação e não cria transcrição', async t => {
  const f = await fixture(t, {convert: () => {throw Error('synthetic decoder failure');}});
  await assert.rejects(() => f.audio.transcrever(f.id), /synthetic decoder failure/);
  await assert.rejects(() => f.audio.transcrever(f.id), /synthetic decoder failure/);
  assert.equal(f.conversions, 2); assert.equal(f.inferences, 0); assert.equal(f.audio.busy, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n, 0);
});

test('áudio pessoal: revogação ou abort durante ASR que ignora sinal descarta o retorno tardio', async t => {
  for (const mutation of ['revogar', 'abort']) await t.test(mutation, async child => {
    let started, release;
    const ready = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
    const controller = new AbortController();
    const f = await fixture(child, {asr: async (_, bytes) => {started(); await gate; return asrResult(bytes);}});
    const pending = f.audio.transcrever(f.id, {signal: controller.signal});
    await ready;
    await assert.rejects(() => f.audio.transcrever(f.id), /AUDIO_LOCAL_INDISPONIVEL/, 'One transcription at a time');
    try {
      if (mutation === 'revogar') f.db.prepare('UPDATE eventos SET permissao=NULL WHERE id=?').run(f.id);
      else controller.abort();
    } finally {release();}
    await assert.rejects(() => pending, /cancelada|mudou|revogada/);
    assert.equal(f.conversions, 1); assert.equal(f.inferences, 1); assert.equal(f.audio.busy, false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n, 0);
    assert.notEqual(f.db.prepare("SELECT estado FROM etapas WHERE evento_id=? AND etapa='transcricao'").get(f.id).estado, 'concluida');
    assert.equal(f.ia.gasto(), 0);
  });
});

test('áudio pessoal: indisponibilidade do motor local não usa remoto nem cria resultado', async t => {
  const f = await fixture(t, {state: () => ({disponivel: false, motivo: 'Pacote local sintético indisponível.'})});
  await assert.rejects(() => f.audio.transcrever(f.id), /indisponível/);
  assert.equal(f.inferences, 0); assert.equal(f.audio.busy, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM transcricoes').get().n, 0);
  assert.equal(f.ia.gasto(), 0);
});

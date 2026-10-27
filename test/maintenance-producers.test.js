import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { criarServidor } from '../src/painel/servidor.js';
import { registrarRotasNotetaker } from '../src/notetaker/http.js';
import { NotetakerServico } from '../src/notetaker/servico.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('servidor corta admissão síncrona e mantém fechamento idempotente', async t => {
  const db = abrirBanco();
  const server = criarServidor(db);
  t.after(() => db.close());
  assert.equal(typeof server.cortarAdmissao, 'function');
  assert.equal(server.cortarAdmissao(), true);
  assert.equal(server.cortarAdmissao(), false);
  assert.throws(() => server.listen(0, '127.0.0.1'), /SERVIDOR_ENCERRADO/);
  await server.encerrar();
});

test('upload parcial é destravado pelo corte e não publica parte', async () => {
  const controller = new AbortController();
  const id = randomUUID();
  const req = new PassThrough();
  req.on('error', () => {});
  req.method = 'POST'; req.headers = { 'content-type': 'audio/wav' }; req.setTimeout = () => {};
  let saved = 0, released = 0, responses = 0;
  const servico = {
    iniciarImportacao: () => ({ anteriorCompleta: false, liberar: () => released++ }),
    guardarParte: () => saved++, marcarImportacao: () => {}, transcreverImportacao: () => { throw Error('ASR tardio'); }
  };
  const route = registrarRotasNotetaker(req, { destroyed: false },
    new URL(`http://localhost/api/v3/notetaker/sessoes/${id}/importar`),
    { servico, signal: controller.signal, json: () => responses++ });
  req.write(Buffer.alloc(8));
  await tick();
  controller.abort();
  await route;
  assert.equal(req.destroyed, true);
  assert.equal(saved, 0);
  assert.equal(released, 1);
  assert.equal(responses, 0);
});

test('áudio aguardando bytes não escreve resposta depois do corte', async () => {
  const controller = new AbortController();
  const id = randomUUID();
  let resolveAudio, writes = 0;
  const audio = new Promise(resolve => { resolveAudio = resolve; });
  const req = { method: 'GET', headers: {}, destroyed: false, destroy() { this.destroyed = true; } };
  const res = { destroyed: false, setHeader() {}, writeHead() { writes++; }, end() { writes++; } };
  const route = registrarRotasNotetaker(req, res,
    new URL(`http://localhost/api/v3/notetaker/partes/${id}/audio`),
    { servico: { audio: () => audio }, signal: controller.signal, json: () => writes++ });
  controller.abort(); resolveAudio(Buffer.from('audio'));
  await route;
  assert.equal(req.destroyed, true);
  assert.equal(writes, 0);
});

test('notetaker já cortado recusa correção, parte e publicação ASR antes de DB', () => {
  const controller = new AbortController();
  const service = Object.create(NotetakerServico.prototype);
  service.signal = controller.signal;
  service.db = { prepare() { throw Error('DB_ACESSADO'); } };
  controller.abort();
  for (const call of [
    () => service.corrigirTrecho(randomUUID(), {}),
    () => service.guardarParte(randomUUID(), { posicao: 0, bytes: Buffer.alloc(0) }),
    () => service.registrarResultadoAsr(randomUUID(), {}),
  ]) assert.throws(call, e => e.code === 'CANCELADO');
});

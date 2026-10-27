import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramHoje} from '../src/telegram-hoje.js';
import {TelegramHojeRuntime} from '../src/telegram-runtime.js';

const TOKEN = '123456:abcdefghijklmnopqrstuvwxyz123456';
const update = (id, chat = 123) => ({update_id: id, message: {
  chat: {id: chat, type: 'private'}, from: {id: chat}, text: '/hoje',
}});
const ok = result => ({ok: true, json: async () => ({ok: true, result})});
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
async function waitFor(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await nextTurn();
  assert.ok(predicate(), 'operação esperada não ocorreu');
}

function hoje() {
  return new TelegramHoje({clareza: {resumo: () => ({dia: '2026-09-28', cobertura: {estado: 'recente'},
    prioridades: {total: 1, itens: [{titulo: 'Assunto privado'}]}, revisao: {total: 0},
    oportunidades: {total: 0}})}, perfil: () => ({aceito: true}), enabled: true,
    allowedChatIds: [123]});
}

test('polling desligado não consulta token nem rede', async () => {
  let calls = 0;
  const runtime = new TelegramHojeRuntime({hoje: hoje(), token: () => {calls++; return TOKEN;},
    fetchImpl: () => {calls++; throw Error('não deveria chamar');}});
  assert.equal(runtime.start(), false);
  await runtime.stop();
  assert.equal(calls, 0);
});

test('processa só DM permitida, envia só /hoje e avança offset após envio', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const method = url.split('/').at(-1), body = JSON.parse(options.body);
    calls.push({method, body});
    if (method === 'sendMessage') return ok({message_id: 7});
    if (calls.filter(x => x.method === 'getUpdates').length === 1) return ok([update(9, 999), update(10)]);
    return ok([]);
  };
  const runtime = new TelegramHojeRuntime({hoje: hoje(), token: () => TOKEN, fetchImpl,
    enabled: true, backoffMinMs: 1});
  assert.equal(runtime.start(), true);
  await waitFor(() => calls.filter(x => x.method === 'getUpdates').length >= 2);
  await runtime.stop();
  assert.equal(calls.filter(x => x.method === 'sendMessage').length, 1);
  assert.equal(calls[0].body.offset, 0);
  assert.equal(runtime.offset, 11);
  assert.doesNotMatch(calls.find(x => x.method === 'sendMessage').body.text, /Assunto privado/);
});

test('falha no envio mantém offset para nova tentativa e não revela credencial no erro', async () => {
  let polls = 0, sends = 0;
  const runtime = new TelegramHojeRuntime({hoje: hoje(), token: () => TOKEN,
    fetchImpl: async (url) => {
      if (url.endsWith('/getUpdates')) { polls++; return ok(polls <= 2 ? [update(5)] : []); }
      sends++;
      return sends === 1 ? {ok: false} : ok({message_id: 1});
    }, enabled: true, backoffMinMs: 1, backoffMaxMs: 2});
  runtime.start();
  await waitFor(() => sends >= 2);
  await runtime.stop();
  assert.equal(sends, 2);
  assert.equal(runtime.offset, 6);
});

test('stop aborta polling pendente e start é idempotente', async () => {
  let polls = 0;
  const runtime = new TelegramHojeRuntime({hoje: hoje(), token: () => TOKEN,
    fetchImpl: (_url, options) => {polls++; return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('abortado')), {once: true});
    });}, enabled: true});
  assert.equal(runtime.start(), true);
  assert.equal(runtime.start(), true);
  await nextTurn();
  await runtime.stop();
  assert.equal(polls, 1);
});

test('claim durável antes do envio impede duplicata após falha e reinício', async () => {
  let cursor = -1, sends = 0;
  const make = () => new TelegramHojeRuntime({hoje: hoje(), token: () => TOKEN,
    fetchImpl: async (url) => {
      if (url.endsWith('/getUpdates')) return ok([update(5)]);
      sends++;
      return {ok: false};
    }, enabled: true, initialOffset: cursor + 1,
    claimUpdate: id => {if (id <= cursor) return false; cursor = id; return true;},
    backoffMinMs: 1, backoffMaxMs: 2});
  const first = make(); first.start();
  await waitFor(() => sends === 1);
  await first.stop();
  assert.equal(cursor, 5);
  const second = make(); second.start();
  await nextTurn();
  await second.stop();
  assert.equal(sends, 1);
});

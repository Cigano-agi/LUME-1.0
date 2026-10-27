import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TelegramHoje, formatarHojeTelegram} from '../src/telegram-hoje.js';

const update = ({chatId = 123, senderId = chatId, type = 'private', text = '/hoje'} = {}) => ({
  message: {chat: {id: chatId, type}, from: {id: senderId}, text},
});
const snapshot = () => ({dia: '2026-09-28', cobertura: {estado: 'recente'},
  prioridades: {total: 4, itens: [{titulo: 'Revisar a minuta privada', fonteId: 42}, {titulo: 'Enviar contrato'}]},
  revisao: {total: 2}, oportunidades: {total: 1, valorCentavos: 900000},
  conversas: {itens: [{trecho: 'CORPO_SIGILOSO', nome: 'Pessoa privada'}]},
});

test('desligado por padrão e sem autorização exata de DM não consulta o resumo', () => {
  let calls = 0;
  const clareza = {resumo: () => {calls++; return snapshot();}};
  const perfil = () => ({aceito: true});
  assert.equal(new TelegramHoje({clareza, perfil, allowedChatIds: [123]}).handleUpdate(update()), null);
  const bot = new TelegramHoje({clareza, perfil, enabled: true, allowedChatIds: [123]});
  for (const u of [update({chatId: 124}), update({senderId: 124}), update({type: 'group'}),
    update({text: '/hoje algo'}), update({text: '/hoje@OutroBot'}), {edited_message: update().message}]) {
    assert.equal(bot.handleUpdate(u), null);
  }
  assert.equal(calls, 0);
});

test('responde apenas ao comando em DM autorizada, sem trecho, nome, valor ou token', () => {
  let calls = 0;
  const bot = new TelegramHoje({clareza: {resumo: () => {calls++; return snapshot();}},
    perfil: () => ({aceito: true}), enabled: true, allowedChatIds: ['123'], botUsername: 'LumeBot'});
  const reply = bot.handleUpdate(update({text: '/hoje@LumeBot'}));
  assert.equal(reply.chatId, '123');
  assert.match(reply.text, /4 ações · 2 para revisar · 1 oportunidades/);
  assert.doesNotMatch(reply.text, /Revisar a minuta|CORPO_SIGILOSO|Pessoa privada|900000|42/);
  assert.equal(calls, 1);
});

test('títulos requerem opção explícita e revogação é respeitada em nova consulta', () => {
  let state = snapshot();
  const bot = new TelegramHoje({clareza: {resumo: () => state}, perfil: () => ({aceito: true}),
    enabled: true, allowedChatIds: [123], shareTitles: true});
  assert.match(bot.handleUpdate(update()).text, /Revisar a minuta privada/);
  state = {...snapshot(), prioridades: {total: 0, itens: []}, conversas: {itens: []}};
  assert.doesNotMatch(bot.handleUpdate(update()).text, /minuta privada/);
  assert.equal(bot.handleUpdate(update({text: '/hoje@OutroBot'})), null);
});

test('perfil sem aceite bloqueia e texto é curto, literal e sem controles', () => {
  const bot = new TelegramHoje({clareza: {resumo: snapshot}, perfil: () => ({aceito: false}),
    enabled: true, allowedChatIds: [123]});
  assert.equal(bot.handleUpdate(update()), null);
  const s = snapshot(); s.prioridades.itens = [{titulo: 'A\nB\u202e' + 'x'.repeat(5000)}];
  const text = formatarHojeTelegram(s, {shareTitles: true});
  assert.ok(text.length <= 1500);
  assert.doesNotMatch(text, /\u202e|CORPO_SIGILOSO|900000/);
  assert.match(text, /A B/);
});

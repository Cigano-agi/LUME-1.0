import {test} from 'node:test';
import assert from 'node:assert/strict';
import {abrirBanco} from '../src/banco.js';
import {TelegramHojeIntegracao} from '../src/telegram-integracao.js';

const TOKEN = '123456:abcdefghijklmnopqrstuvwxyz123456';
function setup(t, {available = true} = {}) {
  const db = abrirBanco(); t.after(() => db.close());
  db.exec('CREATE TABLE IF NOT EXISTS desktop_config(chave TEXT PRIMARY KEY,valor TEXT NOT NULL)');
  let secret = null, removed = 0, calls = 0;
  const segredos = {
    estado: async () => ({disponivel: available, configurada: Boolean(secret)}),
    gravar: async value => {secret = value;},
    ler: async () => {if (!secret) throw Error('sem token'); return secret;},
    remover: async () => {removed++; secret = null;},
  };
  const desktop = {perfil: () => ({aceito: true})};
  const fetchImpl = async (_url, {signal}) => {calls++; return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('abortado')), {once: true});
  });};
  const service = new TelegramHojeIntegracao(db, {desktop,
    clareza: {resumo: () => ({dia: '2026-09-28', prioridades: {total: 0}, revisao: {total: 0}, oportunidades: {total: 0}})},
    segredos, fetchImpl});
  return {db, service, segredos, get secret() {return secret;}, get removed() {return removed;}, get calls() {return calls;}};
}

test('padrão desligado e estado não retorna nem persiste token', async t => {
  const e = setup(t);
  assert.equal((await e.service.estado()).enabled, false);
  assert.equal(e.service.iniciar instanceof Function, true);
  await e.service.iniciar();
  assert.equal(e.calls, 0);
  await e.service.configurar({token: TOKEN, chatId: '123', enabled: true});
  const saved = e.db.prepare("SELECT valor FROM desktop_config WHERE chave='telegram-hoje'").get().valor;
  assert.deepEqual(JSON.parse(saved), {enabled: true, chatId: '123', shareTitles: false, botUsername: null});
  assert.doesNotMatch(JSON.stringify(await e.service.estado()) + saved, /123456:|abcdefghijklmnopqrstuvwxyz/);
});

test('cofre indisponível falha fechado sem gravar configuração nem consultar rede', async t => {
  const e = setup(t, {available: false});
  await assert.rejects(e.service.configurar({token: TOKEN, chatId: '123', enabled: true}), /Cofre/);
  assert.equal(e.db.prepare("SELECT valor FROM desktop_config WHERE chave='telegram-hoje'").get(), undefined);
  assert.equal(e.calls, 0);
});

test('iniciar é opt-in; desativar aborta antes de remover segredo', async t => {
  const e = setup(t);
  await e.service.configurar({token: TOKEN, chatId: 123, enabled: true});
  assert.equal(e.calls, 0);
  await e.service.iniciar();
  assert.equal((await e.service.estado()).running, true);
  await e.service.desativar();
  assert.equal(e.secret, null);
  assert.equal(e.removed, 1);
  assert.equal((await e.service.estado()).enabled, false);
});

test('configuração inválida e perfil sem aceite não ativam', async t => {
  const e = setup(t);
  await assert.rejects(e.service.configurar({chatId: 'grupo@g.us', enabled: true}), /inválida/);
  e.service.desktop.perfil = () => ({aceito: false});
  await assert.rejects(e.service.configurar({chatId: '123', token: TOKEN, enabled: true}), /primeiro acesso/);
  assert.equal(e.calls, 0);
});

// Real SQLite journals, including a killed child process. No Telegram network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {abrirBanco} from '../src/banco.js';
import {TelegramDiario, identidadeTelegram} from '../src/pessoal/telegram-diario.js';

const BOT = '987654321', OWNER = '123456789';
const update = (id = 7, text = 'Pedido sintético do dono') => ({update_id: id, message: {message_id: id, date: 1793008800, chat: {id: Number(OWNER), type: 'private'}, from: {id: Number(OWNER), is_bot: false}, text}});
function fixture(t, {disk = false} = {}) {
  const dir = disk ? mkdtempSync(join(tmpdir(), 'lume-telegram-diario-')) : null;
  const path = dir ? join(dir, 'sintetico.sqlite') : ':memory:';
  let now = new Date('2026-10-26T10:00:00Z');
  const f = {path, handles: []};
  const connect = () => {f.db = abrirBanco(path); f.diario = new TelegramDiario(f.db, {botId: BOT, donoId: OWNER, agora: () => now});};
  connect();
  f.time = value => now = new Date(value);
  f.reopen = () => {assert.ok(disk); f.db.close(); connect();};
  t.after(() => {for (const handle of f.handles) handle.close(); f.db.close(); if (dir) rmSync(dir, {recursive: true, force: true});});
  return f;
}

test('Telegram diário: somente dono exato na DM entra no diário; terceiros avançam cursor sem preservar conteúdo', t => {
  const f = fixture(t), own = update();
  assert.equal(identidadeTelegram(own, OWNER), true);
  const foreign = update(8); foreign.message.from.id = 444444444;
  const wrongChat = update(9); wrongChat.message.chat.id = 444444444;
  const group = update(10); group.message.chat.type = 'supergroup';
  const bot = update(11); bot.message.from.is_bot = true;
  const invalidId = update(-1);
  for (const item of [foreign, wrongChat, group, bot, invalidId]) assert.equal(identidadeTelegram(item, OWNER), false);
  for (const item of [foreign, wrongChat, group, bot]) f.diario.aceitar(item);
  assert.throws(() => f.diario.aceitar(invalidId), /inválida/);
  assert.equal(f.diario.offset(), 12);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_entradas').get().n, 0);
  assert.equal(f.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-telegram-identidade'").get(), undefined);
  f.diario.aceitar(own);
  assert.equal(f.diario.offset(), 12, 'Older authorized update never regresses the cursor');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_entradas').get().n, 1);
});

test('Telegram diário: falha ao persistir entrada mantém cursor e identidade sem avanço', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER synthetic_intake_fail BEFORE INSERT ON telegram_entradas BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  assert.throws(() => f.diario.aceitar(update()), /synthetic disk failure/);
  assert.equal(f.diario.offset(), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_entradas').get().n, 0);
  assert.equal(f.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-telegram-identidade'").get(), undefined);
  f.db.exec('DROP TRIGGER synthetic_intake_fail');
  // This trigger checks the real write order, not a mocked database call trace.
  f.db.exec(`CREATE TRIGGER synthetic_cursor_guard BEFORE INSERT ON desktop_config
    WHEN NEW.chave='pessoal-telegram-offset:${BOT}' AND NOT EXISTS(SELECT 1 FROM telegram_entradas WHERE bot_id='${BOT}' AND update_id=7)
    BEGIN SELECT RAISE(ABORT,'cursor before inbox'); END`);
  f.diario.aceitar(update());
  assert.equal(f.diario.offset(), 8);
  assert.equal(f.diario.proxima().message.text, 'Pedido sintético do dono');
});

test('Telegram diário: falha ao salvar cursor reverte também a entrada e o dono confirmado', t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER synthetic_cursor_fail BEFORE INSERT ON desktop_config WHEN NEW.chave='pessoal-telegram-offset:${BOT}'
    BEGIN SELECT RAISE(ABORT,'synthetic cursor failure'); END`);
  assert.throws(() => f.diario.aceitar(update()), /synthetic cursor failure/);
  assert.equal(f.diario.offset(), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_entradas').get().n, 0);
  assert.equal(f.db.prepare("SELECT valor FROM desktop_config WHERE chave='pessoal-telegram-identidade'").get(), undefined);
});

test('Telegram diário: replay não substitui pedido nem duplica resposta, inclusive após reabrir SQLite', t => {
  const f = fixture(t, {disk: true});
  f.diario.aceitar(update(20, 'Texto original sintético'));
  f.diario.aceitar(update(20, 'Texto substituído no replay'));
  f.diario.aceitar(update(2, 'Pedido anterior sintético'));
  assert.equal(f.diario.offset(), 21);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_entradas').get().n, 2);
  const first = f.diario.proxima(); assert.equal(first.update_id, 2);
  f.diario.concluir(first, {chatId: OWNER, text: 'Resposta sintética anterior'});
  const second = f.diario.proxima(); assert.equal(second.update_id, 20);
  assert.equal(second.message.text, 'Texto original sintético');
  const reply = {chatId: OWNER, text: 'Resposta sintética atual'};
  f.diario.concluir(second, reply); f.diario.concluir(second, reply);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_saidas').get().n, 2);
  f.reopen(); f.diario.aceitar(update(20, 'Outro replay'));
  assert.equal(f.diario.offset(), 21); assert.equal(f.diario.proxima(), null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_saidas').get().n, 2);
});

test('Telegram diário: entrada em processamento só retoma após expiração do claim', t => {
  const f = fixture(t, {disk: true}); f.diario.aceitar(update());
  assert.equal(f.diario.proxima().update_id, 7);
  f.reopen(); assert.equal(f.diario.proxima(), null);
  f.time('2026-10-26T10:04:59Z'); assert.equal(f.diario.proxima(), null);
  f.time('2026-10-26T10:05:01Z'); assert.equal(f.diario.proxima().update_id, 7);
  assert.equal(f.db.prepare('SELECT tentativas FROM telegram_entradas').get().tentativas, 2);
});

test('Telegram diário: conclusão e resposta são atômicas e resposta para outro chat é recusada', t => {
  const f = fixture(t); f.diario.aceitar(update()); const current = f.diario.proxima();
  f.db.exec("CREATE TRIGGER synthetic_complete_fail BEFORE UPDATE OF estado ON telegram_entradas WHEN NEW.estado='concluida' BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END");
  assert.throws(() => f.diario.concluir(current, {chatId: OWNER, text: 'Resposta ainda não confirmada'}), /synthetic commit failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_saidas').get().n, 0);
  assert.equal(f.db.prepare('SELECT estado FROM telegram_entradas').get().estado, 'processando');
  f.db.exec('DROP TRIGGER synthetic_complete_fail');
  f.diario.concluir(current, {chatId: '444444444', text: 'Nunca enviar a outro destino'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM telegram_saidas').get().n, 0);
  assert.equal(f.db.prepare('SELECT estado FROM telegram_entradas').get().estado, 'concluida');
});

test('Telegram diário: dois handles disputam saída uma vez e recibo é necessário para enviada', t => {
  const f = fixture(t, {disk: true}), second = abrirBanco(f.path);
  f.handles.push(second);
  const concurrent = new TelegramDiario(second, {botId: BOT, donoId: OWNER});
  assert.equal(f.diario.agendar('synthetic-same-key', 'Aviso sintético'), true);
  assert.equal(concurrent.agendar('synthetic-same-key', 'Aviso sintético'), false);
  const claimed = f.diario.proximaSaida();
  assert.equal(second.prepare('SELECT estado FROM telegram_saidas').get().estado, 'incerta');
  assert.equal(concurrent.proximaSaida(), null);
  f.diario.enviada(claimed, {});
  assert.equal(second.prepare('SELECT estado FROM telegram_saidas').get().estado, 'incerta');
  f.diario.enviada(claimed, {message_id: 555});
  assert.deepEqual({...second.prepare('SELECT estado,externo_id FROM telegram_saidas').get()}, {estado: 'enviada', externo_id: '555'});
  assert.equal(concurrent.proximaSaida(), null);
});

test('Telegram diário: crash real após claim durável deixa incerta sem retry automático', async t => {
  const f = fixture(t, {disk: true});
  f.diario.agendar('synthetic-crash', 'Mensagem sintética sem rede');
  const source = `import {abrirBanco} from ${JSON.stringify(new URL('../src/banco.js', import.meta.url).href)};
    import {TelegramDiario} from ${JSON.stringify(new URL('../src/pessoal/telegram-diario.js', import.meta.url).href)};
    const db=abrirBanco(${JSON.stringify(f.path)}),diario=new TelegramDiario(db,{botId:${JSON.stringify(BOT)},donoId:${JSON.stringify(OWNER)}});
    const row=diario.proximaSaida();
    if(!row)throw Error('No synthetic output to claim');
    process.stdout.write('CLAIM_DURABLE\\n');setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => stderr += chunk);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(Error('Claim timeout: ' + stderr));}, 10000);
    child.stdout.on('data', chunk => {stdout += chunk; if (stdout.includes('CLAIM_DURABLE')) child.kill('SIGKILL');});
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', () => {clearTimeout(timer); stdout.includes('CLAIM_DURABLE') ? resolve() : reject(Error('Child exited before claim: ' + stderr));});
  });
  f.reopen();
  assert.equal(f.db.prepare('SELECT estado FROM telegram_saidas').get().estado, 'incerta');
  assert.equal(f.diario.proximaSaida(), null);
  f.time('2026-10-30T10:00:00Z'); assert.equal(f.diario.proximaSaida(), null, 'Uncertain output has no lease-based retry');
  assert.equal(f.diario.agendar('synthetic-crash', 'Mensagem sintética sem rede'), false);
});

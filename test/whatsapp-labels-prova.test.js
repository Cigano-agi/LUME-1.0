import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import {
  CONFIRMACAO_LITERAL,
  EVIDENCIA_FIM,
  EVIDENCIA_INICIO,
  STATUS_PROVA,
  atualizarEvidencia,
  blocoEvidencia,
  criarQrTTY,
  executarProvaManual,
  prepararPerfilIsolado,
  removerPerfilIsolado
} from '../scripts/provar-whatsapp-labels.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DOC = join(ROOT, 'docs', 'LUME-3.2-LABELS-PROVA.md');

function dentro(path, root) {
  const trecho = relative(root, path);
  return trecho === '' || (!trecho.startsWith('..') && !isAbsolute(trecho));
}

function nomePerfil(sufixo = randomUUID().replaceAll('-', '')) {
  return join(tmpdir(), `lume-label-proof-${sufixo}`);
}

function terminal() {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.resume = () => {}; input.pause = () => {};
  const writes = [], output = { isTTY: true, write: value => { writes.push(String(value)); return true; } };
  return { input, output, writes };
}

function prompts({ modalidade = 'CHAT', visivel = 'SIM', limpo = 'SIM', confirmacao = CONFIRMACAO_LITERAL } = {}) {
  return {
    confirmarConta: async () => confirmacao,
    modalidade: async () => modalidade,
    chatId: async () => '5511999999999@s.whatsapp.net',
    messageId: async () => 'MSG-TESTE-001',
    telefoneVisivel: async () => visivel,
    telefoneLimpo: async () => limpo
  };
}

function timersRastreados() {
  const ativos = new Set();
  return {
    ativos,
    setTimeout(fn, ms) {
      const id = setTimeout(() => { ativos.delete(id); fn(); }, ms);
      ativos.add(id); return id;
    },
    clearTimeout(id) { ativos.delete(id); clearTimeout(id); }
  };
}

function socketFalso({ abrir = true, fecharAntes = false, falhaCriacao = false, modalidade = 'CHAT' } = {}) {
  const ev = new EventEmitter();
  let aberto = false, encerramentos = 0, mutacoesAntesDeAbrir = 0;
  const mutacao = () => { if (!aberto) mutacoesAntesDeAbrir++; };
  const socket = {
    ev,
    async addLabel(chatId, body) {
      mutacao();
      if (falhaCriacao && body.deleted === false) throw Error('falha sintetica');
      ev.emit('labels.edit', { ...body });
    },
    async addChatLabel(chatId, labelId) {
      mutacao(); ev.emit('labels.association', { type: 'add', association: { type: 'label_jid', chatId, labelId } });
    },
    async removeChatLabel(chatId, labelId) {
      mutacao(); ev.emit('labels.association', { type: 'remove', association: { type: 'label_jid', chatId, labelId } });
    },
    async addMessageLabel(chatId, messageId, labelId) {
      mutacao(); ev.emit('labels.association', { type: 'add', association: { type: 'label_message', chatId, messageId, labelId } });
    },
    async removeMessageLabel(chatId, messageId, labelId) {
      mutacao(); ev.emit('labels.association', { type: 'remove', association: { type: 'label_message', chatId, messageId, labelId } });
    },
    async end() { encerramentos++; }
  };
  const loadAdapters = async () => ({
    version: '7.0.0-rc14',
    auth: async () => ({ state: {}, saveCreds() {} }),
    makeSocket: async () => {
      setImmediate(() => {
        ev.emit('connection.update', { qr: 'QR-SENSIVEL-NAO-PERSISTIR' });
        if (fecharAntes) ev.emit('connection.update', { connection: 'close' });
        else if (abrir) { aberto = true; ev.emit('connection.update', { connection: 'open' }); }
      });
      return socket;
    }
  });
  return {
    socket, loadAdapters, modalidade,
    get aberto() { return aberto; },
    get encerramentos() { return encerramentos; },
    get mutacoesAntesDeAbrir() { return mutacoesAntesDeAbrir; }
  };
}

async function documentoTemporario(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'lume-label-doc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'LUME-3.2-LABELS-PROVA.md');
  await fs.copyFile(DOC, path);
  return path;
}

async function removerSeExiste(path) {
  await fs.rm(path, { recursive: true, force: true });
}

test('perfil precisa ser absoluto, novo, direto no tmp e nao pode coincidir com perfil vivo', async t => {
  await assert.rejects(prepararPerfilIsolado('relativo/lume-label-proof-teste'), { code: 'PROFILE_NOT_ABSOLUTE' });
  await assert.rejects(prepararPerfilIsolado(resolve(tmpdir(), 'sub', 'lume-label-proof-teste')), { code: 'PROFILE_OUTSIDE_TEMP' });
  await assert.rejects(prepararPerfilIsolado(parseRoot()), { code: /PROFILE_/ });

  const existing = nomePerfil(); await fs.mkdir(existing);
  t.after(() => removerSeExiste(existing));
  await assert.rejects(prepararPerfilIsolado(existing), { code: 'PROFILE_EXISTS' });

  const protectedPath = nomePerfil();
  await assert.rejects(prepararPerfilIsolado(protectedPath, { env: { ASSESSOR_DATA_DIR: protectedPath } }), { code: 'PROFILE_LIVE_PATH' });
  assert.equal(existsSync(protectedPath), false);
});

function parseRoot() {
  return process.platform === 'win32' ? resolve(tmpdir()).slice(0, 3) : '/';
}

test('perfil recusa alias e so apaga o diretorio cuja posse foi provada', async t => {
  const target = await fs.mkdtemp(join(tmpdir(), 'lume-label-target-'));
  const alias = nomePerfil();
  let aliasCriado = false;
  t.after(async () => {
    if (aliasCriado) await fs.unlink(alias).catch(() => {});
    await removerSeExiste(target);
  });
  try { await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); aliasCriado = true; }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Ambiente nao permite criar junction/symlink.'); throw error; }
  await assert.rejects(prepararPerfilIsolado(alias), { code: 'PROFILE_ALIAS' });

  const ownedPath = nomePerfil(), owned = await prepararPerfilIsolado(ownedPath);
  await assert.rejects(removerPerfilIsolado({ ...owned, nonce: 'outro' }), { code: 'PROFILE_OWNERSHIP' });
  assert.equal(existsSync(ownedPath), true);
  await removerPerfilIsolado(owned);
  assert.equal(existsSync(ownedPath), false);
});

test('perfil compara caminhos protegidos pelo realpath e recusa ancestral via junction', async t => {
  const container = await fs.mkdtemp(join(tmpdir(), 'lume-protected-alias-'));
  const alias = join(container, 'dados-vivos'), candidate = nomePerfil();
  let aliasCriado = false, fsUsado = fs;
  t.after(async () => {
    if (aliasCriado) await fs.unlink(alias).catch(() => {});
    await removerSeExiste(container);
    await removerSeExiste(candidate);
  });
  try {
    await fs.symlink(tmpdir(), alias, process.platform === 'win32' ? 'junction' : 'dir');
    aliasCriado = true;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    fsUsado = {
      ...fs,
      async realpath(path) {
        if (resolve(path) === resolve(alias)) return fs.realpath(tmpdir());
        return fs.realpath(path);
      }
    };
  }
  await assert.rejects(
    prepararPerfilIsolado(candidate, { fs: fsUsado, env: { ASSESSOR_DATA_DIR: alias } }),
    { code: 'PROFILE_LIVE_PATH' }
  );
  assert.equal(existsSync(candidate), false);
});

test('sem TTY nao cria perfil, nao carrega Baileys e nao mostra QR', async () => {
  let imports = 0, qr = 0;
  await assert.rejects(executarProvaManual({
    profileDir: nomePerfil(),
    input: { isTTY: false }, output: { isTTY: false },
    loadAdapters: async () => { imports++; },
    qrSink: { mostrar() { qr++; }, limpar() {} }
  }), { code: 'TTY_REQUIRED' });
  assert.equal(imports, 0); assert.equal(qr, 0);
});

test('AbortSignal ja cancelado para antes de criar perfil ou carregar adaptadores', async () => {
  const profileDir = nomePerfil(), controller = new AbortController(), tty = terminal();
  controller.abort(); let imports = 0, mutations = 0;
  await assert.rejects(executarProvaManual({
    profileDir, ...tty, prompts: prompts(), signal: controller.signal,
    processLike: new EventEmitter(),
    loadAdapters: async () => { imports++; mutations++; },
    qrSink: { async mostrar() { mutations++; }, limpar() {} }
  }), { name: 'AbortError' });
  assert.equal(existsSync(profileDir), false);
  assert.equal(imports, 0); assert.equal(mutations, 0);
});

test('confirmacao literal acontece antes do carregamento remoto', async t => {
  const path = nomePerfil(); t.after(() => removerSeExiste(path));
  const tty = terminal(); let imports = 0;
  const result = await executarProvaManual({
    profileDir: path, ...tty, prompts: prompts({ confirmacao: 'SIM' }),
    loadAdapters: async () => { imports++; }, qrSink: { mostrar() {}, limpar() {} }
  });
  assert.equal(imports, 0);
  assert.equal(result.status, STATUS_PROVA.INCONCLUSIVO);
  assert.ok(result.codigos.includes('PROFILE_RETAINED'));
});

for (const modalidade of ['CHAT', 'MENSAGEM']) {
  test(`fluxo feliz ${modalidade} exige open, quatro provas externas e fecha uma vez`, async t => {
    const profileDir = nomePerfil(), evidencePath = await documentoTemporario(t), fake = socketFalso({ modalidade });
    const tty = terminal(), shown = [], clears = [], timers = timersRastreados();
    const result = await executarProvaManual({
      profileDir, evidencePath, expectedEvidencePath: evidencePath,
      ...tty, prompts: prompts({ modalidade }), loadAdapters: fake.loadAdapters,
      qrSink: { async mostrar(value) { shown.push(value); }, limpar() { clears.push(true); } },
      timers, connectionTimeoutMs: 100, eventTimeoutMs: 100
    });
    assert.equal(result.status, STATUS_PROVA.APROVADO, JSON.stringify(result));
    assert.equal(fake.mutacoesAntesDeAbrir, 0);
    assert.equal(fake.encerramentos, 1);
    assert.deepEqual(shown, ['QR-SENSIVEL-NAO-PERSISTIR']);
    assert.ok(clears.length >= 2);
    assert.equal(timers.ativos.size, 0);
    assert.equal(fake.socket.ev.eventNames().length, 0);
    assert.equal(existsSync(profileDir), false);
    const markdown = await fs.readFile(evidencePath, 'utf8');
    assert.match(markdown, /\*\*Status:\*\* APROVADO/);
    const evidenceBlock = markdown.slice(markdown.indexOf(EVIDENCIA_INICIO), markdown.indexOf(EVIDENCIA_FIM) + EVIDENCIA_FIM.length);
    assert.doesNotMatch(evidenceBlock, /5511999999999|MSG-TESTE|QR-SENSIVEL|labelId/i);
  });
}

test('pareamento novo aceita um restartRequired e encerra cada socket exatamente uma vez', async t => {
  const profileDir = nomePerfil(), fake = socketFalso(), tty = terminal();
  t.after(() => removerSeExiste(profileDir));
  const firstEv = new EventEmitter(); let firstEnds = 0, creates = 0;
  const realAdapter = await fake.loadAdapters();
  const loadAdapters = async () => ({
    version: '7.0.0-rc14',
    auth: async () => ({ state: {}, saveCreds() {} }),
    async makeSocket(args) {
      creates++;
      if (creates > 1) return realAdapter.makeSocket(args);
      setImmediate(() => {
        firstEv.emit('connection.update', { qr: 'QR-PRIMEIRO' });
        firstEv.emit('connection.update', {
          connection: 'close',
          lastDisconnect: { error: { output: { statusCode: 515 } } }
        });
      });
      return { ev: firstEv, async end() { firstEnds++; } };
    }
  });
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, connectionTimeoutMs: 100, eventTimeoutMs: 100
  });
  assert.equal(result.status, STATUS_PROVA.APROVADO);
  assert.equal(creates, 2);
  assert.equal(firstEnds, 1);
  assert.equal(fake.encerramentos, 1);
  assert.equal(firstEv.eventNames().length, 0);
  assert.equal(fake.socket.ev.eventNames().length, 0);
});

test('timeout nao toca mutadores, limpa QR/timer/listeners e fecha exatamente uma vez', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso({ abrir: false }), tty = terminal(), timers = timersRastreados(); let clears = 0;
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() { clears++; } }, timers,
    connectionTimeoutMs: 8, eventTimeoutMs: 8
  });
  assert.equal(result.status, STATUS_PROVA.INCONCLUSIVO);
  assert.ok(result.codigos.includes('CONNECTION_TIMEOUT'));
  assert.equal(fake.mutacoesAntesDeAbrir, 0);
  assert.equal(fake.encerramentos, 1);
  assert.equal(timers.ativos.size, 0);
  assert.equal(fake.socket.ev.eventNames().length, 0);
  assert.ok(clears >= 2);
});

test('cancelamento durante QR nao toca mutadores e encerra exatamente uma vez', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso({ abrir: false }), tty = terminal(), controller = new AbortController(), timers = timersRastreados();
  let qrSeen = false;
  const resultPromise = executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() { qrSeen = true; queueMicrotask(() => controller.abort()); }, limpar() {} },
    signal: controller.signal, timers, connectionTimeoutMs: 100, eventTimeoutMs: 100
  });
  const result = await resultPromise;
  assert.equal(qrSeen, true);
  assert.ok(result.codigos.includes('CONNECTION_CANCELED'));
  assert.equal(fake.mutacoesAntesDeAbrir, 0);
  assert.equal(fake.encerramentos, 1);
  assert.equal(timers.ativos.size, 0);
  assert.equal(fake.socket.ev.eventNames().length, 0);
});

test('erro de autenticacao nao toca mutadores e encerra exatamente uma vez', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso({ fecharAntes: true }), tty = terminal(), timers = timersRastreados();
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, timers, connectionTimeoutMs: 100, eventTimeoutMs: 100
  });
  assert.ok(result.codigos.includes('CONNECTION_FAILED'));
  assert.equal(fake.mutacoesAntesDeAbrir, 0);
  assert.equal(fake.encerramentos, 1);
  assert.equal(timers.ativos.size, 0);
  assert.equal(fake.socket.ev.eventNames().length, 0);
});

test('socket retornado com emissor invalido ainda e encerrado exatamente uma vez', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const tty = terminal(); let encerramentos = 0, mutacoes = 0;
  const loadAdapters = async () => ({
    version: '7.0.0-rc14',
    auth: async () => ({ state: {}, saveCreds() {} }),
    makeSocket: async () => ({ ev: null, async end() { encerramentos++; }, async addLabel() { mutacoes++; } })
  });
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, connectionTimeoutMs: 100, eventTimeoutMs: 20
  });
  assert.equal(result.status, STATUS_PROVA.INCONCLUSIVO);
  assert.ok(result.codigos.includes('TRIAL_ERROR'));
  assert.equal(encerramentos, 1);
  assert.equal(mutacoes, 0);
});

test('falha de escrita reprova, tenta limpeza uma vez e so remove perfil apos confirmacao final', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso({ falhaCriacao: true }), tty = terminal();
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, connectionTimeoutMs: 100, eventTimeoutMs: 30
  });
  assert.equal(result.status, STATUS_PROVA.REPROVADO);
  assert.ok(result.codigos.includes('CREATE_CALL_FAILED'));
  assert.ok(result.codigos.includes('PHONE_CLEAN_OK'));
  assert.ok(result.codigos.includes('PROFILE_REMOVED'));
  assert.equal(existsSync(profileDir), false);
  assert.equal(fake.encerramentos, 1);
  assert.equal(fake.socket.ev.eventNames().length, 0);
});

test('mutacao pendurada expira, tenta rollback e termina inconclusiva', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso(), tty = terminal(), original = fake.socket.addLabel;
  let criacoes = 0, limpezas = 0;
  fake.socket.addLabel = async (chatId, body) => {
    if (body.deleted === false) { criacoes++; return new Promise(() => {}); }
    limpezas++; return original.call(fake.socket, chatId, body);
  };
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, connectionTimeoutMs: 100, eventTimeoutMs: 8
  });
  assert.equal(result.status, STATUS_PROVA.INCONCLUSIVO);
  assert.equal(criacoes, 1); assert.equal(limpezas, 1);
  assert.ok(result.codigos.includes('OPERATION_TIMEOUT'));
  assert.ok(result.codigos.includes('REMOVE_DEFINITION_CALL_OK'));
  assert.equal(fake.encerramentos, 1);
});

test('cleanup rejeitado ou pendurado e tentado uma unica vez no finally', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso(), tty = terminal(), original = fake.socket.addLabel, timers = timersRastreados();
  let remocoesAssociacao = 0, remocoesDefinicao = 0;
  fake.socket.removeChatLabel = async () => { remocoesAssociacao++; throw Error('rejeicao sintetica'); };
  fake.socket.addLabel = async (chatId, body) => {
    if (body.deleted === true) { remocoesDefinicao++; return new Promise(() => {}); }
    return original.call(fake.socket, chatId, body);
  };
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, timers,
    connectionTimeoutMs: 100, eventTimeoutMs: 8
  });
  await new Promise(resolvePromise => setImmediate(resolvePromise));
  assert.equal(result.status, STATUS_PROVA.REPROVADO);
  assert.equal(remocoesAssociacao, 1);
  assert.equal(remocoesDefinicao, 1);
  assert.ok(result.codigos.includes('REMOVE_ASSOCIATION_CALL_FAILED'));
  assert.ok(result.codigos.includes('OPERATION_TIMEOUT'));
  assert.ok(result.codigos.includes('ASSOCIATION_CLEANUP_EVENT_MISSING'));
  assert.ok(result.codigos.includes('DEFINITION_CLEANUP_EVENT_MISSING'));
  assert.equal(timers.ativos.size, 0);
  assert.equal(fake.encerramentos, 1);
});

test('negativa no telefone reprova e limpeza nao confirmada preserva o perfil', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso(), tty = terminal();
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts({ visivel: 'NAO', limpo: 'NAO' }), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, connectionTimeoutMs: 100, eventTimeoutMs: 100
  });
  assert.equal(result.status, STATUS_PROVA.REPROVADO);
  assert.ok(result.codigos.includes('PHONE_VISIBLE_NO'));
  assert.ok(result.codigos.includes('PHONE_CLEAN_NO'));
  assert.ok(result.codigos.includes('PROFILE_RETAINED'));
  assert.equal(existsSync(profileDir), true);
});

test('falha local ao apagar perfil impede APROVADO mesmo com todas as provas externas', async t => {
  const profileDir = nomePerfil(); t.after(() => removerSeExiste(profileDir));
  const fake = socketFalso(), tty = terminal();
  const fsFail = {
    ...fs,
    async rm(path, options) {
      if (resolve(path) === resolve(profileDir)) throw Object.assign(Error('bloqueio sintetico'), { code: 'EACCES' });
      return fs.rm(path, options);
    }
  };
  const result = await executarProvaManual({
    profileDir, ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, fs: fsFail,
    connectionTimeoutMs: 100, eventTimeoutMs: 100
  });
  assert.equal(result.status, STATUS_PROVA.INCONCLUSIVO);
  assert.ok(result.codigos.includes('PHONE_CLEAN_OK'));
  assert.ok(result.codigos.includes('PROFILE_RETAINED'));
  assert.equal(existsSync(profileDir), true);
});

test('QR so aparece em TTY e a limpeza nao preserva seu conteudo', async () => {
  const writes = [], tty = { isTTY: true, write: value => writes.push(String(value)) };
  const sink = criarQrTTY(tty, { renderQr: async value => `desenho:${value}` });
  assert.equal(await sink.mostrar('SEGREDO-QR'), true);
  assert.match(writes.join(''), /desenho:SEGREDO-QR/);
  sink.limpar();
  assert.match(writes.at(-1), /\x1b\[2J/);
  let rendered = 0;
  const blocked = criarQrTTY({ isTTY: false, write() {} }, { renderQr: async () => { rendered++; } });
  assert.equal(await blocked.mostrar('SEGREDO-QR'), false);
  assert.equal(rendered, 0);

  let liberar;
  const atrasado = criarQrTTY(tty, { renderQr: () => new Promise(resolvePromise => { liberar = resolvePromise; }) });
  const pending = atrasado.mostrar('QR-ATRASADO');
  atrasado.limpar();
  liberar('desenho:QR-ATRASADO');
  assert.equal(await pending, false);
  assert.doesNotMatch(writes.join(''), /QR-ATRASADO/);
});

test('evidencia usa allowlist, rejeita outro destino e remove payloads sensiveis', async t => {
  const evidencePath = await documentoTemporario(t), other = join(dirname(evidencePath), 'outro.md');
  const payload = {
    status: STATUS_PROVA.APROVADO,
    inicio: '2026-09-19T10:00:00.000Z', fim: '2026-09-19T10:01:00.000Z',
    baileys: '7.0.0-rc14', modalidade: 'CHAT',
    codigos: ['CREATE_CALL_OK', '5511999999999@s.whatsapp.net', 'C:\\segredo\\wa-auth', 'QR-TOKEN-SECRETO'],
    jid: '5511888888888@s.whatsapp.net', qr: 'QR-TOKEN-SECRETO', token: 'cookie-super-secreto'
  };
  const block = blocoEvidencia(payload);
  assert.match(block, /CREATE_CALL_OK/);
  assert.doesNotMatch(block, /5511|segredo|wa-auth|QR-TOKEN|cookie/i);
  await assert.rejects(atualizarEvidencia(payload, { destino: evidencePath, destinoEsperado: other }), { code: 'EVIDENCE_DESTINATION' });
  await atualizarEvidencia(payload, { destino: evidencePath, destinoEsperado: evidencePath });
  const saved = await fs.readFile(evidencePath, 'utf8');
  assert.equal(saved.split(EVIDENCIA_INICIO).length, 2);
  assert.equal(saved.split(EVIDENCIA_FIM).length, 2);
  assert.doesNotMatch(saved, /5511|cookie-super|QR-TOKEN|C:\\segredo/i);
});

test('evidencia recusa symlink em vez de seguir outro arquivo', async t => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'lume-label-alias-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'target.md'), alias = join(dir, 'LUME-3.2-LABELS-PROVA.md');
  await fs.copyFile(DOC, target);
  try {
    await fs.symlink(target, alias, 'file');
    await assert.rejects(
      atualizarEvidencia({ status: STATUS_PROVA.INCONCLUSIVO }, { destino: alias, destinoEsperado: alias }),
      { code: 'EVIDENCE_ALIAS' }
    );
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    const fsAlias = {
      ...fs,
      async lstat(path) {
        const stat = await fs.lstat(path);
        return resolve(path) === resolve(target) ? { ...stat, isFile: () => true, isSymbolicLink: () => true } : stat;
      }
    };
    await assert.rejects(
      atualizarEvidencia({ status: STATUS_PROVA.INCONCLUSIVO }, { destino: target, destinoEsperado: target, fs: fsAlias }),
      { code: 'EVIDENCE_ALIAS' }
    );
  }
  assert.match(await fs.readFile(target, 'utf8'), /\*\*Status:\*\* NAO EXECUTADO/);
});

test('execucao simulada escreve apenas no perfil possuido e na copia prevista do Markdown', async t => {
  const profileDir = nomePerfil(), evidencePath = await documentoTemporario(t), fake = socketFalso(), tty = terminal();
  const operations = [];
  const fsSpy = {
    ...fs,
    async writeFile(path, ...args) { operations.push(['write', resolve(path)]); return fs.writeFile(path, ...args); },
    async rename(from, to) { operations.push(['rename', resolve(from), resolve(to)]); return fs.rename(from, to); },
    async rm(path, ...args) { operations.push(['rm', resolve(path)]); return fs.rm(path, ...args); }
  };
  const result = await executarProvaManual({
    profileDir, evidencePath, expectedEvidencePath: evidencePath,
    ...tty, prompts: prompts(), loadAdapters: fake.loadAdapters,
    qrSink: { async mostrar() {}, limpar() {} }, fs: fsSpy,
    connectionTimeoutMs: 100, eventTimeoutMs: 100
  });
  assert.equal(result.status, STATUS_PROVA.APROVADO);
  const evidenceDir = dirname(evidencePath);
  for (const operation of operations) {
    if (operation[0] === 'write') {
      const allowed = dentro(operation[1], profileDir) ||
        (dirname(operation[1]) === evidenceDir && basename(operation[1]).startsWith('.LUME-3.2-LABELS-PROVA.md.'));
      assert.equal(allowed, true, `escrita inesperada: ${operation[1]}`);
    } else if (operation[0] === 'rename') {
      assert.equal(operation[2], resolve(evidencePath));
      assert.equal(dirname(operation[1]), evidenceDir);
    } else if (operation[0] === 'rm') {
      const allowed = operation[1] === resolve(profileDir) || dirname(operation[1]) === evidenceDir;
      assert.equal(allowed, true, `remocao inesperada: ${operation[1]}`);
    }
  }
  assert.ok(operations.some(row => row[0] === 'rename' && row[2] === resolve(evidencePath)));
});

async function arquivosEm(root) {
  const result = [];
  async function walk(path) {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else result.push(child);
    }
  }
  await walk(root); return result;
}

async function snapshot(paths) {
  const files = [];
  for (const path of paths) {
    const stat = await fs.stat(path);
    if (stat.isDirectory()) files.push(...await arquivosEm(path)); else files.push(path);
  }
  const rows = [];
  for (const file of files.sort()) rows.push(`${relative(ROOT, file)}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`);
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

test('quatro status alteram somente copias temporarias da evidencia, nunca produto ou gates', async t => {
  const protectedPaths = [
    join(ROOT, 'src'), join(ROOT, 'desktop'), join(ROOT, 'package.json'), DOC,
    join(ROOT, 'scripts', 'release-readiness.mjs'), join(ROOT, 'scripts', 'construir-candidato.mjs'),
    join(ROOT, 'scripts', 'preparar-release.mjs'), join(ROOT, 'scripts', 'publicar-release.mjs')
  ];
  const before = await snapshot(protectedPaths);
  for (const status of Object.values(STATUS_PROVA)) {
    const copy = await documentoTemporario(t);
    await atualizarEvidencia({ status, codigos: [] }, { destino: copy, destinoEsperado: copy });
  }
  assert.equal(await snapshot(protectedPaths), before);
});

test('runtime, pacote e gates nao importam, leem nem empacotam a prova', async () => {
  const forbidden = ['provar-whatsapp-labels', 'LUME-3.2-LABELS-PROVA', 'WHATSAPP-LABELS-PROOF'];
  const runtimeFiles = [
    ...await arquivosEm(join(ROOT, 'src')),
    ...await arquivosEm(join(ROOT, 'desktop')),
    ...await arquivosEm(join(ROOT, 'scripts'))
  ].filter(path => basename(path) !== 'provar-whatsapp-labels.mjs');
  for (const file of runtimeFiles) {
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    for (const needle of forbidden) assert.equal(text.includes(needle), false, `${relative(ROOT, file)} referencia ${needle}`);
  }

  const pkg = JSON.parse(await fs.readFile(join(ROOT, 'package.json'), 'utf8'));
  const buildFiles = pkg.build?.files || [];
  assert.equal(buildFiles.includes('scripts/provar-whatsapp-labels.mjs'), false);
  assert.equal(buildFiles.includes('docs/LUME-3.2-LABELS-PROVA.md'), false);
  assert.equal(buildFiles.some(item => /^scripts\/(?:\*|\*\*)/.test(item)), false);
  assert.equal(buildFiles.some(item => /^docs\/(?:\*|\*\*)/.test(item)), false);

  const source = await fs.readFile(join(ROOT, 'scripts', 'provar-whatsapp-labels.mjs'), 'utf8');
  const doc = await fs.readFile(DOC, 'utf8');
  assert.match(doc, /\*\*Status:\*\* NAO EXECUTADO/);
  assert.match(source, /import\('@whiskeysockets\/baileys'\)/);
  assert.doesNotMatch(source, /from\s+['"]\.\.\/(?:src|desktop)\//);
  assert.doesNotMatch(source, /import\(['"]\.\.\/(?:src|desktop)\//);
});

test('a suite nunca chama o adaptador Baileys real', async () => {
  const source = await fs.readFile(import.meta.filename, 'utf8');
  const calls = [...source.matchAll(/executarProvaManual\(\{([\s\S]*?)\n\s*\}\)/g)];
  assert.ok(calls.length >= 6);
  for (const call of calls) assert.match(call[1], /loadAdapters(?:\s*:|\s*[,}])/);
});

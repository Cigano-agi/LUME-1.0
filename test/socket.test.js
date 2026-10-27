import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Browsers } from '@whiskeysockets/baileys';
import { Conexao, identidadeDispositivo } from '../src/transporte/socket.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fake() { return { ev: new EventEmitter(), end() { this.encerrado = true; } }; }
test('entrypoints de producao ligam update e delete ao contexto local', async () => {
  for (const caminho of ['../bin/app.js', '../desktop/service.js']) {
    const codigo=await readFile(new URL(caminho,import.meta.url),'utf8');
    assert.match(codigo,/aoAtualizarMensagens:\s*updates\s*=>[\s\S]{0,100}contexto\.atualizarMensagens\(updates\)/,caminho);
    assert.match(codigo,/aoRemoverMensagens:\s*evento\s*=>[\s\S]{0,100}contexto\.removerMensagens\(evento\)/,caminho);
  }
});
test('pareamento usa a identidade Web compatível com o protocolo',()=>{
  const identidade=identidadeDispositivo(Browsers);
  assert.equal(identidade[1],'Chrome');assert.equal(identidade.length,3);
});
test('inicio unico, QR efemero, lotes ao vivo/historico e parada', async () => {
  const socket = fake(), lotes = []; let chamadas = 0;
  const c = new Conexao({ authDir: 'fake', aoLote: lote => lotes.push(lote), criarSocket: async () => { chamadas++; return socket; } });
  await Promise.all([c.iniciar(), c.iniciar()]); assert.equal(chamadas, 1);
  socket.ev.emit('connection.update', { qr: 'segredo' }); assert.equal(c.estado().qr, 'segredo'); assert.equal(c.estado().qrVersao,1); assert.ok(c.estado().qrGeradoEm);
  socket.ev.emit('connection.update', { qr: 'segredo' }); assert.equal(c.estado().qrVersao,1);
  socket.ev.emit('connection.update', { qr: 'segredo-novo' }); assert.equal(c.estado().qrVersao,2);
  socket.ev.emit('connection.update', { connection: 'open' }); assert.equal(c.estado().estado, 'conectada'); assert.equal(c.estado().qr, null); assert.equal(c.estado().qrGeradoEm,null);
  socket.ev.emit('messages.upsert', { messages: [{ key: { id: '1' } }], type: 'notify' });
  socket.ev.emit('messaging-history.set', { messages: [{ key: { id: '2' } }] }); await tick();
  assert.deepEqual(lotes.map(l => l.type), ['notify', 'history']); assert.ok(c.estado().ultimaRecepcaoEm);
  await c.parar(); socket.ev.emit('connection.update', { qr: 'velho' }); socket.ev.emit('messages.upsert', { messages: [{}] }); await tick();
  assert.equal(c.estado().estado, 'desconectada'); assert.equal(c.estado().qr, null); assert.equal(lotes.length, 2); assert.ok(socket.encerrado);
});
test('messages.update com conteudo segue a fila de ingestao e recibos sao ignorados', async () => {
  const socket = fake(), ordem = []; let liberarLote;
  const c = new Conexao({
    authDir: 'fake',
    criarSocket: async () => socket,
    aoLote: () => new Promise(resolve => { ordem.push('lote'); liberarLote = resolve; }),
    aoAtualizarMensagens: updates => ordem.push(`update:${updates[0].key.id}`)
  });
  await c.iniciar();
  socket.ev.emit('messages.upsert', {messages: [{key: {id: 'antes'}}], type: 'notify'});
  socket.ev.emit('messages.update', [{key: {remoteJid: 'chat@s.whatsapp.net', id: 'editada'}, update: {message: {conversation: 'novo'}}}]);
  socket.ev.emit('messages.update', [{key: {remoteJid: 'chat@s.whatsapp.net', id: 'recibo'}, update: {status: 3}}]);
  await tick();
  assert.deepEqual(ordem, ['lote']);
  liberarLote(); await tick();
  assert.deepEqual(ordem, ['lote', 'update:editada']);
  await c.parar();
  assert.equal(socket.ev.listenerCount('messages.update'), 0);
});
test('messages.delete segue a mesma fila, remove listeners e diagnostica falha sem payload', async () => {
  const socket = fake(), ordem = [], diagnosticos = []; let liberarUpdate;
  const c = new Conexao({
    authDir: 'fake', criarSocket: async () => socket, aoLote() {},
    aoAtualizarMensagens: () => new Promise(resolve => { ordem.push('update'); liberarUpdate = resolve; }),
    aoRemoverMensagens: evento => { ordem.push(`delete:${evento.keys[0].id}`); throw Error('jid-secreto@s.whatsapp.net texto privado'); },
    aoDiagnostico: evento => diagnosticos.push(evento)
  });
  await c.iniciar();
  socket.ev.emit('messages.update', [{key: {remoteJid: 'chat@s.whatsapp.net', id: 'edit'}, update: {message: {conversation: 'novo'}}}]);
  socket.ev.emit('messages.delete', {keys: [{remoteJid: 'chat@s.whatsapp.net', id: 'apagada'}]});
  await tick(); assert.deepEqual(ordem, ['update']);
  liberarUpdate(); await tick();
  assert.deepEqual(ordem, ['update', 'delete:apagada']);
  assert.deepEqual(diagnosticos, [{evento: 'messages_delete_falhou', codigo: 'CICLO_MENSAGEM_FALHA'}]);
  assert.doesNotMatch(JSON.stringify(c.estado()), /jid-secreto|texto privado/);
  await c.parar();
  assert.equal(socket.ev.listenerCount('messages.delete'), 0);
});
test('lotes carregam identificadores normalizados da própria conta sem expor credencial',async()=>{
  const socket=fake(),lotes=[];socket.user={id:'5511999999999:17@s.whatsapp.net',lid:'123456:3@lid',name:'Nome privado'};
  const c=new Conexao({authDir:'fake',aoLote:lote=>lotes.push(lote),criarSocket:async()=>socket});
  await c.iniciar();socket.ev.emit('messages.upsert',{messages:[{key:{id:'1'}}],type:'notify'});await tick();
  assert.deepEqual(lotes[0].donoJids,['5511999999999@s.whatsapp.net','123456@lid']);
  assert.equal(JSON.stringify(lotes[0]).includes('Nome privado'),false);await c.parar();
});
test('parada durante fabrica pendente descarta socket', async () => {
  let liberar; const socket = fake();
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: () => new Promise(resolve => { liberar = resolve; }) });
  const inicio = c.iniciar(); await tick(); await c.parar(); liberar(socket); await inicio;
  assert.ok(socket.encerrado); assert.equal(c.estado().estado, 'desconectada'); assert.equal(socket.ev.listenerCount('messages.upsert'), 0);
});
test('auth invalida terminal; restart requerido reconecta e ignora socket antigo', async () => {
  const sockets = [];
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: async () => { const s = fake(); sockets.push(s); return s; } });
  await c.iniciar(); sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(sockets.length, 2);
  sockets[0].ev.emit('connection.update', { qr: 'velho' }); assert.equal(c.estado().qr, null);
  sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(c.estado().estado, 'auth_invalida'); await c.parar();
});
test('fechamento expõe só código e tentativas, sem mensagem ou identidade privada', async () => {
  const socket=fake();
  const c=new Conexao({authDir:'fake',aoLote(){},criarSocket:async()=>socket});
  await c.iniciar();
  socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{
    output:{statusCode:401},message:'5511999999999@s.whatsapp.net token-privado caminho C:/segredo'
  }}});
  const estado=c.estado();
  assert.equal(estado.estado,'auth_invalida');
  assert.equal(estado.ultimoFechamento?.codigo,401);
  assert.equal(estado.ultimoFechamento?.tentativas,0);
  assert.ok(estado.ultimoFechamento?.em);
  assert.doesNotMatch(JSON.stringify(estado),/5511999999999|token-privado|C:\/segredo/);
  await c.parar();
});
test('falha de ingestao observavel sem rejeicao solta', async () => {
  const socket = fake(); const c = new Conexao({ authDir: 'fake', criarSocket: async () => socket, aoLote: async () => { throw Error('conteudo privado'); } });
  await c.iniciar(); socket.ev.emit('messages.upsert', { messages: [{}] }); await tick();
  assert.match(c.estado().erro, /ingest/i); assert.doesNotMatch(c.estado().erro, /privado/); await c.parar();
});
test('lote aceito antes da desconexao continua sendo ingerido', async () => {
  const socket = fake(), lotes = [];
  const c = new Conexao({ authDir: 'fake', criarSocket: async () => socket, aoLote: lote => lotes.push(lote) });
  await c.iniciar(); socket.ev.emit('messages.upsert', { messages: [{ key: { id: 'ultimo' } }] });
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await tick(); assert.equal(lotes.length, 1); await c.parar();
});
test('reconexao transitoria limitada e parada cancela timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const sockets = [];
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: async () => { const s = fake(); sockets.push(s); return s; } });
  await c.iniciar(); sockets[0].ev.emit('connection.update',{qr:'codigo-que-vai-vencer'});
  for (const espera of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const quantidade = sockets.length;
    sockets.at(-1).ev.emit('connection.update', { connection: 'close' });
    assert.equal(c.estado().qr,null);assert.equal(c.estado().qrGeradoEm,null);
    t.mock.timers.tick(espera - 1); await tick(); assert.equal(sockets.length, quantidade);
    t.mock.timers.tick(1); await tick(); assert.equal(sockets.length, quantidade + 1);
  }
  sockets.at(-1).ev.emit('connection.update', { connection: 'close' });
  const quantidade = sockets.length; await c.parar(); t.mock.timers.tick(60000); await tick(); assert.equal(sockets.length, quantidade);
});
test('lease de sessao impede segundo processo e libera ao concluir', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { bloquearSessao } = await import('../src/transporte/sessao.js');
  const dir = await mkdtemp(join(tmpdir(), 'assessor-socket-'));
  try { const liberar = await bloquearSessao(dir); await assert.rejects(bloquearSessao(dir), /ocupada/); await liberar(); await liberar(); const outra = await bloquearSessao(dir); await outra(); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
test('lease recupera trava de processo comprovadamente encerrado', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process'); const { bloquearSessao } = await import('../src/transporte/sessao.js');
  const dir = await mkdtemp(join(tmpdir(), 'assessor-stale-')); const encerrado = spawnSync(process.execPath, ['-e', '']).pid;
  try { await writeFile(join(dir, '.assessor.lock'), String(encerrado)); const liberar = await bloquearSessao(dir); await liberar(); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('restartRequired repetido tambem respeita backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const sockets = [];
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: async () => { const s = fake(); sockets.push(s); return s; } });
  const fechar = () => sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
  await c.iniciar(); fechar(); t.mock.timers.tick(0); await tick(); assert.equal(sockets.length, 2);
  fechar(); t.mock.timers.tick(0); await tick(); assert.equal(sockets.length, 2);
  t.mock.timers.tick(2000); await tick(); assert.equal(sockets.length, 3); await c.parar();
});
test('nova tentativa arquiva auth invalida, mas nao conexao substituida', async () => {
  const sockets = [], recuperadas = [];
  const c = new Conexao({ authDir: 'fake', aoLote() {}, recuperarSessao: async dir => recuperadas.push(dir), criarSocket: async () => { const s = fake(); sockets.push(s); return s; } });
  await c.iniciar(); sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await c.parar(); await Promise.all([c.iniciar(), c.iniciar()]); assert.deepEqual(recuperadas, ['fake']); assert.equal(sockets.length, 2);
  sockets[1].ev.emit('connection.update', { qr: 'novo' }); assert.equal(c.estado().qr, 'novo');
  sockets[1].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 440 } } } });
  await c.iniciar(); assert.equal(recuperadas.length, 1); await c.parar();
});
test('inicio espera parada drenar ingestao e nao recebe estado desconectada atrasado', async () => {
  let concluir; const sockets = [];
  const c = new Conexao({ authDir: 'fake', aoLote: () => new Promise(resolve => { concluir = resolve; }), criarSocket: async () => { const s = fake(); sockets.push(s); return s; } });
  await c.iniciar(); sockets[0].ev.emit('messages.upsert', { messages: [{}] }); await tick();
  const parada = c.parar(); const inicio = c.iniciar(); await tick(); assert.equal(sockets.length, 1);
  concluir(); await Promise.all([parada, inicio]); assert.equal(sockets.length, 2);
  sockets[1].ev.emit('connection.update', { connection: 'open' }); assert.equal(c.estado().estado, 'conectada'); await c.parar();
});
test('inicio aguarda fabrica anterior cancelada antes de criar novo socket', async () => {
  let concluir; const sockets = [];
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: () => { const s = fake(); sockets.push(s); return sockets.length === 1 ? new Promise(resolve => { concluir = () => resolve(s); }) : s; } });
  const primeiro = c.iniciar(); await tick(); await c.parar(); const segundo = c.iniciar(); await tick(); assert.equal(sockets.length, 1);
  concluir(); await Promise.all([primeiro, segundo]); assert.equal(sockets.length, 2); assert.ok(sockets[0].encerrado); await c.parar();
});
test('arquivo de auth invalida preserva conteudo em pasta irma', async () => {
  const fs = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join, dirname } = await import('node:path');
  const { arquivarSessaoInvalida } = await import('../src/transporte/sessao.js');
  const raiz = await fs.mkdtemp(join(tmpdir(), 'assessor-invalid-')); const dir = join(raiz, 'auth');
  try { await fs.mkdir(dir); await fs.writeFile(join(dir, 'creds.json'), 'sintetico'); const destino = await arquivarSessaoInvalida(dir); assert.equal(dirname(destino), raiz); assert.equal(await fs.readFile(join(destino, 'creds.json'), 'utf8'), 'sintetico'); await assert.rejects(fs.stat(dir), { code: 'ENOENT' }); }
  finally { await fs.rm(raiz, { recursive: true, force: true }); }
});
test('conexao propaga sincronizacao e eventos de grupos', async () => {
  const socket = fake();
  socket.groupFetchAllParticipating = async () => ({
    'g1@g.us': { id: 'g1@g.us', subject: 'Grupo Teste', participants: [] }
  });
  const recebidos = [];
  const c = new Conexao({
    authDir: 'fake',
    aoLote() {},
    aoGrupos: g => recebidos.push(g),
    criarSocket: async () => socket
  });
  await c.iniciar();
  socket.ev.emit('connection.update', { connection: 'open' });
  const res = await c.sincronizarGrupos();
  assert.ok(res['g1@g.us']);
  assert.equal(recebidos.length, 1);
  socket.ev.emit('groups.upsert', [{ id: 'g2@g.us', subject: 'Outro' }]);
  await tick();
  assert.equal(recebidos.length, 2);
  await c.parar();
});
test('falhas de callbacks de grupos ficam visiveis sem escapar do emitter', async () => {
  const socket = fake(); let falhar = true;
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: async () => socket, aoGrupos() { if (falhar) throw Error('privado'); } });
  await c.iniciar();
  for (const evento of ['groups.upsert', 'groups.update']) {
    assert.doesNotThrow(() => socket.ev.emit(evento, [{ id: 'g@g.us' }])); await tick();
    assert.match(c.estado().erroGrupos, /grupos/i); assert.doesNotMatch(c.estado().erroGrupos, /privado/);
  }
  falhar = false; socket.ev.emit('groups.update', []); await tick(); assert.equal(c.estado().erroGrupos, null); await c.parar();
});
test('sync manual rejeita falha remota e de persistencia com erro seguro', async () => {
  const socket = fake(); socket.groupFetchAllParticipating = async () => { throw Error('token privado'); };
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: async () => socket, aoGrupos: async () => { throw Error('banco privado'); } });
  await assert.rejects(c.sincronizarGrupos(), { code: 'GRUPOS_INDISPONIVEIS' });
  await c.iniciar(); socket.ev.emit('connection.update', { connection: 'open' });
  await assert.rejects(c.sincronizarGrupos(), { code: 'GRUPOS_FALHA', message: 'Falha ao sincronizar grupos WhatsApp' });
  assert.match(c.estado().erroGrupos, /grupos/);
  socket.groupFetchAllParticipating = async () => ({});
  await assert.rejects(c.sincronizarGrupos(), { code: 'GRUPOS_FALHA' }); await c.parar();
});
test('parada drena callback de grupos ja iniciado', async () => {
  const socket = fake(); let liberar; let parou = false;
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: async () => socket, aoGrupos: () => new Promise(resolve => { liberar = resolve; }) });
  await c.iniciar(); socket.ev.emit('groups.upsert', []); await tick();
  const parada = c.parar().then(() => { parou = true; }); await tick(); assert.equal(parou, false);
  liberar(); await parada; assert.equal(parou, true);
});
test('metadata atrasada apos reconexao nao persiste nem altera estado', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const sockets = []; const recebidos = []; let liberar;
  const c = new Conexao({ authDir: 'fake', aoLote() {}, aoGrupos: g => recebidos.push(g), criarSocket: async () => { const socket = fake(); socket.groupMetadata = () => new Promise(resolve => { liberar = resolve; }); sockets.push(socket); return socket; } });
  await c.iniciar(); sockets[0].ev.emit('group-participants.update', { id: 'g@g.us' }); await tick();
  sockets[0].ev.emit('connection.update', { connection: 'close' }); t.mock.timers.tick(1000); await tick(); assert.equal(sockets.length, 2);
  liberar({ id: 'g@g.us' }); await tick(); assert.equal(recebidos.length, 0); assert.equal(c.estado().erroGrupos, null); await c.parar();
});
test('sync atrasada apos parada rejeita cancelamento e nao persiste', async () => {
  const socket = fake(); let liberar; const recebidos = [];
  socket.groupFetchAllParticipating = () => new Promise(resolve => { liberar = resolve; });
  const c = new Conexao({ authDir: 'fake', aoLote() {}, criarSocket: async () => socket, aoGrupos: g => recebidos.push(g) });
  await c.iniciar(); socket.ev.emit('connection.update', { connection: 'open' });
  const sync = c.sincronizarGrupos(); const rejeicao = assert.rejects(sync, { code: 'GRUPOS_CANCELADOS' }); await tick();
  const parada = c.parar(); liberar({ 'g@g.us': { id: 'g@g.us' } }); await Promise.all([parada, rejeicao]);
  assert.equal(recebidos.length, 0); assert.equal(c.estado().erroGrupos, null);
});

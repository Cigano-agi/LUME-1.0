import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

test('utility real corta, confirma ACK, drena, emite recibo e sai zero', async () => {
  const tempRoot = realpathSync(tmpdir());
  const prefix = 'lume-maintenance-service-';
  const profile = mkdtempSync(join(tempRoot, prefix));
  const removeFixture = () => {
    const target = realpathSync(profile);
    if (dirname(target) !== tempRoot || !basename(target).startsWith(prefix)) {
      throw new Error('fixture fora do diretório temporário isolado');
    }
    rmSync(target, { recursive: true, force: true });
  };
  const bootstrap = `
    import {EventEmitter} from 'node:events';
    import {pathToFileURL} from 'node:url';
    import {resolve} from 'node:path';
    const port = new EventEmitter();
    port.postMessage = message => process.stdout.write('PORT:' + JSON.stringify(message) + '\\n');
    process.parentPort = port;
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buffer += chunk; let end;
      while ((end = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        port.emit('message', {data: JSON.parse(line)});
      }
    });
    process.stdin.resume();
    await import(pathToFileURL(resolve('desktop/service.js')));
  `;
  let child;
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: process.cwd(),
      env: { ...process.env, ASSESSOR_DESKTOP_USER_DATA: profile,
        ASSESSOR_DESKTOP_PROFILE_ID: 'legado', ASSESSOR_DESKTOP_PROFILE_GENERATION: '',
        ASSESSOR_DESKTOP_DATA: join(profile, 'data') },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    });
  } catch (error) {
    removeFixture();
    throw error;
  }
  let spawnError;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const perfil = { tipo: 'legado', id: 'legado', geracao: null };
  const opId = '11111111-1111-4111-8111-111111111111';
  const cut = { tipo: 'intake-cut-pedido', boot: 'boot-1', pedido: 'cut-1', perfil, opId };
  const shutdown = { tipo: 'shutdown-pedido', boot: 'boot-1', pedido: 'shutdown-1', perfil,
    motivo: 'manutencao', opId };
  const messages = [];
  let buffer = '', stderr = '';
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.startsWith('PORT:')) continue;
      const message = JSON.parse(line.slice(5)); messages.push(message);
      if (message.tipo === 'pronto') send(cut);
      if (message.tipo === 'intake-cut-ack') send(shutdown);
      if (message.tipo === 'shutdown-recibo') send({ tipo: 'shutdown-ack', boot: shutdown.boot,
        pedido: shutdown.pedido, perfil, motivo: 'manutencao', opId });
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const timeout = setTimeout(() => child.kill(), 15000);
  let deadline;
  let closeObserved = false;
  const closeResult = closed.then(result => { closeObserved = true; return result; });
  try {
    const exit = await Promise.race([
      closeResult,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('utility não fechou pipes após kill')), 25000);
      })
    ]);
    if (spawnError) throw spawnError;
    assert.equal(exit.code, 0, stderr);
    assert.equal(exit.signal, null);
    const ciclo = messages.filter(m => ['pronto','intake-cut-ack','shutdown-recibo'].includes(m.tipo));
    assert.deepEqual(ciclo.map(m => m.tipo), ['pronto','intake-cut-ack','shutdown-recibo']);
    assert.deepEqual(ciclo[1], { tipo: 'intake-cut-ack', boot: cut.boot, pedido: cut.pedido, perfil, opId });
    assert.deepEqual(ciclo[2], { tipo: 'shutdown-recibo', boot: shutdown.boot, pedido: shutdown.pedido,
      perfil, motivo: 'manutencao', opId });
  } finally {
    clearTimeout(timeout);
    clearTimeout(deadline);
    if (!closeObserved) {
      child.kill();
      await Promise.race([closeResult, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    if (closeObserved) removeFixture();
  }
});

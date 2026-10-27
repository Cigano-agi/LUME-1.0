import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrirBanco } from '../src/banco.js';
import { Semantica } from '../src/semantica.js';
import { criarServidor } from '../src/painel/servidor.js';
import { Server } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { DesktopIA } from '../src/desktop-ia.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('review: falha da tarefa concluida nao torna liberacao semantica malsucedida', async t => {
  const db = abrirBanco();
  t.after(() => db.close());
  new ContextoApp(db); new Desktop(db); new DesktopIA(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('equipe', 'Equipe');
  db.prepare('INSERT INTO desktop_ia_conversas VALUES(?,?,?)').run('equipe', 1, '2026-09-17');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('equipe','fonte','entrada','texto','{}','Revisar contrato','2026-09-17T12:00:00Z','2026-09-17','minha')`).run();
  const inference = deferred();
  const entered = deferred();
  const sem = new Semantica(db, { extrair: () => { entered.resolve(); return inference.promise; } });
  await sem.ativar();
  const job = sem.indexar();
  await entered.promise;
  const failedJob = assert.rejects(job, /falha da tarefa/);
  const drain = sem.encerrar();
  inference.reject(new Error('falha da tarefa'));
  await failedJob;
  await drain;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM desktop_vetores').get().n, 0);
});

test('review: listen e encerrar na mesma volta nao deixam listener aberto', async t => {
  const db = abrirBanco();
  const server = criarServidor(db);
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => Server.prototype.close.call(server, error => error ? reject(error) : resolve()));
    db.close();
  });
  server.listen(0, '127.0.0.1');
  await server.encerrar();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(server.listening, false);
  assert.equal(server.address(), null);
});

test('review: service real atende shutdown com perfil temporario e parentPort sintetico', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'lume-drain-service-review-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const bootstrap = `
    import {EventEmitter} from 'node:events';
    import {pathToFileURL} from 'node:url';
    import {resolve} from 'node:path';
    const port = new EventEmitter();
    port.postMessage = message => process.stdout.write('PORT:' + JSON.stringify(message) + '\\n');
    process.parentPort = port;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => { if (data.includes('shutdown')) port.emit('message', {data:'shutdown'}); });
    process.stdin.resume();
    await import(pathToFileURL(resolve('desktop/service.js')));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: process.cwd(),
    env: { ...process.env, ASSESSOR_DESKTOP_USER_DATA: profile,
      ASSESSOR_DESKTOP_PROFILE_ID: 'legado', ASSESSOR_DESKTOP_PROFILE_GENERATION: '',
      ASSESSOR_DESKTOP_DATA: join(profile, 'data') },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '', errors = '', ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('"tipo":"pronto"')) ready(); });
  child.stderr.on('data', chunk => { errors += chunk; });
  const exitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const timeout = setTimeout(() => child.kill(), 10000);
  try {
    const first = await Promise.race([readyPromise.then(() => 'ready'), exitPromise.then(() => 'exited')]);
    assert.equal(first, 'ready', `service nao iniciou: ${errors}`);
    child.stdin.write('shutdown\n');
    const exit = await exitPromise;
    assert.equal(exit.code, 0, `service nao encerrou: ${errors}`);
    assert.equal(exit.signal, null);
    assert.doesNotMatch(errors, /Falha ao encerrar o Lume/);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
});

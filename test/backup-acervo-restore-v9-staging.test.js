import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { gravarPacote } from '../src/backup-stream.js';
import { verificarPacote } from '../src/backup-stream.js';
import { validarAcervoV9, descartarPlanoV9, inspecionarPlanoV9, aplicarAcervoV9 } from '../src/backup-acervo-restore-v9.js';
import { recuperarAreasStagingV9 } from '../src/backup-staging-v9.js';

const senha = 'senha sintética de staging';

async function observarPrimeiroPlaintext(pacote, raiz, action) {
  const probe = await open(pacote, 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const original = proto.write;
  let observed = false;
  proto.write = async function(...args) {
    if (!observed) {
      const own = await this.stat({ bigint: true });
      for (const area of await readdir(raiz)) {
        if (!area.startsWith('.lume-restore-')) continue;
        const base = path.join(raiz, area);
        for (const name of await readdir(base)) {
          if (!name.startsWith('.lume-stream-')) continue;
          const content = path.join(base, name, 'conteudo.bin');
          const st = await lstat(content, { bigint: true }).catch(() => null);
          if (st?.dev !== own.dev || st.ino !== own.ino) continue;
          const journal = (await readFile(path.join(base, 'manifesto.json'), 'utf8')).trim().split('\n').map(JSON.parse);
          assert.ok(journal.some(row => row.name === `${name}/conteudo.bin` && row.ino === st.ino.toString()));
          observed = true;
          const result = await original.apply(this, args);
          await action(base);
          return result;
        }
      }
    }
    return original.apply(this, args);
  };
  return { restore: () => { proto.write = original; }, observed: () => observed };
}

function criarColetorLimitado(limite, marcador = '') {
  let texto = '';
  let borda = '';
  let encontrou = false;
  return {
    adicionar(bytes) {
      const chunk = String(bytes);
      texto = (texto + chunk).slice(-limite);
      if (marcador && !encontrou) {
        const candidato = borda + chunk;
        encontrou = candidato.includes(marcador);
        borda = marcador.length > 1 ? candidato.slice(1 - marcador.length) : '';
      }
      return encontrou;
    },
    get texto() { return texto; },
    get encontrou() { return encontrou; },
  };
}

test('restore gerido inventaria plaintext e SQLite e descarta área inteira', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  try {
    f.db.close();
    await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    await assert.rejects(verificarPacote({ pacote, pastaStaging: raizStaging, senha,
      areaStaging: Object.freeze({ caminho: raizStaging, criarPastaStream() { throw Error('forjada'); } }) }), { code: 'AREA_INVALIDA' });
    assert.deepEqual(await readdir(raizStaging), []);
    const result = await validarAcervoV9({ pacote, senha, raizStaging });
    assert.ok(inspecionarPlanoV9(result.plano).resumo);
    const [area] = await readdir(raizStaging);
    const journal = (await readFile(path.join(raizStaging, area, 'manifesto.json'), 'utf8')).trim().split('\n').map(JSON.parse);
    const names = journal.slice(1).map(item => item.name);
    assert.ok(names.some(name => name.endsWith('/conteudo.bin')));
    for (const name of ['acervo.sqlite', 'acervo.sqlite-wal', 'acervo.sqlite-shm']) assert.ok(names.includes(name), name);
    const dbStat = await lstat(path.join(raizStaging, area, 'acervo.sqlite'), { bigint: true });
    const dbRecord = journal.find(item => item.name === 'acervo.sqlite');
    assert.equal(dbRecord.ino, dbStat.ino.toString());
    const other = await validarAcervoV9({ pacote, senha, raizStaging });
    assert.ok(inspecionarPlanoV9(other.plano).resumo);
    assert.equal((await descartarPlanoV9(other.plano)).limpezaPendente, false);
    const receipt = await descartarPlanoV9(result.plano);
    assert.equal(receipt.limpezaPendente, false);
    assert.deepEqual(await readdir(raizStaging), []);
  } finally { await f.close(); }
});

test('processo filho encerra após restore gerido e outro processo recupera inventário', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    const modulo = new URL('../src/backup-acervo-restore-v9.js', import.meta.url).href;
    const script = `import { validarAcervoV9 } from ${JSON.stringify(modulo)};
await validarAcervoV9({ pacote: process.argv[1], senha: process.argv[2], raizStaging: process.argv[3] });
process.exit(0);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, pacote, senha, raizStaging], { timeout: 120000, windowsHide: true, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const [area] = await readdir(raizStaging);
    const journal = (await readFile(path.join(raizStaging, area, 'manifesto.json'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(journal.some(item => item.name === 'acervo.sqlite'));
    const receipt = await recuperarAreasStagingV9({ raizStaging });
    assert.equal(receipt.limpezaPendente, false);
    assert.deepEqual(await readdir(raizStaging), []);
  } finally { await f.close(); }
});

test('coletor do supervisor limita muitas chunks e reconhece marcador dividido', () => {
  const stdout = criarColetorLimitado(32, 'PLAINTEXT_WRITTEN');
  const stderr = criarColetorLimitado(32);
  for (let i = 0; i < 10000; i++) {
    stdout.adicionar('x'.repeat(40));
    stderr.adicionar('erro'.repeat(20));
  }
  assert.equal(stdout.texto.length, 32);
  assert.equal(stderr.texto.length, 32);
  assert.equal(stdout.encontrou, false);
  stdout.adicionar('PLAINTEXT_');
  stdout.adicionar('WRITTEN');
  assert.equal(stdout.encontrou, true);
  stdout.adicionar('ruído'.repeat(100));
  assert.equal(stdout.encontrou, true);
  assert.equal(stdout.texto.length, 32);
});

test('crash após primeira escrita plaintext confirma diário prévio e recuperação', { timeout: 120000 }, async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  let child; let childClosed = false;
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    const modulo = new URL('../src/backup-acervo-restore-v9.js', import.meta.url).href;
    const script = `import { open, readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[3];
const probe = await open(process.argv[1], 'r');
const proto = Object.getPrototypeOf(probe);
await probe.close();
const original = proto.write;
let held = false;
proto.write = async function(...args) {
  if (!held) {
    const own = await this.stat({ bigint: true });
    for (const area of await readdir(root)) {
      if (!area.startsWith('.lume-restore-')) continue;
      const base = path.join(root, area);
      for (const name of await readdir(base)) {
        if (!name.startsWith('.lume-stream-')) continue;
        const content = path.join(base, name, 'conteudo.bin');
        const st = await lstat(content, { bigint: true }).catch(() => null);
        if (st?.ino !== own.ino || st.dev !== own.dev) continue;
        const rows = (await readFile(path.join(base, 'manifesto.json'), 'utf8')).trim().split('\\n').map(JSON.parse);
        if (!rows.some(row => row.name === name + '/conteudo.bin' && row.ino === st.ino.toString())) throw Error('plaintext sem diário');
        held = true;
        await original.apply(this, args);
        process.stdout.write('PLAINTEXT_WRITTEN\\n');
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    }
  }
  return original.apply(this, args);
};
const { validarAcervoV9 } = await import(${JSON.stringify(modulo)});
await validarAcervoV9({ pacote: process.argv[1], senha: process.argv[2], raizStaging: root });`;
    child = spawn(process.execPath, ['--input-type=module', '-e', script, pacote, senha, raizStaging], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('close', () => { childClosed = true; });
    const closed = once(child, 'close');
    const stderr = criarColetorLimitado(4096);
    const stdout = criarColetorLimitado(4096, 'PLAINTEXT_WRITTEN');
    child.stderr.on('data', bytes => { stderr.adicionar(bytes); });
    const marker = new Promise((resolve, reject) => {
      child.stdout.on('data', bytes => { if (stdout.adicionar(bytes)) resolve('PLAINTEXT_WRITTEN'); });
      child.on('error', reject);
      child.on('close', () => { if (!stdout.encontrou) reject(Error(`filho encerrou antes da escrita: ${stderr.texto}`)); });
    });
    let timer;
    let ready;
    try {
      ready = await Promise.race([
        marker,
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('filho sem plaintext')), 60000); }),
      ]);
    } finally { clearTimeout(timer); }
    assert.match(ready, /PLAINTEXT_WRITTEN/);
    assert.equal(child.exitCode, null);
    const [area] = await readdir(raizStaging);
    const rows = (await readFile(path.join(raizStaging, area, 'manifesto.json'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(row => row.name?.endsWith('/conteudo.bin')));
    child.kill('SIGKILL'); await closed;
    assert.equal((await recuperarAreasStagingV9({ raizStaging })).limpezaPendente, false);
    assert.deepEqual(await readdir(raizStaging), []);
  } finally {
    if (child && !childClosed) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; }
    await f.close();
  }
});

test('expiração e descarte com objeto desconhecido preservam capacidade para retry', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    const result = await validarAcervoV9({ pacote, senha, raizStaging });
    const [area] = await readdir(raizStaging);
    const extra = path.join(raizStaging, area, 'desconhecido');
    await writeFile(extra, 'não remover');
    const now = Date.now;
    try {
      Date.now = () => now() + 6 * 60 * 1000;
      await assert.rejects(aplicarAcervoV9({ plano: result.plano, confirmarMeuBackup: true }), { code: 'PLANO_INVALIDO' });
      assert.throws(() => inspecionarPlanoV9(result.plano), { code: 'PLANO_INVALIDO' });
    } finally { Date.now = now; }
    const first = await descartarPlanoV9(result.plano);
    assert.equal(first.limpezaPendente, true);
    assert.ok(first.codigos.includes('OBJETO_EXTRA'));
    assert.equal(await readFile(extra, 'utf8'), 'não remover');
    assert.throws(() => inspecionarPlanoV9(result.plano), { code: 'PLANO_INVALIDO' });
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, true);
    await unlink(extra);
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, false);
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, false);
    assert.deepEqual(await readdir(raizStaging), []);
  } finally { await f.close(); }
});

test('DB trocado não é adotado e identidade original permite retry', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    const result = await validarAcervoV9({ pacote, senha, raizStaging });
    const [area] = await readdir(raizStaging);
    const db = path.join(raizStaging, area, 'acervo.sqlite');
    const antigo = `${db}.antigo`;
    await rename(db, antigo);
    await writeFile(db, 'substituto');
    assert.throws(() => inspecionarPlanoV9(result.plano), { code: 'PLANO_INVALIDO' });
    const receipt = await descartarPlanoV9(result.plano);
    assert.equal(receipt.limpezaPendente, true);
    assert.ok(receipt.codigos.includes('IDENTIDADE_DIVERGENTE'));
    assert.equal(await readFile(db, 'utf8'), 'substituto');
    await unlink(db);
    await rename(antigo, db);
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, false);
    assert.deepEqual(await readdir(raizStaging), []);
  } finally { await f.close(); }
});

test('pasta stream trocada recusa inspeção mesmo com inode do conteúdo original', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    const result = await validarAcervoV9({ pacote, senha, raizStaging });
    const [area] = await readdir(raizStaging);
    const base = path.join(raizStaging, area);
    const stream = (await readdir(base)).find(name => name.startsWith('.lume-stream-'));
    const original = path.join(base, stream);
    const old = path.join(base, 'pasta-antiga');
    await rename(original, old);
    await mkdir(original);
    await rename(path.join(old, 'conteudo.bin'), path.join(original, 'conteudo.bin'));
    assert.throws(() => inspecionarPlanoV9(result.plano), { code: 'PLANO_INVALIDO' });
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, true);
    await rename(path.join(original, 'conteudo.bin'), path.join(old, 'conteudo.bin'));
    const { rmdir } = await import('node:fs/promises');
    await rmdir(original);
    await rename(old, original);
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, false);
  } finally { await f.close(); }
});

test('oráculo readOnly externo não concede propriedade de novos sidecars', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    const result = await validarAcervoV9({ pacote, senha, raizStaging });
    const [area] = await readdir(raizStaging);
    const db = path.join(raizStaging, area, 'acervo.sqlite');
    const observer = new DatabaseSync(db, { readOnly: true });
    observer.prepare('SELECT count(*) AS n FROM eventos').get();
    observer.close();
    const receipt = await descartarPlanoV9(result.plano);
    assert.equal(receipt.limpezaPendente, true);
    assert.ok(receipt.codigos.includes('IDENTIDADE_DIVERGENTE'));
  } finally { await f.close(); }
});

test('falha de schema após plaintext preserva desconhecido e permite nova tentativa', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  let hook;
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    hook = await observarPrimeiroPlaintext(pacote, raizStaging, base => writeFile(path.join(base, 'acervo.sqlite'), 'desconhecido'));
    await assert.rejects(validarAcervoV9({ pacote, senha, raizStaging }), error =>
      error.limpezaPendente === true && error.codigosLimpeza.includes('OBJETO_EXTRA') && !error.message.includes(raizStaging));
    assert.equal(hook.observed(), true);
    hook.restore(); hook = null;
    const [area] = await readdir(raizStaging);
    const extra = path.join(raizStaging, area, 'acervo.sqlite');
    assert.equal(await readFile(extra, 'utf8'), 'desconhecido');
    await unlink(extra);
    const result = await validarAcervoV9({ pacote, senha, raizStaging });
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, false);
    assert.deepEqual(await readdir(raizStaging), []);
  } finally { hook?.restore(); await f.close(); }
});

test('abort após primeira escrita plaintext fecha handle e limpa inventário', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  const controller = new AbortController();
  let hook;
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    hook = await observarPrimeiroPlaintext(pacote, raizStaging, async () => controller.abort());
    await assert.rejects(validarAcervoV9({ pacote, senha, raizStaging, signal: controller.signal }), error =>
      error.limpezaPendente === false && !error.message.includes(raizStaging));
    assert.equal(hook.observed(), true);
    assert.deepEqual(await readdir(raizStaging), []);
  } finally { hook?.restore(); await f.close(); }
});

test('segunda validação simultânea da mesma raiz recusa antes de criar área', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  let hook; let release;
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    const reached = Promise.withResolvers();
    const gate = new Promise(resolve => { release = resolve; });
    hook = await observarPrimeiroPlaintext(pacote, raizStaging, async () => { reached.resolve(); await gate; });
    const first = validarAcervoV9({ pacote, senha, raizStaging });
    await reached.promise;
    await assert.rejects(validarAcervoV9({ pacote, senha, raizStaging }), { code: 'STAGING_EM_USO' });
    assert.equal((await readdir(raizStaging)).length, 1);
    release();
    const result = await first;
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, false);
  } finally { release?.(); hook?.restore(); await f.close(); }
});

test('DB, WAL e SHM constam no diário antes da primeira DDL SQLite', async () => {
  const f = await criarPerfilRealSintetico();
  const raizStaging = path.join(f.dir, 'staging');
  const pacote = path.join(f.dir, 'acervo.lumebak');
  const originalExec = DatabaseSync.prototype.exec;
  let observed = false;
  try {
    f.db.close(); await mkdir(raizStaging);
    const origem = await criarOrigemV9({ dbPath: f.dbPath, perfil: { dono: 'Teste' } });
    await gravarPacote({ origem: origem.origem, destino: pacote, senha });
    DatabaseSync.prototype.exec = function(sql) {
      if (!observed) for (const area of readdirSync(raizStaging)) {
        if (!area.startsWith('.lume-restore-')) continue;
        const base = path.join(raizStaging, area);
        const names = ['acervo.sqlite', 'acervo.sqlite-wal', 'acervo.sqlite-shm'];
        if (!names.every(name => readdirSync(base).includes(name))) continue;
        const journal = readFileSync(path.join(base, 'manifesto.json'), 'utf8').trim().split('\n').map(JSON.parse);
        for (const name of names) {
          const st = lstatSync(path.join(base, name), { bigint: true });
          const row = journal.find(item => item.name === name);
          assert.equal(row?.ino, st.ino.toString(), name);
          assert.equal(row?.dev, st.dev.toString(), name);
          assert.equal(st.size, 0n, name);
        }
        observed = true;
      }
      return originalExec.call(this, sql);
    };
    const result = await validarAcervoV9({ pacote, senha, raizStaging });
    assert.equal(observed, true);
    assert.equal((await descartarPlanoV9(result.plano)).limpezaPendente, false);
  } finally { DatabaseSync.prototype.exec = originalExec; await f.close(); }
});

// Ensaio descartável de desempenho: só bancos e conteúdo sintéticos.
// Uso: node scripts/diagnostic-restore-scale.mjs --rows 250001 --variant baseline
// QA do supervisor: node scripts/diagnostic-restore-scale.mjs --self-test
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { criarPerfilRealSintetico } from '../test/fixtures/backup-schema-real.js';
import { criarOrigemV9 } from '../src/backup-acervo-v9.js';
import { gravarPacote } from '../src/backup-stream.js';
import { validarAcervoV9, descartarPlanoV9 } from '../src/backup-acervo-restore-v9.js';

const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
const rows = Number(option('--rows'));
const variant = option('--variant');
const selfTest = args.includes('--self-test');
const testChild = args.includes('--self-test-child');
if (!selfTest && !testChild) {
  assert.ok(Number.isInteger(rows) && rows >= 1 && rows <= 250001, 'rows entre 1 e 250001');
  assert.ok(['baseline', 'cache32'].includes(variant), 'variant baseline ou cache32');
}

const samePath = (a, b) => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  : path.resolve(a) === path.resolve(b);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function checkedStat(target, root, expected) {
  assert.ok(path.isAbsolute(target) && samePath(target, path.resolve(target)), 'alvo não absoluto');
  assert.ok(samePath(target, root) || inside(root, target), 'alvo fora da raiz exclusiva');
  const stat = await lstat(target, { bigint: true });
  assert.ok(!stat.isSymbolicLink(), 'link/reparse recusado');
  assert.ok(samePath(await realpath(target), target), 'caminho reparse recusado');
  if (expected) assert.ok(sameIdentity(stat, expected), 'identidade do temporário alterada');
  return stat;
}
async function removeOwnedTree(target, root, expected) {
  const stat = await checkedStat(target, root, expected);
  if (stat.isDirectory()) {
    for (const name of await readdir(target)) {
      const child = path.resolve(target, name);
      assert.ok(inside(root, child) && samePath(path.dirname(child), target), 'entrada fora da raiz');
      await removeOwnedTree(child, root);
    }
    await checkedStat(target, root, stat);
    await rmdir(target);
  } else if (stat.isFile()) {
    await checkedStat(target, root, stat);
    await unlink(target);
  } else {
    throw new Error('tipo de entrada temporária recusado');
  }
}
async function ownedTemp() {
  const base = path.resolve(tmpdir());
  const root = path.resolve(await mkdtemp(path.join(base, 'lume-restore-scale-')));
  assert.ok(!samePath(root, base) && samePath(path.dirname(root), base) &&
    !samePath(root, process.cwd()) && !samePath(root, homedir()),
  'raiz temporária inesperada');
  const rootStat = await checkedStat(root, root);
  assert.ok(rootStat.isDirectory(), 'raiz temporária não é diretório');
  const childTemp = path.resolve(root, 'child-tmp');
  assert.ok(inside(root, childTemp) && samePath(path.dirname(childTemp), root), 'subdiretório temporário inesperado');
  await mkdir(childTemp, { mode: 0o700 });
  const childStat = await checkedStat(childTemp, root);
  return { root, rootStat, childTemp, childStat };
}
async function cleanupOwnedTemp(owned) {
  await checkedStat(owned.root, owned.root, owned.rootStat);
  await removeOwnedTree(owned.childTemp, owned.root, owned.childStat);
  await checkedStat(owned.root, owned.root, owned.rootStat);
  assert.deepEqual(await readdir(owned.root), [], 'raiz exclusiva contém entrada inesperada');
  await rmdir(owned.root);
  await assert.rejects(lstat(owned.root, { bigint: true }), { code: 'ENOENT' });
}
async function runSupervised(childArgs, watchdogMs) {
  const owned = await ownedTemp();
  let watchdog;
  let timedOut = false;
  let overflow = false;
  let stdout = '';
  let stdoutPending = '';
  let stderr = '';
  let outputBytes = 0;
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMP: owned.childTemp, TEMP: owned.childTemp, TMPDIR: owned.childTemp,
        LUME_DIAG_CHILD_TMP: owned.childTemp },
    });
    const capture = (which, chunk) => {
      const capacity = Math.max(0, 65536 - outputBytes);
      const kept = chunk.subarray(0, capacity);
      outputBytes += kept.length;
      if (which === 'stdout') {
        const output = kept.toString('utf8');
        stdout += output;
        stdoutPending += output;
        let newline;
        while ((newline = stdoutPending.indexOf('\n')) !== -1) {
          const line = stdoutPending.slice(0, newline);
          stdoutPending = stdoutPending.slice(newline + 1);
          try {
            // Apenas diagnósticos parciais saem antes de close e cleanup.
            if (JSON.parse(line).status === 'progress') process.stdout.write(`${line}\n`);
          } catch { /* Linhas inválidas ficam na captura para falhar na validação final. */ }
        }
      } else stderr += kept.toString('utf8');
      if (kept.length < chunk.length) { overflow = true; child.kill(); }
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    watchdog = setTimeout(() => { timedOut = true; child.kill(); }, watchdogMs);
    let spawnError;
    const { code, signal } = await new Promise(resolve => {
      child.once('error', error => { spawnError = error.code || error.name; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { code, signal, timedOut, overflow, spawnError, stdout, stderr, watchdogMs };
  } finally {
    clearTimeout(watchdog);
    // `close` acima garante que o filho terminou e os pipes fecharam antes da limpeza.
    await cleanupOwnedTemp(owned);
  }
}

if (testChild) {
  assert.ok(path.isAbsolute(process.env.LUME_DIAG_CHILD_TMP || '') &&
    samePath(tmpdir(), process.env.LUME_DIAG_CHILD_TMP), 'tmpdir do filho fora da raiz exclusiva');
  await writeFile(path.join(tmpdir(), 'arquivo-sintetico-apos-spawn'), 'sintético', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'selftest-file-created' }));
  await new Promise(() => { setInterval(() => {}, 1000); });
} else if (selfTest) {
  const sentinel = await ownedTemp();
  const marker = path.join(sentinel.childTemp, 'sentinela-fora-da-raiz-do-filho');
  await writeFile(marker, 'preservar', { flag: 'wx' });
  try {
    const result = await runSupervised(['--self-test-child'], 1500);
    assert.ok(result.timedOut && result.stdout.includes('selftest-file-created'), 'timeout após criação não comprovado');
    assert.equal(await readFile(marker, 'utf8'), 'preservar', 'sentinela externa alterada');
    console.log(JSON.stringify({ status: 'selftest-ok', timedOut: result.timedOut,
      childCreatedFile: true, childTempRemoved: true, externalSentinelPreserved: true,
      childExitCode: result.code, childSignal: result.signal }));
  } finally { await cleanupOwnedTemp(sentinel); }
} else if (!args.includes('--child')) {
  const result = await runSupervised(['--child', '--rows', String(rows), '--variant', variant], 300000);
  if (result.code === 0 && !result.timedOut && !result.overflow && !result.spawnError) {
    const lines = result.stdout.trimEnd().split('\n');
    const metrics = JSON.parse(lines.at(-1));
    assert.equal(metrics.status, 'ok', 'filho saiu sem métricas válidas');
    assert.equal(metrics.rows, rows, 'filho mediu número diferente de linhas');
    assert.equal(metrics.variant, variant, 'filho mediu variante diferente');
    console.log(JSON.stringify(metrics));
  } else {
    console.error(JSON.stringify({ status: 'failed', exitCode: result.code, signal: result.signal,
      timeout: result.timedOut, outputOverflow: result.overflow, spawnError: result.spawnError || null,
      watchdogMs: result.watchdogMs, childTempRemoved: true, childOutput: result.stderr.slice(0, 2000) }));
    process.exitCode = 1;
  }
} else {
  assert.ok(path.isAbsolute(process.env.LUME_DIAG_CHILD_TMP || '') &&
    samePath(tmpdir(), process.env.LUME_DIAG_CHILD_TMP), 'tmpdir do filho fora da raiz exclusiva');
  const start = performance.now();
  const cpuStart = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const stamps = {};
  const phaseEnds = {
    fixtureDdlEnd: ['fixtureDdl', 'start'], fixtureRowsEnd: ['fixtureRows', 'fixtureDdlEnd'],
    packageEnd: ['sourceAndPackage', 'fixtureRowsEnd'], ddlStart: ['verifyAead', 'packageEnd'],
    loadStart: ['destinationDdl', 'ddlStart'], semanticStart: ['parseAndLoad', 'loadStart'],
    fkStart: ['semanticScans', 'semanticStart'], integrityStart: ['foreignKeyCheck', 'fkStart'],
    commitStart: ['integrityCheck', 'integrityStart'], commitEnd: ['commit', 'commitStart'],
    restoreEnd: ['reopen', 'commitEnd'], assertsEnd: ['parityAsserts', 'restoreEnd'],
  };
  const progress = value => process.stdout.write(`${JSON.stringify({ status: 'progress', ...value })}\n`);
  const stamp = name => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const rss = process.memoryUsage().rss;
    rssPeak = Math.max(rssPeak, rss);
    stamps[name] = { wall: now, cpu, rss };
    const phase = phaseEnds[name];
    if (phase && stamps[phase[1]]) progress({ phase: phase[0], ...diff(phase[1], name),
      elapsedMs: Math.round(now - start), rssMiB: Math.round((rss - rssStart) / 1048576),
      rssPeakMiB: Math.round((rssPeak - rssStart) / 1048576) });
  };
  const diff = (a, b) => ({ wallMs: Math.round(stamps[b].wall - stamps[a].wall),
    cpuMs: Math.round((stamps[b].cpu.user + stamps[b].cpu.system - stamps[a].cpu.user - stamps[a].cpu.system) / 1000) });
  const originalExec = DatabaseSync.prototype.exec;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalGet = StatementSync.prototype.get;
  let inRestore = false;
  let restoreDb;
  let destinationPragmas;
  let sourcePragmas;
  let insertSqlMs = 0;
  let insertRows = 0;
  let blockStart;
  let blockCpu;
  const blocks = [];
  const fixtureBlocks = [];
  const insertStatements = new WeakSet();
  const pragmas = db => Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys', 'cache_size',
    'cache_spill', 'page_size', 'page_count'].map(name => [name, Object.values(originalPrepare.call(db, `PRAGMA ${name}`).get())[0]]));

  DatabaseSync.prototype.exec = function(sql) {
    if (inRestore && !restoreDb && sql.includes('PRAGMA journal_mode = WAL')) stamp('ddlStart');
    if (inRestore && sql.includes('BEGIN IMMEDIATE') && sql.includes('defer_foreign_keys')) {
      restoreDb = this;
      if (variant === 'cache32') originalExec.call(this, 'PRAGMA cache_size=-32768');
      destinationPragmas = pragmas(this);
      progress({ phase: 'destinationPragmas', pragmas: destinationPragmas,
        elapsedMs: Math.round(performance.now() - start) });
      stamp('loadStart');
    }
    if (inRestore && this === restoreDb && sql === 'COMMIT') stamp('commitStart');
    const result = originalExec.call(this, sql);
    if (inRestore && this === restoreDb && sql === 'COMMIT') stamp('commitEnd');
    return result;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    if (inRestore && this === restoreDb) {
      if (sql.startsWith('SELECT id,conversa_id,origem_id,permissao,tipo,projeto_id FROM eventos')) stamp('semanticStart');
      if (sql === 'PRAGMA foreign_key_check') stamp('fkStart');
      if (sql === 'PRAGMA integrity_check') stamp('integrityStart');
    }
    const statement = originalPrepare.call(this, sql);
    if (inRestore && this === restoreDb && sql.startsWith('INSERT INTO "eventos"(')) insertStatements.add(statement);
    return statement;
  };
  StatementSync.prototype.get = function(...values) {
    if (!insertStatements.has(this)) return originalGet.apply(this, values);
    const before = performance.now();
    if (!blockStart) { blockStart = before; blockCpu = process.cpuUsage(); }
    const result = originalGet.apply(this, values);
    insertSqlMs += performance.now() - before;
    insertRows++;
    if (insertRows % 10000 === 0 || insertRows === rows) {
      const now = performance.now();
      const cpu = process.cpuUsage(blockCpu);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      const block = { through: insertRows, wallMs: Math.round(now - blockStart),
        cpuMs: Math.round((cpu.user + cpu.system) / 1000), rssMiB: Math.round((process.memoryUsage().rss - rssStart) / 1048576) };
      blocks.push(block);
      progress({ phase: 'restoreInsert', ...block, elapsedMs: Math.round(now - start) });
      blockStart = now; blockCpu = process.cpuUsage();
    }
    return result;
  };

  const aborter = new AbortController();
  const abortTimer = setTimeout(() => aborter.abort(), 295000);
  const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 20);
  let fixture;
  let plano;
  try {
    stamp('start');
    fixture = await criarPerfilRealSintetico();
    stamp('fixtureDdlEnd');
    sourcePragmas = pragmas(fixture.db);
    progress({ phase: 'sourcePragmas', pragmas: sourcePragmas,
      elapsedMs: Math.round(performance.now() - start) });
    const insert = fixture.db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,'c',?,'entrada','texto',?,?,'2026-09-27T12:00:00.000Z','2026-09-27','minha')`);
    fixture.db.exec('BEGIN');
    let fixtureBlockStart = performance.now();
    let fixtureBlockCpu = process.cpuUsage();
    for (let i = 1; i <= rows; i++) {
      insert.run(BigInt(i), `origem-${i}`, `bruto ${i}`, `texto ${i}`);
      if (i % 10000 === 0 || i === rows) {
        const now = performance.now();
        const cpu = process.cpuUsage(fixtureBlockCpu);
        const rss = process.memoryUsage().rss;
        rssPeak = Math.max(rssPeak, rss);
        const block = { through: i, wallMs: Math.round(now - fixtureBlockStart),
          cpuMs: Math.round((cpu.user + cpu.system) / 1000), rssMiB: Math.round((rss - rssStart) / 1048576) };
        fixtureBlocks.push(block);
        progress({ phase: 'fixtureInsert', ...block, elapsedMs: Math.round(now - start) });
        fixtureBlockStart = now;
        fixtureBlockCpu = process.cpuUsage();
      }
    }
    fixture.db.exec('COMMIT');
    fixture.db.close();
    stamp('fixtureRowsEnd');
    const staging = path.join(fixture.dir, 'staging');
    const pacote = path.join(fixture.dir, 'volume.lumebak');
    await mkdir(staging);
    const source = await criarOrigemV9({ dbPath: fixture.dbPath, perfil: { dono: 'Volume sintético' }, signal: aborter.signal });
    await gravarPacote({ origem: source.origem, destino: pacote, senha: 'senha sintética do teste', signal: aborter.signal });
    stamp('packageEnd');
    inRestore = true;
    const result = await validarAcervoV9({ pacote, senha: 'senha sintética do teste', raizStaging: staging, signal: aborter.signal });
    inRestore = false;
    plano = result.plano;
    stamp('restoreEnd');
    assert.equal(result.resumo.linhas, rows);
    const work = (await readdir(staging))[0];
    const restored = new DatabaseSync(path.join(staging, work, 'acervo.sqlite'), { readOnly: true });
    const original = new DatabaseSync(fixture.dbPath, { readOnly: true });
    let digest;
    try {
      assert.equal(restored.prepare('SELECT COUNT(*) n FROM eventos').get().n, rows);
      const sql = 'SELECT id,conversa_id,origem_id,bruto,texto,permissao FROM eventos ORDER BY id';
      const hashRows = db => {
        const h = createHash('sha256');
        for (const r of db.prepare(sql).iterate()) h.update(JSON.stringify([r.id, r.conversa_id, r.origem_id, r.bruto, r.texto, r.permissao]));
        return h.digest('hex');
      };
      const sourceHash = hashRows(original);
      digest = hashRows(restored);
      assert.equal(digest, sourceHash);
      for (const id of [1, rows]) assert.deepEqual(
        { ...restored.prepare(`SELECT typeof(id) id,typeof(bruto) bruto,typeof(texto) texto FROM eventos WHERE id=${id}`).get() },
        { id: 'integer', bruto: 'text', texto: 'text' });
    } finally { restored.close(); original.close(); }
    stamp('assertsEnd');
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    assert.ok(rssPeak - rssStart <= 512 * 1048576, 'RSS adicional acima de 512 MiB');
    const segment = (a, b) => stamps[a] && stamps[b] ? diff(a, b) : null;
    console.log(JSON.stringify({ status: 'ok', rows, variant, digest, pragmas: { source: sourcePragmas, destination: destinationPragmas },
      phases: { fixtureDdl: segment('start', 'fixtureDdlEnd'), fixtureRows: segment('fixtureDdlEnd', 'fixtureRowsEnd'),
        sourceAndPackage: segment('fixtureRowsEnd', 'packageEnd'), verifyAead: segment('packageEnd', 'ddlStart'),
        destinationDdl: segment('ddlStart', 'loadStart'), parseAndLoad: segment('loadStart', 'semanticStart'),
        semanticScans: segment('semanticStart', 'fkStart'), foreignKeyCheck: segment('fkStart', 'integrityStart'),
        integrityCheck: segment('integrityStart', 'commitStart'), commit: segment('commitStart', 'commitEnd'),
        reopen: segment('commitEnd', 'restoreEnd'), parityAsserts: segment('restoreEnd', 'assertsEnd') },
      insertSqlMs: Math.round(insertSqlMs), insertRows, fixtureBlocks, blocks,
      total: { wallMs: Math.round(performance.now() - start), cpuMs: Math.round((process.cpuUsage().user + process.cpuUsage().system - cpuStart.user - cpuStart.system) / 1000),
        rssAdditionalMiB: Math.round((rssPeak - rssStart) / 1048576) } }));
  } finally {
    clearTimeout(abortTimer); clearInterval(rssTimer);
    DatabaseSync.prototype.exec = originalExec;
    DatabaseSync.prototype.prepare = originalPrepare;
    StatementSync.prototype.get = originalGet;
    if (plano) await descartarPlanoV9(plano);
    if (fixture) await fixture.close();
  }
}

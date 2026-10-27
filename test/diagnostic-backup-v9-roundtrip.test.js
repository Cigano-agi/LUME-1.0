import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { link, mkdir, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { criarPerfilRealSintetico } from './fixtures/backup-schema-real.js';
import { TABELAS_I_V9 } from '../src/backup-acervo-catalogo.js';
import { compararParidade, executarDiagnostico } from '../scripts/diagnostic-backup-v9-roundtrip.mjs';
import { supervisionarFilho } from '../scripts/supervise-backup-v9-roundtrip.mjs';

async function fixture(alterar) {
  const f = await criarPerfilRealSintetico();
  const outputRoot = path.join(f.dir, 'saida');
  await mkdir(outputRoot);
  try {
    alterar?.(f.db);
    f.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    f.db.exec('PRAGMA journal_mode=DELETE');
    f.db.close();
    return { ...f, outputRoot };
  } catch (error) { await f.close(); throw error; }
}

test('roundtrip sintético confere todos os campos de eventos e conversas_app', async () => {
  const f = await fixture(db => {
    db.prepare('INSERT INTO conversas_app(id,nome) VALUES(?,?)').run('c', 'Nome sintético');
    db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,'c','o','entrada','texto','bruto',?,'2026-09-27T12:00:00.000Z','2026-09-27','minha')`)
      .run(9007199254740993n, 'texto\0livre');
    db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,'c','o2','entrada','texto','bruto',?,'2026-09-27T12:00:00.000Z','2026-09-27','minha')`)
      .run(9007199254740994n, Buffer.from([0, 255, 1]));
  });
  try {
    const r = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot });
    assert.equal(r.codigo, 'PARIDADE_CONFIRMADA');
    assert.equal(r.pacoteCriado, true);
    assert.equal(r.validacao, 'VALIDADA');
    assert.equal(r.paridade.eventos, true);
    assert.equal(r.paridade.conversas_app, true);
    assert.equal(r.limpeza, 'CONCLUIDA');
    assert.deepEqual(await readdir(f.outputRoot), []);
    const serialized = JSON.stringify(r);
    assert.equal(serialized.includes('texto\\u0000livre'), false);
    assert.equal(serialized.includes('AP8B'), false);
    assert.equal(serialized.includes(f.dbPath), false);
  } finally { await f.close(); }
});

test('recusa origem inválida e output ocupado sem apagar itens do chamador', async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.outputRoot, 'marcador');
    await writeFile(marker, 'intacto');
    const ocupado = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot });
    assert.equal(ocupado.codigo, 'OUTPUT_OCUPADO');
    assert.deepEqual(await readdir(f.outputRoot), ['marcador']);
    await rm(marker);
    const invalido = await executarDiagnostico({ source: path.join(f.dir, 'ausente.sqlite'), outputRoot: f.outputRoot });
    assert.equal(invalido.codigo, 'FONTE_INVALIDA');
    assert.deepEqual(await readdir(f.outputRoot), []);
  } finally { await f.close(); }
});

test('recusa junction, symlink quando disponível e sobreposição de caminhos', async () => {
  const f = await fixture();
  try {
    const link = path.join(f.dir, 'link.sqlite');
    try {
      await symlink(f.dbPath, link, 'file');
      assert.equal((await executarDiagnostico({ source: link, outputRoot: f.outputRoot })).codigo, 'CAMINHO_INVALIDO');
    } catch (error) { if (error.code !== 'EPERM') throw error; }
    const junction = path.join(f.dir, 'junction');
    await symlink(f.dir, junction, 'junction');
    assert.equal((await executarDiagnostico({ source: path.join(junction, path.basename(f.dbPath)), outputRoot: f.outputRoot })).codigo, 'CAMINHO_INVALIDO');
    assert.equal((await executarDiagnostico({ source: f.dbPath, outputRoot: f.dir })).codigo, 'CAMINHO_SOBREPOSTO');
  } finally { await f.close(); }
});

test('cancelamento prévio não deixa artefatos', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    const r = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot, signal: controller.signal });
    assert.equal(r.codigo, 'DIAGNOSTICO_CANCELADO');
    assert.deepEqual(await readdir(f.outputRoot), []);
  } finally { await f.close(); }
});

test('recusa semântica da produção e limpa pacote efêmero', async () => {
  const f = await fixture(db => db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,tipo,bruto,recebido_em,dia_local,permissao)
    VALUES('c','o','entrada','texto','bruto','2026-09-27T12:00:00.000Z','2026-09-27','todas')`).run());
  try {
    const r = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot });
    assert.equal(r.codigo, 'SEMANTICA_INVALIDA');
    assert.equal(r.pacoteCriado, true);
    assert.equal(r.validacao, 'RECUSADA');
    assert.deepEqual(await readdir(f.outputRoot), []);
  } finally { await f.close(); }
});

test('recusa hardlink da origem sem iniciar pacote', async () => {
  const f = await fixture();
  try {
    const hard = path.join(f.dir, 'hard.sqlite');
    await link(f.dbPath, hard);
    const r = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot });
    assert.equal(r.codigo, 'CAMINHO_INVALIDO');
    assert.equal(r.pacoteCriado, false);
    assert.deepEqual(await readdir(f.outputRoot), []);
  } finally { await f.close(); }
});

test('diferença de hash obrigatória bloqueia paridade; outras tabelas são diagnóstico', () => {
  const vazio = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const origem = Object.fromEntries(TABELAS_I_V9.map(t => [t.nome, { linhas: 0, sha256: vazio }]));
  const oraculo = structuredClone(origem);
  oraculo.eventos.sha256 = '0'.repeat(64);
  let r = compararParidade(origem, oraculo);
  assert.equal(r.eventos, false);
  assert.equal(r.conversas_app, true);
  oraculo.eventos.sha256 = vazio;
  oraculo.pessoas.linhas = 1;
  r = compararParidade(origem, oraculo);
  assert.equal(r.eventos, true);
  assert.equal(r.conversas_app, true);
  assert.equal(r.tabelas.find(t => t.tabela === 'pessoas').igual, false);
});

async function waitForOwn(root, prefix) {
  for (let i = 0; i < 200; i++) {
    const names = await readdir(root);
    const name = names.find(n => n.startsWith(prefix));
    if (name) return path.join(root, name);
    await pause(10);
  }
  assert.fail('diretório próprio não apareceu na janela sintética');
}

test('cancelamento após início fecha recursos e remove apenas artefatos próprios', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const pending = executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot, signal: controller.signal });
    await waitForOwn(f.outputRoot, 'lume-work-');
    controller.abort();
    const r = await pending;
    assert.equal(r.codigo, 'DIAGNOSTICO_CANCELADO');
    assert.equal(r.limpeza, 'CONCLUIDA');
    assert.deepEqual(await readdir(f.outputRoot), []);
  } finally { await f.close(); }
});

test('objeto desconhecido no diretório próprio impede remoção da pasta, sem apagá-lo', async () => {
  const f = await fixture();
  try {
    const pending = executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot });
    const work = await waitForOwn(f.outputRoot, 'lume-work-');
    await writeFile(path.join(work, 'desconhecido'), 'marcador sintético');
    const r = await pending;
    assert.equal(r.codigo, 'LIMPEZA_PENDENTE');
    assert.equal(r.limpeza, 'PENDENTE');
    assert.deepEqual(await readdir(work), ['desconhecido']);
  } finally { await f.close(); }
});

test('WAL intruso no oráculo é preservado e impede adoção na limpeza', async () => {
  const f = await fixture();
  try {
    const pending = executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot });
    const oracle = await waitForOwn(f.outputRoot, 'lume-oracle-');
    await writeFile(path.join(oracle, 'oraculo.sqlite-wal'), 'intruso sintético');
    const r = await pending;
    assert.equal(r.codigo, 'LIMPEZA_PENDENTE');
    assert.equal(r.limpeza, 'PENDENTE');
    assert.deepEqual(await readdir(oracle), ['oraculo.sqlite-wal']);
  } finally { await f.close(); }
});

test('troca do diretório pai antes da limpeza preserva ambos os objetos', async () => {
  const f = await fixture();
  let moved, replacement;
  try {
    const r = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot,
      async __testBeforeCleanup() {
        const work = (await readdir(f.outputRoot)).find(n => n.startsWith('lume-work-'));
        assert.ok(work);
        replacement = path.join(f.outputRoot, work);
        moved = path.join(f.outputRoot, 'movido-pelo-teste');
        await rename(replacement, moved);
        await mkdir(replacement);
        await writeFile(path.join(replacement, 'intruso'), 'marcador sintético');
      } });
    assert.equal(r.codigo, 'CAMINHO_ALTERADO');
    assert.equal(r.limpeza, 'PENDENTE');
    assert.deepEqual(await readdir(replacement), ['intruso']);
    assert.ok((await readdir(moved)).includes('fonte.sqlite'));
  } finally { await f.close(); }
});

test('recusa SHM já presente na origem offline sem o abrir ou remover', async () => {
  const f = await fixture();
  const shm = `${f.dbPath}-shm`;
  try {
    await writeFile(shm, 'sentinela sintética');
    const r = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot });
    assert.equal(r.codigo, 'CAMINHO_ALTERADO');
    assert.equal(r.pacoteCriado, false);
    assert.equal((await readdir(f.dir)).includes(path.basename(shm)), true);
    assert.deepEqual(await readdir(f.outputRoot), []);
  } finally { await f.close(); }
});

test('recusa WAL surgido depois da paridade e do hook de limpeza', async () => {
  const f = await fixture();
  const wal = `${f.dbPath}-wal`;
  try {
    const r = await executarDiagnostico({ source: f.dbPath, outputRoot: f.outputRoot,
      async __testBeforeCleanup() { await writeFile(wal, 'sentinela sintética'); } });
    assert.equal(r.codigo, 'CAMINHO_ALTERADO');
    assert.equal(r.paridade.eventos, true);
    assert.equal(r.paridade.conversas_app, true);
    assert.equal((await readdir(f.dir)).includes(path.basename(wal)), true);
  } finally { await f.close(); }
});

test('supervisor mata filho após snapshot SQLite sintético dentro da raiz exclusiva', async () => {
  const f = await fixture();
  const ready = path.join(f.outputRoot, 'snapshot-pronto');
  const controller = new AbortController();
  const script = pathToFileURL(path.resolve('scripts/diagnostic-backup-v9-roundtrip.mjs')).href;
  const code = `import { executarDiagnostico } from ${JSON.stringify(script)};` +
    `import { writeFile } from 'node:fs/promises';` +
    `await executarDiagnostico({source:${JSON.stringify(f.dbPath)},outputRoot:${JSON.stringify(f.outputRoot)},` +
    `async __testAfterOrigin(){await writeFile(${JSON.stringify(ready)},'pronto');while(true){}}});`;
  const pending = supervisionarFilho({ comando: process.execPath, argumentos: ['--input-type=module', '-e', code],
    outputRoot: f.outputRoot, signal: controller.signal, timeoutMs: 60_000, graceMs: 60, finalMs: 1_000 });
  let result;
  try {
    for (let i = 0; i < 1_000; i++) {
      if (await stat(ready).then(() => true, () => false)) break;
      await pause(50);
    }
    assert.equal(await stat(ready).then(() => true, () => false), true);
    controller.abort();
    result = await pending;
    assert.equal(result.codigo, 'SUPERVISAO_CANCELADA');
    assert.equal(result.processo.fechamentoConfirmado, true);
    assert.equal(result.supervisao.cancelamentoEnviado, true);
    assert.equal(result.limpeza, 'PENDENTE');
    const snapshots = (await readdir(f.outputRoot)).filter(name => name.startsWith('lume-acervo-v9-'));
    assert.equal(snapshots.length, 1);
    assert.equal((await stat(path.join(f.outputRoot, snapshots[0], 'snapshot.sqlite'))).isFile(), true);
  } finally {
    if (!result) { controller.abort(); result = await pending; }
    assert.equal(result.processo.fechamentoConfirmado, true);
    await f.close();
  }
});

test('CLI real do supervisor fecha roundtrip sintético e esvazia a raiz', async () => {
  const f = await fixture();
  let podeLimpar = false;
  try {
    const proc = spawn(process.execPath, [path.resolve('scripts/supervise-backup-v9-roundtrip.mjs'),
      '--source', f.dbPath, '--output-root', f.outputRoot], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', excedeu = false, spawnError = null;
    proc.stdout.on('data', chunk => {
      if (Buffer.byteLength(stdout) + chunk.length > 1_000_000) excedeu = true;
      else stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', chunk => {
      if (Buffer.byteLength(stderr) + chunk.length > 1_000_000) excedeu = true;
      else stderr += chunk.toString('utf8');
    });
    proc.once('error', error => { spawnError = error; });
    const closed = await new Promise(resolve => proc.once('close', (code, signal) => resolve({ code, signal })));
    assert.equal(spawnError, null);
    assert.equal(excedeu, false);
    assert.equal(closed.code, 0);
    assert.equal(closed.signal, null);
    assert.equal(stderr, '');
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.codigo, 'PARIDADE_CONFIRMADA');
    assert.equal(receipt.processo.fechamentoConfirmado, true);
    assert.equal(receipt.processo.exitCode, 0);
    assert.equal(receipt.limpeza, 'CONCLUIDA');
    assert.deepEqual(await readdir(f.outputRoot), []);
    podeLimpar = true;
  } finally {
    if (podeLimpar) await f.close();
  }
});

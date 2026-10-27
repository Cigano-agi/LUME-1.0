import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validarRecibo03A20, supervisionarFilho } from '../scripts/diagnostic-copy-migration.mjs';

const script = fileURLToPath(new URL('../scripts/diagnostic-copy-migration.mjs', import.meta.url));
const outputRoot = mkdtempSync(join(tmpdir(), 'lume-03a20-supervisor-'));
after(() => rmSync(outputRoot, { recursive: true, force: true }));
const receipt = {
  codigo: 'COPIA_PREPARADA', fase: 'fechamento', origemIntacta: true,
  tabelasOriginais: 2, tabelasNovas: 5, divergencias: 0, dbFechado: true,
};

test('recibo fechado aceita sucesso e recusa campos, tipos e conteúdo livre', () => {
  assert.equal(validarRecibo03A20(receipt), true);
  assert.equal(validarRecibo03A20({ ...receipt, caminho: 'C:/privado/assessor.db' }), false);
  assert.equal(validarRecibo03A20({ ...receipt, codigo: 'COPIA_PREPARADA\nsegredo' }), false);
  assert.equal(validarRecibo03A20({ ...receipt, tabelasNovas: '5' }), false);
  assert.equal(validarRecibo03A20({ ...receipt, origemIntacta: false }), false);
});

test('supervisor aceita apenas recibo válido após close e exit zero', async () => {
  const result = await supervisionarFilho({
    comando: process.execPath,
    argumentos: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n`)})`],
    outputRoot,
    timeoutMs: 2_000,
  });
  assert.equal(result.codigo, 'COPIA_PREPARADA');
  assert.equal(result.processo.fechamentoConfirmado, true);
  assert.equal(result.processo.exitCode, 0);
  assert.deepEqual(result.recibo, receipt);
});

test('supervisor recusa saída inválida, múltiplas linhas e timeout de filho', async () => {
  for (const code of [
    'process.stdout.write("texto privado\\n")',
    `process.stdout.write(${JSON.stringify(`${JSON.stringify(receipt)}\n${JSON.stringify(receipt)}\n`)})`,
  ]) {
    const result = await supervisionarFilho({ comando: process.execPath, argumentos: ['-e', code], outputRoot, timeoutMs: 2_000 });
    assert.equal(result.codigo, 'RECIBO_INVALIDO');
    assert.equal(result.recibo, null);
    assert.equal(result.processo.fechamentoConfirmado, true);
  }
  const timeout = await supervisionarFilho({
    comando: process.execPath,
    argumentos: ['-e', 'setInterval(() => {}, 1000)'], outputRoot, timeoutMs: 60, graceMs: 20, finalMs: 300,
  });
  assert.notEqual(timeout.codigo, 'COPIA_PREPARADA');
  assert.equal(timeout.recibo, null);
});

test('supervisor propaga só código conhecido de falha e isola stderr e TEMP', async () => {
  const failure = { ...receipt, codigo: 'MIGRACAO_ALTERARIA_DADOS', fase: 'inventario', divergencias: 1 };
  const code = `if(process.env.TEMP!==${JSON.stringify(outputRoot)}||process.env.TMP!==${JSON.stringify(outputRoot)}||process.env.TMPDIR!==${JSON.stringify(outputRoot)})process.exit(2);process.stderr.write('SEGREDO\\n');process.stdout.write(${JSON.stringify(`${JSON.stringify(failure)}\n`)});process.exitCode=1`;
  const result = await supervisionarFilho({ comando: process.execPath, argumentos: ['-e', code], outputRoot, timeoutMs: 2_000 });
  assert.equal(result.codigo, 'FILHO_EXIT_NAO_ZERO');
  assert.equal(result.codigoFilho, 'MIGRACAO_ALTERARIA_DADOS');
  assert.equal(result.recibo?.dbFechado, true);
  assert.equal(JSON.stringify(result).includes('SEGREDO'), false);
});

test('supervisor nunca aprova filho cujo close não foi confirmado', async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(receipt)}\n`));
    return child;
  };
  const result = await supervisionarFilho({ comando: process.execPath, argumentos: ['-e', 'process.exit(0)'],
    outputRoot, timeoutMs: 20, graceMs: 10, finalMs: 10, spawnImpl: fakeSpawn });
  assert.equal(result.codigo, 'FECHAMENTO_NAO_CONFIRMADO');
  assert.equal(result.processo.fechamentoConfirmado, false);
  assert.equal(result.recibo, null);
});

function sondarErroStream(pipe, emitirClose) {
  const probe = `
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { supervisionarFilho } from ${JSON.stringify(new URL('../scripts/diagnostic-copy-migration.mjs', import.meta.url).href)};
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => {
        if (${JSON.stringify(emitirClose)}) queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      queueMicrotask(() => child[${JSON.stringify(pipe)}].emit('error', new Error('SEGREDO_SINTETICO')));
      return child;
    };
    const result = await supervisionarFilho({ comando: process.execPath,
      outputRoot: ${JSON.stringify(outputRoot)}, spawnImpl: fakeSpawn,
      timeoutMs: 50, graceMs: 10, finalMs: 10 });
    process.stdout.write(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
    { encoding: 'utf8', timeout: 2_000, windowsHide: true });
  assert.equal(child.status, 0, `probe ${pipe} deve encerrar sem exception`);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(JSON.stringify(result).includes('SEGREDO_SINTETICO'), false);
  return result;
}

for (const pipe of ['stdout', 'stderr']) {
  test(`supervisor sanitiza erro de ${pipe} e aguarda close`, () => {
    const result = sondarErroStream(pipe, true);
    assert.equal(result.codigo, 'SAIDA_FALHOU');
    assert.equal(result.processo.fechamentoConfirmado, true);
    assert.equal(result.recibo, null);
  });
}

test('supervisor não aprova erro de stream sem close', () => {
  const result = sondarErroStream('stdout', false);
  assert.equal(result.codigo, 'FECHAMENTO_NAO_CONFIRMADO');
  assert.equal(result.processo.fechamentoConfirmado, false);
  assert.equal(result.recibo, null);
});

test('CLI rejeita argumentos ausentes em JSON sem eco de paths', async () => {
  const child = spawn(process.execPath, [script, '--source', 'RELATIVO'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const status = await new Promise((resolveDone, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('CLI não fechou')); }, 2_000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(deadline); resolveDone(code); });
  });
  assert.equal(status, 1);
  assert.equal(stderr, '');
  const output = JSON.parse(stdout.trim());
  assert.equal(output.codigo, 'ARGUMENTOS_INVALIDOS');
  assert.equal(stdout.includes('RELATIVO'), false);
});

const cleanupAreas = new Map();
function areaSintetica(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lume-03a20-synthetic-'));
  const output = join(dir, 'output');
  mkdirSync(output);
  const state = { canClean: false };
  cleanupAreas.set(output, state);
  t.after(() => {
    cleanupAreas.delete(output);
    if (state.canClean) rmSync(dir, { recursive: true, force: true });
  });
  return { dir, output, source: join(dir, 'legado.sqlite') };
}

async function runDiagnostic(source, output) {
  const child = spawn(process.execPath, [script, '--source', source, '--output-root', output],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', timedOut = false, overflow = false, closed = false;
  const result = await new Promise(resolveDone => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolveDone(value); } };
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1024 * 1024) { overflow = true; child.kill('SIGTERM'); }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64 * 1024) { overflow = true; child.kill('SIGTERM'); }
    });
    child.on('error', error => finish({ error }));
    child.on('close', (status, signal) => { closed = true; finish({ status, signal }); });
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60_000);
    const final = setTimeout(() => {
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish({ error: new Error('Supervisor não confirmou close') });
    }, 65_000);
    child.on('close', () => { clearTimeout(deadline); clearTimeout(final); });
  });
  assert.equal(result.error, undefined);
  assert.equal(timedOut, false);
  assert.equal(overflow, false);
  assert.equal(closed, true);
  assert.equal(stderr, '');
  assert.equal(stdout.trim().split(/\r?\n/).length, 1);
  const receipt = JSON.parse(stdout.trim());
  cleanupAreas.get(output).canClean = receipt?.processo?.fechamentoConfirmado === true &&
    receipt?.recibo?.dbFechado === true;
  return { status: result.status, receipt, stdout };
}

async function criarLegado(source, { filaAnalisando = false, projetoG = false, manterHeaderWal = false } = {}) {
  const [{ abrirBanco }, { ContextoApp }] = await Promise.all([
    import('../src/banco.js'), import('../src/contexto-app.js'),
  ]);
  const db = abrirBanco(source);
  try {
    new ContextoApp(db);
    db.prepare('INSERT INTO conversas_app(id,nome) VALUES(?,?)').run('c1', 'Nome sintético');
    db.prepare('INSERT INTO politicas_conversa(conversa_id,politica,atualizado_em) VALUES(?,?,?)')
      .run('c1', 'tudo', '2026-01-01');
    if (projetoG) db.prepare('INSERT INTO projetos(id,cliente,nome,raiz,criado_em) VALUES(?,?,?,?,?)')
      .run('p1', 'Cliente sintético', 'Projeto sintético', 'raiz sintética', '2026-01-01');
    db.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(9007199254740995n, 'c1', 'm1', 'entrada', 'texto', '{}', 'Texto sintético',
      '2026-01-01T00:00:00.000Z', '2026-01-01', 'minha');
    if (filaAnalisando) {
      const { FilaLaya } = await import('../src/laya/fila.js');
      new FilaLaya(db, { laya: { classificar: async () => ({}), status: () => ({}) } });
      db.prepare(`INSERT INTO lume_laya_fila(evento_id,conversa_id,fonte_assinatura,estado,criada_em,atualizada_em,tentativa_id)
        VALUES(?,?,?,?,?,?,?)`).run(9007199254740995n, 'c1', 's1', 'analisando', '2026-01-01', '2026-01-01', 't1');
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (!manterHeaderWal) db.exec('PRAGMA journal_mode=DELETE');
  } finally { db.close(); }
}

test('sqlite: legado sintético migra duas vezes na cópia sem alterar origem ou PK bigint', async t => {
  const { source, output } = areaSintetica(t);
  await criarLegado(source);
  const before = createHash('sha256').update(readFileSync(source)).digest('hex');
  const result = await runDiagnostic(source, output);
  assert.equal(result.status, 0, JSON.stringify(result.receipt));
  assert.equal(result.receipt.codigo, 'COPIA_PREPARADA');
  assert.equal(result.receipt.processo.fechamentoConfirmado, true);
  assert.equal(result.stdout.includes('Nome sintético'), false);
  assert.equal(result.stdout.includes(source), false);
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), before);
  const prepared = join(output, 'prepared.sqlite');
  assert.equal(existsSync(prepared), true);
  assert.equal(existsSync(`${prepared}-wal`), false);
  assert.equal(existsSync(`${prepared}-shm`), false);
  await (await import('../scripts/diagnostic-copy-migration.mjs')).capturarOrigemOffline(prepared);
  assert.deepEqual([...readFileSync(prepared).subarray(18, 20)], [1, 1]);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(prepared, { readOnly: true });
  try {
    const stmt = copy.prepare('SELECT id,texto FROM eventos'); stmt.setReadBigInts(true);
    const row = stmt.get();
    assert.equal(row.id, 9007199254740995n);
    assert.equal(row.texto, 'Texto sintético');
    assert.equal(copy.prepare("SELECT politica FROM politicas_conversa WHERE conversa_id='c1'").get().politica, 'tudo');
    const { auditarEsquemaRestoreV9 } = await import('../src/backup-acervo-schema-v9.js');
    assert.equal(auditarEsquemaRestoreV9(copy), true);
  } finally { copy.close(); }
  const writable = new DatabaseSync(prepared);
  try {
    writable.prepare('INSERT INTO wa_interrupcoes(id,inicio,motivo) VALUES(?,?,?)')
      .run('i1', '2026-01-01', 'teste');
    writable.prepare(`INSERT INTO eventos(id,conversa_id,origem_id,direcao,tipo,bruto,texto,recebido_em,dia_local,permissao)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(9007199254740997n, 'c1', 'm2', 'entrada', 'texto', '{}', 'Outro evento',
      '2026-01-01T01:00:00.000Z', '2026-01-01', 'minha');
    writable.prepare(`INSERT INTO wa_fila_retomada(interrupcao_id,conversa_id,estado,criado_em,atualizado_em)
      VALUES(?,?,?,?,?)`).run('i1', 'c1', 'pendente', '2026-01-01', '2026-01-01');
    writable.prepare('DELETE FROM eventos WHERE id=?').run(9007199254740995n);
    assert.ok(writable.prepare('SELECT 1 FROM wa_fila_retomada').get(), 'fila permanece com outro evento');
    writable.prepare('DELETE FROM eventos WHERE id=?').run(9007199254740997n);
    assert.equal(writable.prepare('SELECT 1 FROM wa_fila_retomada').get(), undefined, 'último evento remove fila');
  } finally { writable.close(); }
});

test('sqlite: fonte técnica com header WAL offline entrega cópia DELETE sem sidecars', async t => {
  const { source, output } = areaSintetica(t);
  await criarLegado(source, { manterHeaderWal: true });
  assert.deepEqual([...readFileSync(source).subarray(18, 20)], [2, 2]);
  assert.equal(existsSync(`${source}-wal`), false);
  assert.equal(existsSync(`${source}-shm`), false);
  const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
  const result = await runDiagnostic(source, output);
  assert.equal(result.status, 0, JSON.stringify(result.receipt));
  assert.equal(result.receipt.codigo, 'COPIA_PREPARADA');
  const prepared = join(output, 'prepared.sqlite');
  assert.equal(existsSync(`${prepared}-wal`), false);
  assert.equal(existsSync(`${prepared}-shm`), false);
  const { capturarOrigemOffline } = await import('../scripts/diagnostic-copy-migration.mjs');
  await capturarOrigemOffline(prepared); // Preflight offline antes de reabrir.
  assert.deepEqual([...readFileSync(prepared).subarray(18, 20)], [1, 1]);
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), sourceHash);
  const { DatabaseSync } = await import('node:sqlite');
  const copy = new DatabaseSync(prepared, { readOnly: true });
  try { assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); }
  finally { copy.close(); }
});

test('sqlite: WAL ou SHM vazio e hardlink recusam antes de abrir origem', async t => {
  for (const suffix of ['-wal', '-shm']) {
    const { source, output } = areaSintetica(t);
    writeFileSync(source, 'arquivo sintético');
    writeFileSync(`${source}${suffix}`, '');
    const result = await runDiagnostic(source, output);
    assert.equal(result.status, 1);
    assert.equal(result.receipt.codigoFilho, 'ORIGEM_OCUPADA');
    assert.equal(existsSync(join(output, 'prepared.sqlite')), false);
  }
  const { dir, source, output } = areaSintetica(t);
  writeFileSync(source, 'arquivo sintético');
  linkSync(source, join(dir, 'alias.sqlite'));
  const linked = await runDiagnostic(source, output);
  assert.equal(linked.receipt.codigoFilho, 'ORIGEM_INSEGURA');
});

test('sqlite: fila operacional ativa produz falha explícita sem reescrever origem', async t => {
  const { source, output } = areaSintetica(t);
  await criarLegado(source, { filaAnalisando: true });
  const before = createHash('sha256').update(readFileSync(source)).digest('hex');
  const result = await runDiagnostic(source, output);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.codigoFilho, 'MIGRACAO_ALTERARIA_DADOS');
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), before);
  assert.equal(existsSync(join(output, 'prepared.sqlite')), true);
});

test('sqlite: tabela G povoada é diagnosticada sem limpeza da cópia', async t => {
  const { source, output } = areaSintetica(t);
  await criarLegado(source, { projetoG: true });
  const result = await runDiagnostic(source, output);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.codigoFilho, 'G_POVOADA');
  assert.equal(existsSync(join(output, 'prepared.sqlite')), true);
});

test('sqlite: fila de retomada posterior ao v9 na origem permanece fora do catálogo legado', async t => {
  const { source, output } = areaSintetica(t);
  await criarLegado(source);
  const { abrirBanco } = await import('../src/banco.js');
  const db = abrirBanco(source);
  try {
    db.exec(`CREATE TABLE wa_fila_retomada (
      interrupcao_id TEXT NOT NULL REFERENCES wa_interrupcoes(id) ON DELETE CASCADE,
      conversa_id TEXT NOT NULL, estado TEXT NOT NULL,
      tentativas INTEGER NOT NULL DEFAULT 0, proxima_tentativa_em TEXT,
      ultimo_erro TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL,
      PRIMARY KEY(interrupcao_id,conversa_id))`);
    assert.deepEqual(db.prepare('PRAGMA table_list').all()
      .filter(row => row.schema === 'main' && row.name.startsWith('wa_')).map(row => row.name),
      ['wa_fila_retomada']);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode=DELETE');
  } finally { db.close(); }
  const before = createHash('sha256').update(readFileSync(source)).digest('hex');
  const result = await runDiagnostic(source, output);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.codigoFilho, 'SCHEMA_NAO_MAPEADO');
  assert.equal(result.receipt.recibo.fase, 'inventario');
  assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), before);
});

test('sqlite: fila criada pela migração exige tipos, obrigatoriedade, default e ausência de jobs', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { validarFilaDiagnostica } = await import('../scripts/diagnostic-copy-migration.mjs');
  const { prepararHistoricoWhatsApp } = await import('../src/transporte/historico.js');
  const ddl = `CREATE TABLE wa_fila_retomada (
    interrupcao_id TEXT NOT NULL REFERENCES wa_interrupcoes(id) ON DELETE CASCADE,
    conversa_id TEXT NOT NULL, estado TEXT NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0, proxima_tentativa_em TEXT,
    ultimo_erro TEXT, criado_em TEXT NOT NULL, atualizado_em TEXT NOT NULL,
    PRIMARY KEY(interrupcao_id,conversa_id))`;
  for (const mutation of [
    sql => sql,
    sql => sql.replace('estado TEXT NOT NULL', 'estado BLOB NOT NULL'),
    sql => sql.replace('tentativas INTEGER NOT NULL DEFAULT 0', 'tentativas INTEGER NOT NULL DEFAULT 1'),
    sql => sql.replace('criado_em TEXT NOT NULL', 'criado_em TEXT'),
    sql => sql.replace('PRIMARY KEY(interrupcao_id,conversa_id)',
      'extra TEXT GENERATED ALWAYS AS (estado) VIRTUAL, PRIMARY KEY(interrupcao_id,conversa_id)'),
    sql => sql.replace('ON DELETE CASCADE', 'ON UPDATE CASCADE ON DELETE CASCADE'),
    sql => sql.replace('estado TEXT NOT NULL', 'estado TEXT NOT NULL CHECK(length(estado)>0)'),
    sql => sql.replace('conversa_id TEXT NOT NULL', 'conversa_id TEXT NOT NULL COLLATE NOCASE'),
    sql => sql.replace('PRIMARY KEY(interrupcao_id,conversa_id)',
      'UNIQUE(estado), PRIMARY KEY(interrupcao_id,conversa_id)'),
    sql => `${sql} STRICT`,
    sql => `${sql} WITHOUT ROWID`,
  ]) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE eventos(id INTEGER PRIMARY KEY, conversa_id TEXT)');
      prepararHistoricoWhatsApp(db);
      if (mutation(ddl) !== ddl) {
        db.exec('DROP TABLE wa_fila_retomada');
        db.exec(mutation(ddl));
        db.exec('CREATE INDEX wa_fila_retomada_ordem ON wa_fila_retomada(estado,proxima_tentativa_em,criado_em)');
      }
      if (mutation(ddl) === ddl) {
        assert.equal(validarFilaDiagnostica(db), true);
        db.prepare('INSERT INTO wa_interrupcoes(id,inicio,motivo) VALUES(?,?,?)').run('i1', '2026-01-01', 'teste');
        db.prepare(`INSERT INTO wa_fila_retomada
          (interrupcao_id,conversa_id,estado,criado_em,atualizado_em) VALUES(?,?,?,?,?)`)
          .run('i1', 'c1', 'pendente', '2026-01-01', '2026-01-01');
        assert.throws(() => validarFilaDiagnostica(db), { code: 'MIGRACAO_ALTERARIA_DADOS' });
      } else assert.throws(() => validarFilaDiagnostica(db), { code: 'SCHEMA_NAO_MAPEADO' });
    } finally { db.close(); }
  }
});

test('sqlite: extensão da fila exige índice e gatilho canônicos sem objetos extras', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { prepararHistoricoWhatsApp } = await import('../src/transporte/historico.js');
  const { validarFilaDiagnostica } = await import('../scripts/diagnostic-copy-migration.mjs');
  const variants = [
    db => db.exec('DROP INDEX wa_fila_retomada_ordem'),
    db => db.exec('DROP INDEX wa_fila_retomada_ordem; CREATE INDEX wa_fila_retomada_ordem ON wa_fila_retomada(estado DESC)'),
    db => db.exec('DROP INDEX wa_fila_retomada_ordem; CREATE UNIQUE INDEX wa_fila_retomada_ordem ON wa_fila_retomada(estado,proxima_tentativa_em,criado_em)'),
    db => db.exec('DROP INDEX wa_fila_retomada_ordem; CREATE INDEX wa_fila_retomada_ordem ON wa_fila_retomada(estado) WHERE estado IS NOT NULL'),
    db => db.exec('CREATE INDEX fila_extra ON wa_fila_retomada(estado)'),
    db => db.exec('DROP TRIGGER wa_fila_retomada_removida'),
    db => db.exec('DROP TRIGGER wa_fila_retomada_removida; CREATE TRIGGER wa_fila_retomada_removida AFTER DELETE ON eventos BEGIN SELECT 1; END'),
    db => db.exec('CREATE TRIGGER fila_extra AFTER INSERT ON wa_fila_retomada BEGIN SELECT 1; END'),
    db => db.exec('DROP TABLE wa_fila_retomada'),
  ];
  for (const mutate of variants) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE eventos(id INTEGER PRIMARY KEY, conversa_id TEXT)');
      prepararHistoricoWhatsApp(db);
      assert.equal(validarFilaDiagnostica(db), true);
      mutate(db);
      assert.throws(() => validarFilaDiagnostica(db), { code: 'SCHEMA_NAO_MAPEADO' });
    } finally { db.close(); }
  }
});

for (const kind of ['trigger', 'index', 'trigger-uppercase', 'index-uppercase']) {
  test(`sqlite: ${kind} com nome da fila na origem não sequestra a migração`, async t => {
    const { source, output } = areaSintetica(t);
    await criarLegado(source);
    const { abrirBanco } = await import('../src/banco.js');
    const db = abrirBanco(source);
    try {
      const name = kind.endsWith('-uppercase')
        ? (kind.startsWith('trigger') ? 'WA_FILA_RETOMADA_REMOVIDA' : 'WA_FILA_RETOMADA_ORDEM')
        : (kind.startsWith('trigger') ? 'wa_fila_retomada_removida' : 'wa_fila_retomada_ordem');
      if (kind.startsWith('trigger')) db.exec(`CREATE TRIGGER ${name} AFTER DELETE ON eventos BEGIN SELECT 1; END`);
      else db.exec(`CREATE INDEX ${name} ON eventos(texto)`);
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('PRAGMA journal_mode=DELETE');
    } finally { db.close(); }
    const before = createHash('sha256').update(readFileSync(source)).digest('hex');
    const result = await runDiagnostic(source, output);
    assert.equal(result.status, 1, `${kind}: ${JSON.stringify(result.receipt)}`);
    assert.equal(result.receipt.codigoFilho, 'SCHEMA_NAO_MAPEADO');
    assert.equal(result.receipt.recibo.fase, 'inventario');
    assert.equal(result.receipt.recibo.origemIntacta, true);
    assert.equal(result.receipt.recibo.dbFechado, true);
    assert.equal(result.receipt.processo.fechamentoConfirmado, true);
    assert.equal(result.receipt.recibo.tabelasNovas, 0);
    assert.equal(existsSync(join(output, 'prepared.sqlite')), true);
    assert.equal(existsSync(`${source}-wal`), false);
    assert.equal(existsSync(`${source}-shm`), false);
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), before);
  });
}

test('sqlite: raiz não vazia é recusada sem apagar seus arquivos', async t => {
  const { source, output } = areaSintetica(t);
  writeFileSync(source, 'arquivo sintético');
  const marker = join(output, 'marcador.txt');
  writeFileSync(marker, 'teste');
  const result = await runDiagnostic(source, output);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.codigoFilho, 'DESTINO_INSEGURO');
  assert.equal(readFileSync(marker, 'utf8'), 'teste');
});

test('sqlite: raiz sobreposta à origem é recusada', async t => {
  const { output } = areaSintetica(t);
  const source = join(output, 'legado.sqlite');
  writeFileSync(source, 'arquivo sintético');
  const result = await runDiagnostic(source, output);
  assert.equal(result.status, 1);
  assert.equal(result.receipt.codigoFilho, 'DESTINO_INSEGURO');
  assert.equal(readFileSync(source, 'utf8'), 'arquivo sintético');
});

test('sqlite: digest tipado distingue TEXT de BLOB e PK bigint exata', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { resumirTabelaDiagnostica } = await import('../scripts/diagnostic-copy-migration.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE conversas_app(id INTEGER PRIMARY KEY,nome TEXT)');
    db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(9007199254740995n, 'abc');
    const text = await resumirTabelaDiagnostica(db, 'conversas_app');
    db.prepare('UPDATE conversas_app SET nome=?').run(Buffer.from('abc'));
    const blob = await resumirTabelaDiagnostica(db, 'conversas_app');
    assert.notEqual(blob.hash, text.hash);
    db.prepare('UPDATE conversas_app SET id=?').run(9007199254740997n);
    const changedPk = await resumirTabelaDiagnostica(db, 'conversas_app');
    assert.notEqual(changedPk.hash, blob.hash);
    assert.deepEqual(changedPk.pk, ['id']);
    assert.equal(changedPk.rows, 1);
    db.exec(`CREATE TABLE conversas_app_nova(id INTEGER PRIMARY KEY,nome BLOB);
      INSERT INTO conversas_app_nova SELECT * FROM conversas_app;
      DROP TABLE conversas_app;
      ALTER TABLE conversas_app_nova RENAME TO conversas_app`);
    await assert.rejects(resumirTabelaDiagnostica(db, 'conversas_app', changedPk),
      error => error.code === 'DADOS_PREEXISTENTES_ALTERADOS');
  } finally { db.close(); }
});

test('sqlite: tabela sem PK e NOCASE conserva digest com ordem de inserção inversa', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { resumirTabelaDiagnostica } = await import('../scripts/diagnostic-copy-migration.mjs');
  const digests = [];
  for (const valores of [['A', 'a'], ['a', 'A']]) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE conversas_app(nome TEXT COLLATE NOCASE)');
      for (const valor of valores) db.prepare('INSERT INTO conversas_app VALUES(?)').run(valor);
      const result = await resumirTabelaDiagnostica(db, 'conversas_app');
      assert.equal(result.rows, 2);
      digests.push(result.hash);
    } finally { db.close(); }
  }
  assert.equal(digests[0], digests[1]);
});

test('sqlite: digest sem PK distingue INTEGER de REAL', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { resumirTabelaDiagnostica } = await import('../scripts/diagnostic-copy-migration.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE conversas_app(valor); INSERT INTO conversas_app VALUES(1)');
    assert.equal(db.prepare('SELECT typeof(valor) AS tipo FROM conversas_app').get().tipo, 'integer');
    const inteiro = await resumirTabelaDiagnostica(db, 'conversas_app');
    db.exec('DELETE FROM conversas_app; INSERT INTO conversas_app VALUES(1.0)');
    assert.equal(db.prepare('SELECT typeof(valor) AS tipo FROM conversas_app').get().tipo, 'real');
    const real = await resumirTabelaDiagnostica(db, 'conversas_app');
    assert.notEqual(inteiro.hash, real.hash);
  } finally { db.close(); }
});

test('sqlite: digest detecta mutação tipada em tabelas I, G e X', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { resumirTabelaDiagnostica } = await import('../scripts/diagnostic-copy-migration.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    for (const table of ['conversas_app', 'projetos', 'politicas_conversa']) {
      db.exec(`CREATE TABLE "${table}"(id INTEGER PRIMARY KEY,payload TEXT)`);
      db.prepare(`INSERT INTO "${table}" VALUES(?,?)`).run(9007199254740995n, 'abc');
      const baseline = await resumirTabelaDiagnostica(db, table);
      db.prepare(`UPDATE "${table}" SET payload=?`).run(Buffer.from('abc'));
      const blob = await resumirTabelaDiagnostica(db, table);
      assert.notEqual(blob.hash, baseline.hash, table);
      db.prepare(`UPDATE "${table}" SET id=?`).run(9007199254740997n);
      const pk = await resumirTabelaDiagnostica(db, table);
      assert.notEqual(pk.hash, blob.hash, table);
    }
  } finally { db.close(); }
});

test('sqlite: segunda passagem não idempotente recebe código próprio', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { resumirTabelaDiagnostica, conferirSegundaPassagem } = await import('../scripts/diagnostic-copy-migration.mjs');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE conversas_app(id INTEGER PRIMARY KEY,payload TEXT)');
    db.prepare('INSERT INTO conversas_app VALUES(?,?)').run(1n, 'antes');
    const afterFirst = new Map([['conversas_app', await resumirTabelaDiagnostica(db, 'conversas_app')]]);
    db.prepare('UPDATE conversas_app SET payload=?').run('depois');
    const catalog = [{ nome: 'conversas_app', decisao: 'I', colunas: ['id', 'payload'], pk: ['id'] }];
    await assert.rejects(conferirSegundaPassagem(db, catalog, afterFirst),
      error => error.code === 'SEGUNDA_PASSAGEM_NAO_IDEMPOTENTE');
  } finally { db.close(); }
});

test('origem offline detecta troca de conteúdo e identidade sem abrir SQLite', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lume-03a20-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'legado.sqlite');
  writeFileSync(source, 'abc');
  const { capturarOrigemOffline, confirmarOrigemOffline } = await import('../scripts/diagnostic-copy-migration.mjs');
  const baseline = await capturarOrigemOffline(source);
  writeFileSync(source, 'xyz');
  await assert.rejects(confirmarOrigemOffline(source, baseline), error => error.code === 'ORIGEM_MUDOU');
  writeFileSync(source, 'abc');
  const replacement = join(dir, 'substituto.sqlite');
  writeFileSync(replacement, 'abc');
  renameSync(source, join(dir, 'antigo.sqlite'));
  renameSync(replacement, source);
  await assert.rejects(confirmarOrigemOffline(source, baseline), error => error.code === 'ORIGEM_MUDOU');
});

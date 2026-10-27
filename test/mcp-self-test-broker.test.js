import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { abrirBanco } from '../src/banco.js';
import { ContextoApp } from '../src/contexto-app.js';
import { Desktop } from '../src/desktop.js';
import { LumeMcpDesktopService, runPackagedStdio } from '../src/mcp/desktop-service.js';
import { startLumeAppPresence } from '../src/mcp/presence.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function synthetic(t) {
  const parent = mkdtempSync(join(homedir(), 'lume-self-test-broker-'));
  t.after(() => rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  const dataDir = join(parent, 'AssessorDesktop', 'data');
  mkdirSync(dataDir, { recursive: true });
  const database = join(dataDir, 'assessor.db');
  const db = abrirBanco(database); new ContextoApp(db); new Desktop(db);
  db.prepare('INSERT INTO conversas_app VALUES(?,?)').run('teste@g.us', 'Equipe sintética');
  db.prepare(`INSERT INTO eventos(conversa_id,origem_id,direcao,autor_id,autor_e_dono,tipo,bruto,texto,recebido_em,dia_local,permissao)
    VALUES('teste@g.us','self-test-own','saida','eu',1,'texto','{}','Acordo sintético de hoje','2026-09-19T12:00:00.000Z','2026-09-19','minha')`).run();
  db.close();
  return { parent, dataDir, database };
}

test('autoteste usa broker/ACL reais no snapshot, fecha com recibos e preserva original', async t => {
  if (process.platform !== 'win32') return t.skip('ACL Windows real');
  const fixture = synthetic(t), before = hash(readFileSync(fixture.database));
  const presence = startLumeAppPresence({ dataDir: fixture.dataDir });
  t.after(() => presence.stop());
  const service = new LumeMcpDesktopService({ dataDir: fixture.dataDir, packageRoot: resolve('.'), now: () => new Date('2026-09-19T15:00:00.000Z') });
  service.ativarClaudeHoje({ confirmar: true });
  const originalActivation = readFileSync(join(fixture.dataDir, 'mcp', 'claude-desktop.json'));
  const result = await service.testarClaudeLocal();
  assert.equal(result.ok, true);
  assert.equal(result.claude_conectado, false);
  assert.deepEqual(result.provas, { pacote: true, configuracao: true, leitura_local: true, transporte_stdio: true });
  assert.equal(hash(readFileSync(fixture.database)), before);
  assert.deepEqual(readFileSync(join(fixture.dataDir, 'mcp', 'claude-desktop.json')), originalActivation);
  assert.equal(existsSync(join(fixture.parent, 'AssessorDesktop', 'broker-control')), false);
  assert.equal(JSON.stringify(result).includes(fixture.parent), false);
});

test('stdio de autoteste não confirma saída antecipada ou exit 1', async t => {
  const parent = mkdtempSync(join(homedir(), 'lume-self-test-process-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const [name, body] of [
    ['early', 'process.exit(0)'],
    ['failed', 'process.exit(1)'],
    ['proofs-then-failed', `
      const tools=['lume_resumo_do_dia','lume_buscar_contexto','lume_abrir_fonte','lume_listar_pendencias','lume_listar_negocios'].map(name=>({name}));
      for(const value of [
        {id:1,result:{serverInfo:{name:'lume'}}},
        {id:2,result:{structuredContent:{ok:true,items:[]}}},
        {id:3,result:{tools}},
        {id:4,error:{code:-32602}}
      ]) process.stdout.write(JSON.stringify(value)+'\\n');
      setTimeout(()=>process.exit(1),10);
    `]
  ]) {
    const entry = join(parent, name, 'server', 'index.js');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, body);
    await assert.rejects(runPackagedStdio({ entry, profileEnv: { APPDATA: parent }, credential: 'synthetic-credential', timeoutMs: 2000 }), /SELF_TEST_(?:EARLY_EXIT|PROCESS)/);
  }
});

test('stdio de autoteste trata timeout/kill como incerto', async t => {
  const parent = mkdtempSync(join(homedir(), 'lume-self-test-hang-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const entry = join(parent, 'server', 'index.js');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, 'setInterval(() => {}, 1000);');
  await assert.rejects(runPackagedStdio({ entry, profileEnv: { APPDATA: parent }, credential: 'synthetic-credential', timeoutMs: 200 }), error => {
    assert.equal(error.message, 'SELF_TEST_TIMEOUT');
    assert.equal(error.uncertain, true);
    return true;
  });
  assert.equal(existsSync(entry), true, 'helper não remove staging ao matar processo');
});

test('autoteste não aceita plataforma injetada para escolher outro perfil', async t => {
  const fixture = synthetic(t);
  const presence = startLumeAppPresence({ dataDir: fixture.dataDir });
  t.after(() => presence.stop());
  const other = process.platform === 'win32' ? 'darwin' : 'win32';
  const service = new LumeMcpDesktopService({ dataDir: fixture.dataDir, packageRoot: resolve('.'), platform: other });
  service.ativarClaudeHoje({ confirmar: true });
  await assert.rejects(service.testarClaudeLocal(), { code: 'SISTEMA_INCOMPATIVEL' });
  assert.equal(existsSync(join(fixture.dataDir, 'mcp', 'packages')), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLumeMcpb, inspectStoredMcpb } from '../scripts/build-lume-mcpb.mjs';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function fixture(t) {
  const parent = mkdtempSync(join(tmpdir(), 'lume-entrypoint-'));
  const userData = process.platform === 'darwin' ? join(parent, 'Library', 'Application Support', 'AssessorDesktop') : join(parent, 'AssessorDesktop');
  mkdirSync(userData, { recursive: true });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, userData };
}

function managed(userData) {
  const data = join(userData, 'profiles', ID, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'assessor.db'), 'synthetic-db');
  const info = statSync(data, { bigint: true });
  writeFileSync(join(userData, 'perfil-ativo.json'), JSON.stringify({ schema: 1, id: ID, geracao: GENERATION, diretorio: { dev: String(info.dev), ino: String(info.ino) } }));
}

function child(args, env) {
  return spawnSync(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000, windowsHide: true });
}

test('utility recusa envelope ausente, alterado e gerido antes de DB e cofre', t => {
  for (const kind of ['missing', 'generation', 'id', 'journal', 'managed']) {
    const { userData } = fixture(t);
    if (kind === 'managed') managed(userData);
    if (kind === 'journal') writeFileSync(join(userData, 'perfil-publicacao.json'), '{}');
    const env = {
      ASSESSOR_DESKTOP_USER_DATA: userData,
      ASSESSOR_DESKTOP_PROFILE_ID: kind === 'id' ? 'antigo' : 'legado',
      ASSESSOR_DESKTOP_PROFILE_GENERATION: kind === 'generation' ? GENERATION : '',
      ASSESSOR_DESKTOP_DATA: join(userData, 'data')
    };
    if (kind === 'missing') delete env.ASSESSOR_DESKTOP_USER_DATA;
    const run = child(['desktop/service.js'], env);
    assert.notEqual(run.status, 0, `${kind}: ${run.error?.message ?? ''}`);
    assert.match(run.stderr, /PERFIL_(?:ENVELOPE_INVALIDO|RECUPERACAO_PENDENTE|GERIDO_AGUARDANDO_BROKER)/);
    assert.equal(run.stderr.includes(userData), false);
    assert.equal(readdirSync(userData).includes('data'), false);
    assert.equal(readdirSync(userData).includes('credenciais'), false);
  }
});

test('launcher MCPB recusa journal, seletor inválido, profiles sem seletor e gerido sem criar DB', t => {
  if (!['win32', 'darwin'].includes(process.platform)) return t.skip('Plataforma do MCPB não suportada');
  const packageBase = mkdtempSync(join(tmpdir(), 'lume-entrypoint-package-'));
  t.after(() => rmSync(packageBase, { recursive: true, force: true }));
  const built = buildLumeMcpb({ outputDir: join(packageBase, 'out') });
  const extracted = join(packageBase, 'unpacked');
  for (const entry of inspectStoredMcpb(readFileSync(built.artifact))) {
    const target = join(extracted, ...entry.name.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, entry.data);
  }
  for (const kind of ['journal', 'corrupt', 'profiles', 'managed',
    'maintenance-empty', 'maintenance-invalid', 'maintenance-directory', 'maintenance-link',
    'delete-empty', 'delete-invalid', 'delete-directory', 'delete-link']) {
    const { parent, userData } = fixture(t);
    if (kind === 'journal') writeFileSync(join(userData, 'perfil-publicacao.json'), '{}');
    if (kind === 'corrupt') writeFileSync(join(userData, 'perfil-ativo.json'), '{}');
    if (kind === 'profiles') mkdirSync(join(userData, 'profiles'));
    if (kind === 'managed') managed(userData);
    if (kind.startsWith('maintenance-') || kind.startsWith('delete-')) {
      const marker = kind.startsWith('maintenance-') ? 'perfil-manutencao.json' : 'notetaker-delete-journal';
      const target = join(userData, marker);
      if (kind.endsWith('-directory')) mkdirSync(target);
      else if (kind.endsWith('-link')) {
        const destination = join(userData, 'destino');
        mkdirSync(destination);
        symlinkSync(destination, target, process.platform === 'win32' ? 'junction' : 'dir');
      } else writeFileSync(target, kind.endsWith('-empty') ? '' : '{ inválido');
    }
    const env = process.platform === 'win32' ? { APPDATA: parent } : { HOME: parent };
    const run = child([join(extracted, 'server', 'index.js')], { ...env, LUME_MCP_DATA_DIR: join(parent, 'forbidden'), LUME_MCP_CREDENTIAL: 'synthetic-only' });
    assert.notEqual(run.status, 0, `${kind}: ${run.error?.message ?? ''}`);
    assert.match(run.stderr, kind.startsWith('maintenance-') || kind.startsWith('delete-')
      ? /PERFIL_MANUTENCAO_PENDENTE/ : /PERFIL_(?:RECUPERACAO_PENDENTE|SELETOR_INVALIDO|SELECAO_PENDENTE|GERIDO_AGUARDANDO_BROKER)/);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr.includes(parent), false);
    assert.equal(readdirSync(userData).includes('data'), false);
    assert.equal(readdirSync(userData).includes('credenciais'), false);
  }
  rmSync(join(extracted, 'src', 'perfil-boot.js'));
  const { parent } = fixture(t);
  const env = process.platform === 'win32' ? { APPDATA: parent } : { HOME: parent };
  const broken = child([join(extracted, 'server', 'index.js')], { ...env, LUME_MCP_CREDENTIAL: 'synthetic-only' });
  assert.notEqual(broken.status, 0);
  assert.equal(broken.stderr.trim(), 'PERFIL_VERIFICACAO_FALHOU: O Lume não conseguiu verificar o perfil.');
  assert.equal(broken.stderr.includes(parent), false);
  assert.equal(broken.stderr.includes('at '), false);
});

test('stdio direto e env de caminho divergente falham antes de SQLite', t => {
  const { userData } = fixture(t);
  const code = `const {startFromEnvironment}=await import('./src/mcp/stdio-entry.js');try{await startFromEnvironment({version:'3.2.0-beta.6',userData:process.env.LUME_TEST_USER_DATA,expectedSelection:process.env.LUME_TEST_DIRECT?undefined:{tipo:'legado',id:'legado',geracao:null}});process.exitCode=9}catch(error){process.stderr.write(String(error.code)+'\\n');process.exitCode=1}`;
  for (const kind of ['direct', 'divergent']) {
    const env = { LUME_TEST_USER_DATA: userData, LUME_TEST_DIRECT: kind === 'direct' ? '1' : '', LUME_MCP_DATABASE: join(userData, 'forbidden.db') };
    const run = child(['--input-type=module', '-e', code], env);
    assert.equal(run.status, 1, `${kind}: ${run.error?.message ?? run.stderr}`);
    assert.match(run.stderr, kind === 'direct' ? /PERFIL_SELECAO_INVALIDA/ : /PERFIL_CAMINHO_DIVERGENTE/);
    assert.equal(run.stderr.includes(userData), false);
    assert.deepEqual(readdirSync(userData), []);
  }
});

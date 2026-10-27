import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepararRaizElectron, selecionarPerfilBoot, envelopeLegado, validarEnvelopeLegado, userDataMcp, validarSelecaoEsperada, erroPublicoPerfil } from '../src/perfil-boot.js';

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'lume-boot-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, userData: path.join(parent, 'AssessorDesktop') };
}

test('primeiro boot cria somente a raiz Electron e preserva legado existente', async t => {
  const { userData } = await fixture(t);
  await prepararRaizElectron(userData);
  assert.deepEqual(await readdir(userData), []);
  const selection = await selecionarPerfilBoot(userData);
  assert.deepEqual([selection.tipo, selection.id, selection.geracao, selection.dataDir], ['legado', 'legado', null, path.join(userData, 'data')]);
  await mkdir(selection.dataDir);
  await writeFile(path.join(selection.dataDir, 'sentinela'), 'bytes-legado');
  assert.deepEqual(await validarEnvelopeLegado(envelopeLegado(userData, selection)), selection);
  assert.equal(await readFile(path.join(selection.dataDir, 'sentinela'), 'utf8'), 'bytes-legado');
});

test('seletores suspeitos e gerido recusam antes de criar data', async t => {
  for (const kind of ['journal', 'corrupt', 'profiles', 'managed']) {
    const { userData } = await fixture(t);
    await prepararRaizElectron(userData);
    if (kind === 'journal') await writeFile(path.join(userData, 'perfil-publicacao.json'), '{}');
    if (kind === 'corrupt') await writeFile(path.join(userData, 'perfil-ativo.json'), '{}');
    if (kind === 'profiles') await mkdir(path.join(userData, 'profiles'));
    if (kind === 'managed') {
      const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const dataDir = path.join(userData, 'profiles', id, 'data');
      await mkdir(dataDir, { recursive: true });
      await writeFile(path.join(dataDir, 'assessor.db'), 'sintetico');
      const info = await stat(dataDir, { bigint: true });
      await writeFile(path.join(userData, 'perfil-ativo.json'), JSON.stringify({ schema: 1, id, geracao: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', diretorio: { dev: String(info.dev), ino: String(info.ino) } }));
    }
    const code = { journal: 'PERFIL_RECUPERACAO_PENDENTE', corrupt: 'PERFIL_SELETOR_INVALIDO', profiles: 'PERFIL_SELECAO_PENDENTE', managed: 'PERFIL_GERIDO_AGUARDANDO_BROKER' }[kind];
    await assert.rejects(() => selecionarPerfilBoot(userData), { code, message: code });
    assert.equal((await readdir(userData)).includes('data'), false);
  }
});

test('envelope exige campos exatos e seleção revalidada', async t => {
  const { userData } = await fixture(t);
  await prepararRaizElectron(userData);
  const selection = await selecionarPerfilBoot(userData);
  const env = envelopeLegado(userData, selection);
  for (const invalid of [
    { ...env, ASSESSOR_DESKTOP_USER_DATA: undefined },
    { ...env, ASSESSOR_DESKTOP_PROFILE_ID: 'outro' },
    { ...env, ASSESSOR_DESKTOP_PROFILE_GENERATION: 'antiga' },
    { ...env, ASSESSOR_DESKTOP_PROFILE_EXTRA: 'invalido' },
    { ...env, ASSESSOR_DESKTOP_DATA: path.join(userData, 'outra') }
  ]) await assert.rejects(() => validarEnvelopeLegado(invalid), { code: 'PERFIL_ENVELOPE_INVALIDO' });
  assert.deepEqual(await validarEnvelopeLegado(env), selection);
  assert.deepEqual(validarSelecaoEsperada(selection, { tipo: 'legado', id: 'legado', geracao: null }), selection);
  assert.throws(() => validarSelecaoEsperada(selection, { tipo: 'legado', id: 'legado', geracao: 'antiga' }), { code: 'PERFIL_SELECAO_ALTERADA' });
  await writeFile(path.join(userData, 'perfil-publicacao.json'), '{}');
  await assert.rejects(() => validarEnvelopeLegado(env), { code: 'PERFIL_RECUPERACAO_PENDENTE' });
});

test('MCP deriva raiz apenas da plataforma e ambiente local', () => {
  assert.equal(userDataMcp({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Teste\\AppData\\Roaming' } }), path.join('C:\\Users\\Teste\\AppData\\Roaming', 'AssessorDesktop'));
  assert.equal(userDataMcp({ platform: 'darwin', env: { HOME: '/tmp/lume-teste' } }), '/tmp/lume-teste/Library/Application Support/AssessorDesktop');
  assert.throws(() => userDataMcp({ platform: 'linux', env: {} }), { code: 'PERFIL_CAMINHO_INVALIDO' });
});

test('erro público publica só códigos conhecidos e texto fixo', () => {
  assert.deepEqual(erroPublicoPerfil({ code: 'PERFIL_CODIGO_INVENTADO', message: 'C:\\segredo' }), { code: 'PERFIL_VERIFICACAO_FALHOU', message: 'O Lume não conseguiu verificar o perfil.' });
  assert.deepEqual(erroPublicoPerfil({ code: 'PERFIL_GERIDO_AGUARDANDO_BROKER', message: 'C:\\segredo' }), { code: 'PERFIL_GERIDO_AGUARDANDO_BROKER', message: 'Este perfil ainda não pode ser aberto nesta versão do Lume.' });
  assert.deepEqual(erroPublicoPerfil({ code: 'PERFIL_SELETOR_INVALIDO', message: 'C:\\segredo' }), { code: 'PERFIL_SELETOR_INVALIDO', message: 'A seleção do perfil precisa ser verificada.' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolverPerfilAtivo } from '../src/perfil-ativo.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'lume-perfil-ativo-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^lume-perfil-ativo-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function selectorFor(info, patch = {}) {
  return {
    schema: 1,
    id: ID,
    geracao: GENERATION,
    diretorio: { dev: info.dev.toString(), ino: info.ino.toString() },
    ...patch,
  };
}

async function managed(root) {
  const dataDir = path.join(root, 'profiles', ID, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'assessor.db'), 'synthetic-db');
  const info = await stat(dataDir, { bigint: true });
  await writeFile(path.join(root, 'perfil-ativo.json'), JSON.stringify(selectorFor(info)));
  return { dataDir, info };
}

async function rejectsCode(action, code, secret = '') {
  await assert.rejects(action, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    if (secret) assert.equal(error.stack?.includes(secret), false);
    return true;
  });
}

test('primeiro boot e legado existente são somente leitura', async (t) => {
  const root = await fixture(t);
  const first = await resolverPerfilAtivo({ userData: root });
  assert.deepEqual(first, {
    tipo: 'legado', id: 'legado', geracao: null,
    dataDir: path.join(root, 'data'), credenciaisDir: path.join(root, 'credenciais'),
  });
  assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(await readdir(root), []);
  await mkdir(first.dataDir);
  await mkdir(first.credenciaisDir);
  await writeFile(path.join(first.dataDir, 'sentinela'), 'intacto');
  assert.equal((await resolverPerfilAtivo({ userData: root })).tipo, 'legado');
  assert.equal(await readFile(path.join(first.dataDir, 'sentinela'), 'utf8'), 'intacto');
});

test('perfil gerido aceita identidade exata e caminho derivado', async (t) => {
  const root = await fixture(t);
  const { dataDir, info } = await managed(root);
  const selectorBytes = await readFile(path.join(root, 'perfil-ativo.json'));
  const selected = await resolverPerfilAtivo({ userData: root });
  assert.deepEqual(selected, {
    tipo: 'gerido', id: ID, geracao: GENERATION, dataDir,
    credenciaisDir: path.join(root, 'profiles', ID, 'credenciais'),
  });
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(info.ino.toString(), JSON.parse(await readFile(path.join(root, 'perfil-ativo.json'), 'utf8')).diretorio.ino);
  assert.equal((await readFile(path.join(root, 'perfil-ativo.json'))).equals(selectorBytes), true);
});

test('seletor parcial, extra, protótipo e UTF-8 inválido são recusados sem fallback', async (t) => {
  const root = await fixture(t);
  const { info } = await managed(root);
  const file = path.join(root, 'perfil-ativo.json');
  const cases = [
    '{}',
    JSON.stringify(selectorFor(info, { extra: 'no' })),
    JSON.stringify(selectorFor(info)).replace('"schema":1', '"__proto__":{},"schema":1'),
    Buffer.from([0xff]),
  ];
  for (const content of cases) {
    await writeFile(file, content);
    await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_SELETOR_INVALIDO', root);
  }
  assert.equal(await readFile(file).then((buffer) => buffer.equals(Buffer.from([0xff]))), true);
});

test('teto de 4096 bytes e campos de caminho/UUID inválidos', async (t) => {
  const root = await fixture(t);
  const { info } = await managed(root);
  const file = path.join(root, 'perfil-ativo.json');
  for (const object of [
    selectorFor(info, { id: '../other' }),
    selectorFor(info, { id: ID.toUpperCase() }),
    selectorFor(info, { geracao: 'not-uuid' }),
    selectorFor(info, { path: 'C:/secret' }),
    selectorFor(info, { diretorio: { dev: '01', ino: info.ino.toString() } }),
    selectorFor(info, { diretorio: { dev: '18446744073709551616', ino: info.ino.toString() } }),
  ]) {
    await writeFile(file, JSON.stringify(object));
    await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_SELETOR_INVALIDO', root);
  }
  await writeFile(file, ' '.repeat(4097));
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_SELETOR_INVALIDO', root);
});

test('destino ausente, DB ausente e identidade trocada recusam seleção', async (t) => {
  const root = await fixture(t);
  const { dataDir, info } = await managed(root);
  await writeFile(path.join(root, 'perfil-ativo.json'), JSON.stringify(selectorFor(info, { diretorio: { dev: info.dev.toString(), ino: (info.ino + 1n).toString() } })));
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_IDENTIDADE_DIVERGENTE', root);
  await writeFile(path.join(root, 'perfil-ativo.json'), JSON.stringify(selectorFor(info)));
  await rm(path.join(dataDir, 'assessor.db'));
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_DESTINO_INVALIDO', root);
  await rm(dataDir, { recursive: true });
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_DESTINO_INVALIDO', root);
});

test('identidade decimal divergente é recusada', async (t) => {
  const root = await fixture(t);
  const { info } = await managed(root);
  const file = path.join(root, 'perfil-ativo.json');
  await writeFile(file, JSON.stringify(selectorFor(info, {
    diretorio: { dev: info.dev.toString(), ino: '9007199254740993' },
  })));
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_IDENTIDADE_DIVERGENTE', root);
});

test('colisão Number em inode acima de 2^53 é recusada se a plataforma permitir', async (t) => {
  const root = await fixture(t);
  const { info } = await managed(root);
  if (info.ino <= BigInt(Number.MAX_SAFE_INTEGER)) {
    t.skip('inode nativo da fixture não ultrapassa 2^53; colisão Number indisponível');
    return;
  }
  const adjacent = [info.ino - 1n, info.ino + 1n]
    .find((candidate) => candidate >= 0n && candidate <= 18446744073709551615n &&
      Number(candidate) === Number(info.ino));
  if (adjacent === undefined) {
    t.skip('inode nativo não tem decimal adjacente com o mesmo Number');
    return;
  }
  await writeFile(path.join(root, 'perfil-ativo.json'), JSON.stringify(selectorFor(info, {
    diretorio: { dev: info.dev.toString(), ino: adjacent.toString() },
  })));
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_IDENTIDADE_DIVERGENTE', root);
});

test('DB com segundo link é recusado quando suportado', async (t) => {
  const root = await fixture(t);
  const { dataDir } = await managed(root);
  const db = path.join(dataDir, 'assessor.db');
  const secondLink = path.join(dataDir, 'second.db');
  try {
    await link(db, secondLink);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`hardlink indisponível: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_DESTINO_INVALIDO', root);
});

test('credenciais geridas como arquivo são recusadas', async (t) => {
  const root = await fixture(t);
  await managed(root);
  await writeFile(path.join(root, 'profiles', ID, 'credenciais'), 'invalid');
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_DESTINO_INVALIDO', root);
});

test('journal pendente e profiles órfão são recuperáveis, sem legado implícito', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'perfil-publicacao.json'), 'incomplete');
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_RECUPERACAO_PENDENTE', root);
  await rm(path.join(root, 'perfil-publicacao.json'));
  await mkdir(path.join(root, 'profiles'));
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_SELECAO_PENDENTE', root);
});

test('seletor symlink é recusado quando suportado', async (t) => {
  const root = await fixture(t);
  await managed(root);
  const file = path.join(root, 'perfil-ativo.json');
  const other = path.join(root, 'other.json');
  await writeFile(other, await readFile(file));
  await rm(file);
  try {
    await symlink(other, file, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlink de arquivo indisponível: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_SELETOR_INVALIDO', root);
});

test('seletor hardlink é recusado quando suportado', async (t) => {
  const root = await fixture(t);
  await managed(root);
  const file = path.join(root, 'perfil-ativo.json');
  const extra = path.join(root, 'extra.json');
  try {
    await link(file, extra);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`hardlink indisponível: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_SELETOR_INVALIDO', root);
});

test('componente link na raiz userData é recusado quando suportado', async (t) => {
  const root = await fixture(t);
  const alias = path.join(root, 'alias');
  try {
    await symlink(root, alias, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`junction indisponível: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsCode(() => resolverPerfilAtivo({ userData: alias }), 'PERFIL_CAMINHO_INVALIDO', root);
});

test('diretório data gerido como junction é recusado quando suportado', async (t) => {
  const root = await fixture(t);
  const { dataDir } = await managed(root);
  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(elsewhere);
  await rm(dataDir, { recursive: true });
  try {
    await symlink(elsewhere, dataDir, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`junction indisponível: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_DESTINO_INVALIDO', root);
});

test('DB legado ausente é válido; se existir deve ser arquivo regular de um link', async (t) => {
  const root = await fixture(t);
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  assert.equal((await resolverPerfilAtivo({ userData: root })).tipo, 'legado');
  const db = path.join(dataDir, 'assessor.db');
  await mkdir(db);
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_DESTINO_INVALIDO', root);
  await rm(db, { recursive: true });
  await writeFile(db, 'synthetic-db');
  assert.equal((await resolverPerfilAtivo({ userData: root })).tipo, 'legado');
});

test('DB legado com segundo link é recusado quando suportado', async (t) => {
  const root = await fixture(t);
  const dataDir = path.join(root, 'data');
  await mkdir(dataDir);
  const db = path.join(dataDir, 'assessor.db');
  await writeFile(db, 'synthetic-db');
  try {
    await link(db, path.join(dataDir, 'second.db'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`hardlink indisponível: ${error.code}`);
      return;
    }
    throw error;
  }
  await rejectsCode(() => resolverPerfilAtivo({ userData: root }), 'PERFIL_DESTINO_INVALIDO', root);
});

test('entrada relativa ou inexistente é recusada sem revelar caminho', async (t) => {
  const root = await fixture(t);
  await rejectsCode(() => resolverPerfilAtivo({ userData: '.' }), 'PERFIL_CAMINHO_INVALIDO');
  await rejectsCode(() => resolverPerfilAtivo({ userData: path.join(root, 'missing') }), 'PERFIL_CAMINHO_INVALIDO', root);
  await rejectsCode(() => resolverPerfilAtivo(null), 'PERFIL_CAMINHO_INVALIDO');
  await rejectsCode(() => resolverPerfilAtivo({ userData: root, db: 'other' }), 'PERFIL_CAMINHO_INVALIDO', root);
});

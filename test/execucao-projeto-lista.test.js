import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, open, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let listar;
async function api() {
  const modulo = await import('../src/execucao/projeto.js');
  assert.equal(typeof modulo.listarArquivosProjeto, 'function', 'deve exportar listarArquivosProjeto');
  listar = modulo.listarArquivosProjeto;
  return listar;
}
async function fixture(t) {
  const raiz = await mkdtemp(path.join(tmpdir(), 'lume-lista-projeto-'));
  const tempReal = await (await import('node:fs/promises')).realpath(tmpdir());
  const raizReal = path.resolve(raiz);
  assert.ok(raizReal.startsWith(tempReal + path.sep), 'fixture deve ficar dentro do diretório temporário');
  t.after(async () => {
    const alvo = path.resolve(raiz);
    assert.ok(alvo.startsWith(path.resolve(tmpdir()) + path.sep), 'cleanup limitado à fixture temporária');
    await rm(alvo, { recursive: true, force: true });
  });
  const origem = path.join(raiz, 'projeto');
  await mkdir(origem);
  return { raiz, origem };
}

test('lista só arquivos regulares seguros em ordem, com caminho relativo e bytes, contando omissões', async t => {
  const run = await api(), { origem, raiz } = await fixture(t);
  await mkdir(path.join(origem, 'src'));
  await mkdir(path.join(origem, '.git'));
  await mkdir(path.join(origem, 'secrets'));
  await writeFile(path.join(origem, 'src', 'z.js'), 'z');
  await writeFile(path.join(origem, 'src', 'a.js'), 'á');
  await writeFile(path.join(origem, '.env'), 'synthetic secret');
  await writeFile(path.join(origem, '.git', 'config'), 'synthetic git data');
  await writeFile(path.join(origem, 'AGENTS.md'), 'synthetic instructions');
  await writeFile(path.join(origem, 'credentials.json'), '{}');
  await writeFile(path.join(origem, 'secrets', 'token.txt'), 'synthetic token');
  await writeFile(path.join(raiz, 'outside.txt'), 'outside');
  let symlinkOk = true;
  try { await symlink(path.join(raiz, 'outside.txt'), path.join(origem, 'escape.txt'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { symlinkOk = false; t.diagnostic(`symlink indisponível: ${error.code}`); } else throw error; }
  await link(path.join(raiz, 'outside.txt'), path.join(origem, 'hardlink.txt'));
  assert.ok((await lstat(path.join(origem, 'hardlink.txt'))).nlink > 1, 'fixture comprova hardlink real');

  const resultado = await run({ origem });
  assert.deepEqual(resultado.arquivos.map(x => x.caminho), ['src/a.js', 'src/z.js']);
  assert.deepEqual(resultado.arquivos.map(x => x.bytes), [Buffer.byteLength('á'), Buffer.byteLength('z')]);
  assert.ok(resultado.arquivos.every(x => !path.isAbsolute(x.caminho) && !x.caminho.includes('..')));
  assert.equal(resultado.omitidos, 6 + (symlinkOk ? 1 : 0));
});

test('recusa uma raiz que seja symlink sem percorrer o alvo', async t => {
  const run = await api(), f = await fixture(t);
  await writeFile(path.join(f.raiz, 'outside.txt'), 'outside');
  const alias = path.join(f.raiz, 'alias');
  try { await symlink(f.origem, alias, 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip(`symlink de diretório indisponível: ${error.code}`);
    throw error;
  }
  await assert.rejects(run({ origem: alias }), /UNSAFE_SOURCE|INVALID_SOURCE|symlink/i);
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(f.raiz, 'outside.txt'), 'utf8'), 'outside');
});

test('falha ao ultrapassar 5.000 arquivos ou 512 MiB sem listar parcialmente', async t => {
  const run = await api(), f = await fixture(t);
  const muitos = path.join(f.origem, 'muitos');
  await mkdir(muitos);
  for (let i = 0; i < 5001; i++) await writeFile(path.join(muitos, `${String(i).padStart(4, '0')}.txt`), 'x');
  await assert.rejects(run({ origem: f.origem }), /PROJECT_TOO_LARGE|FILE_LIMIT|TOO_MANY/i);
  await rm(muitos, { recursive: true });

  const grande = path.join(f.origem, 'sparse.bin');
  const handle = await open(grande, 'w');
  try { await handle.truncate(256 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(run({ origem: f.origem }), /PROJECT_TOO_LARGE|SIZE_LIMIT|TOO_LARGE/i);
  await rm(grande);

  for (let i = 0; i < 3; i++) {
    const parte = await open(path.join(f.origem, `parte-${i}.bin`), 'w');
    try { await parte.truncate(200 * 1024 * 1024); } finally { await parte.close(); }
  }
  await assert.rejects(run({ origem: f.origem }), /PROJECT_TOO_LARGE|SIZE_LIMIT|TOO_LARGE/i);
});

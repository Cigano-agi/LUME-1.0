import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertNormalBootAllowed } from '../src/perfil-boot-guard.js';
import { assertNormalBootAllowed as maintenanceGuard } from '../src/perfil-manutencao.js';

function fixture(t) {
  const userData = mkdtempSync(join(tmpdir(), 'lume-boot-guard-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  return userData;
}

test('guard isolado e reexport da manutenção são a mesma função', t => {
  const userData = fixture(t);
  assert.equal(maintenanceGuard, assertNormalBootAllowed);
  assert.doesNotThrow(() => assertNormalBootAllowed(userData));
  assert.deepEqual(readdirSync(userData), []);
});

test('guard bloqueia qualquer presença dos dois marcadores, inclusive vazio e diretório', t => {
  for (const marker of ['perfil-manutencao.json', 'notetaker-delete-journal']) {
    for (const kind of ['empty', 'invalid', 'directory']) {
      const userData = fixture(t), target = join(userData, marker);
      if (kind === 'directory') mkdirSync(target);
      else writeFileSync(target, kind === 'empty' ? '' : '{ inválido');
      assert.throws(() => assertNormalBootAllowed(userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
    }
  }
});

test('guard bloqueia link para cada marcador', t => {
  for (const marker of ['perfil-manutencao.json', 'notetaker-delete-journal']) {
    const userData = fixture(t), target = join(userData, marker);
    const directory = join(userData, 'destino');
    mkdirSync(directory);
    symlinkSync(directory, target, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertNormalBootAllowed(userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  }
});

test('guard recusa caminho não absoluto, não normalizado, NUL e tipo incorreto', () => {
  for (const userData of ['relativo', `${resolve('.')}${sep}.${sep}sub`, `${resolve('.')}\0`, null]) {
    assert.throws(() => assertNormalBootAllowed(userData), { code: 'PERFIL_CAMINHO_INVALIDO' });
  }
});

test('erro de lstat diferente de ENOENT bloqueia e não vaza detalhe', async t => {
  const userData = fixture(t);
  const source = readFileSync(new URL('../src/perfil-boot-guard.js', import.meta.url), 'utf8');
  const injected = source.replace("import { lstatSync } from 'node:fs';",
    "const lstatSync = () => { const error = new Error('detalhe privado'); error.code = 'EACCES'; throw error; };");
  assert.notEqual(injected, source);
  const { assertNormalBootAllowed: guard } = await import(`data:text/javascript,${encodeURIComponent(injected)}`);
  assert.throws(() => guard(userData), error =>
    error.code === 'PERFIL_MANUTENCAO_PENDENTE' && !error.message.includes('detalhe privado'));
});

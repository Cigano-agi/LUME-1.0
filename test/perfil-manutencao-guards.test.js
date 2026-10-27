import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolverPerfilAtivo } from '../src/perfil-ativo.js';
import { selecionarPerfilBoot, validarEnvelopeLegado, erroPublicoPerfil } from '../src/perfil-boot.js';
import { createLegacySelectionGuard } from '../src/mcp/desktop-broker.js';

function fixture(t) {
  const userData = mkdtempSync(join(homedir(), 'lume-maint-guard-'));
  mkdirSync(join(userData, 'data'));
  t.after(() => {
    assert.equal(dirname(resolve(userData)), resolve(homedir()));
    assert.match(basename(userData), /^lume-maint-guard-/);
    rmSync(userData, { recursive: true, force: true });
  });
  return userData;
}

test('marcador de qualquer conteúdo bloqueia seletor, boot e envelope antes do DB', async t => {
  const userData = fixture(t), marker = join(userData, 'perfil-manutencao.json');
  const selection = await selecionarPerfilBoot(userData);
  writeFileSync(marker, '{}');
  await assert.rejects(resolverPerfilAtivo({ userData }), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  await assert.rejects(selecionarPerfilBoot(userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  await assert.rejects(validarEnvelopeLegado({ ASSESSOR_DESKTOP_USER_DATA: userData, ASSESSOR_DESKTOP_PROFILE_ID: 'legado' }), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  assert.equal(erroPublicoPerfil({ code: 'PERFIL_MANUTENCAO_PENDENTE' }).code, 'PERFIL_MANUTENCAO_PENDENTE');
  rmSync(marker);
  assert.deepEqual(await selecionarPerfilBoot(userData), selection);
});

test('sentinela órfã bloqueia e guard síncrono do broker corta HELLO/BEGIN', async t => {
  const userData = fixture(t), selection = await selecionarPerfilBoot(userData);
  const guard = createLegacySelectionGuard({ userData, selection });
  assert.equal(guard(), true);
  mkdirSync(join(userData, 'notetaker-delete-journal'));
  assert.equal(guard(), false);
  assert.throws(() => guard.ensureData());
  await assert.rejects(selecionarPerfilBoot(userData), { code: 'PERFIL_MANUTENCAO_PENDENTE' });
  rmSync(join(userData, 'notetaker-delete-journal'), { recursive: true });
  writeFileSync(join(userData, 'perfil-manutencao.json'), 'cold');
  assert.equal(guard(), false);
});

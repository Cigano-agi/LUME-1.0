import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as A from '../src/perfil-manutencao.js';

const api = ['beginContentMaintenance', 'executeContentMaintenance', 'recoverContentMaintenance',
  'completeContentMaintenance', 'isContentMaintenanceComplete'];

test('C1 revisão: autoridade nasce somente das cinco entradas A previstas', () => {
  for (const name of api) assert.equal(typeof A[name], 'function', `API ausente: ${name}`);
  assert.equal(A.isContentMaintenanceComplete({}), false);
  assert.equal(A.isContentMaintenanceComplete(null), false);
});

function isolated(steps) {
  const home = realpathSync(homedir());
  const root = realpathSync(mkdtempSync(join(home, 'lume-03a36-content-review-')));
  const guard = randomUUID();
  writeFileSync(join(root, '.review-harness'), guard, { flag: 'wx' });
  let exited = true;
  try {
    for (const step of steps) {
      exited = false;
      const child = spawnSync(process.execPath,
        [fileURLToPath(new URL('./fixtures/03A36-content-review-child.mjs', import.meta.url)), root, step],
        { env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root },
          encoding: 'utf8', timeout: 45000, windowsHide: true });
      exited = child.status !== null && child.signal === null;
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(exited, true, `Saída não comprovada: ${child.signal}`);
      assert.equal(child.status, step.startsWith('crash-') ? 73 : 0, `${step}: ${child.stderr}`);
      assert.equal(JSON.parse(child.stdout).step, step);
    }
  } finally {
    if (exited) {
      const verified = realpathSync(root);
      assert.equal(verified, root);
      assert.equal(dirname(verified), home);
      assert.match(basename(verified), /^lume-03a36-content-review-/);
      assert.equal(readFileSync(join(verified, '.review-harness'), 'utf8'), guard);
      rmSync(verified, { recursive: true });
    }
  }
}

test('C1 revisão: JSON, B2, DB arbitrário e cinco rotas genéricas recusados sem efeitos', () => {
  isolated(['setup', 'authority']);
});
test('C1 revisão: zero WAV exige execução e recibo privado consumido uma vez', () => {
  isolated(['setup', 'zero']);
});
test('C1 revisão: dois handles frios disputam uma reserva; marker inicial aborta com prova', () => {
  isolated(['setup', 'prepare', 'cold']);
});
test('C1 revisão: segundo ciclo no mesmo perfil usa controle terminal existente', () => {
  isolated(['setup', 'zero', 'second-cycle']);
});
for (const point of ['commit', 'unlink', 'progress']) {
  test(`C1 revisão: processo novo recupera crash ${point} sem duplicar progresso`, () => {
    isolated(['setup-wav', `crash-${point}`, 'recover-committed']);
  });
}
for (const corruption of ['extra', 'later-file', 'resurrect', 'missing-tail']) {
  test(`C1 revisão: ${corruption} bloqueia recovery antes de qualquer unlink`, () => {
    isolated(['setup-wav', corruption === 'resurrect' ? 'crash-progress' : 'crash-commit', corruption, 'recover-refuse']);
  });
}
test('C1 revisão: marker inicial não aborta se WAV saiu da origem', () => {
  isolated(['setup-wav', 'prepare', 'move-initial', 'recover-refuse']);
});
test('C1 revisão: DDL fechado recusa trigger/index sem prefixo e conclusão sem recibo', () => {
  isolated(['setup', 'zero', 'control-negatives']);
});
test('C1 revisão: novo crash após abort durável permite replay sem bloquear origens restauradas', () => {
  isolated(['setup-wav', 'crash-rename', 'crash-abort', 'recover-aborted']);
});
test('C1 revisão: schema de procedência aceita família legítima e recusa trigger ausente/alterada', () => {
  isolated(['setup', 'schema-family']);
});
test('C1 revisão: abort terminal sem journal ainda conclui após processo novo', () => {
  isolated(['setup-wav', 'crash-rename', 'crash-abort-cleanup', 'recover-aborted']);
});
test('C1 revisão: abort inicial reconfere arquivos também no complete', () => {
  isolated(['setup-wav', 'prepare', 'cold-finalize-race']);
});
test('C1 revisão: marker inicial de segundo ciclo aborta com tabelas terminais preexistentes', () => {
  isolated(['setup', 'zero', 'prepare-next', 'cold']);
});

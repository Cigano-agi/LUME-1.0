import test from 'node:test';
import assert from 'node:assert/strict';

test('C1 expõe somente o ciclo privado de manutenção de conteúdo em A', async () => {
  const api = await import('../src/perfil-manutencao.js');
  for (const name of [
    'beginContentMaintenance',
    'executeContentMaintenance',
    'recoverContentMaintenance',
    'completeContentMaintenance',
    'isContentMaintenanceComplete'
  ]) assert.equal(typeof api[name], 'function', `${name} ainda está ausente`);
});

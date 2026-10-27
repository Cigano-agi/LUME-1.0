import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: new URL('..', import.meta.url),
    shell: false,
    windowsHide: true,
    stdio: 'inherit',
    timeout: 120000
  });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

run(['scripts/build-project-inventory.mjs']);
run(['scripts/build-project-inventory.mjs', '--test-hooks']);
run(['--test', '--test-concurrency=1',
  'test/inventario-nativo-build.test.js',
  'test/inventario-nativo-windows.test.js',
  'test/inventario-nativo-protocolo.test.js']);

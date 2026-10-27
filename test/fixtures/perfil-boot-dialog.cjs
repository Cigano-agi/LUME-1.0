// Wrapper exclusivo do gate Electron: intercepta o diálogo para que a recusa
// termine sem interação humana e registra somente código/estado de processos.
const { app, BrowserWindow, dialog, utilityProcess } = require('electron');
const { join } = require('node:path');
const { writeFileSync } = require('node:fs');

dialog.showErrorBox = (_title, message) => {
  const code = /^PERFIL_[A-Z_]+:/.exec(String(message))?.[0]?.slice(0, -1) || 'PERFIL_DIALOGO_SEM_CODIGO';
  process.stderr.write(`LUME_BOOT_DIALOG_CODE=${code}\n`);
};
if (process.env.LUME_TEST_HIDDEN === '1') BrowserWindow.prototype.show = function () {};
const fork = utilityProcess.fork.bind(utilityProcess);
utilityProcess.fork = (...args) => {
  if (process.env.LUME_TEST_JOURNAL_BEFORE_FORK === '1') writeFileSync(join(process.env.ASSESSOR_DESKTOP_TEST_PROFILE, 'perfil-publicacao.json'), '{}');
  const child = fork(...args);
  process.stderr.write('LUME_UTILITY_STARTED\n');
  if (process.env.LUME_TEST_BROKER_ORDER === '1') {
    const descriptor = join(process.env.ASSESSOR_DESKTOP_TEST_PROFILE, 'broker-control', 'descriptor.json');
    process.stderr.write(`LUME_BROKER_BEFORE_UTILITY=${require('node:fs').existsSync(descriptor) ? '1' : '0'}\n`);
  }
  if (process.env.LUME_TEST_QUIT_AFTER_READY === '1') child.on('message', message => {
    if (message?.tipo === 'pronto') app.quit();
  });
  child.once('exit', () => process.stderr.write('LUME_UTILITY_EXITED\n'));
  return child;
};
require(join(__dirname, '..', '..', 'desktop', 'main.cjs'));

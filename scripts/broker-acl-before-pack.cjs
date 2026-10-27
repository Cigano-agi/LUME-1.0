const { execFile } = require('node:child_process');
const { join } = require('node:path');
const { promisify } = require('node:util');
const { Arch } = require('builder-util/out/arch');

const run = promisify(execFile);

// Nsis7z bundled with electron-builder 26.15.3 cannot decode ARM64 filters.
// Dependencies may contain ARM64 DLLs even in an x64 application archive.
// https://github.com/electron-userland/electron-builder/issues/9983
exports.configureWindowsArchive = function configureWindowsArchive(env = process.env) {
  env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';
};

exports.default = async function beforePack(context) {
  await run(process.execPath, [join(__dirname, 'patch-baileys-companion-refresh.mjs')],
    { cwd: join(__dirname, '..'), windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  if (context.electronPlatformName !== 'win32') return;
  if (context.arch !== Arch.x64) throw Error('BROKER_ACL_BUILD_UNSUPPORTED');
  exports.configureWindowsArchive();
  try {
    await run(process.execPath, [join(__dirname, 'build-app-activity.mjs')],
      { cwd: join(__dirname, '..'), windowsHide: true, timeout: 45000, maxBuffer: 4096 });
  } catch { throw Error('APP_ACTIVITY_BUILD_FAILED'); }
  try {
    await run(process.execPath, [join(__dirname, 'build-broker-acl.mjs')],
      { cwd: join(__dirname, '..'), windowsHide: true, timeout: 45000, maxBuffer: 4096 });
  } catch { throw Error('BROKER_ACL_BUILD_FAILED'); }
  try {
    await run(process.execPath, [join(__dirname, 'build-audio-local.mjs')],
      { cwd: join(__dirname, '..'), windowsHide: true, timeout: 120000, maxBuffer: 4096 });
  } catch { throw Error('AUDIO_LOCAL_BUILD_FAILED'); }
};

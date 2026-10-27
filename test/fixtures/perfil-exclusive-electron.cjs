'use strict';

// Standalone Electron main process. No BrowserWindow or product imports.
const { app } = require('electron');
const { DatabaseSync } = require('node:sqlite');
const { dirname, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const net = require('node:net');

const dbPath = process.argv.find((arg) => arg.startsWith('--probe-db='))?.slice('--probe-db='.length);
const userData = process.argv.find((arg) => arg.startsWith('--probe-user-data='))?.slice('--probe-user-data='.length);
const uriMode = process.argv.includes('--probe-uri-mode=rw');
if (!dbPath || !userData || dirname(resolve(dbPath)) !== dirname(resolve(userData)) ||
    !resolve(userData).startsWith(`${dirname(resolve(dbPath))}${sep}`)) {
  throw new Error('INVALID_PROBE_PATHS');
}
app.setPath('userData', userData);

const emit = (row, done) => process.stdout.write(`${JSON.stringify(row)}\n`, done);
let db;
let begun = false;
let control;

function handle(socket, command) {
  const reply = (row, done) => socket.end(`${JSON.stringify(row)}\n`, done);
  if (uriMode && ['openUriMissing', 'openUriVanished', 'openUriExisting'].includes(command)) {
    const selected = command === 'openUriMissing' ? `${dbPath}.missing`
      : command === 'openUriVanished' ? `${dbPath}.vanished` : dbPath;
    try {
      if (db) throw new Error('DB_ALREADY_OPEN');
      db = new DatabaseSync(`${pathToFileURL(selected).href}?mode=rw`, { timeout: 0 });
      reply({ event: 'opened-uri-rw' });
    } catch (error) {
      reply({ event: 'open-error', code: error.code, message: error.message });
    }
  } else if (command === 'databaseList') {
    try {
      const main = db.prepare('PRAGMA database_list').all().find((row) => row.name === 'main');
      reply({ event: 'database-list', databaseFile: main?.file });
    } catch (error) {
      reply({ event: 'error', code: error.code, message: error.message });
    }
  } else if (command === 'acquire') {
    let mode;
    try {
      mode = db.prepare('PRAGMA locking_mode=EXCLUSIVE').get().locking_mode;
      db.exec('BEGIN EXCLUSIVE');
      begun = true;
      reply({ event: 'acquired', mode });
    } catch (error) {
      reply({ event: 'busy', mode, code: error.code, message: error.message });
    }
  } else if (command === 'rollback') {
    try {
      if (!begun) throw new Error('NO_TRANSACTION');
      db.exec('ROLLBACK');
      begun = false;
      reply({ event: 'rolled-back' });
    } catch (error) {
      reply({ event: 'error', code: error.code || 'ROLLBACK_FAILED', message: error.message });
    }
  } else if (command === 'close') {
    try {
      if (begun) db.exec('ROLLBACK');
      db.close();
      db = undefined;
      reply({ event: 'closed' }, () => control.close(() => app.exit(0)));
    } catch (error) {
      reply({ event: 'error', code: error.code || 'CLOSE_FAILED', message: error.message }, () => app.exit(3));
    }
  } else {
    reply({ event: 'error', code: 'UNKNOWN_COMMAND' }, () => app.exit(2));
  }
}

app.whenReady().then(() => {
  if (!uriMode) db = new DatabaseSync(dbPath, { timeout: 0 });
  control = net.createServer((socket) => {
    let input = '';
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 1024) return socket.end();
      const end = input.indexOf('\n');
      if (end >= 0) handle(socket, input.slice(0, end));
    });
  });
  control.listen(0, '127.0.0.1', () => emit({
    event: 'ready', runtime: 'electron-main', port: control.address().port,
    versions: {
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      electron: process.versions.electron,
    },
  }));
}).catch((error) => emit({ event: 'error', code: error.code || 'START_FAILED', message: error.message }, () => app.exit(1)));

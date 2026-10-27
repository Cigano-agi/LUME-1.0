import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

let db;
process.on('message', ({ id, op, path }) => {
  try {
    let value;
    switch (op) {
      case 'open':
        db = new DatabaseSync(path, { timeout: 0 });
        value = 'opened';
        break;
      case 'openUriRw':
        db = new DatabaseSync(`${pathToFileURL(path).href}?mode=rw`, { timeout: 0 });
        value = 'opened-uri-rw';
        break;
      case 'databaseList':
        value = db.prepare('PRAGMA database_list').all();
        break;
      case 'mode':
        value = db.prepare('PRAGMA locking_mode=EXCLUSIVE').get().locking_mode;
        break;
      case 'read':
        value = db.prepare('SELECT id, value FROM marker ORDER BY id').all();
        break;
      case 'beginExclusive':
        db.exec('BEGIN EXCLUSIVE');
        value = 'begun';
        break;
      case 'beginImmediate':
        db.exec('BEGIN IMMEDIATE');
        value = 'begun';
        break;
      case 'writeAttempt':
        db.prepare("INSERT INTO marker(value) VALUES ('must-not-persist')").run();
        value = 'written';
        break;
      case 'activeRead':
        db.exec('BEGIN');
        value = db.prepare('SELECT id, value FROM marker ORDER BY id').all();
        break;
      case 'rollback':
        db.exec('ROLLBACK');
        value = 'rolled-back';
        break;
      case 'close':
        db.close();
        db = undefined;
        value = 'closed';
        break;
      case 'crash':
        process.send({ id, ok: true, value: 'crashing' }, () => process.abort());
        return;
      default:
        throw new Error(`Unknown operation: ${op}`);
    }
    process.send({ id, ok: true, value });
  } catch (error) {
    process.send({ id, ok: false, error: { code: error.code, message: error.message } });
  }
});

process.send({ ready: true });

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { extractFile } from '@electron/asar';

const appData = process.env.APPDATA;
const local = process.env.LOCALAPPDATA;
if (!appData || !local) throw new Error('Windows APPDATA/LOCALAPPDATA indisponíveis');
const exe = path.join(local, 'Programs', 'Lume', 'Lume.exe');
const dbPath = path.join(appData, 'AssessorDesktop', 'data', 'assessor.db');
const credentials = path.join(appData, 'AssessorDesktop', 'data', 'wa-auth', 'creds.json');
const snapshot = path.join(local, 'LumeRealSnapshot-20260929-03', 'receipt.json');
const rollback = path.join(local, 'LumeBeta5Rollback-20260928-01', 'rollback-receipt.json');
const resources = path.join(local, 'Programs', 'Lume', 'resources');
const asar = path.join(resources, 'app.asar');
const require = createRequire(import.meta.url);
const { brokerBlockedByLocalPolicy } = require('../desktop/sac-fallback.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };

if (![exe, dbPath, credentials, snapshot, rollback, asar].every(existsSync)) fail('INSTALACAO_ARQUIVO_AUSENTE');
const version = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `(Get-Item -LiteralPath '${exe.replaceAll("'", "''")}').VersionInfo.FileVersion`],
  { encoding: 'utf8', windowsHide: true }).trim();
const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const appVersion = JSON.parse(extractFile(asar, 'package.json').toString('utf8')).version;
const exeHash = createHash('sha256').update(readFileSync(exe)).digest('hex').toUpperCase();
const parse = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const snap = parse(snapshot);
const old = parse(rollback);
const db = new DatabaseSync(dbPath, { readOnly: true });
let events, integrity;
try {
  events = db.prepare('SELECT COUNT(*) n FROM eventos').get().n;
  integrity = db.prepare('PRAGMA quick_check').get()?.quick_check;
} finally { db.close(); }
const result = { version, appVersion, expected, exeHash, events, integrity,
  credentialsPresent: statSync(credentials).size > 0,
  snapshotVerified: snap.verified === true && snap.rehearsed === true && snap.files > 0,
  rollbackVerified: old.Verified === true && old.Version === '3.2.0-beta.5',
  mcpPausedForSac: brokerBlockedByLocalPolicy(resources, 'win32') };
if (process.argv.includes('--compare')) {
  console.log(JSON.stringify({ comparison: 'beta.5 instalada antes da troca', ...result }));
  if (appVersion === expected) fail('RED_NAO_REPRODUZIDO');
  fail('RED_BETA_ANTIGA');
}
if (version !== '3.2.0-beta.5' || appVersion !== expected ||
    exeHash !== '67F3D4F5A2B7DA6B62A8350DA93255A3AD2DAE85E3D5D9AD5ACAC56F31CBF473' ||
    events < 219435 || integrity !== 'ok' || !result.credentialsPresent ||
    !result.snapshotVerified || !result.rollbackVerified || !result.mcpPausedForSac) fail('INSTALACAO_NAO_VERIFICADA');
console.log(JSON.stringify({ ok: true, ...result }));

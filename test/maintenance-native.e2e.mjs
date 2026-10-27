import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const home = realpathSync(homedir());
const prefix = 'lume-maintenance-native-';
const profile = mkdtempSync(join(home, prefix));
const electron = (await import('electron')).default;
const child = spawn(electron, [resolve('test/fixtures/maintenance-native.cjs')], {
  cwd:resolve('.'), windowsHide:true, stdio:['ignore','pipe','pipe'],
  env:{ ...process.env, ASSESSOR_DESKTOP_TEST_PROFILE:profile }
});
let output = '', spawnError, closed = false;
child.stdout.on('data', chunk => { output += String(chunk); });
child.stderr.on('data', chunk => { output += String(chunk); });
const close = new Promise(resolve => {
  child.once('error', error => { spawnError = error; });
  child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); });
});
const kill = setTimeout(() => child.kill(), 50000);
let deadline;
try {
  const result = await Promise.race([close, new Promise((_, reject) => {
    deadline = setTimeout(() => reject(Error('Electron close timeout')), 60000);
  })]);
  if (spawnError) throw spawnError;
  assert.equal(result.code, 0, output);
  assert.equal(result.signal, null, output);
  for (const marker of ['UTILITY:1','READY:1','CUT_ACK','LOCAL_LOADED',
    'MAINT_RECEIPT','UTILITY_EXIT:0','LEASE','FINISHED:sem_mutacao','UTILITY:2','READY:2','WEB_LOAD:2','TOTALS:1:2:2'])
    assert.ok(output.includes(`LUME_MAINT_NATIVE=${marker}`), `${marker}\n${output}`);
  console.log(output.split('\n').filter(line => line.startsWith('LUME_MAINT_NATIVE=')).join('\n'));
} finally {
  clearTimeout(kill); clearTimeout(deadline);
  if (!closed) { child.kill(); await Promise.race([close, new Promise(resolve => setTimeout(resolve, 5000))]); }
  if (closed) {
    const actual = realpathSync(profile);
    if (dirname(actual) !== home || !basename(actual).startsWith(prefix)) throw Error('unsafe fixture path');
    rmSync(actual, { recursive:true, force:true });
  }
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import electronBinary from 'electron';
import { execFileSync } from 'node:child_process';

const fixture = resolve('test/fixtures/utility-lifecycle-native.cjs');
async function run(scenario, baseline = false) {
  const root = mkdtempSync(join(tmpdir(), 'lume-lifecycle-'));
  const evidence = join(root, 'events.jsonl');
  const env = { ...process.env, ASSESSOR_DESKTOP_TEST_PROFILE: join(root, 'profile'),
    LUME_LIFECYCLE_SCENARIO: scenario, LUME_LIFECYCLE_EVIDENCE: evidence };
  if (baseline) {
    const baseMain = join(root, 'base-main.cjs');
    writeFileSync(baseMain, execFileSync('git', ['show', '07469c3:desktop/main.cjs'], { cwd: resolve('.'), encoding: 'utf8' }));
    env.LUME_LIFECYCLE_BASE_MAIN = baseMain;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [fixture], { env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); });
  let deadline;
  const result = await Promise.race([
    new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
    new Promise((_, reject) => { deadline = setTimeout(() => {
      child.kill();
      Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 5000))])
        .then(() => reject(Error(`${scenario}: timeout native; ${stderr.slice(-500)}; evidência ${root}`)));
    }, 18000); })
  ]).finally(() => clearTimeout(deadline));
  const rows = existsSync(evidence) ? readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const events = rows.map(row => row.event);
  assert.equal(result.code, 0, `${scenario}: ${stderr.slice(-500)}`);
  assert.ok(events.includes('pronto'), `${scenario}: sem ready; ${stderr.slice(-500)}`);
  assert.ok(events.includes(baseline ? 'pedido-legado' : 'pedido'), `${scenario}: sem pedido; ${stderr.slice(-500)}`);
  assert.equal(events.includes('install'), baseline || scenario === 'valid' || scenario === 'real', `${scenario}: ${events.join(',')}`);
  assert.ok(events.includes('utility-exit'), `${scenario}: utility sem exit observado`);
  if (['valid','real','wrong'].includes(scenario)) assert.equal(rows.find(row => row.event === 'utility-exit').code, 0);
  if (['exit1','real-no-ack'].includes(scenario)) assert.equal(rows.find(row => row.event === 'utility-exit').code, 1);
  if (scenario === 'valid' || scenario === 'real') assert.ok(events.indexOf('ack') < events.indexOf('install'), `${scenario}: instalou antes ACK`);
  if (scenario === 'valid' || scenario === 'real') assert.ok(events.indexOf('recibo') < events.indexOf('ack') && events.indexOf('ack') < events.indexOf('utility-exit') && events.indexOf('utility-exit') < events.indexOf('install'), `${scenario}: ordem inválida`);
  if (scenario === 'real-no-ack') assert.ok(events.includes('ack-dropped') && !events.includes('install'), `${scenario}: ACK ausente autorizou instalação`);
  if (dirname(resolve(root)) === resolve(tmpdir()) && basename(root).startsWith('lume-lifecycle-')) rmSync(root, { recursive: true, force: true });
  return { scenario, events };
}
for (const scenario of ['valid','exit1','wrong','timeout','real','real-no-ack']) {
  const result = await run(scenario);
  process.stdout.write(`${scenario}: ${result.events.join(',')}\n`);
}
const baseline = await run('exit1', true);
process.stdout.write(`base07469c3/exit1: ${baseline.events.join(',')}\n`);

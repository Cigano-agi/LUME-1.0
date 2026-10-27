import test from 'node:test';
import assert from 'node:assert/strict';
import { MacosCandidateProofError, REQUIRED_MACOS_JOBS, verifyMacosCandidateRun } from '../scripts/verify-macos-candidate-run.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const run = (changes = {}) => ({ id: 41, run_attempt: 1, head_sha: SHA, status: 'completed', conclusion: 'success', html_url: 'https://github.test/runs/41', ...changes });
const jobs = changes => REQUIRED_MACOS_JOBS.map((name, index) => ({ id: 100 + index, name, status: 'completed', conclusion: 'success', html_url: `https://github.test/jobs/${index}`, ...(changes?.[name] || {}) }));
const code = expected => error => error instanceof MacosCandidateProofError && error.code === expected;

test('recusa run ausente, incompleta, falha ou de outro SHA sem criar prova', () => {
  for (const runs of [
    [],
    [run({ head_sha: OTHER_SHA })],
    [run({ status: 'in_progress', conclusion: null })],
    [run({ conclusion: 'failure' })]
  ]) assert.throws(() => verifyMacosCandidateRun({ runs, jobs: jobs(), sha: SHA }), code('MACOS_PROOF_ABSENT'));
});

test('recusa job obrigatório ausente, ignorado, cancelado ou falho e informa cada nome', () => {
  for (const [name, conclusion] of [
    [REQUIRED_MACOS_JOBS[0], 'missing'],
    [REQUIRED_MACOS_JOBS[1], 'skipped'],
    [REQUIRED_MACOS_JOBS[2], 'cancelled'],
    [REQUIRED_MACOS_JOBS[3], 'failure']
  ]) {
    const input = conclusion === 'missing' ? jobs().filter(job => job.name !== name) : jobs({ [name]: { conclusion } });
    assert.throws(() => verifyMacosCandidateRun({ runs: [run()], jobs: input, sha: SHA }), error => {
      assert.equal(error.code, 'MACOS_JOBS_INCOMPLETE');
      assert.ok(error.details.incomplete.some(job => job.name === name));
      return true;
    });
  }
});

test('seleciona deterministicamente a run válida mais recente e comprova os quatro jobs', () => {
  const runs = [run({ id: 39, run_attempt: 1 }), run({ id: 42, run_attempt: 2 }), run({ id: 43, run_attempt: 2 })];
  const proof = verifyMacosCandidateRun({ runs, jobs: selected => {
    assert.equal(selected.id, 43);
    return jobs();
  }, sha: SHA });
  assert.equal(proof.headSha, SHA);
  assert.equal(proof.runId, 43);
  assert.equal(proof.runAttempt, 2);
  assert.equal(proof.status, 'completed');
  assert.equal(proof.conclusion, 'success');
  assert.deepEqual(proof.requiredJobs.map(job => [job.name, job.conclusion]), REQUIRED_MACOS_JOBS.map(name => [name, 'success']));
});

test('SHA precisa ser completo e jobs devem vir em lista', () => {
  assert.throws(() => verifyMacosCandidateRun({ runs: [], jobs: [], sha: 'HEAD' }), code('INVALID_SHA'));
  assert.throws(() => verifyMacosCandidateRun({ runs: [run()], jobs: null, sha: SHA }), code('INVALID_JOBS'));
});

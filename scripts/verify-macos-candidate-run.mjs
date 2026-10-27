import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_MACOS_JOBS = Object.freeze([
  'Testar nativamente no Mac arm64',
  'Testar nativamente no Mac x64',
  'Montar universal sem assinatura e provar arm64',
  'Provar universal sem assinatura no Intel'
]);

export class MacosCandidateProofError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MacosCandidateProofError';
    this.code = code;
    this.details = details;
  }
}

const integer = value => Number.isSafeInteger(Number(value)) ? Number(value) : 0;

export function verifyMacosCandidateRun({ runs, jobs, sha, workflow = 'macos.yml' } = {}) {
  if (!/^[a-f0-9]{40}$/i.test(String(sha || ''))) {
    throw new MacosCandidateProofError('INVALID_SHA', 'O SHA solicitado precisa ter 40 caracteres hexadecimais.');
  }
  if (!Array.isArray(runs)) throw new MacosCandidateProofError('INVALID_RUNS', 'A resposta de runs precisa ser uma lista.');

  const exact = runs.filter(run => run?.head_sha === sha);
  const valid = exact
    .filter(run => run?.status === 'completed' && run?.conclusion === 'success')
    .sort((a, b) => integer(b.run_attempt) - integer(a.run_attempt) || integer(b.id) - integer(a.id));

  if (!valid.length) {
    throw new MacosCandidateProofError('MACOS_PROOF_ABSENT', 'Nenhuma run macOS concluída com sucesso corresponde ao SHA exato.', {
      sha,
      observed: exact.map(run => ({ id: run.id ?? null, status: run.status ?? null, conclusion: run.conclusion ?? null, headSha: run.head_sha ?? null }))
    });
  }

  const run = valid[0];
  const selectedJobs = typeof jobs === 'function' ? jobs(run) : jobs;
  if (!Array.isArray(selectedJobs)) throw new MacosCandidateProofError('INVALID_JOBS', 'A resposta de jobs precisa ser uma lista.', { runId: run.id });

  const requiredJobs = REQUIRED_MACOS_JOBS.map(name => {
    const matches = selectedJobs.filter(job => job?.name === name);
    const job = matches.sort((a, b) => integer(b.id) - integer(a.id))[0];
    return { name, id: job?.id ?? null, status: job?.status ?? null, conclusion: job?.conclusion ?? null, url: job?.html_url ?? null };
  });
  const incomplete = requiredJobs.filter(job => job.status !== 'completed' || job.conclusion !== 'success');
  if (incomplete.length) {
    throw new MacosCandidateProofError('MACOS_JOBS_INCOMPLETE', 'A run não aprovou todos os quatro jobs macOS obrigatórios.', {
      runId: run.id,
      incomplete
    });
  }

  return {
    schema: 'lume-macos-candidate-proof-v1',
    workflow,
    headSha: sha,
    runId: integer(run.id),
    runAttempt: integer(run.run_attempt),
    runUrl: run.html_url ?? null,
    status: 'completed',
    conclusion: 'success',
    requiredJobs
  };
}

function parseArgs(argv) {
  const options = { workflow: 'macos.yml', sha: 'HEAD', repository: null };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index], value = argv[index + 1];
    if (key === '--workflow' || key === '--sha' || key === '--repo') {
      if (!value || value.startsWith('--')) throw new MacosCandidateProofError('INVALID_ARGUMENT', `Valor ausente para ${key}.`);
      if (key === '--workflow') options.workflow = value;
      if (key === '--sha') options.sha = value;
      if (key === '--repo') options.repository = value;
      index++;
    } else throw new MacosCandidateProofError('INVALID_ARGUMENT', `Argumento desconhecido: ${key}.`);
  }
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(options.workflow)) throw new MacosCandidateProofError('INVALID_WORKFLOW', 'Nome de workflow inválido.');
  if (options.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) throw new MacosCandidateProofError('INVALID_REPOSITORY', 'Repositório inválido.');
  return options;
}

function command(file, args) {
  return execFileSync(file, args, { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true }).trim();
}

function apiPages(path) {
  const output = command('gh', ['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', path]);
  const pages = JSON.parse(output || '[]');
  if (!Array.isArray(pages)) throw new MacosCandidateProofError('INVALID_API_RESPONSE', 'A API do GitHub retornou um formato inesperado.');
  return pages;
}

export function runMacosCandidateCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const sha = options.sha === 'HEAD' ? command('git', ['rev-parse', 'HEAD']) : options.sha;
  const repository = options.repository || command('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  const encodedWorkflow = encodeURIComponent(options.workflow);
  const runPages = apiPages(`repos/${repository}/actions/workflows/${encodedWorkflow}/runs?head_sha=${sha}&per_page=100`);
  const runs = runPages.flatMap(page => Array.isArray(page?.workflow_runs) ? page.workflow_runs : []);
  const proof = verifyMacosCandidateRun({
    runs,
    sha,
    workflow: options.workflow,
    jobs: run => apiPages(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`).flatMap(page => Array.isArray(page?.jobs) ? page.jobs : [])
  });
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runMacosCandidateCli(); }
  catch (error) {
    const body = error instanceof MacosCandidateProofError
      ? { ok: false, code: error.code, message: error.message, details: error.details }
      : { ok: false, code: 'MACOS_PROOF_ERROR', message: error?.message || 'Falha desconhecida.' };
    process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
    process.exitCode = 1;
  }
}

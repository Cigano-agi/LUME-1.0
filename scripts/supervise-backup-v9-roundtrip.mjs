import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { TABELAS_I_V9 } from '../src/backup-acervo-catalogo.js';

const WATCHDOG_MS = 600_000;
const STDOUT_LIMIT = 256 * 1024;
const STDERR_LIMIT = 64 * 1024;
const CODES = new Set([
  'PARIDADE_CONFIRMADA', 'PARIDADE_DIVERGENTE', 'DIAGNOSTICO_FALHOU',
  'FONTE_INVALIDA', 'CAMINHO_INVALIDO', 'CAMINHO_SOBREPOSTO', 'OUTPUT_OCUPADO',
  'CAMINHO_ALTERADO', 'DIAGNOSTICO_CANCELADO', 'DIAGNOSTICO_TIMEOUT',
  'DIAGNOSTICO_RSS_EXCEDIDO', 'INTEGRIDADE_FALHOU', 'FK_INVALIDA',
  'SCHEMA_NAO_MAPEADO', 'SCHEMA_INCOMPLETO', 'TABELA_G_POVOADA', 'PK_DIVERGENTE',
  'ANEXOS_SEM_LOCK', 'VALOR_SQL_INVALIDO', 'ROW_MAIOR_4MIB', 'PK_INVALIDA',
  'SEMANTICA_INVALIDA', 'DOMINIO_INVALIDO', 'TIPO_INVALIDO', 'TIPO_SQL_DIVERGENTE',
  'TABELA_INVALIDA', 'CATALOGO_DIVERGENTE', 'PACOTE_ALTERADO', 'STAGING_ALTERADO',
  'RESTORE_CANCELADO', 'LIMPEZA_PENDENTE',
]);
const PHASES = new Set(['entrada', 'origem', 'pacote', 'validacao', 'paridade']);
const VALIDATIONS = new Set(['NAO_INICIADA', 'RECUSADA', 'VALIDADA']);
const CLEANUPS = new Set(['NAO_NECESSARIA', 'CONCLUIDA', 'PENDENTE']);
const HEX = /^[0-9a-f]{64}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
const count = value => Number.isSafeInteger(value) && value >= 0;

function validDigest(value) { return exact(value, ['linhas', 'sha256']) && count(value.linhas) && HEX.test(value.sha256); }

/** Valida uma gramática fechada; nunca retorna texto não reconhecido do filho. */
export function validarRecibo03A17(value) {
  if (!exact(value, ['codigo', 'fase', 'pacoteCriado', 'validacao', 'paridade', 'limpeza', 'rssPicoBytes', 'pacoteEfemero']) ||
      !CODES.has(value.codigo) || !PHASES.has(value.fase) || typeof value.pacoteCriado !== 'boolean' ||
      !VALIDATIONS.has(value.validacao) || !CLEANUPS.has(value.limpeza) || !count(value.rssPicoBytes) ||
      value.pacoteEfemero !== 'CHAVE_SOMENTE_EM_MEMORIA') return false;
  const parity = value.paridade;
  if (!exact(parity, ['eventos', 'conversas_app', 'tabelas']) || !Array.isArray(parity.tabelas) ||
      ![0, TABELAS_I_V9.length].includes(parity.tabelas.length)) return false;
  if (parity.tabelas.length === 0) {
    if (parity.eventos !== null || parity.conversas_app !== null) return false;
  } else {
    for (const [index, table] of TABELAS_I_V9.entries()) {
      const row = parity.tabelas[index];
      if (!exact(row, ['tabela', 'origem', 'oraculo', 'igual']) || row.tabela !== table.nome ||
          !validDigest(row.origem) || !validDigest(row.oraculo) || typeof row.igual !== 'boolean' ||
          row.igual !== (row.origem.linhas === row.oraculo.linhas && row.origem.sha256 === row.oraculo.sha256)) return false;
    }
    if (parity.eventos !== parity.tabelas.find(t => t.tabela === 'eventos').igual ||
        parity.conversas_app !== parity.tabelas.find(t => t.tabela === 'conversas_app').igual) return false;
  }
  const hasParity = parity.tabelas.length === TABELAS_I_V9.length;
  if (value.fase === 'entrada' && (value.pacoteCriado || value.validacao !== 'NAO_INICIADA' ||
      hasParity || value.limpeza !== 'NAO_NECESSARIA')) return false;
  if (value.fase === 'origem' && (value.pacoteCriado || value.validacao !== 'NAO_INICIADA' || hasParity)) return false;
  if (value.fase === 'pacote' && (value.validacao !== 'NAO_INICIADA' || hasParity)) return false;
  if (value.fase === 'validacao' && (!value.pacoteCriado || value.validacao !== 'RECUSADA' || hasParity)) return false;
  if (value.fase === 'paridade' && (!value.pacoteCriado || value.validacao !== 'VALIDADA')) return false;
  if (value.fase !== 'entrada' && value.fase !== 'origem' && value.limpeza === 'NAO_NECESSARIA') return false;
  if (hasParity && value.fase !== 'paridade') return false;
  if (value.codigo === 'PARIDADE_CONFIRMADA' &&
      (value.fase !== 'paridade' || !value.pacoteCriado || value.validacao !== 'VALIDADA' ||
       value.limpeza !== 'CONCLUIDA' || parity.eventos !== true || parity.conversas_app !== true ||
       !hasParity)) return false;
  if (value.codigo === 'PARIDADE_DIVERGENTE' &&
      (value.fase !== 'paridade' || !hasParity || value.limpeza !== 'CONCLUIDA' ||
       (parity.eventos && parity.conversas_app))) return false;
  if (value.validacao === 'VALIDADA' && !value.pacoteCriado) return false;
  return true;
}

function resultTemplate(timeoutMs) {
  return { codigo: 'SUPERVISAO_FALHOU', codigoFilho: null,
    supervisao: { estado: 'FALHOU', prazoMs: timeoutMs, cancelamentoEnviado: false, terminacaoForcada: false },
    processo: { iniciado: false, fechamentoConfirmado: false, exitCode: null, sinalizado: false },
    limpeza: 'PENDENTE', recibo: null };
}

function decodeReceipt(chunks) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return null; }
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  if (!text || text.includes('\n') || text.includes('\r')) return null;
  let receipt;
  try { receipt = JSON.parse(text); } catch { return null; }
  return validarRecibo03A17(receipt) ? receipt : null;
}

/** Unidade interna: a CLI fixa comando/argv; testes podem injetar apenas filhos fictícios. */
export async function supervisionarFilho({ comando, argumentos = [], timeoutMs = WATCHDOG_MS, graceMs = 300,
  finalMs = 1_000, signal, outputRoot, maxStdoutBytes = STDOUT_LIMIT, maxStderrBytes = STDERR_LIMIT } = {}) {
  const result = resultTemplate(timeoutMs);
  if (signal?.aborted) { result.codigo = 'SUPERVISAO_CANCELADA'; result.supervisao.estado = 'CANCELADA'; return result; }
  if (typeof comando !== 'string' || !path.isAbsolute(comando) || !Array.isArray(argumentos) ||
      !argumentos.every(x => typeof x === 'string') || ![timeoutMs, graceMs, finalMs, maxStdoutBytes, maxStderrBytes].every(count) ||
      (outputRoot !== undefined && (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot) || path.resolve(outputRoot) !== outputRoot)) ||
      timeoutMs === 0 || maxStdoutBytes === 0 || maxStderrBytes === 0) {
    result.codigo = 'ARGUMENTOS_INVALIDOS'; return result;
  }
  const env = Object.fromEntries(['SystemRoot', 'WINDIR'].filter(k => typeof process.env[k] === 'string').map(k => [k, process.env[k]]));
  if (outputRoot !== undefined) Object.assign(env, { TEMP: outputRoot, TMP: outputRoot, TMPDIR: outputRoot });
  let child;
  try { child = spawn(comando, argumentos, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), env }); }
  catch { result.codigo = 'FALHA_SPAWN'; return result; }

  let stdoutBytes = 0, stderrBytes = 0, reason = null, spawnError = false, closed = false, settled = false;
  let graceTimer, finalTimer, watchdog;
  const chunks = [];
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  function finishOnce() { if (!settled) { settled = true; finish(); } }
  function stop(reasonCode) {
    if (reason || closed) return;
    reason = reasonCode;
    result.supervisao.cancelamentoEnviado = true;
    try { child.kill('SIGTERM'); } catch {}
    graceTimer = setTimeout(() => {
      if (closed) return;
      result.supervisao.terminacaoForcada = true;
      try { child.kill('SIGKILL'); } catch {}
      finalTimer = setTimeout(() => {
        if (closed) return;
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        finishOnce();
      }, finalMs);
    }, graceMs);
  }
  child.once('spawn', () => { result.processo.iniciado = true; });
  child.once('error', () => { spawnError = true; stop('FALHA_SPAWN'); });
  child.stdout?.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) { stop('SAIDA_EXCEDIDA'); return; }
    chunks.push(chunk);
  });
  child.stderr?.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > maxStderrBytes) stop('SAIDA_EXCEDIDA');
  });
  child.stdout?.on('error', () => stop('SAIDA_FALHOU'));
  child.stderr?.on('error', () => stop('SAIDA_FALHOU'));
  child.once('close', (code, childSignal) => {
    if (settled) return;
    closed = true;
    result.processo.fechamentoConfirmado = true;
    result.processo.exitCode = Number.isInteger(code) ? code : null;
    result.processo.sinalizado = childSignal !== null;
    finishOnce();
  });
  watchdog = setTimeout(() => stop('PRAZO_EXCEDIDO'), timeoutMs);
  const onAbort = () => stop('SUPERVISAO_CANCELADA');
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  await completed;
  clearTimeout(watchdog); clearTimeout(graceTimer); clearTimeout(finalTimer);
  signal?.removeEventListener('abort', onAbort);
  if (!closed) { result.codigo = 'TERMINO_NAO_CONFIRMADO'; result.supervisao.estado = 'NAO_CONFIRMADA'; return result; }
  if (spawnError) { result.codigo = 'FALHA_SPAWN'; return result; }
  if (reason) { result.codigo = reason; result.supervisao.estado = 'INTERROMPIDA'; return result; }
  if (result.processo.exitCode !== 0) {
    const receipt = decodeReceipt(chunks);
    result.codigo = 'FILHO_EXIT_NAO_ZERO';
    result.codigoFilho = receipt?.codigo ?? null;
    result.limpeza = receipt?.limpeza ?? 'PENDENTE';
    return result;
  }
  const receipt = decodeReceipt(chunks);
  if (!receipt || receipt.codigo !== 'PARIDADE_CONFIRMADA' || receipt.limpeza !== 'CONCLUIDA') {
    result.codigo = 'RECIBO_INVALIDO'; return result;
  }
  result.codigo = receipt.codigo;
  result.codigoFilho = receipt.codigo;
  result.supervisao.estado = 'CONCLUIDA';
  result.limpeza = receipt.limpeza;
  result.recibo = receipt;
  return result;
}

function invalidArgs() { const result = resultTemplate(WATCHDOG_MS); result.codigo = 'ARGUMENTOS_INVALIDOS'; return result; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source', '--output-root'].includes(args[i]) || !args[i + 1] || parsed[args[i]]) { parsed.invalid = true; break; }
    parsed[args[i]] = args[i + 1];
  }
  const source = parsed['--source'], outputRoot = parsed['--output-root'];
  const validArgs = !parsed.invalid && args.length === 4 && typeof source === 'string' && typeof outputRoot === 'string' &&
    path.isAbsolute(source) && path.isAbsolute(outputRoot) && path.resolve(source) === source && path.resolve(outputRoot) === outputRoot;
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  const result = validArgs
    ? await supervisionarFilho({ comando: process.execPath, outputRoot,
      argumentos: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'diagnostic-backup-v9-roundtrip.mjs'),
        '--source', source, '--output-root', outputRoot], signal: controller.signal })
    : invalidArgs();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.codigo === 'PARIDADE_CONFIRMADA' && result.processo.fechamentoConfirmado &&
    result.processo.exitCode === 0 && result.limpeza === 'CONCLUIDA' ? 0 : 1;
}

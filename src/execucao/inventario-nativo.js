import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import { validarCaminhoProjeto } from './projeto.js';

const VERSAO = 1;
const ENTRADA_MAX = 32 * 1024;
const SAIDA_MAX = 4 * 1024 * 1024;
const ARQUIVOS_MAX = 5000;
const ENTRADAS_MAX = 20000;
const ARQUIVO_BYTES_MAX = 256 * 1024 * 1024;
const TOTAL_BYTES_MAX = 512 * 1024 * 1024;
const PRAZO_MS = 10000;

function indisponivel() {
  const erro = new Error('PROJECT_INVENTORY_UNAVAILABLE');
  erro.code = 'PROJECT_INVENTORY_UNAVAILABLE';
  return erro;
}

function camposExatos(valor, campos) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor) &&
    Object.getPrototypeOf(valor) === Object.prototype &&
    Object.keys(valor).sort().join(',') === campos.slice().sort().join(',');
}

function caminhoHelper() {
  const nome = process.platform === 'win32' ? 'lume-project-inventory.exe' : 'lume-project-inventory';
  const recursos = typeof process.resourcesPath === 'string' && process.resourcesPath
    ? process.resourcesPath
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../native/project-inventory/bin');
  return path.join(recursos, typeof process.resourcesPath === 'string' && process.resourcesPath ? 'project-inventory' : '', nome);
}

function criarQuadro(valor, limite) {
  const dados = Buffer.from(JSON.stringify(valor), 'utf8');
  if (dados.length > limite) throw indisponivel();
  const quadro = Buffer.allocUnsafe(4 + dados.length);
  quadro.writeUInt32BE(dados.length, 0);
  dados.copy(quadro, 4);
  return quadro;
}

function lerQuadro(bytes) {
  if (bytes.length < 4) throw indisponivel();
  const tamanho = bytes.readUInt32BE(0);
  if (!tamanho || tamanho > SAIDA_MAX || bytes.length !== tamanho + 4) throw indisponivel();
  let valor;
  try { valor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4))); }
  catch { throw indisponivel(); }
  if (!camposExatos(valor, ['version', 'files', 'omitted']) || valor.version !== VERSAO ||
      !Array.isArray(valor.files) || valor.files.length > ARQUIVOS_MAX ||
      !Number.isSafeInteger(valor.omitted) || valor.omitted < 0 || valor.omitted > ENTRADAS_MAX ||
      valor.files.length + valor.omitted > ENTRADAS_MAX) throw indisponivel();
  const vistos = new Set();
  const arquivos = [];
  let total = 0;
  for (const item of valor.files) {
    if (!camposExatos(item, ['path', 'bytes']) || typeof item.path !== 'string' ||
        Buffer.byteLength(item.path, 'utf8') > 4096 || item.path.split('/').length > 64 ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > ARQUIVO_BYTES_MAX) throw indisponivel();
    try { validarCaminhoProjeto(item.path); } catch { throw indisponivel(); }
    const chave = item.path.normalize('NFC').toLowerCase();
    if (vistos.has(chave)) throw indisponivel();
    vistos.add(chave);
    total += item.bytes;
    if (total > TOTAL_BYTES_MAX) throw indisponivel();
    arquivos.push({ caminho: item.path, bytes: item.bytes });
  }
  arquivos.sort((a, b) => a.caminho.localeCompare(b.caminho, 'en'));
  return { arquivos, omitidos: valor.omitted };
}

function executar({ helperPath, spawnImpl, timeoutMs, quadro }) {
  return new Promise((resolve, reject) => {
    let filho;
    try {
      filho = spawnImpl(helperPath, [], {
        cwd: path.dirname(helperPath), env: {}, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch { reject(indisponivel()); return; }
    if (!filho?.stdin?.end || !filho?.stdin?.on || !filho?.stdout?.on || !filho?.stderr?.on || !filho?.once || !filho?.kill) {
      reject(indisponivel()); return;
    }
    let terminou = false;
    let tamanho = 0;
    const partes = [];
    const prazo = setTimeout(() => falhar(), timeoutMs);
    function falhar() {
      if (terminou) return;
      terminou = true;
      clearTimeout(prazo);
      try { filho.kill('SIGKILL'); } catch { /* falha permanece fechada */ }
      reject(indisponivel());
    }
    filho.stdout.on('data', parte => {
      if (terminou) return;
      const bytes = Buffer.from(parte);
      tamanho += bytes.length;
      if (tamanho > SAIDA_MAX + 4) { falhar(); return; }
      partes.push(bytes);
    });
    filho.stderr.on('data', parte => { if (Buffer.byteLength(parte)) falhar(); });
    filho.stdout.on('error', falhar);
    filho.stderr.on('error', falhar);
    filho.once('error', falhar);
    filho.once('close', (codigo, sinal) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(prazo);
      if (codigo !== 0 || sinal) { reject(indisponivel()); return; }
      resolve(Buffer.concat(partes, tamanho));
    });
    filho.stdin.on('error', falhar);
    try { filho.stdin.end(quadro); } catch { falhar(); }
  });
}

export function criarClienteInventarioNativo({ helperPath = caminhoHelper(), spawnImpl = spawn, timeoutMs = PRAZO_MS } = {}) {
  if (typeof helperPath !== 'string' || !path.isAbsolute(helperPath) || typeof spawnImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PRAZO_MS) throw indisponivel();
  return async function inventario({ origem } = {}) {
    if (typeof origem !== 'string' || !path.isAbsolute(origem) || origem.includes('\0') ||
        process.platform === 'win32' && /^\\\\/.test(origem)) throw indisponivel();
    const quadro = criarQuadro({ version: VERSAO, root: origem }, ENTRADA_MAX);
    const resposta = await executar({ helperPath, spawnImpl, timeoutMs, quadro });
    return lerQuadro(resposta);
  };
}

const clientePadrao = criarClienteInventarioNativo();

export function listarInventarioNativo({ origem } = {}) {
  return clientePadrao({ origem });
}

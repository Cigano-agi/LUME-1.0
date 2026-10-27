import { constants } from 'node:fs';
import { open, lstat, mkdtemp, chmod, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { conferirObjetoStagingV9, registrarObjetoStagingV9, validarAreaStagingV9 } from './backup-staging-v9.js';

const scrypt = promisify(scryptCb);
const CABECALHO = 72;
const QUADRO = 9;
const TAG = 16;
const PARTE = 1024 * 1024;
const MAX_INPUT = 4 * PARTE;
const MAX_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_PARTES = 16384;
const MANIFESTO = 44;
const MAGIC = Buffer.from('LUMEBK01');
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function abortar(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Operação cancelada');
}

function exigir(condicao, mensagem) { if (!condicao) throw new Error(mensagem); }

async function caminhoGerido(caminho, ultimoExiste) {
  exigir(typeof caminho === 'string' && caminho.length > 0 && path.isAbsolute(caminho), 'Caminho absoluto obrigatório');
  const resolvido = path.resolve(caminho);
  const raiz = path.parse(resolvido).root;
  let atual = raiz;
  const partes = resolvido.slice(raiz.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < partes.length; i++) {
    atual = path.join(atual, partes[i]);
    try {
      const st = await lstat(atual, { bigint: true });
      exigir(!st.isSymbolicLink(), 'Link/reparse point não permitido no caminho');
      if (i < partes.length - 1 || ultimoExiste === 'diretorio') exigir(st.isDirectory(), 'Diretório esperado');
      if (i === partes.length - 1 && ultimoExiste === 'arquivo') exigir(st.isFile(), 'Arquivo regular esperado');
      if (i === partes.length - 1 && ultimoExiste === false) throw new Error('Destino já existe');
    } catch (erro) {
      if (erro.code === 'ENOENT' && i === partes.length - 1 && ultimoExiste === false) return resolvido;
      throw erro;
    }
  }
  return resolvido;
}

function cabecalhoNovo() {
  const b = Buffer.alloc(CABECALHO);
  MAGIC.copy(b, 0);
  b[8] = 1;
  b.writeUInt32BE(PARTE, 12);
  randomBytes(16).copy(b, 16);
  randomBytes(16).copy(b, 32);
  randomBytes(8).copy(b, 48);
  b.writeUInt32BE(32768, 56);
  b.writeUInt32BE(8, 60);
  b.writeUInt32BE(1, 64);
  return b;
}

function validarCabecalho(b) {
  exigir(b.length === CABECALHO && b.subarray(0, 8).equals(MAGIC), 'Cabeçalho inválido');
  exigir(b[8] === 1 && b[9] === 0 && b.readUInt16BE(10) === 0, 'Versão/flags inválidas');
  exigir(b.readUInt32BE(12) === PARTE, 'Limite de parte inválido');
  exigir(b.readUInt32BE(56) === 32768 && b.readUInt32BE(60) === 8 && b.readUInt32BE(64) === 1 && b.readUInt32BE(68) === 0, 'Parâmetros KDF inválidos');
}

async function chave(senha, b) {
  exigir(typeof senha === 'string' && senha.length <= 512 && senha.isWellFormed(), 'Senha deve ter 12 a 256 caracteres Unicode válidos');
  const pontos = Array.from(senha).length;
  exigir(pontos >= 12 && pontos <= 256, 'Senha deve ter 12 a 256 caracteres Unicode válidos');
  return scrypt(senha, b.subarray(16, 32), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function quadroCabecalho(tipo, indice, tamanho) {
  const b = Buffer.alloc(QUADRO);
  b[0] = tipo; b.writeUInt32BE(indice, 1); b.writeUInt32BE(tamanho, 5);
  return b;
}

function nonce(b, indice) {
  const n = Buffer.alloc(12);
  b.copy(n, 0, 48, 56); n.writeUInt32BE(indice, 8);
  return n;
}

function cifrar(b, key, tipo, indice, plaintext) {
  const q = quadroCabecalho(tipo, indice, plaintext.length);
  const cipher = createCipheriv('aes-256-gcm', key, nonce(b, indice));
  cipher.setAAD(Buffer.concat([b, q]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [q, ciphertext, cipher.getAuthTag()];
}

function decifrar(b, key, q, ciphertext, tag) {
  const indice = q.readUInt32BE(1);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce(b, indice));
  decipher.setAAD(Buffer.concat([b, q]));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function escrever(handle, b, signal) {
  let pos = 0;
  while (pos < b.length) {
    abortar(signal);
    const { bytesWritten } = await handle.write(b, pos, b.length - pos);
    exigir(bytesWritten > 0, 'Escrita interrompida');
    pos += bytesWritten;
  }
}

async function ler(handle, tamanho, posicao, signal) {
  const b = Buffer.alloc(tamanho);
  let lidos = 0;
  while (lidos < tamanho) {
    abortar(signal);
    const { bytesRead } = await handle.read(b, lidos, tamanho - lidos, posicao + lidos);
    exigir(bytesRead > 0, 'Pacote truncado');
    lidos += bytesRead;
  }
  return b;
}

async function removerSeProprio(caminho, identidade) {
  if (!identidade) return;
  try {
    const atual = await lstat(caminho, { bigint: true });
    if (atual.dev === identidade.dev && atual.ino === identidade.ino && !atual.isSymbolicLink()) await unlink(caminho);
  } catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
}

/** Grava pacote cifrado em arquivo novo, consumindo AsyncIterable<Buffer>. */
export async function gravarPacote({ origem, destino, senha, signal } = {}) {
  abortar(signal);
  exigir(origem && typeof origem[Symbol.asyncIterator] === 'function', 'Origem AsyncIterable obrigatória');
  const alvo = await caminhoGerido(destino, false);
  let handle; let identidade; let key;
  try {
    handle = await open(alvo, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    identidade = await handle.stat({ bigint: true });
    const b = cabecalhoNovo();
    key = await chave(senha, b);
    await escrever(handle, b, signal);
    const hash = createHash('sha256');
    let partes = 0; let bytes = 0;
    let pendente = Buffer.allocUnsafe(PARTE); let usado = 0;
    async function emitir(tamanho) {
      exigir(partes < MAX_PARTES && bytes + tamanho <= MAX_BYTES, 'Limite de pacote excedido');
      const pedaco = pendente.subarray(0, tamanho);
      hash.update(pedaco);
      for (const bloco of cifrar(b, key, 1, partes, pedaco)) await escrever(handle, bloco, signal);
      partes++; bytes += tamanho; usado = 0;
    }
    for await (const chunk of origem) {
      abortar(signal);
      exigir(Buffer.isBuffer(chunk), 'Cada item da origem deve ser Buffer');
      exigir(chunk.length <= MAX_INPUT, 'Buffer de origem excede 4 MiB');
      for (let inicio = 0; inicio < chunk.length;) {
        const n = Math.min(PARTE - usado, chunk.length - inicio);
        chunk.copy(pendente, usado, inicio, inicio + n);
        inicio += n; usado += n;
        if (usado === PARTE) await emitir(PARTE);
      }
    }
    if (usado) await emitir(usado);
    const m = Buffer.alloc(MANIFESTO);
    m.writeUInt32BE(partes, 0); m.writeBigUInt64BE(BigInt(bytes), 4); hash.digest().copy(m, 12);
    for (const bloco of cifrar(b, key, 2, partes, m)) await escrever(handle, bloco, signal);
    await handle.sync();
    return { destino: alvo, partes, bytes };
  } catch (erro) {
    if (handle) await handle.close().catch(() => {});
    handle = null;
    await removerSeProprio(alvo, identidade);
    throw erro;
  } finally {
    key?.fill(0);
    if (handle) await handle.close();
  }
}

/** Verifica integralmente antes de devolver o arquivo plaintext privado. */
export async function verificarPacote({ pacote, pastaStaging, senha, signal, areaStaging } = {}) {
  abortar(signal);
  if (areaStaging !== undefined) validarAreaStagingV9(areaStaging, pastaStaging);
  const origem = await caminhoGerido(pacote, 'arquivo');
  const pai = await caminhoGerido(pastaStaging, 'diretorio');
  let entrada; let saida; let key; let pasta; let identidadePasta; let identidadeArquivo; let erroOriginal;
  try {
    entrada = await open(origem, constants.O_RDONLY | NOFOLLOW);
    const st = await entrada.stat({ bigint: true });
    exigir(st.isFile() && st.size >= BigInt(CABECALHO + QUADRO + MANIFESTO + TAG), 'Pacote inválido/truncado');
    exigir(st.size <= BigInt(MAX_BYTES + MAX_PARTES * (QUADRO + TAG) + CABECALHO + QUADRO + MANIFESTO + TAG), 'Pacote excede 16 GiB');
    const b = await ler(entrada, CABECALHO, 0, signal);
    validarCabecalho(b);
    key = await chave(senha, b);
    const tamanhoPacote = Number(st.size); // limite de 16 GiB conferido antes; offset exato
    pasta = areaStaging ? await areaStaging.criarPastaStream() : await mkdtemp(path.join(pai, '.lume-stream-'));
    if (!areaStaging) await chmod(pasta, 0o700);
    identidadePasta = await lstat(pasta, { bigint: true });
    if (areaStaging) await registrarObjetoStagingV9(areaStaging, pasta);
    const caminhoStaging = path.join(pasta, 'conteudo.bin');
    saida = areaStaging
      ? await registrarObjetoStagingV9(areaStaging, await areaStaging.criarArquivo('conteudo.bin', pasta))
      : await open(caminhoStaging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    identidadeArquivo = await saida.stat({ bigint: true });
    if (areaStaging) { conferirObjetoStagingV9(areaStaging, pasta); conferirObjetoStagingV9(areaStaging, caminhoStaging); }
    const hash = createHash('sha256');
    let pos = CABECALHO; let partes = 0; let bytes = 0;
    while (true) {
      exigir(pos + QUADRO + TAG <= tamanhoPacote, 'Pacote truncado');
      const q = await ler(entrada, QUADRO, pos, signal); pos += QUADRO;
      const tipo = q[0]; const indice = q.readUInt32BE(1); const tamanho = q.readUInt32BE(5);
      exigir(indice === partes && partes <= MAX_PARTES, 'Índice fora de ordem');
      exigir((tipo === 1 && tamanho > 0 && tamanho <= PARTE && partes < MAX_PARTES) ||
        (tipo === 2 && tamanho === MANIFESTO), 'Quadro/limite inválido');
      exigir(pos + tamanho + TAG <= tamanhoPacote, 'Pacote truncado');
      const ciphertext = await ler(entrada, tamanho, pos, signal); pos += tamanho;
      const tag = await ler(entrada, TAG, pos, signal); pos += TAG;
      const plaintext = decifrar(b, key, q, ciphertext, tag);
      if (tipo === 2) {
        exigir(pos === tamanhoPacote, 'Bytes extras após manifesto');
        exigir((await entrada.stat({ bigint: true })).size === st.size, 'Pacote alterado durante leitura');
        exigir(plaintext.readUInt32BE(0) === partes && plaintext.readBigUInt64BE(4) === BigInt(bytes), 'Manifesto divergente');
        const sha256 = hash.digest('hex');
        exigir(plaintext.subarray(12).toString('hex') === sha256, 'Hash divergente');
        await saida.sync(); await saida.close(); saida = null;
        const arquivoFinal = await lstat(caminhoStaging, { bigint: true });
        const pastaFinal = await lstat(pasta, { bigint: true });
        exigir(arquivoFinal.dev === identidadeArquivo.dev && arquivoFinal.ino === identidadeArquivo.ino && !arquivoFinal.isSymbolicLink() &&
          pastaFinal.dev === identidadePasta.dev && pastaFinal.ino === identidadePasta.ino && !pastaFinal.isSymbolicLink(), 'Staging alterado durante leitura');
        return { caminhoStaging, pastaStaging: pasta, partes, bytes, sha256 };
      }
      exigir(bytes + plaintext.length <= MAX_BYTES, 'Limite de pacote excedido');
      await escrever(saida, plaintext, signal);
      hash.update(plaintext); bytes += plaintext.length; partes++;
    }
  } catch (erro) {
    erroOriginal = erro;
    if (saida) await saida.close().catch(() => {});
    saida = null;
    if (pasta && !areaStaging) {
      await removerSeProprio(path.join(pasta, 'conteudo.bin'), identidadeArquivo).catch(() => {});
      try {
        const atual = await lstat(pasta, { bigint: true });
        if (identidadePasta && atual.dev === identidadePasta.dev && atual.ino === identidadePasta.ino && !atual.isSymbolicLink()) await rmdir(pasta);
      } catch {}
    }
    throw erro;
  } finally {
    key?.fill(0);
    if (entrada) try { await entrada.close(); } catch (erro) { if (!erroOriginal) throw erro; }
  }
}

import { mkdir, open, readFile, unlink, lstat, realpath, rename } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Exclusive process lease; never reads or copies credential contents. */
export async function bloquearSessao(authDir) {
  const dir = resolve(authDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const arquivo = join(dir, '.assessor.lock');
  let handle;
  try { handle = await open(arquivo, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Do not steal an ambiguous lock (including a partially written lock).
    let pid;
    try { pid = Number((await readFile(arquivo, 'utf8')).trim()); } catch { throw Error('Sessao ocupada'); }
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Sessao ocupada');
    try { process.kill(pid, 0); throw Error('Sessao ocupada'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw Error('Sessao ocupada'); }
    // Exclusive recovery guard serializes stale-lock reclaimers. A concurrent
    // fresh owner can win open(wx), but its lock is never removed afterwards.
    const guarda = join(dir, '.assessor.reclaim');
    let claim;
    try { claim = await open(guarda, 'wx', 0o600); }
    catch { throw Error('Sessao em recuperacao por outro processo'); }
    try {
      const atual = Number((await readFile(arquivo, 'utf8')).trim());
      if (atual !== pid) throw Error('Sessao ocupada');
      try { process.kill(atual, 0); throw Error('Sessao ocupada'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw Error('Sessao ocupada'); }
      await unlink(arquivo);
      handle = await open(arquivo, 'wx', 0o600);
    } finally { await claim.close(); await unlink(guarda); }
  }
  await handle.writeFile(String(process.pid));
  // The exclusive file plus live PID owns the lease. Keeping the handle open
  // prevents the safe sibling-directory rename on Windows.
  await handle.close();
  let liberada = false;
  return async (movidaPara) => { if (liberada) return; liberada = true; await unlink(movidaPara ? join(movidaPara, '.assessor.lock') : arquivo); };
}

/** Preserve invalid credentials in a sibling directory, never delete them. */
export async function arquivarSessaoInvalida(authDir) {
  const dir = resolve(authDir);
  if (dirname(dir) === dir) throw Error('Diretorio de sessao invalido');
  let info;
  try { info = await lstat(dir); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Diretorio de sessao invalido');
  const pai = await realpath(dirname(dir));
  const origem = await realpath(dir);
  // Only the explicitly named authentication directory may move, within its
  // verified physical parent. Junctions and filesystem roots are rejected.
  if (dirname(origem).toLowerCase() !== pai.toLowerCase()) throw Error('Sessao fora do diretorio esperado');
  const destino = resolve(pai, `${basename(origem)}-invalid-${Date.now()}-${randomUUID()}`);
  if (dirname(destino).toLowerCase() !== pai.toLowerCase() || destino === origem) throw Error('Destino de sessao invalido');
  const liberar = await bloquearSessao(origem);
  let movida = false;
  try { await rename(origem, destino); movida = true; }
  finally { await liberar(movida ? destino : undefined); }
  return destino;
}

export async function abrirSessao(authDir) {
  const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let fila = Promise.resolve();
  return {
    state,
    salvar() { const atual = fila.then(() => saveCreds()); fila = atual.catch(() => {}); return atual; },
    async concluir() { await fila; },
  };
}


import { constants, lstatSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, opendir, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const MAGIC = 'LUME_STAGING_V9';
const MANIFESTO = 'manifesto.json';
const PREFIXO = '.lume-restore-';
const LIMITE_MANIFESTO = 64 * 1024;
const LIMITE_OBJETOS = 16;
const MAX_ID = (1n << 64n) - 1n;
const CAPACIDADES = new WeakMap();
const NOFOLLOW = constants.O_NOFOLLOW || 0;
const ARQUIVOS = new Set(['acervo.sqlite', 'acervo.sqlite-wal', 'acervo.sqlite-shm', 'anexos.pack']);
const STREAM = /^\.lume-stream-[A-Za-z0-9_-]{6,64}$/;

function falha(code) { const error = new Error(code); error.code = code; return error; }
function sanitizar(error) { return falha(/^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'STAGING_FALHOU'); }
function exigir(ok, code) { if (!ok) throw falha(code); }
function chaves(obj, nomes) { return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).sort().join('|') === nomes.slice().sort().join('|'); }
function decimal(valor) {
  exigir(typeof valor === 'string' && /^(0|[1-9]\d{0,19})$/.test(valor), 'MANIFESTO_INVALIDO');
  const n = BigInt(valor);
  exigir(n <= MAX_ID, 'MANIFESTO_INVALIDO');
  return n;
}
function identidade(st) {
  exigir(st.dev >= 0n && st.dev <= MAX_ID && st.ino >= 0n && st.ino <= MAX_ID, 'IDENTIDADE_INVALIDA');
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}
function igual(id, st) { return st && !st.isSymbolicLink() && BigInt(id.dev) === st.dev && BigInt(id.ino) === st.ino; }
function diretorio(st) { return st?.isDirectory() && !st.isSymbolicLink(); }
function arquivo(st) { return st?.isFile() && !st.isSymbolicLink() && st.nlink === 1n; }
function validarCaminhoAbsoluto(caminho) {
  exigir(typeof caminho === 'string' && path.isAbsolute(caminho) && path.resolve(caminho) === caminho, 'CAMINHO_INVALIDO');
  return caminho;
}
async function caminhoSemLinks(caminho, tipo = 'dir') {
  validarCaminhoAbsoluto(caminho);
  let atual = path.parse(caminho).root;
  let raizStat;
  try { raizStat = await lstat(atual, { bigint: true }); } catch { throw falha('CAMINHO_INVALIDO'); }
  exigir(diretorio(raizStat), 'CAMINHO_INVALIDO');
  const partes = caminho.slice(atual.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < partes.length; i++) {
    atual = path.join(atual, partes[i]);
    let st;
    try { st = await lstat(atual, { bigint: true }); } catch { throw falha('CAMINHO_INVALIDO'); }
    exigir(i === partes.length - 1 && tipo === 'file' ? arquivo(st) : diretorio(st), 'CAMINHO_INVALIDO');
  }
  return lstat(caminho, { bigint: true });
}
function sidAtual() {
  const r = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = r.status === 0 && /S-1-\d+(?:-\d+)+/.exec(r.stdout)?.[0];
  exigir(sid, 'ACL_INDISPONIVEL');
  return sid;
}
function aclWindows(caminho, sid, exclusiva) {
  const script = `$a=Get-Acl -LiteralPath $env:LUME_STAGE_ACL_PATH; $e=@($a.Access | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;rights=[int]$_.FileSystemRights;type=$_.AccessControlType.ToString();inherited=$_.IsInherited} }); [pscustomobject]@{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;entries=$e} | ConvertTo-Json -Compress -Depth 4`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, env: { ...process.env, LUME_STAGE_ACL_PATH: caminho } });
  let acl; try { acl = JSON.parse(r.stdout); } catch { throw falha('ACL_INDISPONIVEL'); }
  exigir(r.status === 0 && acl.owner === sid && Array.isArray(acl.entries), 'ACL_INDISPONIVEL');
  if (exclusiva) exigir(acl.entries.length === 1, 'ACL_INDISPONIVEL');
  const e = acl.entries.find(entry => entry.sid === sid && entry.type === 'Allow' && (entry.rights & 0x1f01ff) === 0x1f01ff);
  exigir(e, 'ACL_INDISPONIVEL');
  exigir(e.sid === sid && e.type === 'Allow' && (e.rights & 0x1f01ff) === 0x1f01ff, 'ACL_INDISPONIVEL');
  if (exclusiva) exigir(acl.protected && !e.inherited, 'ACL_INDISPONIVEL');
}
async function propriedade(caminho, st, sid, exclusiva = false) {
  if (process.platform === 'win32') { aclWindows(caminho, sid, exclusiva); return; }
  exigir(typeof process.getuid === 'function' && st.uid === BigInt(process.getuid()), 'PROPRIEDADE_INVALIDA');
  exigir((st.mode & 0o077n) === 0n, 'MODO_INSEGURO');
}
function relativoPermitido(nome, tipo) {
  exigir(typeof nome === 'string' && nome.length < 128 && nome !== '.' && nome !== '..' && !nome.includes('\\') && !nome.includes('/') && !path.isAbsolute(nome), 'OBJETO_NAO_PERMITIDO');
  if (tipo === 'dir') exigir(STREAM.test(nome), 'OBJETO_NAO_PERMITIDO');
  else exigir(ARQUIVOS.has(nome) || nome === 'conteudo.bin', 'OBJETO_NAO_PERMITIDO');
}
function validarEntrada(obj) {
  exigir(chaves(obj, ['name', 'type', 'dev', 'ino']), 'MANIFESTO_INVALIDO');
  exigir(obj.type === 'file' || obj.type === 'dir', 'MANIFESTO_INVALIDO');
  exigir(typeof obj.name === 'string' && obj.name.length <= 160 && !obj.name.includes('\\'), 'MANIFESTO_INVALIDO');
  const parts = obj.name.split('/');
  exigir(parts.length <= 2, 'MANIFESTO_INVALIDO');
  if (parts.length === 1) {
    exigir(obj.type === 'dir' ? STREAM.test(parts[0]) : ARQUIVOS.has(parts[0]), 'MANIFESTO_INVALIDO');
  } else {
    exigir(obj.type === 'file' && STREAM.test(parts[0]) && parts[1] === 'conteudo.bin', 'MANIFESTO_INVALIDO');
  }
  decimal(obj.dev); decimal(obj.ino);
}
function checksum(record) { return createHash('sha256').update(JSON.stringify(record)).digest('hex'); }
function linha(record) { return JSON.stringify({ ...record, checksum: checksum(record) }) + '\n'; }
function validarRegistro(record, keys) {
  exigir(chaves(record, [...keys, 'checksum']) && /^[a-f0-9]{64}$/.test(record.checksum), 'MANIFESTO_INVALIDO');
  const { checksum: hash, ...body } = record;
  exigir(checksum(body) === hash, 'MANIFESTO_INVALIDO');
  return body;
}
function validarManifesto(bytes, root, area, journal) {
  const ultimoLF = bytes.lastIndexOf(10);
  exigir(ultimoLF >= 0, 'MANIFESTO_INVALIDO');
  const caudaIncompleta = ultimoLF !== bytes.length - 1;
  let texto; try { texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, ultimoLF + 1)); } catch { throw falha('MANIFESTO_INVALIDO'); }
  const linhas = texto.split('\n');
  linhas.pop();
  exigir(linhas.length >= 1, 'MANIFESTO_INVALIDO');
  let header; try { header = validarRegistro(JSON.parse(linhas[0]), ['kind', 'magic', 'version', 'root', 'area', 'journal', 'owner', 'seq']); } catch { throw falha('MANIFESTO_INVALIDO'); }
  exigir(header.kind === 'header' && header.magic === MAGIC && header.version === 2 && header.seq === 0, 'MANIFESTO_INVALIDO');
  for (const id of [header.root, header.area, header.journal]) {
    exigir(chaves(id, ['dev', 'ino']), 'MANIFESTO_INVALIDO'); decimal(id.dev); decimal(id.ino);
  }
  exigir(chaves(header.owner, ['pid', 'token']) && Number.isSafeInteger(header.owner.pid) && header.owner.pid > 0 && /^[a-f0-9]{32}$/.test(header.owner.token), 'MANIFESTO_INVALIDO');
  exigir(igual(header.root, root) && igual(header.area, area) && igual(header.journal, journal), 'IDENTIDADE_DIVERGENTE');
  const objects = []; const nomes = new Set();
  for (const [index, item] of linhas.slice(1).entries()) {
    let obj; try { obj = validarRegistro(JSON.parse(item), ['kind', 'seq', 'name', 'type', 'dev', 'ino']); } catch { throw falha('MANIFESTO_INVALIDO'); }
    exigir(obj.kind === 'object' && obj.seq === index + 1, 'MANIFESTO_INVALIDO');
    validarEntrada({ name: obj.name, type: obj.type, dev: obj.dev, ino: obj.ino });
    exigir(!nomes.has(obj.name) && objects.length < LIMITE_OBJETOS, 'MANIFESTO_INVALIDO');
    nomes.add(obj.name); objects.push({ name: obj.name, type: obj.type, dev: obj.dev, ino: obj.ino });
  }
  for (const obj of objects) if (obj.name.includes('/')) exigir(nomes.has(obj.name.split('/')[0]), 'MANIFESTO_INVALIDO');
  return { header, objects, caudaIncompleta, bytes: bytes.length };
}
async function lerManifesto(area, rootStat, areaStat, sid) {
  const caminho = path.join(area, MANIFESTO);
  const st = await caminhoSemLinks(caminho, 'file');
  exigir(arquivo(st) && st.size <= BigInt(LIMITE_MANIFESTO), 'MANIFESTO_INVALIDO');
  await propriedade(caminho, st, sid);
  const h = await open(caminho, constants.O_RDONLY | NOFOLLOW);
  let bytes;
  try {
    exigir(igual(identidade(st), await h.stat({ bigint: true })), 'IDENTIDADE_DIVERGENTE');
    const buffer = Buffer.alloc(LIMITE_MANIFESTO + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await h.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    bytes = buffer.subarray(0, total);
  } finally { await h.close(); }
  exigir(bytes.length <= LIMITE_MANIFESTO, 'MANIFESTO_INVALIDO');
  return validarManifesto(bytes, rootStat, areaStat, st);
}
async function syncDiretorio(dir) {
  try { const h = await open(dir, constants.O_RDONLY); try { await h.sync(); } finally { await h.close(); } return true; }
  catch { return false; }
}
async function anexarRegistro(area, record) {
  exigir(!area.diarioFalhou, 'DIARIO_INCOMPLETO');
  const { root, atual } = await conferirArea(area);
  const persisted = await lerManifesto(area.caminho, root, atual, area.sid);
  exigir(!persisted.caudaIncompleta && persisted.bytes === area.manifesto.bytes && persisted.header.owner.token === area.manifesto.header.owner.token && persisted.objects.length === area.manifesto.objects.length, 'DIARIO_INCOMPLETO');
  const texto = linha(record);
  exigir(area.manifesto.bytes + Buffer.byteLength(texto) <= LIMITE_MANIFESTO, 'MANIFESTO_INVALIDO');
  const caminho = path.join(area.caminho, MANIFESTO);
  const st = await caminhoSemLinks(caminho, 'file');
  exigir(igual(area.manifesto.header.journal, st), 'IDENTIDADE_DIVERGENTE');
  const h = await open(caminho, constants.O_WRONLY | constants.O_APPEND | NOFOLLOW);
  try {
    exigir(igual(area.manifesto.header.journal, await h.stat({ bigint: true })), 'IDENTIDADE_DIVERGENTE');
    const buffer = Buffer.from(texto);
    let offset = 0;
    while (offset < buffer.length) { const { bytesWritten } = await h.write(buffer, offset, buffer.length - offset); exigir(bytesWritten > 0, 'STAGING_FALHOU'); offset += bytesWritten; }
    await h.sync();
  } catch (error) { area.diarioFalhou = true; throw error; }
  finally { await h.close(); }
  area.manifesto.bytes += Buffer.byteLength(texto);
}
function capacidade(area) { const state = CAPACIDADES.get(area); exigir(state, 'AREA_INVALIDA'); return state; }
export function validarAreaStagingV9(area, caminho) {
  const state = capacidade(area);
  exigir(state.caminho === caminho && !state.encerrando, 'AREA_INVALIDA');
  return true;
}
/** Confere a identidade inventariada sem expor o registro mutável. */
export function conferirObjetoStagingV9(area, caminho, { permitirAusente = false } = {}) {
  const state = capacidade(area);
  const stat = alvo => { try { return lstatSync(alvo, { bigint: true }); } catch { throw falha('IDENTIDADE_DIVERGENTE'); } };
  let atual = path.parse(state.caminho).root;
  for (const parte of state.caminho.slice(atual.length).split(path.sep).filter(Boolean)) {
    atual = path.join(atual, parte);
    exigir(diretorio(stat(atual)), 'IDENTIDADE_DIVERGENTE');
  }
  exigir(igual(identidade(state.rootStat), stat(state.raiz)) &&
    igual(identidade(state.areaStat), stat(state.caminho)), 'IDENTIDADE_DIVERGENTE');
  exigir(typeof caminho === 'string' && path.isAbsolute(caminho), 'CAMINHO_INVALIDO');
  const rel = path.relative(state.caminho, caminho).split(path.sep).join('/');
  const obj = state.manifesto.objects.find(item => item.name === rel);
  exigir(obj && path.join(state.caminho, ...rel.split('/')) === caminho, 'OBJETO_NAO_REGISTRADO');
  if (rel.includes('/')) {
    const parentName = rel.split('/')[0];
    const parent = state.manifesto.objects.find(item => item.name === parentName && item.type === 'dir');
    exigir(parent && igual(parent, stat(path.join(state.caminho, parentName))), 'IDENTIDADE_DIVERGENTE');
  }
  let st;
  try { st = lstatSync(caminho, { bigint: true }); }
  catch (error) {
    if (permitirAusente && error.code === 'ENOENT') return false;
    throw falha('IDENTIDADE_DIVERGENTE');
  }
  exigir(igual(obj, st) && (obj.type === 'file' ? arquivo(st) : diretorio(st)), 'IDENTIDADE_DIVERGENTE');
  return true;
}
function serializar(area, func) {
  const proximo = area.fila.then(func, func).catch(error => { throw sanitizar(error); });
  area.fila = proximo.catch(() => {});
  return proximo;
}
function montarArea(caminho, raiz, rootStat, areaStat, sid, manifesto) {
  const area = {
    caminho, raiz, rootStat, areaStat, sid, manifesto,
    pendentes: new Map(), entregues: new Set(), fila: Promise.resolve(), fsyncDiretorioSuportado: null, encerrando: false, diarioFalhou: false,
  };
  const fachada = Object.freeze({
    caminho,
    criarArquivo(nome, pastaStream) { return serializar(area, async () => {
      exigir(!area.encerrando && !area.diarioFalhou, 'AREA_ENCERRADA');
      relativoPermitido(nome, 'file');
      exigir(nome === 'conteudo.bin' ? typeof pastaStream === 'string' : pastaStream === undefined, 'OBJETO_NAO_PERMITIDO');
      let rel = nome;
      if (pastaStream) {
        exigir(path.dirname(pastaStream) === caminho && STREAM.test(path.basename(pastaStream)), 'OBJETO_NAO_PERMITIDO');
        rel = `${path.basename(pastaStream)}/conteudo.bin`;
        const pastaRegistrada = area.manifesto.objects.find(o => o.name === path.basename(pastaStream) && o.type === 'dir');
        exigir(pastaRegistrada, 'OBJETO_NAO_PERMITIDO');
        const pastaAtual = await caminhoSemLinks(pastaStream);
        exigir(igual(pastaRegistrada, pastaAtual), 'IDENTIDADE_DIVERGENTE');
      }
      exigir(!area.manifesto.objects.some(o => o.name === rel) && !area.pendentes.has(rel), 'OBJETO_DUPLICADO');
      exigir(area.manifesto.objects.length + area.pendentes.size < LIMITE_OBJETOS, 'LIMITE_OBJETOS');
      const destino = path.join(caminho, ...rel.split('/'));
      const h = await open(destino, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      try {
        const st = await h.stat({ bigint: true });
        exigir(arquivo(st) && st.size === 0n, 'OBJETO_INVALIDO');
        area.pendentes.set(rel, { caminho: destino, type: 'file', stat: st, handle: h });
        return destino;
      } catch (error) { await h.close(); throw error; }
    }); },
    criarPastaStream() { return serializar(area, async () => {
      exigir(!area.encerrando && !area.diarioFalhou, 'AREA_ENCERRADA');
      exigir(area.manifesto.objects.length + area.pendentes.size < LIMITE_OBJETOS, 'LIMITE_OBJETOS');
      const destino = await mkdtemp(path.join(caminho, '.lume-stream-'));
      const st = await lstat(destino, { bigint: true });
      exigir(diretorio(st) && STREAM.test(path.basename(destino)), 'OBJETO_INVALIDO');
      area.pendentes.set(path.basename(destino), { caminho: destino, type: 'dir', stat: st });
      return destino;
    }); },
  });
  CAPACIDADES.set(fachada, area);
  return fachada;
}
async function conferirArea(area) {
  const root = await caminhoSemLinks(area.raiz);
  const atual = await caminhoSemLinks(area.caminho);
  exigir(igual(identidade(area.rootStat), root) && igual(identidade(area.areaStat), atual), 'IDENTIDADE_DIVERGENTE');
  await propriedade(area.caminho, atual, area.sid, true);
  return { root, atual };
}
export async function criarAreaStagingV9({ raizStaging }) {
  try { return await criarAreaInterna(raizStaging); }
  catch (error) { throw sanitizar(error); }
}
async function criarAreaInterna(raizStaging) {
  const raiz = validarCaminhoAbsoluto(raizStaging);
  const rootStat = await caminhoSemLinks(raiz);
  const sid = process.platform === 'win32' ? sidAtual() : null;
  await propriedade(raiz, rootStat, sid);
  const caminho = await mkdtemp(path.join(raiz, PREFIXO));
  const areaStat = await lstat(caminho, { bigint: true });
  try {
    await chmod(caminho, 0o700);
    if (process.platform === 'win32') {
      const r = spawnSync('icacls', [caminho, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true });
      exigir(r.status === 0, 'ACL_INDISPONIVEL');
    }
    await propriedade(caminho, await lstat(caminho, { bigint: true }), sid, true);
    const arquivoManifesto = path.join(caminho, MANIFESTO);
    const h = await open(arquivoManifesto, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    let header; let texto;
    try {
      const journal = identidade(await h.stat({ bigint: true }));
      header = { kind: 'header', magic: MAGIC, version: 2, root: identidade(rootStat), area: identidade(areaStat), journal, owner: { pid: process.pid, token: randomBytes(16).toString('hex') }, seq: 0 };
      texto = linha(header);
      await h.writeFile(texto); await h.sync();
    } finally { await h.close(); }
    const manifesto = { header, objects: [], bytes: Buffer.byteLength(texto), caudaIncompleta: false };
    const fachada = montarArea(caminho, raiz, rootStat, areaStat, sid, manifesto);
    CAPACIDADES.get(fachada).fsyncDiretorioSuportado = await syncDiretorio(caminho);
    return fachada;
  } catch (error) {
    // Falha antes de admitir conteúdo: só retira a área vazia de identidade conhecida.
    if (igual(identidade(areaStat), await lstat(caminho, { bigint: true }).catch(() => null))) await rmdir(caminho).catch(() => {});
    throw sanitizar(error);
  }
}
export async function registrarObjetoStagingV9(area, caminho) {
  const state = capacidade(area);
  return serializar(state, async () => {
    exigir(typeof caminho === 'string', 'CAMINHO_INVALIDO');
    const rel = path.relative(state.caminho, caminho).split(path.sep).join('/');
    const pendente = state.pendentes.get(rel);
    exigir(pendente?.caminho === caminho, 'OBJETO_NAO_CRIADO');
    try {
      exigir(!state.encerrando && !state.diarioFalhou, 'AREA_ENCERRADA');
      await conferirArea(state);
      exigir(state.manifesto.objects.length < LIMITE_OBJETOS, 'LIMITE_OBJETOS');
      if (rel.includes('/')) {
        const pasta = state.manifesto.objects.find(o => o.name === rel.split('/')[0] && o.type === 'dir');
        exigir(pasta && igual(pasta, await caminhoSemLinks(path.dirname(caminho))), 'IDENTIDADE_DIVERGENTE');
      }
      const st = await lstat(caminho, { bigint: true });
      exigir(igual(identidade(pendente.stat), st) && (pendente.type === 'file' ? arquivo(st) && st.size === 0n : diretorio(st)), 'IDENTIDADE_DIVERGENTE');
      if (pendente.type === 'file') exigir(igual(identidade(st), await pendente.handle.stat({ bigint: true })), 'IDENTIDADE_DIVERGENTE');
      else exigir((await (async () => { const d = await opendir(caminho); try { return await d.read(); } finally { await d.close(); } })()) === null, 'OBJETO_INVALIDO');
      await propriedade(caminho, st, state.sid);
      const entrada = { name: rel, type: pendente.type, ...identidade(st) };
      await anexarRegistro(state, { kind: 'object', seq: state.manifesto.objects.length + 1, ...entrada });
      state.manifesto.objects.push(entrada);
      state.pendentes.delete(rel);
      if (pendente.handle) state.entregues.add(pendente.handle);
      return pendente.handle ?? caminho;
    } catch (error) {
      state.pendentes.delete(rel);
      if (pendente.handle) await pendente.handle.close().catch(() => {});
      throw error;
    }
  });
}
function recibo() { return { areasVistas: 0, areasLimpas: 0, areasEmUso: 0, objetosRemovidos: 0, codigos: [], limpezaPendente: false, fsyncDiretorioSuportado: null }; }
function pendencia(r, code) { r.limpezaPendente = true; if (!r.codigos.includes(code)) r.codigos.push(code); }
function combinar(r, x) {
  r.areasVistas += x.areasVistas; r.areasLimpas += x.areasLimpas; r.areasEmUso += x.areasEmUso; r.objetosRemovidos += x.objetosRemovidos;
  for (const code of x.codigos) if (!r.codigos.includes(code)) r.codigos.push(code);
  r.limpezaPendente ||= x.limpezaPendente;
  if (x.fsyncDiretorioSuportado === false) r.fsyncDiretorioSuportado = false;
  else if (x.fsyncDiretorioSuportado === true && r.fsyncDiretorioSuportado === null) r.fsyncDiretorioSuportado = true;
}
function codigo(error) { return /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'LIMPEZA_FALHOU'; }
function donoMorreu(owner) {
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}
async function removerArea(area, recovery = false) {
  const r = recibo(); r.areasVistas = 1; r.fsyncDiretorioSuportado = area.fsyncDiretorioSuportado;
  try {
    const existe = await lstat(area.caminho, { bigint: true }).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
    if (!existe) { r.areasLimpas = 1; return r; }
    if (!recovery) {
      for (const h of area.entregues) if (h.fd !== -1) throw falha('HANDLE_ABERTO');
      if (area.pendentes.size) {
        for (const obj of area.pendentes.values()) if (obj.handle) await obj.handle.close().catch(() => {});
        area.pendentes.clear();
        throw falha('OBJETO_NAO_REGISTRADO');
      }
    }
    if (area.manifestoRemovido) {
      await conferirArea(area);
      const d = await opendir(area.caminho);
      try { exigir((await d.read()) === null, 'OBJETO_EXTRA'); } finally { await d.close(); }
      await rmdir(area.caminho);
      r.areasLimpas = 1;
      return r;
    }
    const { root, atual } = await conferirArea(area);
    area.manifesto = await lerManifesto(area.caminho, root, atual, area.sid);
    if (recovery && !donoMorreu(area.manifesto.header.owner)) throw falha('AREA_EM_USO');
    const permitidos = new Set([MANIFESTO, ...area.manifesto.objects.map(o => o.name.split('/')[0])]);
    const d = await opendir(area.caminho);
    try { for await (const entry of d) if (!permitidos.has(entry.name)) pendencia(r, 'OBJETO_EXTRA'); }
    finally { await d.close().catch(() => {}); }
    for (const obj of area.manifesto.objects) {
      if (obj.type !== 'dir') continue;
      const dir = path.join(area.caminho, obj.name);
      const st = await lstat(dir, { bigint: true }).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
      if (!st) continue;
      if (!diretorio(st) || !igual(obj, st)) { pendencia(r, 'IDENTIDADE_DIVERGENTE'); continue; }
      try { await propriedade(dir, st, area.sid); } catch (error) { pendencia(r, codigo(error)); continue; }
      const permitidosFilhos = new Set(area.manifesto.objects.filter(o => o.name.startsWith(`${obj.name}/`)).map(o => o.name.split('/')[1]));
      const sub = await opendir(dir);
      try { for await (const entry of sub) if (!permitidosFilhos.has(entry.name)) pendencia(r, 'OBJETO_EXTRA'); }
      finally { await sub.close().catch(() => {}); }
    }
    for (const obj of area.manifesto.objects.filter(o => o.type === 'file')) {
      const destino = path.join(area.caminho, ...obj.name.split('/'));
      try {
        await conferirArea(area);
        if (obj.name.includes('/')) {
          const parent = area.manifesto.objects.find(o => o.name === obj.name.split('/')[0] && o.type === 'dir');
          const parentPath = path.dirname(destino);
          const parentStat = await lstat(parentPath, { bigint: true }).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
          if (!parentStat) continue;
          exigir(parent && diretorio(parentStat) && igual(parent, parentStat), 'IDENTIDADE_DIVERGENTE');
        }
      } catch (error) { pendencia(r, codigo(error)); continue; }
      const st = await lstat(destino, { bigint: true }).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
      if (!st) continue;
      if (!arquivo(st) || !igual(obj, st)) { pendencia(r, 'IDENTIDADE_DIVERGENTE'); continue; }
      try { await propriedade(destino, st, area.sid); await unlink(destino); r.objetosRemovidos++; }
      catch (error) { pendencia(r, codigo(error)); }
    }
    for (const obj of area.manifesto.objects.filter(o => o.type === 'dir')) {
      const destino = path.join(area.caminho, obj.name);
      try { await conferirArea(area); } catch (error) { pendencia(r, codigo(error)); continue; }
      const st = await lstat(destino, { bigint: true }).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
      if (!st) continue;
      if (!diretorio(st) || !igual(obj, st)) { pendencia(r, 'IDENTIDADE_DIVERGENTE'); continue; }
      try { await rmdir(destino); r.objetosRemovidos++; }
      catch (error) { pendencia(r, codigo(error)); }
    }
    if (area.manifesto.caudaIncompleta) pendencia(r, 'DIARIO_INCOMPLETO');
    if (r.limpezaPendente) return r;
    const diario = path.join(area.caminho, MANIFESTO);
    const journalStat = await caminhoSemLinks(diario, 'file');
    exigir(arquivo(journalStat) && igual(area.manifesto.header.journal, journalStat), 'IDENTIDADE_DIVERGENTE');
    const jh = await open(diario, constants.O_RDONLY | NOFOLLOW);
    try { exigir(igual(area.manifesto.header.journal, await jh.stat({ bigint: true })), 'IDENTIDADE_DIVERGENTE'); }
    finally { await jh.close(); }
    await unlink(diario);
    area.manifestoRemovido = true;
    r.fsyncDiretorioSuportado = await syncDiretorio(area.caminho);
    await rmdir(area.caminho);
    r.areasLimpas = 1;
  } catch (error) { if (recovery && error?.code === 'AREA_EM_USO') r.areasEmUso++; pendencia(r, codigo(error)); }
  return r;
}
export async function limparAreaStagingV9(area) {
  const state = capacidade(area);
  return serializar(state, async () => { state.encerrando = true; return removerArea(state); });
}
export async function recuperarAreasStagingV9({ raizStaging }) {
  try { return await recuperarAreasInterno(raizStaging); }
  catch (error) { throw sanitizar(error); }
}
async function recuperarAreasInterno(raizStaging) {
  const raiz = validarCaminhoAbsoluto(raizStaging);
  const root = await caminhoSemLinks(raiz);
  const sid = process.platform === 'win32' ? sidAtual() : null;
  await propriedade(raiz, root, sid);
  const r = recibo();
  const d = await opendir(raiz);
  try {
    for await (const entry of d) {
      if (!entry.name.startsWith(PREFIXO)) continue;
      const caminho = path.join(raiz, entry.name);
      try {
        const st = await caminhoSemLinks(caminho);
        await propriedade(caminho, st, sid, true);
        const m = await lerManifesto(caminho, root, st, sid);
        const area = CAPACIDADES.get(montarArea(caminho, raiz, root, st, sid, m));
        combinar(r, await removerArea(area, true));
      } catch (error) { r.areasVistas++; pendencia(r, codigo(error)); }
    }
  } finally { await d.close().catch(() => {}); }
  return r;
}

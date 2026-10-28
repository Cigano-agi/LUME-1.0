import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertVersionContract } from './version-contract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = Object.freeze([
  ['mcpb/lume/manifest.json', 'manifest.json'],
  ['mcpb/lume/package.json', 'package.json'],
  ['desktop/icon.png', 'icon.png'],
  ['mcpb/lume/server/index.js', 'server/index.js'],
  ['src/perfil-ativo.js', 'src/perfil-ativo.js'],
  ['src/perfil-boot.js', 'src/perfil-boot.js'],
  ['src/perfil-boot-guard.js', 'src/perfil-boot-guard.js'],
  ['src/mcp/core.js', 'src/mcp/core.js'],
  ['src/mcp/execucao.js', 'src/mcp/execucao.js'],
  ['src/execucao/esquema.js', 'src/execucao/esquema.js'],
  ['src/execucao/projeto.js', 'src/execucao/projeto.js'],
  ['src/execucao/inventario-nativo.js', 'src/execucao/inventario-nativo.js'],
  ['src/execucao/servico.js', 'src/execucao/servico.js'],
  ['src/notetaker/perfil-teste.js', 'src/notetaker/perfil-teste.js'],
  ['src/notetaker/vinculos.js', 'src/notetaker/vinculos.js'],
  ['src/mcp/errors.js', 'src/mcp/errors.js'],
  ['src/mcp/activation.js', 'src/mcp/activation.js'],
  ['src/mcp/profile-broker-client.js', 'src/mcp/profile-broker-client.js'],
  ['src/mcp/broker-frames.js', 'src/mcp/broker-frames.js'],
  ['src/mcp/broker-bootstrap.js', 'src/mcp/broker-bootstrap.js'],
  ['src/mcp/broker-acl-native.js', 'src/mcp/broker-acl-native.js'],
  ['src/mcp/presence.js', 'src/mcp/presence.js'],
  ['src/mcp/read-service.js', 'src/mcp/read-service.js'],
  ['src/mcp/schemas.js', 'src/mcp/schemas.js'],
  ['src/mcp/stdio-entry.js', 'src/mcp/stdio-entry.js'],
  ['src/mcp/stdio-server.js', 'src/mcp/stdio-server.js'],
  ['src/mcp/tokens.js', 'src/mcp/tokens.js'],
  ['src/fontes-desktop.js', 'src/fontes-desktop.js'],
  ['src/leitura-sql.js', 'src/leitura-sql.js'],
  ['src/qualidade-transcricao.js', 'src/qualidade-transcricao.js'],
  ['src/relogio.js', 'src/relogio.js'],
  ['src/tarefas-esquema.js', 'src/tarefas-esquema.js'],
  ['src/pessoal/organizacao-validade.js', 'src/pessoal/organizacao-validade.js'],
  ['src/pessoal/organizacao-identidade.js', 'src/pessoal/organizacao-identidade.js'],
  ['src/pessoal/organizacao-atribuicao.js', 'src/pessoal/organizacao-atribuicao.js']
]);
const NATIVE = Object.freeze([
  ['lume-acl.exe', 'native/win-acl/bin/lume-acl.exe'],
  ['manifest.json', 'native/win-acl/bin/manifest.json']
]);
const HEX = /^[a-f0-9]{64}$/;
const TOOLS = ['lume_resumo_do_dia', 'lume_buscar_contexto', 'lume_abrir_fonte', 'lume_listar_pendencias', 'lume_listar_negocios'];
const nativeError = () => new Error('MCPB_NATIVE_UNTRUSTED');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function checkedFile(path, maxBytes, failure = nativeError, virtualRoot = null) {
  let current = parse(path).root;
  const parts = relative(current, path).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    // An ASAR is a regular physical file whose children are exposed by Electron's fs shim.
    if (virtualRoot && resolve(current).toLowerCase() === resolve(virtualRoot).toLowerCase()) continue;
    let stat;
    try { stat = lstatSync(current); } catch { throw failure(); }
    if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) ||
        (i === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes))) throw failure();
  }
  let before, bytes, after;
  try { before = lstatSync(path); bytes = readFileSync(path); after = lstatSync(path); }
  catch { throw failure(); }
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1) throw failure();
  if (bytes.length !== before.size || (!virtualRoot && (before.dev !== after.dev || before.ino !== after.ino)) ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw failure();
  return bytes;
}

function archiveStat(path) {
  const previous = process.noAsar;
  try {
    process.noAsar = true;
    let current = parse(path).root, stat;
    for (const part of relative(current, path).split(sep).filter(Boolean)) {
      current = join(current, part);
      stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current === path ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()))
        throw new Error('MCPB_ASAR_UNTRUSTED');
    }
    return stat;
  } catch { throw new Error('MCPB_ASAR_UNTRUSTED'); }
  finally { if (previous === undefined) delete process.noAsar; else process.noAsar = previous; }
}

function sameStat(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function nativeRoot(root, shape) {
  if (shape === 'packaged' && basename(root).toLowerCase() === 'app.asar')
    return join(dirname(root), 'app.asar.unpacked');
  return root;
}

function nativeEntries(root, shape) {
  const base = nativeRoot(root, shape);
  const entries = NATIVE.map(([file, name]) => ({
    name, data: checkedFile(join(base, 'native', 'win-acl', 'bin', file), file.endsWith('.exe') ? 4 * 1024 * 1024 : 1024)
  }));
  let manifest;
  try { manifest = JSON.parse(entries[1].data.toString('utf8')); } catch { throw nativeError(); }
  if (!manifest || Object.getPrototypeOf(manifest) !== Object.prototype ||
      Object.keys(manifest).sort().join(',') !== 'arch,file,platform,schema,sha256,sourceSha256' ||
      manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.file !== 'lume-acl.exe' || !HEX.test(manifest.sha256) ||
      !HEX.test(manifest.sourceSha256) || digest(entries[0].data) !== manifest.sha256) throw nativeError();
  return entries;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const u16 = value => { const out = Buffer.allocUnsafe(2); out.writeUInt16LE(value); return out; };
const u32 = value => { const out = Buffer.allocUnsafe(4); out.writeUInt32LE(value >>> 0); return out; };

function storedZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const data = Buffer.from(entry.data), crc = crc32(data);
    const localHeader = Buffer.concat([
      Buffer.from('504b0304', 'hex'), u16(20), u16(0x800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name
    ]);
    local.push(localHeader, data);
    central.push(Buffer.concat([
      Buffer.from('504b0102', 'hex'), u16(20), u16(20), u16(0x800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name
    ]));
    offset += localHeader.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.concat([
    Buffer.from('504b0506', 'hex'), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0)
  ]);
  return Buffer.concat([...local, centralBytes, end]);
}

export function inspectStoredMcpb(bytes) {
  const buffer = Buffer.from(bytes), entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26), extraLength = buffer.readUInt16LE(offset + 28);
    if (method !== 0) throw new Error('Pacote MCPB usa compressão inesperada.');
    const nameStart = offset + 30, dataStart = nameStart + nameLength + extraLength, end = dataStart + size;
    if (end > buffer.length) throw new Error('Pacote MCPB truncado.');
    entries.push({ name: buffer.subarray(nameStart, nameStart + nameLength).toString('utf8'), data: buffer.subarray(dataStart, end) });
    offset = end;
  }
  if (!entries.length) throw new Error('Pacote MCPB inválido.');
  return entries;
}

export function buildLumeMcpb({ root = ROOT, outputDir = join(root, 'dist', 'mcpb'), shape = 'checkout' } = {}) {
  const asar = shape === 'packaged' && basename(root).toLowerCase() === 'app.asar' ? root : null;
  const before = asar ? archiveStat(asar) : null;
  const contract = assertVersionContract({ root, shape });
  const entries = FILES.map(([source, name]) => ({ name, data: checkedFile(join(root, source), 4 * 1024 * 1024, () => new Error(`MCPB_INPUT_UNTRUSTED:${name}`), asar) }));
  if (process.platform === 'darwin') {
    const raw = JSON.parse(entries[0].data.toString('utf8'));
    if (!Array.isArray(raw.compatibility?.platforms) || !raw.compatibility.platforms.includes('darwin')) throw new Error('MCPB_MANIFEST_UNTRUSTED');
    entries[0].data = Buffer.from(JSON.stringify({ ...raw, compatibility: { ...raw.compatibility, platforms: ['darwin'] } }));
  } else {
    entries.push(...nativeEntries(root, shape));
  }
  if (asar && !sameStat(before, archiveStat(asar))) throw new Error('MCPB_ASAR_UNTRUSTED');
  const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data.toString('utf8'));
  if (manifest.manifest_version !== '0.3' || manifest.name !== 'com.readyworks.lume.local-memory' ||
      manifest.compatibility?.runtimes?.node !== '>=24.0.0' ||
      JSON.stringify(manifest.compatibility?.platforms) !== JSON.stringify(process.platform === 'darwin' ? ['darwin'] : ['darwin', 'win32']) ||
      manifest.server?.type !== 'node' || manifest.server?.entry_point !== 'server/index.js' ||
      manifest.server?.mcp_config?.command !== 'node' ||
      JSON.stringify(manifest.server?.mcp_config?.args) !== '["${__dirname}/server/index.js"]' ||
      manifest.server?.mcp_config?.env?.LUME_MCP_CREDENTIAL !== '${user_config.activation_code}' ||
      manifest.user_config?.activation_code?.sensitive !== true ||
      JSON.stringify(manifest.tools?.map(tool => tool.name)) !== JSON.stringify(TOOLS)) throw new Error('Manifesto MCPB incompatível.');
  const bytes = storedZip(entries), name = `Lume-${contract.version}.mcpb`, artifact = join(outputDir, name), temp = `${artifact}.${process.pid}.tmp`;
  mkdirSync(outputDir, { recursive: true });
  try { writeFileSync(temp, bytes, { flag: 'wx' }); renameSync(temp, artifact); }
  finally { rmSync(temp, { force: true }); }
  return { artifact, file: basename(artifact), entries: entries.map(entry => entry.name), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = buildLumeMcpb();
  process.stdout.write(JSON.stringify(result) + '\n');
}

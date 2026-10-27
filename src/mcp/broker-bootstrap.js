import { createHash, X509Certificate } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { verifyBrokerAcl } from './broker-acl-native.js';

const CONTROL = 'broker-control';
const DESCRIPTOR = 'descriptor.json';
const MAX_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keys = (value, names) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === names.slice().sort().join(',');
const fail = () => Object.assign(new Error('BROKER_BOOTSTRAP_UNTRUSTED'), { code: 'BROKER_BOOTSTRAP_UNTRUSTED' });

function selected(value) {
  if (!value || typeof value !== 'object' || !['legado', 'gerido'].includes(value.tipo) || typeof value.id !== 'string' ||
    (value.tipo === 'legado' ? value.id !== 'legado' || value.geracao !== null : !UUID.test(value.id) || !UUID.test(value.geracao))) throw fail();
  return { tipo: value.tipo, id: value.id, geracao: value.geracao };
}

function location(userData) {
  if (typeof userData !== 'string' || !isAbsolute(userData) || resolve(userData) !== normalize(userData)) throw fail();
  return { control: join(userData, CONTROL), descriptor: join(userData, CONTROL, DESCRIPTOR) };
}

function statSafe(path) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); } catch { throw fail(); }
  if (stat.isSymbolicLink() || Number(stat.nlink) > 1 && !stat.isDirectory() || !(stat.isDirectory() || stat.isFile())) throw fail();
  return stat;
}

function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs; }
function sameObject(a, b) { return a.dev === b.dev && a.ino === b.ino; }

function chain(path) {
  const root = parse(path).root;
  const pieces = relative(root, path).split(sep).filter(Boolean);
  const paths = [root];
  for (const piece of pieces) paths.push(join(paths.at(-1), piece));
  return paths;
}

function checkPosix(paths, strictFrom) {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) throw fail();
  paths.forEach((path, index) => {
    const stat = statSafe(path);
    if (stat.uid !== BigInt(uid) && stat.uid !== 0n) throw fail();
    const mode = Number(stat.mode) & 0o7777;
    const writable = mode & 0o022;
    const stickyAncestor = index < strictFrom && stat.isDirectory() && stat.uid === 0n && (mode & 0o1000);
    if (writable && !stickyAncestor) throw fail();
    if (index >= strictFrom && stat.uid !== BigInt(uid)) throw fail();
  });
}

async function protectedPath(userData, path) {
  const paths = chain(path);
  const strictFrom = paths.indexOf(userData);
  if (strictFrom < 0 || paths.length > 32) throw fail();
  const before = paths.map(statSafe);
  if (process.platform === 'win32') await verifyBrokerAcl({ userData, paths, strictFrom });
  else await checkPosix(paths, strictFrom);
  // Detect replacement of path components during inspection.
  for (let i = 0; i < paths.length; i++) {
    const after = statSafe(paths[i]);
    // Sibling creation changes directory size/mtime without replacing its identity.
    if (before[i].isDirectory() !== after.isDirectory() ||
      (before[i].isDirectory() ? !sameObject(before[i], after) : !same(before[i], after))) throw fail();
  }
}

export function validateBrokerDescriptor(value, selection) {
  if (!keys(value, ['schema', 'boot', 'perfil', 'port', 'certPem', 'pin']) || value.schema !== 1 || !UUID.test(value.boot) ||
    !keys(value.perfil, ['tipo', 'id', 'geracao']) || JSON.stringify(value.perfil) !== JSON.stringify(selected(selection)) ||
    !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.certPem !== 'string' ||
    !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n?$/.test(value.certPem) ||
    typeof value.pin !== 'string' || !/^[0-9a-f]{64}$/.test(value.pin)) throw fail();
  let cert;
  try { cert = new X509Certificate(value.certPem); } catch { throw fail(); }
  if (cert.ca || cert.subjectAltName !== 'DNS:lume.local' || cert.checkHost('lume.local') !== 'lume.local' ||
    JSON.stringify(cert.keyUsage) !== JSON.stringify(['1.3.6.1.5.5.7.3.1']) ||
    !(Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now()) ||
    createHash('sha256').update(cert.raw).digest('hex') !== value.pin) throw fail();
  return value;
}

export async function readBrokerDescriptor({ userData, selection } = {}) {
  const { control, descriptor } = location(userData);
  const before = statSafe(descriptor);
  if (!before.isFile() || before.size > BigInt(MAX_BYTES)) throw fail();
  await protectedPath(userData, control);
  await protectedPath(userData, descriptor);
  const opened = statSafe(descriptor);
  if (!same(before, opened)) throw fail();
  let value;
  try { value = JSON.parse(readFileSync(descriptor, 'utf8')); } catch { throw fail(); }
  if (!same(before, statSafe(descriptor))) throw fail();
  return validateBrokerDescriptor(value, selection);
}

export async function publishBrokerDescriptor({ userData, selection, boot, port, identity } = {}) {
  const { control, descriptor: path } = location(userData);
  const perfil = selected(selection);
  const descriptor = validateBrokerDescriptor({ schema: 1, boot, perfil, port, certPem: identity?.certPem, pin: identity?.pin }, selection);
  await protectedPath(userData, userData);
  if (!existsSync(control)) { try { mkdirSync(control, { mode: 0o700 }); } catch { throw fail(); } }
  await protectedPath(userData, control);
  const previous = existsSync(path) ? statSafe(path) : null;
  if (previous) await readBrokerDescriptor({ userData, selection });
  const temp = join(control, `.${boot}.tmp`);
  let handle, createdTemp;
  try {
    handle = openSync(temp, 'wx', 0o600);
    createdTemp = fstatSync(handle, { bigint: true });
    writeFileSync(handle, JSON.stringify(descriptor) + '\n', 'utf8');
    fsyncSync(handle);
    const flushed = fstatSync(handle, { bigint: true });
    closeSync(handle); handle = undefined;
    await protectedPath(userData, temp);
    if (!sameObject(createdTemp, statSafe(temp)) || !same(flushed, statSafe(temp))) throw fail();
    if (previous ? !same(previous, statSafe(path)) : existsSync(path)) throw fail();
    renameSync(temp, path);
    const published = statSafe(path);
    if (!sameObject(createdTemp, published) || published.size !== flushed.size) throw fail();
    await protectedPath(userData, path);
    return { descriptor, release: async () => {
      try {
        await protectedPath(userData, path);
        if (!same(published, statSafe(path)) || JSON.stringify(await readBrokerDescriptor({ userData, selection })) !== JSON.stringify(descriptor)) throw fail();
        // readBrokerDescriptor awaits ACL inspection; another file may replace this one meanwhile.
        if (!same(published, statSafe(path))) throw fail();
        unlinkSync(path);
      } catch { throw fail(); }
    } };
  } catch (error) {
    if (handle !== undefined) closeSync(handle);
    if (createdTemp && existsSync(temp)) {
      try {
        await protectedPath(userData, temp);
        if (sameObject(createdTemp, statSafe(temp))) unlinkSync(temp);
      } catch { /* leave uncertain file intact */ }
    }
    throw error?.code === 'BROKER_BOOTSTRAP_UNTRUSTED' ? error : fail();
  }
}

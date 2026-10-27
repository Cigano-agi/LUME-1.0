import { lstatSync, mkdirSync } from 'node:fs';
import { join, parse, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBootIdentity } from './broker-identity.js';
import { createProfileBroker } from './profile-broker.js';
import { publishBrokerDescriptor } from './broker-bootstrap.js';
import { authorizeClaudeBrokerHello, authorizeClaudeBrokerBegin } from './activation.js';
import { assertNormalBootAllowed } from '../perfil-manutencao.js';

const MARKERS = ['perfil-ativo.json', 'perfil-publicacao.json', 'profiles'];
const legacy = selection => selection?.tipo === 'legado' && selection.id === 'legado' && selection.geracao === null;
const identity = stat => ({ dev: stat.dev, ino: stat.ino });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function directory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('PERFIL_SELECAO_ALTERADA');
  return identity(stat);
}
function absent(path) {
  try { lstatSync(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

// Only the already selected legacy profile is accepted here. Managed profiles
// continue through the async selector and remain closed at boot.
export function createLegacySelectionGuard({ userData, selection }) {
  if (!legacy(selection) || selection.dataDir !== join(userData, 'data')) throw Error('PERFIL_SELECAO_ALTERADA');
  const dataDir = selection.dataDir;
  const root = parse(userData).root;
  const paths = [root];
  for (const piece of relative(root, userData).split(sep).filter(Boolean)) paths.push(join(paths.at(-1), piece));
  const original = paths.map(directory);
  // Preserve an existing selection before any boot await; first-boot creation
  // is the only case where identity may be established later.
  let dataIdentity = absent(dataDir) ? null : directory(dataDir);
  function check() {
    try {
      assertNormalBootAllowed(userData);
      if (paths.some((path, index) => !same(directory(path), original[index]))) return false;
      if (MARKERS.some(marker => !absent(join(userData, marker)))) return false;
      if (!dataIdentity || absent(dataDir)) return false;
      const current = directory(dataDir);
      return same(current, dataIdentity);
    } catch { return false; }
  }
  check.ensureData = () => {
    assertNormalBootAllowed(userData);
    if (paths.some((path, index) => !same(directory(path), original[index])) ||
        MARKERS.some(marker => !absent(join(userData, marker)))) throw Error('PERFIL_SELECAO_ALTERADA');
    if (!dataIdentity) {
      if (!absent(dataDir)) throw Error('PERFIL_SELECAO_ALTERADA');
      mkdirSync(dataDir, { mode: 0o700 });
      dataIdentity = directory(dataDir);
    }
    if (!check()) throw Error('PERFIL_SELECAO_ALTERADA');
  };
  return check;
}

export function createDesktopBroker({ userData, selection,
  createIdentity = createBootIdentity, createBroker = createProfileBroker,
  publish = publishBrokerDescriptor,
  authorizeHello = authorizeClaudeBrokerHello, authorizeBegin = authorizeClaudeBrokerBegin }) {
  const guard = createLegacySelectionGuard({ userData, selection });
  const activationPath = join(selection.dataDir, 'mcp', 'claude-desktop.json');
  const boot = randomUUID();
  let broker, published, started = false, startAttempted = false, publishAttempted = false, cut = false, startPromise, cleanupPromise;
  const checked = fn => request => guard() ? fn({ ...request, activationPath }) : null;
  function shutdown() {
    cut = true;
    broker?.stopAdmission();
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try { await startPromise; } catch { /* partial boot still owns resources */ }
      if (!broker) return { confirmed: true };
      let confirmed = !(startAttempted && !started) && !(publishAttempted && !published?.release);
      if (started) {
        try { const receipt = await broker.drain(); if (receipt?.closed !== true) confirmed = false; }
        catch { confirmed = false; }
      }
      try { await broker.close(); } catch { confirmed = false; }
      if (published?.release) {
        try { await published.release(); } catch { confirmed = false; }
      }
      return { confirmed };
    })();
    return cleanupPromise;
  }
  function start() {
    if (startPromise || cut) throw Error('BROKER_ALREADY_STARTED');
    startPromise = (async () => {
      try {
        const identity = await createIdentity();
        if (cut) throw Error('BROKER_BOOT_CANCELLED');
        broker = createBroker({ selection, boot, identity,
          authorizeHello: checked(authorizeHello), authorizeBegin: checked(authorizeBegin) });
        startAttempted = true;
        const { port } = await broker.start(); started = true;
        if (cut) throw Error('BROKER_BOOT_CANCELLED');
        publishAttempted = true;
        published = await publish({ userData, selection, boot, port, identity });
        if (cut) throw Error('BROKER_BOOT_CANCELLED');
        guard.ensureData();
        if (cut) throw Error('BROKER_BOOT_CANCELLED');
        broker.admit();
        return published.descriptor;
      } catch (error) {
        // Do not await shutdown here: it waits for this startup promise to settle.
        queueMicrotask(() => { void shutdown(); });
        throw error;
      }
    })();
    return startPromise;
  }
  return { start, shutdown, stopAdmission: () => { cut = true; broker?.stopAdmission(); } };
}

export function createShutdownGate({ install, onDone = () => {} }) {
  let requested, resolve, promise, done = false;
  const receipts = new Map();
  function finish() {
    if (!requested || done || !receipts.has('utility') || !receipts.has('broker')) return;
    done = true;
    const confirmed = receipts.get('utility') === true && receipts.get('broker') === true;
    if (requested === 'instalar' && confirmed) { try { install(); } catch { onDone({ reason: requested, confirmed: false }); resolve(false); return; } }
    onDone({ reason: requested, confirmed }); resolve(confirmed);
  }
  return {
    request(reason) {
      if (!promise) { requested = reason; promise = new Promise(r => { resolve = r; }); }
      return promise;
    },
    report(side, confirmed) { if (!['utility', 'broker'].includes(side) || receipts.has(side)) return; receipts.set(side, confirmed === true); finish(); },
    reason: () => requested,
  };
}

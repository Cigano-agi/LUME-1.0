import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseReleaseVersion } from './release-version.mjs';

export const VERSION_SHAPES = Object.freeze({ CHECKOUT: 'checkout', PACKAGED: 'packaged' });

export class VersionContractError extends Error {
  constructor(blockers) {
    super(`Contrato de versao invalido:\n- ${blockers.map(item => `${item.id}: ${item.message}`).join('\n- ')}`);
    this.name = 'VersionContractError';
    this.blockers = blockers;
  }
}

function readJson(root, relative, ids, blockers) {
  const path = resolve(root, relative);
  if (!existsSync(path)) {
    blockers.push({ id: ids.missing, message: `${relative} ausente.` });
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed;
  } catch {
    blockers.push({ id: ids.malformed, message: `${relative} malformado.` });
    return null;
  }
}

function validVersion(value) {
  try { return parseReleaseVersion(value).raw; } catch { return null; }
}

export function inspectVersionContract({ root, shape = VERSION_SHAPES.CHECKOUT } = {}) {
  if (!Object.values(VERSION_SHAPES).includes(shape)) throw new TypeError('Forma de pacote invalida.');
  if (typeof root !== 'string' || !root) throw new TypeError('Raiz do pacote obrigatoria.');
  const blockers = [];
  const packageJson = readJson(root, 'package.json', { missing: 'PACKAGE_MISSING', malformed: 'PACKAGE_MALFORMED' }, blockers);
  const manifest = readJson(root, 'mcpb/lume/manifest.json', { missing: 'MCP_MANIFEST_MISSING', malformed: 'MCP_MANIFEST_MALFORMED' }, blockers);
  const version = packageJson ? validVersion(packageJson.version) : null;
  if (packageJson && !version) blockers.push({ id: 'PACKAGE_VERSION', message: 'package.version precisa ser beta ou estavel valido.' });

  let lock = null;
  if (shape === VERSION_SHAPES.CHECKOUT) {
    const metadata = packageJson?.build?.extraMetadata;
    if (packageJson && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
      blockers.push({ id: 'ELECTRON_METADATA_MISSING', message: 'build.extraMetadata.version ausente.' });
    } else if (packageJson && metadata.version !== version) {
      blockers.push({ id: 'ELECTRON_METADATA_VERSION', message: 'build.extraMetadata.version diverge de package.version.' });
    }
    lock = readJson(root, 'package-lock.json', { missing: 'PACKAGE_LOCK_MISSING', malformed: 'PACKAGE_LOCK_MALFORMED' }, blockers);
    if (lock && lock.version !== version) blockers.push({ id: 'PACKAGE_LOCK_VERSION', message: 'package-lock.version diverge de package.version.' });
    if (lock && (!lock.packages || typeof lock.packages !== 'object' || !lock.packages[''])) {
      blockers.push({ id: 'PACKAGE_LOCK_ROOT_MISSING', message: 'package-lock.packages[""] ausente.' });
    } else if (lock && lock.packages[''].version !== version) {
      blockers.push({ id: 'PACKAGE_LOCK_ROOT_VERSION', message: 'package-lock.packages[""].version diverge de package.version.' });
    }
  }

  if (manifest) {
    if (manifest.name !== 'com.readyworks.lume.local-memory') blockers.push({ id: 'MCP_MANIFEST_NAME', message: 'manifest.name nao identifica a extensao do Lume.' });
    if (manifest.manifest_version !== '0.3') blockers.push({ id: 'MCP_MANIFEST_FORMAT', message: 'manifest_version precisa permanecer 0.3.' });
    if (!validVersion(manifest.version) || manifest.version !== version) blockers.push({ id: 'MCP_MANIFEST_VERSION', message: 'manifest.version diverge de package.version.' });
  }
  return { shape, version, packageJson, lock, manifest, blockers };
}

export function assertVersionContract(options = {}) {
  const result = inspectVersionContract(options);
  if (result.blockers.length) throw new VersionContractError(result.blockers);
  return result;
}

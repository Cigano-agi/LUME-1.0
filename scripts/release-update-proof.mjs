import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareReleaseVersions, manifestVersion, parseReleaseVersion } from './release-version.mjs';

export const UPDATE_OBSERVATION_SCHEMA = 'lume-native-update-observation-v1';
export const UPDATE_PROOF_SCHEMA = 'lume-native-update-proof-v1';

const PLATFORM_ARCHITECTURES = Object.freeze({ windows: new Set(['x64']), macos: new Set(['arm64', 'x64']) });
const CHANNELS = new Set(['beta', 'estavel']);
const exactKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

function releasePair(baselineVersion, targetVersion) {
  const baseline = parseReleaseVersion(baselineVersion).raw;
  const target = parseReleaseVersion(targetVersion).raw;
  if (compareReleaseVersions(target, baseline) <= 0) throw new Error('A versao alvo precisa ser posterior a versao base.');
  return { baseline, target };
}

export function assertUpdateVersions({ baselineVersion, targetVersion } = {}) {
  return releasePair(baselineVersion, targetVersion);
}

export function assertUpdateObservation(value) {
  const rootKeys = ['schema', 'platform', 'architecture', 'channel', 'baselineVersion', 'targetVersion', 'githubRunId', 'profile', 'database', 'update', 'whatsapp'];
  if (!exactKeys(value, rootKeys) || value.schema !== UPDATE_OBSERVATION_SCHEMA) throw new Error('Observacao de atualizacao possui formato invalido.');
  if (!Object.hasOwn(PLATFORM_ARCHITECTURES, value.platform) || !PLATFORM_ARCHITECTURES[value.platform].has(value.architecture)) throw new Error('Plataforma ou arquitetura da observacao e invalida.');
  if (!CHANNELS.has(value.channel)) throw new Error('Canal da observacao e invalido.');
  const versions = releasePair(value.baselineVersion, value.targetVersion);
  if (!/^\d+$/.test(String(value.githubRunId || ''))) throw new Error('A observacao precisa pertencer a uma execucao do GitHub Actions.');
  if (!exactKeys(value.profile, ['samePath', 'isolatedRunnerProfile']) || value.profile.samePath !== true || value.profile.isolatedRunnerProfile !== true) throw new Error('A prova exige o mesmo perfil descartavel antes e depois.');
  if (!exactKeys(value.database, ['existedBefore', 'existsAfter', 'markerPreserved']) || value.database.existedBefore !== true || value.database.existsAfter !== true || value.database.markerPreserved !== true) throw new Error('A prova nao confirmou a preservacao do banco e do marcador sintetico.');
  if (!exactKeys(value.update, ['offeredVersion', 'downloadCompleted', 'installRequested', 'runtimeBefore', 'runtimeAfter'])) throw new Error('Observacao do atualizador incompleta.');
  if (value.update.runtimeBefore !== versions.baseline || value.update.offeredVersion !== versions.target || value.update.runtimeAfter !== versions.target || value.update.downloadCompleted !== true || value.update.installRequested !== true) throw new Error('A troca de versao nao foi observada por inteiro.');
  if (!exactKeys(value.whatsapp, ['testedWithRealAccount', 'preserved'])) throw new Error('Estado da prova real do WhatsApp ausente.');
  if (typeof value.whatsapp.testedWithRealAccount !== 'boolean') throw new Error('Estado da prova real do WhatsApp invalido.');
  if (value.whatsapp.testedWithRealAccount ? value.whatsapp.preserved !== true : value.whatsapp.preserved !== null) throw new Error('A observacao nao pode inferir preservacao do WhatsApp.');
  return { ...value, baselineVersion: versions.baseline, targetVersion: versions.target };
}

function fileEvidence(path) {
  if (!nonEmpty(path) || !existsSync(path)) throw new Error('Artefato da prova ausente.');
  const bytes = readFileSync(path);
  return { name: basename(path), bytes: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') };
}

export function finalizeUpdateProof({ observation, baselineArtifact, baselineManifest, targetExecutable, baselineSignature, targetSignature, notarization = 'NA' } = {}) {
  const checked = assertUpdateObservation(observation);
  if (baselineSignature !== 'VERIFICADO' || targetSignature !== 'VERIFICADO') throw new Error('As assinaturas da versao base e da versao alvo precisam ser verificadas no sistema nativo.');
  if (checked.platform === 'macos' && notarization !== 'VERIFICADO') throw new Error('A prova macOS exige Gatekeeper e ticket de notarizacao verificados.');
  if (checked.platform === 'windows' && notarization !== 'NA') throw new Error('Notarizacao so se aplica ao macOS.');
  const expectedInstaller = checked.platform === 'windows' ? `Lume-${checked.baselineVersion}-win-x64-Setup.exe` : `Lume-${checked.baselineVersion}-mac-universal.dmg`;
  if (basename(baselineArtifact || '') !== expectedInstaller) throw new Error('Instalador base nao corresponde a versao e a plataforma.');
  if (basename(targetExecutable || '') !== (checked.platform === 'windows' ? 'Lume.exe' : 'Lume')) throw new Error('Executavel alvo nao corresponde a plataforma.');
  if (!nonEmpty(baselineManifest) || !existsSync(baselineManifest)) throw new Error('Manifesto imutavel da versao base ausente.');
  const manifestName = checked.platform === 'windows' ? 'beta.yml' : 'beta-mac.yml';
  const manifestText = readFileSync(baselineManifest, 'utf8');
  const expectedUpdateArtifact = checked.platform === 'windows' ? expectedInstaller : `Lume-${checked.baselineVersion}-mac-universal.zip`;
  const escapedArtifact = expectedUpdateArtifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (basename(baselineManifest) !== manifestName || manifestVersion(manifestText) !== checked.baselineVersion || !new RegExp(`^path:\\s*["']?${escapedArtifact}["']?\\s*$`, 'm').test(manifestText)) throw new Error('Manifesto de rollback nao corresponde a versao base e a plataforma.');
  const whatsappComplete = checked.whatsapp.testedWithRealAccount && checked.whatsapp.preserved;
  const baselineInstaller = fileEvidence(baselineArtifact), rollbackManifest = fileEvidence(baselineManifest);
  return {
    schema: UPDATE_PROOF_SCHEMA,
    platform: checked.platform,
    architecture: checked.architecture,
    channel: checked.channel,
    baselineVersion: checked.baselineVersion,
    targetVersion: checked.targetVersion,
    githubRunId: checked.githubRunId,
    artifacts: { baselineInstaller, baselineManifest: rollbackManifest, targetExecutable: fileEvidence(targetExecutable) },
    nativeVerification: { baselineSignature: true, targetSignature: true, notarization: checked.platform === 'macos' },
    profile: checked.profile,
    database: checked.database,
    update: checked.update,
    whatsapp: checked.whatsapp,
    technicalUpdatePassed: true,
    acceptanceComplete: Boolean(whatsappComplete),
    openGates: whatsappComplete ? [] : ['REAL_WHATSAPP_RECONNECTION'],
    rollback: {
      automaticDowngradeAllowed: false,
      baselineVersion: checked.baselineVersion,
      baselineInstaller: baselineInstaller.name,
      liveManifest: manifestName,
      immutableManifestPath: `releases/${checked.channel}/manifests/${checked.baselineVersion}/${manifestName}`,
      immutableManifestSha512: rollbackManifest.sha512,
      profileAction: 'PRESERVE',
      recovery: 'RESTORE_CHANNEL_FOR_NOT_YET_UPDATED_OR_PUBLISH_HIGHER_HOTFIX'
    }
  };
}

export function validateUpdateProof(value) {
  const keys = ['schema', 'platform', 'architecture', 'channel', 'baselineVersion', 'targetVersion', 'githubRunId', 'artifacts', 'nativeVerification', 'profile', 'database', 'update', 'whatsapp', 'technicalUpdatePassed', 'acceptanceComplete', 'openGates', 'rollback'];
  if (!exactKeys(value, keys) || value.schema !== UPDATE_PROOF_SCHEMA) throw new Error('Prova nativa de atualizacao possui formato invalido.');
  const observation = assertUpdateObservation({
    schema: UPDATE_OBSERVATION_SCHEMA,
    platform: value.platform,
    architecture: value.architecture,
    channel: value.channel,
    baselineVersion: value.baselineVersion,
    targetVersion: value.targetVersion,
    githubRunId: value.githubRunId,
    profile: value.profile,
    database: value.database,
    update: value.update,
    whatsapp: value.whatsapp
  });
  if (!exactKeys(value.artifacts, ['baselineInstaller', 'baselineManifest', 'targetExecutable'])) throw new Error('Hashes dos artefatos estao ausentes.');
  for (const artifact of Object.values(value.artifacts)) {
    if (!exactKeys(artifact, ['name', 'bytes', 'sha512']) || !nonEmpty(artifact.name) || basename(artifact.name) !== artifact.name || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || !/^[a-f0-9]{128}$/.test(artifact.sha512)) throw new Error('Evidencia de artefato invalida.');
  }
  if (!exactKeys(value.nativeVerification, ['baselineSignature', 'targetSignature', 'notarization']) || value.nativeVerification.baselineSignature !== true || value.nativeVerification.targetSignature !== true || value.nativeVerification.notarization !== (observation.platform === 'macos')) throw new Error('Verificacao nativa de assinatura invalida.');
  if (value.technicalUpdatePassed !== true) throw new Error('A prova tecnica de atualizacao nao passou.');
  const complete = observation.whatsapp.testedWithRealAccount && observation.whatsapp.preserved;
  if (value.acceptanceComplete !== Boolean(complete)) throw new Error('Estado final da prova diverge da evidencia de WhatsApp.');
  const expectedGates = complete ? [] : ['REAL_WHATSAPP_RECONNECTION'];
  if (!Array.isArray(value.openGates) || JSON.stringify(value.openGates) !== JSON.stringify(expectedGates)) throw new Error('Portoes externos da prova estao incorretos.');
  const rollbackKeys = ['automaticDowngradeAllowed', 'baselineVersion', 'baselineInstaller', 'liveManifest', 'immutableManifestPath', 'immutableManifestSha512', 'profileAction', 'recovery'];
  if (!exactKeys(value.rollback, rollbackKeys) || value.rollback.automaticDowngradeAllowed !== false || value.rollback.baselineVersion !== observation.baselineVersion || value.rollback.baselineInstaller !== value.artifacts.baselineInstaller.name || value.rollback.liveManifest !== (observation.platform === 'windows' ? 'beta.yml' : 'beta-mac.yml') || value.rollback.immutableManifestPath !== `releases/${observation.channel}/manifests/${observation.baselineVersion}/${value.rollback.liveManifest}` || value.rollback.immutableManifestSha512 !== value.artifacts.baselineManifest.sha512 || value.rollback.profileAction !== 'PRESERVE' || value.rollback.recovery !== 'RESTORE_CHANNEL_FOR_NOT_YET_UPDATED_OR_PUBLISH_HIGHER_HOTFIX') throw new Error('Plano de rollback da prova e invalido.');
  return value;
}

function parseArgs(argv) {
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Argumentos invalidos.');
    const name = key.slice(2).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
    if (Object.hasOwn(result, name)) throw new Error('Argumento repetido.');
    result[name] = value;
  }
  return result;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.command === 'check-versions') {
    const versions = assertUpdateVersions(options);
    process.stdout.write(JSON.stringify(versions) + '\n');
    return;
  }
  if (options.command === 'finalize') {
    for (const name of ['input', 'output', 'baselineArtifact', 'baselineManifest', 'targetExecutable', 'baselineSignature', 'targetSignature']) if (!nonEmpty(options[name])) throw new Error(`Argumento --${name} ausente.`);
    const observation = JSON.parse(readFileSync(resolve(options.input), 'utf8'));
    const proof = finalizeUpdateProof({ ...options, observation });
    validateUpdateProof(proof);
    writeFileSync(resolve(options.output), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ output: resolve(options.output), technicalUpdatePassed: true, acceptanceComplete: proof.acceptanceComplete, openGates: proof.openGates }) + '\n');
    return;
  }
  if (options.command === 'validate') {
    if (!nonEmpty(options.input)) throw new Error('Argumento --input ausente.');
    const proof = validateUpdateProof(JSON.parse(readFileSync(resolve(options.input), 'utf8')));
    process.stdout.write(JSON.stringify({ technicalUpdatePassed: proof.technicalUpdatePassed, acceptanceComplete: proof.acceptanceComplete, openGates: proof.openGates }) + '\n');
    return;
  }
  throw new Error('Comando invalido. Use check-versions, finalize ou validate.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

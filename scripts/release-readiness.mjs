import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import yaml from 'js-yaml';
import {manifestVersion} from './release-version.mjs';
import {inspectVersionContract} from './version-contract.mjs';

export const RELEASE_PROOF_SCHEMA = 'lume-native-release-proof-v2';

const REQUIRED_ARCHITECTURES = Object.freeze({windows: ['x64'], macos: ['arm64', 'x64']});
const VERIFICATION_KIND = Object.freeze({windows: {x64: 'signed-build'}, macos: {arm64: 'signed-build', x64: 'public-verification'}});
const BETA06_REQUIREMENTS = Object.freeze(['L06-ORG','L06-ACOES','L06-ONB','L06-DIST','L06-FEED','L06-TRUST','L06-UI','L06-AUDIO','L06-OPS','L06-PILOTO']);

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const sha512 = path => createHash('sha512').update(readFileSync(path)).digest('hex');
const sha512Base64 = path => createHash('sha512').update(readFileSync(path)).digest('base64');

export class ReleaseReadinessError extends Error {
  constructor(blockers) {
    super(`Release bloqueada:\n- ${blockers.map(item => `${item.id}: ${item.message}`).join('\n- ')}`);
    this.name = 'ReleaseReadinessError';
    this.blockers = blockers;
  }
}

function loadProject(root) {
  const contract = inspectVersionContract({root, shape: 'checkout'});
  const policyPath = resolve(root, 'desktop/release-policy.json');
  let policy = null, policyError = null;
  try { policy = JSON.parse(readFileSync(policyPath, 'utf8')); }
  catch { policyError = {id: 'RELEASE_POLICY_CONFIG', message: 'desktop/release-policy.json ausente ou malformado.'}; }
  return {contract, pkg: contract.packageJson, policy, policyError, version: contract.version};
}

export function inspectReleaseWorkflow(root) {
  let build, publish;
  try {
    build = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
    publish = readFileSync(resolve(root, '.github/workflows/release-publish.yml'), 'utf8');
  }
  catch { return [{id: 'RELEASE_WORKFLOW', message: 'Workflow de release ausente ou ilegivel.'}]; }
  const buildChecks = [
    /tags:\s*[\s\S]*-[ \t]+["']?v3\.\*["']?/,
    /\n  windows:\s*\n/,
    /\n  macos-build:\s*\n/,
    /\n  macos-intel:\s*\n/,
    /environment:\s*windows-signing/,
    /environment:\s*macos-signing/,
    /laya-release-assets\.mjs prepare/,
    /laya-release-assets\.mjs verify windows/,
    /laya-release-assets\.mjs verify macos/,
    /prepare-windows-signed-build\.mjs/,
    /--config work\/windows-signed-electron-builder\.json/,
    /verify-windows-signatures\.mjs/,
    /verify-windows-signed-package\.mjs/,
    /release-proof-windows\.json/,
    /--platform\s+macos\s+--architecture\s+arm64/,
    /--platform\s+macos\s+--architecture\s+x64\s+--public-verification/,
    /--merge-macos/
  ];
  const publishChecks = [
    /workflow_dispatch:/,
    /confirmation:/,
    /build_run_id:/,
    /environment:\s*release-beta/,
    /LUME_RELEASE_CONFIRMATION/,
    /LUME_RELEASE_SOURCE_RUN_ID/,
    /run\.event!=='push'/,
    /run\.conclusion!=='success'/,
    /run\.head_sha!==head/,
    /scripts\/release-readiness\.mjs --mode publish/,
    /scripts\/publicar-release\.mjs release-files/
  ];
  const noAutomaticPublish = !/\n  publish:\s*\n/.test(build) && !/LUME_RELEASE_ENABLED/.test(build + publish);
  return buildChecks.every(pattern => pattern.test(build)) && publishChecks.every(pattern => pattern.test(publish)) && noAutomaticPublish
    ? []
    : [{id: 'RELEASE_WORKFLOW', message: 'Workflow nao preserva build assinado por tag e publicacao manual vinculada ao tag, commit e run verde.'}];
}

function baseBlockers({root, requireCandidatePolicy = false}) {
  let project;
  try { project = loadProject(root); }
  catch { return {project: null, blockers: [{id: 'PROJECT_CONFIG', message: 'A configuracao do projeto nao pode ser inspecionada.'}]}; }
  const blockers = [...project.contract.blockers, ...inspectReleaseWorkflow(root)];
  if (project.policyError) blockers.push(project.policyError);
  else {
    if (project.policy?.schema !== 'lume-release-v1') blockers.push({id: 'RELEASE_POLICY', message: 'A politica de atualizacao usa um schema desconhecido.'});
    const channel = project.version?.includes('-beta.') ? 'beta' : 'estavel';
    if (project.version && project.policy?.channel !== channel) blockers.push({id: 'RELEASE_CHANNEL', message: `O canal ${project.policy?.channel || 'ausente'} diverge da versao ${project.version}.`});
    if (requireCandidatePolicy && (project.policy?.enabled !== false || project.policy?.feedUrl !== null)) blockers.push({id: 'CANDIDATE_POLICY', message: 'O candidato interno precisa manter atualizacoes desligadas e feed nulo.'});
  }
  return {project, blockers};
}
function tagBlockers(env, version) {
  const blockers = [];
  if (env.LUME_RELEASE_APPROVED !== 'PUBLICAR') blockers.push({id: 'RELEASE_APPROVAL', message: 'LUME_RELEASE_APPROVED=PUBLICAR não foi fornecido.'});
  if (env.GITHUB_ACTIONS !== 'true') blockers.push({id: 'RELEASE_CI', message: 'A distribuição só pode ser preparada pelo GitHub Actions.'});
  if (!nonEmpty(env.GITHUB_RUN_ID)) blockers.push({id: 'RELEASE_RUN', message: 'A execução não possui identidade de run do GitHub Actions.'});
  if (env.GITHUB_REF_TYPE !== 'tag' || env.GITHUB_REF_NAME !== `v${version}`) blockers.push({id: 'RELEASE_TAG', message: `A execução precisa vir da tag v${version}.`});
  return blockers;
}

function manualPublishBlockers(env, version) {
  const blockers = [];
  if (env.LUME_RELEASE_APPROVED !== 'PUBLICAR' || env.LUME_RELEASE_CONFIRMATION !== 'PUBLICAR') blockers.push({id: 'RELEASE_APPROVAL', message: 'A publicacao manual nao recebeu a confirmacao literal PUBLICAR.'});
  if (env.GITHUB_ACTIONS !== 'true') blockers.push({id: 'RELEASE_CI', message: 'A publicacao so pode ocorrer pelo GitHub Actions.'});
  if (!nonEmpty(env.GITHUB_RUN_ID)) blockers.push({id: 'RELEASE_RUN', message: 'A publicacao nao possui identidade de run do GitHub Actions.'});
  if (env.LUME_RELEASE_TAG !== `v${version}`) blockers.push({id: 'RELEASE_TAG', message: `A aprovacao manual precisa apontar para a tag v${version}.`});
  if (!/^\d+$/.test(String(env.LUME_RELEASE_SOURCE_RUN_ID || ''))) blockers.push({id: 'RELEASE_SOURCE_RUN', message: 'A run assinada de origem nao foi informada.'});
  return blockers;
}

function signingBlockers(kind, env) {
  if (kind === 'windows') {
    const certificate = nonEmpty(env.WINDOWS_CERTIFICATE_P12_BASE64) || nonEmpty(env.CSC_LINK);
    return certificate && nonEmpty(env.CSC_KEY_PASSWORD) ? [] : [{id: 'WINDOWS_SIGNING', message: 'Certificado Windows e senha de assinatura estão ausentes.'}];
  }
  const identity = env.CSC_IDENTITY_AUTO_DISCOVERY?.trim() !== 'false' && env.CSC_NAME?.trim() !== '-';
  const certificate = nonEmpty(env.CSC_LINK) && nonEmpty(env.CSC_KEY_PASSWORD);
  const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every(key => nonEmpty(env[key]));
  const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every(key => nonEmpty(env[key]));
  const keychain = nonEmpty(env.APPLE_KEYCHAIN_PROFILE);
  const blockers = [];
  if (!identity || !certificate) blockers.push({id: 'APPLE_DEVELOPER_ID', message: 'Certificado Developer ID e senha estão ausentes ou a assinatura foi desativada.'});
  if (!apiKey && !appleId && !keychain) blockers.push({id: 'APPLE_NOTARIZATION', message: 'Nenhum conjunto completo de credenciais de notarização Apple foi fornecido.'});
  return blockers;
}

function productAcceptanceBlockers(root, version) {
  const path = resolve(root, 'docs/beta-06/release-acceptance.json');
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return [{id: 'PRODUCT_ACCEPTANCE', message: 'Registro de aceite da Beta 0.6 ausente ou ilegível.'}]; }
  if (record?.schema !== 'lume-beta06-acceptance-v1' || record.version !== version || !record.requirements || typeof record.requirements !== 'object' || Array.isArray(record.requirements))
    return [{id: 'PRODUCT_ACCEPTANCE', message: 'Registro de aceite não corresponde à versão e ao contrato da Beta 0.6.'}];
  return BETA06_REQUIREMENTS.filter(id => record.requirements[id]?.status !== 'aprovado' || !Array.isArray(record.requirements[id]?.evidence) || !record.requirements[id].evidence.length || record.requirements[id].evidence.some(value => !nonEmpty(value)))
    .map(id => ({id: 'PRODUCT_ACCEPTANCE', message: `${id} ainda não tem aceite com evidência registrada.`}));
}

function artifactFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter(name => statSync(resolve(dir, name)).isFile());
}

function platformArtifacts(kind, files) {
  const manifest = kind === 'windows' ? 'beta.yml' : 'beta-mac.yml';
  const primary = kind === 'windows'
    ? files.filter(name => name.endsWith('.exe'))
    : files.filter(name => /-mac-universal\.(?:dmg|zip)$/.test(name));
  const requiredExtensions = kind === 'windows' ? ['.exe'] : ['.dmg', '.zip'];
  return {manifest, primary, requiredExtensions, files: files.filter(name => name === manifest || name.endsWith('.blockmap') || requiredExtensions.some(ext => name.endsWith(ext)))};
}

function manifestBlockers(kind, dir, files, version) {
  const {manifest, requiredExtensions} = platformArtifacts(kind, files);
  const blockers = [];
  if (!files.includes(manifest)) return [{id: 'UPDATE_MANIFEST', message: `Manifesto ${manifest} ausente.`}];
  let text;
  try { text = readFileSync(resolve(dir, manifest), 'utf8'); }
  catch { return [{id: 'UPDATE_MANIFEST', message: `Manifesto ${manifest} não pôde ser lido.`}]; }
  try { if (manifestVersion(text) !== version) blockers.push({id: 'UPDATE_MANIFEST_VERSION', message: `${manifest} não aponta para ${version}.`}); }
  catch { blockers.push({id: 'UPDATE_MANIFEST_VERSION', message: `${manifest} contém uma versão inválida.`}); }
  let data;
  try { data = yaml.load(text, {schema: yaml.JSON_SCHEMA}); }
  catch { blockers.push({id: 'UPDATE_MANIFEST_FORMAT', message: `${manifest} não é YAML válido.`}); }
  const entries = Array.isArray(data?.files) ? data.files : [];
  if (!entries.length || data?.version !== version || data?.packages) blockers.push({id: 'UPDATE_MANIFEST_FORMAT', message: `${manifest} não contém a lista de arquivos esperada.`});
  const safeName = name => typeof name === 'string' && name.length > 0 && basename(name) === name && !/[\\/%?#]/.test(name) && files.includes(name);
  const validHash = (name, hash) => typeof hash === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(hash) && hash === sha512Base64(resolve(dir, name));
  const listed = new Set();
  for (const entry of entries) {
    const name = entry?.url;
    if (!safeName(name) || !requiredExtensions.some(ext => name.endsWith(ext)) || listed.has(name)) {blockers.push({id: 'UPDATE_MANIFEST_PATH', message: `${manifest} referencia arquivo ausente, duplicado ou fora do pacote.`});continue;}
    listed.add(name);
    if (!validHash(name, entry.sha512)) blockers.push({id: 'UPDATE_MANIFEST_HASH', message: `${manifest} tem checksum ausente ou diferente para ${name}.`});
  }
  if (!safeName(data?.path) || !listed.has(data.path)) blockers.push({id: 'UPDATE_MANIFEST_PATH', message: `${manifest} não aponta para um arquivo listado no pacote.`});
  else if (!validHash(data.path, data.sha512)) blockers.push({id: 'UPDATE_MANIFEST_HASH', message: `${manifest} tem checksum principal ausente ou diferente.`});
  for (const extension of requiredExtensions) {
    const candidates = kind === 'macos'
      ? files.filter(name => name.endsWith(`-mac-universal${extension}`))
      : files.filter(name => name.endsWith(extension));
    if (!candidates.length) blockers.push({id: 'RELEASE_ARTIFACT', message: `Artefato ${extension} ausente para ${kind}.`});
    if (candidates.some(name => !name.includes(`-${version}-`))) blockers.push({id: 'RELEASE_ARTIFACT_VERSION', message: `Há artefato ${extension} de outra versão no conjunto ${kind}.`});
    if (extension === '.exe' || extension === '.zip') {
      if (candidates.length && !candidates.some(name => listed.has(name))) blockers.push({id: 'UPDATE_MANIFEST_PATH', message: `${manifest} não referencia o artefato de atualização ${extension}.`});
    }
  }
  if (kind === 'macos' && files.some(name => /-mac-(?:arm64|x64)\.(?:dmg|zip)$/.test(name))) blockers.push({id: 'MACOS_UNIVERSAL', message: 'A release macOS deve conter somente o pacote universal validado nas duas arquiteturas.'});
  return blockers;
}

function proofBlockers(kind, dir, files, version, env) {
  const proofName = `release-proof-${kind}.json`;
  if (!files.includes(proofName)) return [{id: 'NATIVE_PROOF', message: `Prova nativa ${proofName} ausente.`}];
  let proof;
  try { proof = JSON.parse(readFileSync(resolve(dir, proofName), 'utf8')); }
  catch { return [{id: 'NATIVE_PROOF', message: `Prova nativa ${proofName} inválida.`}]; }
  const blockers = [];
  if (proof.schema !== RELEASE_PROOF_SCHEMA || proof.platform !== kind || proof.version !== version) blockers.push({id: 'NATIVE_PROOF', message: `Prova nativa ${proofName} não corresponde à release.`});
  const expectedRunId = String(env.LUME_RELEASE_SOURCE_RUN_ID || env.GITHUB_RUN_ID || '');
  if (!nonEmpty(proof.githubRunId) || proof.githubRunId !== expectedRunId) blockers.push({id: 'NATIVE_PROOF_RUN', message: `Prova ${proofName} não pertence à run assinada aprovada.`});
  if (proof.signatureVerified !== true || (kind === 'macos' && proof.notarizationVerified !== true)) blockers.push({id: 'NATIVE_VERIFICATION', message: `Assinatura${kind === 'macos' ? ' e notarização' : ''} não foram confirmadas para ${kind}.`});
  const expectedArchitectures = REQUIRED_ARCHITECTURES[kind];
  const verifiedArchitectures = Array.isArray(proof.verifiedArchitectures) ? [...proof.verifiedArchitectures].sort() : [];
  const nativeExecutions = Array.isArray(proof.nativeExecutions) ? proof.nativeExecutions : [];
  if (verifiedArchitectures.join(',') !== [...expectedArchitectures].sort().join(',')) blockers.push({id: 'NATIVE_ARCHITECTURES', message: `Prova ${proofName} não cobre todas as arquiteturas nativas exigidas.`});
  if (nativeExecutions.length !== expectedArchitectures.length || expectedArchitectures.some(architecture => !nativeExecutions.some(entry => entry?.architecture === architecture && entry?.githubRunId === expectedRunId && entry?.nativeExecutionVerified === true && entry?.verificationKind === VERIFICATION_KIND[kind][architecture]))) blockers.push({id: 'NATIVE_EXECUTION', message: `Prova ${proofName} não confirma execução nativa em todas as arquiteturas pelo caminho exigido.`});
  const proofFiles = Array.isArray(proof.files) ? proof.files : [];
  const proofNames = new Set(proofFiles.map(entry => entry.name));
  const expected = platformArtifacts(kind, files), required = [expected.manifest, ...expected.primary];
  if (required.some(name => !proofNames.has(name))) blockers.push({id: 'NATIVE_PROOF_FILES', message: `Prova ${proofName} não cobre todos os instaladores e manifestos da plataforma.`});
  for (const entry of proofFiles) {
    const safe = basename(entry.name || '') === entry.name && files.includes(entry.name);
    if (!safe || !/^[a-f0-9]{128}$/.test(entry.sha512 || '') || sha512(resolve(dir, entry.name)) !== entry.sha512) blockers.push({id: 'NATIVE_PROOF_HASH', message: `Hash inválido ou artefato ausente na prova ${proofName}.`});
  }
  if (!proofFiles.length) blockers.push({id: 'NATIVE_PROOF_FILES', message: `Prova ${proofName} não lista artefatos.`});
  return blockers;
}

export function inspectReleaseReadiness({mode = 'candidate', root = resolve(import.meta.dirname, '..'), artifactsDir, env = process.env} = {}) {
  if (!['candidate', 'windows', 'macos', 'publish'].includes(mode)) throw Error('Modo inválido. Use candidate, windows, macos ou publish.');
  const {project, blockers} = baseBlockers({root, requireCandidatePolicy: mode === 'candidate'});
  const version = project?.version;
  if (mode === 'candidate') {
    const files = artifactFiles(artifactsDir);
    const publicationBlockers = [
      ...productAcceptanceBlockers(root, version),
      ...tagBlockers(env, version),
      ...signingBlockers('windows', env),
      ...signingBlockers('macos', env),
      ...manifestBlockers('windows', artifactsDir, files, version),
      ...manifestBlockers('macos', artifactsDir, files, version),
      {id: 'MANUAL_PUBLICATION', message: 'A promocao manual com tag, run assinada e confirmacao literal ainda nao ocorreu.'}
    ];
    return {mode, version, candidateBuildAllowed: blockers.length === 0, publicationAllowed: false, blockers, publicationBlockers};
  }
  blockers.push(...(mode === 'publish' ? manualPublishBlockers(env, version) : tagBlockers(env, version)));
  if (mode === 'windows' || mode === 'macos') blockers.push(...signingBlockers(mode, env));
  if (mode === 'publish') {
    blockers.push(...productAcceptanceBlockers(root, version));
    if (!nonEmpty(env.BLOB_READ_WRITE_TOKEN)) blockers.push({id: 'PUBLISH_TOKEN', message: 'Token de publicação está ausente.'});
    const files = artifactFiles(artifactsDir);
    for (const kind of ['windows', 'macos']) {
      blockers.push(...manifestBlockers(kind, artifactsDir, files, version));
      blockers.push(...proofBlockers(kind, artifactsDir, files, version, env));
    }
    const unexpected = files.filter(name => !/^(?:release-proof-(?:windows|macos)\.json|[^/]+\.(?:exe|blockmap|dmg|zip|yml))$/.test(name));
    if (unexpected.length) blockers.push({id: 'UNEXPECTED_ARTIFACT', message: 'O diretório contém arquivos não permitidos.'});
  }
  return {mode, version, candidateBuildAllowed: false, publicationAllowed: blockers.length === 0, blockers};
}

export function assertReleaseReady(options = {}) {
  const result = inspectReleaseReadiness(options);
  const allowed = result.mode === 'candidate' ? result.candidateBuildAllowed : result.publicationAllowed;
  if (!allowed) throw new ReleaseReadinessError(result.blockers);
  return result;
}

function assertMacPublicVerificationReady({root, env}) {
  const {project, blockers} = baseBlockers({root});
  blockers.push(...tagBlockers(env, project?.version));
  if (blockers.length) throw new ReleaseReadinessError(blockers);
  return {version: project.version};
}

export function recordNativeProof({platform, architecture = platform === 'windows' ? 'x64' : null, publicVerification = false, root = resolve(import.meta.dirname, '..'), artifactsDir, env = process.env} = {}) {
  if (!['windows', 'macos'].includes(platform)) throw Error('Plataforma de prova inválida.');
  if (!REQUIRED_ARCHITECTURES[platform].includes(architecture)) throw Error('Arquitetura de prova inválida.');
  if (publicVerification && (platform !== 'macos' || architecture !== 'x64')) throw Error('Verificação pública é aceita somente para a prova macOS Intel.');
  const readiness = publicVerification ? assertMacPublicVerificationReady({root, env}) : assertReleaseReady({mode: platform, root, artifactsDir, env});
  if (env.LUME_NATIVE_VERIFICATION !== 'VERIFICADO') throw new ReleaseReadinessError([{id: 'NATIVE_VERIFICATION', message: 'A etapa nativa de assinatura ainda não confirmou o artefato.'}]);
  if (publicVerification && env.LUME_PUBLIC_SIGNATURE_VERIFICATION !== 'VERIFICADO') throw new ReleaseReadinessError([{id: 'PUBLIC_SIGNATURE_VERIFICATION', message: 'A verificação pública de assinatura, Gatekeeper e notarização não foi confirmada.'}]);
  const files = artifactFiles(artifactsDir), selected = platformArtifacts(platform, files).files;
  const manifestErrors = manifestBlockers(platform, artifactsDir, files, readiness.version);
  if (manifestErrors.length) throw new ReleaseReadinessError(manifestErrors);
  const verificationKind = publicVerification ? 'public-verification' : 'signed-build';
  const nativeExecution = {architecture, githubRunId: String(env.GITHUB_RUN_ID || ''), nativeExecutionVerified: true, verificationKind};
  const proof = {
    schema: RELEASE_PROOF_SCHEMA,
    version: readiness.version,
    platform,
    signatureVerified: true,
    notarizationVerified: platform === 'macos',
    githubRunId: String(env.GITHUB_RUN_ID || ''),
    files: selected.sort().map(name => ({name, sha512: sha512(resolve(artifactsDir, name))}))
  };
  if (platform === 'windows') {
    proof.verifiedArchitectures = ['x64'];
    proof.nativeExecutions = [nativeExecution];
  } else {
    proof.architecture = architecture;
    proof.nativeExecutionVerified = true;
    proof.verificationKind = verificationKind;
  }
  const output = resolve(artifactsDir, platform === 'macos' ? `release-proof-macos-${architecture}.json` : 'release-proof-windows.json');
  writeFileSync(output, JSON.stringify(proof, null, 2) + '\n');
  return {output, proof};
}

export function mergeMacNativeProofs({root = resolve(import.meta.dirname, '..'), artifactsDir, env = process.env} = {}) {
  const readiness = assertMacPublicVerificationReady({root, env});
  if (env.LUME_NATIVE_VERIFICATION !== 'VERIFICADO') throw new ReleaseReadinessError([{id: 'NATIVE_VERIFICATION', message: 'A etapa nativa de assinatura ainda não confirmou o artefato.'}]);
  if (env.LUME_PUBLIC_SIGNATURE_VERIFICATION !== 'VERIFICADO') throw new ReleaseReadinessError([{id: 'PUBLIC_SIGNATURE_VERIFICATION', message: 'A verificação pública de assinatura, Gatekeeper e notarização não foi confirmada.'}]);
  const files = artifactFiles(artifactsDir);
  const selected = platformArtifacts('macos', files).files.sort();
  const manifestErrors = manifestBlockers('macos', artifactsDir, files, readiness.version);
  if (manifestErrors.length) throw new ReleaseReadinessError(manifestErrors);
  const expectedRunId = String(env.GITHUB_RUN_ID || '');
  const proofs = REQUIRED_ARCHITECTURES.macos.map(architecture => {
    const name = `release-proof-macos-${architecture}.json`;
    let proof;
    try { proof = JSON.parse(readFileSync(resolve(artifactsDir, name), 'utf8')); }
    catch { throw new ReleaseReadinessError([{id: 'NATIVE_PROOF', message: `Prova nativa ${name} ausente ou inválida.`}]); }
    const blockers = [];
    if (proof.schema !== RELEASE_PROOF_SCHEMA || proof.platform !== 'macos' || proof.version !== readiness.version || proof.architecture !== architecture) blockers.push({id: 'NATIVE_PROOF', message: `Prova nativa ${name} não corresponde à release e arquitetura.`});
    if (proof.githubRunId !== expectedRunId) blockers.push({id: 'NATIVE_PROOF_RUN', message: `Prova ${name} não pertence à run atual.`});
    if (proof.signatureVerified !== true || proof.notarizationVerified !== true || proof.nativeExecutionVerified !== true || proof.verificationKind !== VERIFICATION_KIND.macos[architecture]) blockers.push({id: 'NATIVE_VERIFICATION', message: `Prova ${name} não confirma assinatura, notarização e execução nativa pelo caminho exigido.`});
    const proofFiles = Array.isArray(proof.files) ? proof.files : [];
    if (proofFiles.length !== selected.length || selected.some(file => !proofFiles.some(entry => entry.name === file))) blockers.push({id: 'NATIVE_PROOF_FILES', message: `Prova ${name} não cobre o conjunto universal completo.`});
    for (const entry of proofFiles) {
      const safe = basename(entry.name || '') === entry.name && selected.includes(entry.name);
      if (!safe || !/^[a-f0-9]{128}$/.test(entry.sha512 || '') || sha512(resolve(artifactsDir, entry.name)) !== entry.sha512) blockers.push({id: 'NATIVE_PROOF_HASH', message: `Hash inválido ou artefato ausente na prova ${name}.`});
    }
    if (blockers.length) throw new ReleaseReadinessError(blockers);
    return proof;
  });
  const proof = {
    schema: RELEASE_PROOF_SCHEMA,
    version: readiness.version,
    platform: 'macos',
    signatureVerified: true,
    notarizationVerified: true,
    githubRunId: expectedRunId,
    verifiedArchitectures: [...REQUIRED_ARCHITECTURES.macos],
    nativeExecutions: proofs.map(({architecture, githubRunId, nativeExecutionVerified, verificationKind}) => ({architecture, githubRunId, nativeExecutionVerified, verificationKind})),
    files: proofs[0].files
  };
  const output = resolve(artifactsDir, 'release-proof-macos.json');
  writeFileSync(output, JSON.stringify(proof, null, 2) + '\n');
  return {output, proof};
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') result.mode = argv[++i];
    else if (argv[i] === '--platform') result.platform = argv[++i];
    else if (argv[i] === '--architecture') result.architecture = argv[++i];
    else if (argv[i] === '--public-verification') result.publicVerification = true;
    else if (argv[i] === '--merge-macos') result.mergeMacos = true;
    else if (argv[i] === '--artifacts') result.artifactsDir = resolve(argv[++i]);
    else throw Error(`Argumento desconhecido: ${argv[i]}`);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = args(process.argv.slice(2));
    const result = options.mergeMacos ? mergeMacNativeProofs(options) : options.platform ? recordNativeProof(options) : assertReleaseReady(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

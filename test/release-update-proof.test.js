import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertUpdateObservation, assertUpdateVersions, finalizeUpdateProof, validateUpdateProof, UPDATE_OBSERVATION_SCHEMA } from '../scripts/release-update-proof.mjs';

const observation = (overrides = {}) => ({
  schema: UPDATE_OBSERVATION_SCHEMA,
  platform: 'windows', architecture: 'x64', channel: 'beta',
  baselineVersion: '3.2.0-beta.2', targetVersion: '3.2.0-beta.3', githubRunId: '123',
  profile: { samePath: true, isolatedRunnerProfile: true },
  database: { existedBefore: true, existsAfter: true, markerPreserved: true },
  update: { offeredVersion: '3.2.0-beta.3', downloadCompleted: true, installRequested: true, runtimeBefore: '3.2.0-beta.2', runtimeAfter: '3.2.0-beta.3' },
  whatsapp: { testedWithRealAccount: false, preserved: null },
  ...overrides
});

function artifacts(t) {
  const root = mkdtempSync(join(tmpdir(), 'lume-update-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baselineArtifact = join(root, 'Lume-3.2.0-beta.2-win-x64-Setup.exe');
  const targetExecutable = join(root, 'Lume.exe');
  const baselineManifest = join(root, 'beta.yml');
  writeFileSync(baselineArtifact, 'signed baseline'); writeFileSync(targetExecutable, 'signed target'); writeFileSync(baselineManifest, 'version: 3.2.0-beta.2\npath: Lume-3.2.0-beta.2-win-x64-Setup.exe\n');
  return { baselineArtifact, baselineManifest, targetExecutable };
}

test('prova tecnica registra hashes e mantem WhatsApp real como gate aberto', t => {
  const proof = finalizeUpdateProof({ observation: observation(), ...artifacts(t), baselineSignature: 'VERIFICADO', targetSignature: 'VERIFICADO', notarization: 'NA' });
  assert.equal(validateUpdateProof(proof), proof);
  assert.equal(proof.technicalUpdatePassed, true);
  assert.equal(proof.acceptanceComplete, false);
  assert.deepEqual(proof.openGates, ['REAL_WHATSAPP_RECONNECTION']);
  assert.match(proof.artifacts.baselineInstaller.sha512, /^[a-f0-9]{128}$/);
  assert.equal(proof.rollback.automaticDowngradeAllowed, false);
  assert.equal(proof.rollback.immutableManifestPath, 'releases/beta/manifests/3.2.0-beta.2/beta.yml');
});

test('prova macOS aceita arm64 e x64 somente com pacote universal, assinaturas e notarizacao', t => {
  for (const architecture of ['arm64', 'x64']) {
    const raw = observation({ platform: 'macos', architecture, whatsapp: { testedWithRealAccount: true, preserved: true } });
    const files = artifacts(t);
    const macArtifact = join(dirname(files.baselineArtifact), 'Lume-3.2.0-beta.2-mac-universal.dmg'); writeFileSync(macArtifact, 'signed mac baseline'); files.baselineArtifact = macArtifact;
    const macExecutable = join(dirname(files.targetExecutable), 'Lume'); writeFileSync(macExecutable, 'signed mac target'); files.targetExecutable = macExecutable;
    const macManifest = join(dirname(files.baselineManifest), 'beta-mac.yml'); writeFileSync(macManifest, 'version: 3.2.0-beta.2\npath: Lume-3.2.0-beta.2-mac-universal.zip\n'); files.baselineManifest = macManifest;
    assert.throws(() => finalizeUpdateProof({ observation: raw, ...files, baselineSignature: 'VERIFICADO', targetSignature: 'VERIFICADO', notarization: 'NA' }), /notarizacao/);
    const proof = finalizeUpdateProof({ observation: raw, ...files, baselineSignature: 'VERIFICADO', targetSignature: 'VERIFICADO', notarization: 'VERIFICADO' });
    assert.equal(proof.acceptanceComplete, true); assert.equal(proof.architecture, architecture); assert.deepEqual(proof.openGates, []);
  }
});

test('observacao falha fechada para downgrade, perfil novo ou troca incompleta', () => {
  assert.throws(() => assertUpdateVersions({ baselineVersion: '3.2.0-beta.3', targetVersion: '3.2.0-beta.2' }), /posterior/);
  assert.throws(() => assertUpdateObservation(observation({ profile: { samePath: false, isolatedRunnerProfile: true } })), /mesmo perfil/);
  assert.throws(() => assertUpdateObservation(observation({ update: { ...observation().update, runtimeAfter: '3.2.0-beta.2' } })), /troca de versao/);
  assert.throws(() => assertUpdateObservation(observation({ whatsapp: { testedWithRealAccount: false, preserved: true } })), /inferir/);
});

test('prova recusa artefato ausente e atestado de assinatura textual falso', t => {
  const files = artifacts(t);
  assert.throws(() => finalizeUpdateProof({ observation: observation(), ...files, baselineSignature: 'NAO', targetSignature: 'VERIFICADO' }), /assinaturas/);
  assert.throws(() => finalizeUpdateProof({ observation: observation(), ...files, baselineArtifact: join(tmpdir(), 'Lume-3.2.0-beta.2-win-x64-Setup.exe'), baselineSignature: 'VERIFICADO', targetSignature: 'VERIFICADO' }), /ausente/);
});

test('workflow de prova e manual, nativo, sem segredos e mantem WhatsApp real aberto', () => {
  const workflow = readFileSync(new URL('../.github/workflows/update-proof.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  push:/);
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /runner: macos-15\b/);
  assert.match(workflow, /runner: macos-15-intel/);
  assert.match(workflow, /architecture: arm64/);
  assert.match(workflow, /architecture: x64/);
  assert.match(workflow, /mac-universal\.dmg/);
  assert.doesNotMatch(workflow, /mac-arm64\.dmg/);
  assert.match(workflow, /Get-AuthenticodeSignature/);
  assert.match(workflow, /codesign --verify/);
  assert.match(workflow, /spctl --assess/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.match(workflow, /release-update-native\.e2e\.mjs/);
  assert.doesNotMatch(workflow, /secrets\./);
  const runner = readFileSync(new URL('./release-update-native.e2e.mjs', import.meta.url), 'utf8');
  assert.match(runner, /GITHUB_ACTIONS[^\n]+LUME_UPDATE_PROOF/);
  assert.match(runner, /LUME_REAL_WHATSAPP_CONFIRMED === 'VERIFICADO'/);
  assert.match(runner, /preserved: realWhatsapp \? true : null/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {assertUniversalDependencies, universalDependencyPlan} from '../scripts/prepare-macos-universal-deps.mjs';

test('plano usa dois npm ci isolados e presos ao lock', () => {
  const root = resolve('.');
  for (const architecture of ['arm64', 'x64']) {
    const plan = universalDependencyPlan({root, platform: 'darwin', architecture});
    for (const targetArchitecture of ['arm64', 'x64']) {
      const args = plan.npmArgsByArchitecture[targetArchitecture];
      assert.deepEqual(args.slice(0, 5), ['ci', '--ignore-scripts', '--omit=dev', '--include=optional', '--os=darwin']);
      assert.ok(args.includes(`--cpu=${targetArchitecture}`));
      assert.doesNotMatch(args.join(' '), /install|force|package-lock=false/);
    }
  }
});

test('lock raiz declara exatamente as quatro dependências universais', () => {
  const root = resolve('.');
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lock.packages[''].optionalDependencies, metadata.optionalDependencies);
  const plan = universalDependencyPlan({root, platform: 'darwin', architecture: 'arm64'});
  for (const [name, contract] of Object.entries(plan.expected)) {
    assert.equal(metadata.optionalDependencies[name], contract.version);
    assert.match(contract.integrity, /^sha512-/);
  }
});

test('checagem falha fechada quando qualquer variante não foi copiada', t => {
  const source = resolve('.');
  const root = join(tmpdir(), `lume-universal-deps-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(root, {recursive: true});
  cpSync(join(source, 'package-lock.json'), join(root, 'package-lock.json'));
  const plan = universalDependencyPlan({root, platform: 'darwin', architecture: 'arm64'});
  for (const [name, contract] of Object.entries(plan.expected)) {
    const path = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(path, {recursive: true});
    writeFileSync(join(path, 'package.json'), JSON.stringify({name, version: contract.version}));
  }
  assert.equal(assertUniversalDependencies(plan), true);
  rmSync(join(root, 'node_modules', '@img', 'sharp-darwin-x64'), {recursive: true, force: true});
  assert.throws(() => assertUniversalDependencies(plan), /sharp-darwin-x64/);
});

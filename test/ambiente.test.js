import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregarEnv, caminhoVault, vaultPadrao, vaultExigido, VaultAusente } from '../src/ambiente.js';

function pasta() { return mkdtempSync(join(tmpdir(), 'assessor-env-')); }

function limpo(vars, corpo) {
  const antes = { ...process.env };
  for (const k of Object.keys(vars)) {
    if (vars[k] === null) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { corpo(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
    Object.assign(process.env, antes);
  }
}

test('.env salvo com BOM ainda entrega a primeira chave', () => {
  // Medido em 12/09/2026: `Set-Content -Encoding utf8` do PowerShell 5.1 escreve BOM, e
  // sem esta correcao `process.env.GEMINI_API_KEY` voltava undefined enquanto existia
  // uma variavel chamada "\uFEFFGEMINI_API_KEY". A chave sumia sem erro nenhum.
  const dir = pasta();
  const arquivo = join(dir, '.env');
  writeFileSync(arquivo, '\uFEFFGEMINI_API_KEY=AIza-com-bom\nOUTRA=valor\n', 'utf8');
  limpo({ GEMINI_API_KEY: null, OUTRA: null }, () => {
    assert.equal(carregarEnv(arquivo), true);
    assert.equal(process.env.GEMINI_API_KEY, 'AIza-com-bom');
    assert.equal(process.env.OUTRA, 'valor');
    assert.ok(!Object.keys(process.env).some(k => k.startsWith('\uFEFF')),
      'nenhuma chave pode sobrar com o BOM grudado');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('variavel exportada no shell ganha do .env, e nao o contrario', () => {
  // Quem exportou no terminal quis sobrepor. Se o .env desfizesse isso pelas costas,
  // depurar com `ASSESSOR_LLM=agy` viraria impossivel.
  const dir = pasta();
  const arquivo = join(dir, '.env');
  writeFileSync(arquivo, 'ASSESSOR_PORT=9999\n', 'utf8');
  limpo({ ASSESSOR_PORT: '8080' }, () => {
    carregarEnv(arquivo);
    assert.equal(process.env.ASSESSOR_PORT, '8080');
  });
  rmSync(dir, { recursive: true, force: true });
});

test('.env ausente nao e erro: a captura nao pode cair por falta de configuracao', () => {
  assert.equal(carregarEnv(join(pasta(), 'nao-existe.env')), false);
});

test('.env quebrado avisa e segue, em vez de derrubar o app', () => {
  const dir = pasta();
  const arquivo = join(dir, '.env');
  writeFileSync(arquivo, '\x00\x01lixo binario sem = nenhum\x00', 'utf8');
  const erroOriginal = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => carregarEnv(arquivo));
  } finally { console.error = erroOriginal; }
  rmSync(dir, { recursive: true, force: true });
});

test('PUNK_RECORDS declarado manda no caminho do vault', () => {
  limpo({ PUNK_RECORDS: 'C:/vault/do/socio', PUNK_VAULT_DIR: null }, () => {
    assert.match(caminhoVault().split('\\').join('/'), /vault\/do\/socio$/);
  });
});

test('sem nada declarado, o vault e o padrao por usuario e nunca ~/PunkRecords', () => {
  // O achado A04 da auditoria foi exatamente isso: `vaultDir()` caia num caminho
  // adivinhado e a entrega falhava dizendo "pulado com sucesso".
  const padrao = vaultPadrao();
  assert.match(padrao, /AssessorVault$/);
  assert.doesNotMatch(padrao, /PunkRecords/);
});

test('vault inexistente e ERRO alto, nunca sucesso silencioso', () => {
  limpo({ PUNK_RECORDS: join(tmpdir(), 'vault-que-nao-existe-' + Date.now()), PUNK_VAULT_DIR: null }, () => {
    assert.throws(() => vaultExigido(), VaultAusente);
    assert.throws(() => vaultExigido(), /criar-vault/,
      'o erro precisa dizer o comando que resolve');
  });
});

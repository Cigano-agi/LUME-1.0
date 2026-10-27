import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lerEnv, gravarEnv, testarChave } from '../src/configuracao.js';

const pasta = () => mkdtempSync(join(tmpdir(), 'assessor-cfg-'));

test('gravar preserva comentario e ordem em vez de reescrever o arquivo', () => {
  // O .env do sócio é escrito pelo instalador, com comentários que explicam cada campo.
  // Reescrever tudo a cada salvamento apagaria essa explicação.
  const dir = pasta();
  const arquivo = join(dir, '.env');
  writeFileSync(arquivo, '# minha config\nGEMINI_API_KEY=antiga\n\n# como apareco\nASSESSOR_DONO=Guilherme\n', 'utf8');

  gravarEnv({ GEMINI_API_KEY: 'nova' }, arquivo);

  const texto = readFileSync(arquivo, 'utf8');
  assert.match(texto, /# minha config/);
  assert.match(texto, /# como apareco/);
  assert.match(texto, /GEMINI_API_KEY=nova/);
  assert.match(texto, /ASSESSOR_DONO=Guilherme/, 'o que nao foi tocado continua la');
  assert.doesNotMatch(texto, /antiga/);
  rmSync(dir, { recursive: true, force: true });
});

test('chave nova entra em arquivo que ainda nao tem a linha', () => {
  const dir = pasta();
  const arquivo = join(dir, '.env');
  writeFileSync(arquivo, 'ASSESSOR_PORT=8787\n', 'utf8');
  gravarEnv({ GEMINI_API_KEY: 'AIza-x' }, arquivo);
  assert.equal(lerEnv(arquivo).valores.GEMINI_API_KEY, 'AIza-x');
  rmSync(dir, { recursive: true, force: true });
});

test('gravar nunca deixa BOM no arquivo', () => {
  // Se deixasse, a proxima leitura perderia a primeira chave sem dar erro.
  const dir = pasta();
  const arquivo = join(dir, '.env');
  gravarEnv({ GEMINI_API_KEY: 'AIza-x' }, arquivo);
  const bytes = readFileSync(arquivo);
  assert.notEqual(bytes[0], 0xEF, 'nada de BOM');
  rmSync(dir, { recursive: true, force: true });
});

test('ler ignora o BOM de arquivo salvo no Bloco de Notas', () => {
  const dir = pasta();
  const arquivo = join(dir, '.env');
  writeFileSync(arquivo, '﻿GEMINI_API_KEY=AIza-com-bom\n', 'utf8');
  assert.equal(lerEnv(arquivo).valores.GEMINI_API_KEY, 'AIza-com-bom');
  rmSync(dir, { recursive: true, force: true });
});

test('o painel so escreve configuracao, nao qualquer variavel de ambiente', () => {
  // `/api/config/chave` recebe um corpo JSON vindo do navegador. Sem a lista fechada,
  // um POST poderia injetar PATH ou NODE_OPTIONS no arquivo que o app carrega no boot.
  const dir = pasta();
  const arquivo = join(dir, '.env');
  assert.throws(() => gravarEnv({ PATH: '/tmp/mau' }, arquivo), TypeError);
  assert.throws(() => gravarEnv({ NODE_OPTIONS: '--require /tmp/x.js' }, arquivo), TypeError);
  assert.equal(existsSync(arquivo), false, 'recusa antes de tocar o disco');
  rmSync(dir, { recursive: true, force: true });
});

test('valor com quebra de linha e recusado, para nao corromper o resto do arquivo', () => {
  const dir = pasta();
  const arquivo = join(dir, '.env');
  assert.throws(() => gravarEnv({ ASSESSOR_DONO: 'Guilherme\nGEMINI_API_KEY=roubada' }, arquivo), TypeError);
  rmSync(dir, { recursive: true, force: true });
});

test('gravar guarda uma copia do arquivo anterior', () => {
  const dir = pasta();
  const arquivo = join(dir, '.env');
  writeFileSync(arquivo, 'GEMINI_API_KEY=antiga\n', 'utf8');
  gravarEnv({ GEMINI_API_KEY: 'nova' }, arquivo);
  assert.match(readFileSync(`${arquivo}.bak`, 'utf8'), /antiga/);
  rmSync(dir, { recursive: true, force: true });
});

test('chave vazia e recusada sem ir na rede', async () => {
  const r = await testarChave('');
  assert.equal(r.ok, false);
  assert.match(r.erro, /Cole a chave/);
});

test('quem cola a URL da pagina em vez da chave recebe um erro que explica', async () => {
  // Erro mais provavel de todos: a pessoa copia a barra de endereco.
  const r = await testarChave('https://aistudio.google.com/apikey');
  assert.equal(r.ok, false);
  assert.match(r.erro, /AIza/);
});

test('espaco colado junto nao invalida a chave', async () => {
  // Copiar da tela do Google traz espaco no fim com frequencia.
  const r = await testarChave('   ');
  assert.equal(r.ok, false);
  assert.match(r.erro, /Cole a chave/);
});

test('testar a chave nao deixa rastro no ambiente do processo', async () => {
  // A chave testada vale so para o teste. Se vazasse para `process.env`, uma chave
  // recusada continuaria valendo ate o app reiniciar.
  const antes = process.env.GEMINI_API_KEY;
  await testarChave('AIzaSyD' + 'x'.repeat(33));
  assert.equal(process.env.GEMINI_API_KEY, antes);
});

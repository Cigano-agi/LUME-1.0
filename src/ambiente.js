// Onde a configuração mora e como o vault é encontrado.
//
// Enquanto isto rodou só na máquina do Fabrício, o caminho do vault podia ficar cravado
// no código — e ficava, em três arquivos. Na máquina do sócio esse caminho não existe, e
// o efeito não seria um erro claro: `bin/publicar-vault.js` apontaria para uma pasta
// ausente e a publicação falharia falando de permissão.
//
// Regra: nada de `~/PunkRecords` adivinhado (foi o achado A04 da auditoria, onde o
// destino inexistente virava `skipped:true` e o comando saía com sucesso). Ou o caminho
// é declarado, ou é o padrão por usuário — e nos dois casos a pasta precisa existir de
// verdade antes de qualquer escrita.

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ_REPO = resolve(fileURLToPath(import.meta.url), '../..');

// Onde o vault do Fabrício está desde o começo. Continua sendo consultado, mas agora
// como penúltimo recurso e só se a pasta existir de fato — assim esta máquina não muda
// de comportamento e a do sócio não herda um caminho que nunca vai existir lá.
const VAULT_HERDADO = 'C:/Users/Usuario/orca/projects/knowledge-brain/punk-records';

/**
 * Lê o `.env` da raiz do repositório, se existir. É onde o instalador grava a
 * `GEMINI_API_KEY` e o caminho do vault do sócio.
 *
 * Variável que já veio do shell ganha do arquivo: quem exportou no terminal quis
 * sobrepor, e o `.env` não pode desfazer isso pelas costas.
 */
export function carregarEnv(caminho = join(RAIZ_REPO, '.env')) {
  if (!existsSync(caminho)) return false;
  const jaDefinidas = new Set(Object.keys(process.env));
  const antes = { ...process.env };
  try {
    process.loadEnvFile(caminho);
  } catch (e) {
    // `.env` malformado não pode derrubar a captura do WhatsApp, que é a única coisa
    // desse sistema que perde dado quando para.
    console.error(`aviso: .env ignorado (${e?.message ?? e})`);
    return false;
  }
  desfazerBom();
  for (const chave of jaDefinidas) process.env[chave] = antes[chave];
  return true;
}

/**
 * Arquivo salvo como "UTF-8" pelo Bloco de Notas ou por `Set-Content -Encoding utf8` do
 * PowerShell 5.1 começa com BOM. O leitor de `.env` do Node não descarta esses três
 * bytes: a primeira chave vira literalmente `﻿GEMINI_API_KEY`, e quem procura por
 * `GEMINI_API_KEY` recebe `undefined` — a chave some sem nenhum erro aparecer.
 *
 * Medido em 12/09/2026 nesta máquina. O instalador já grava sem BOM; isto cobre o
 * arquivo que a pessoa editar depois, à mão.
 */
function desfazerBom() {
  for (const chave of Object.keys(process.env)) {
    if (!chave.startsWith('﻿')) continue;
    const limpa = chave.slice(1);
    if (process.env[limpa] === undefined) process.env[limpa] = process.env[chave];
    delete process.env[chave];
  }
}

export function raizDoRepo() {
  return RAIZ_REPO;
}

/** O padrão por usuário, usado quando ninguém declarou nada. */
export function vaultPadrao() {
  return join(homedir(), 'AssessorVault');
}

/**
 * Resolve o caminho do vault sem exigir que ele exista — serve ao instalador, que
 * precisa saber onde criar antes de existir. Para uso operacional, `vaultExigido()`.
 */
export function caminhoVault() {
  const declarado = (process.env.PUNK_RECORDS || process.env.PUNK_VAULT_DIR || '').trim();
  if (declarado) return resolve(declarado);
  if (existsSync(VAULT_HERDADO)) return VAULT_HERDADO;
  return vaultPadrao();
}

export class VaultAusente extends Error {}

/** Igual a `caminhoVault()`, mas falha alto se a pasta não existir. */
export function vaultExigido() {
  const caminho = caminhoVault();
  if (!existsSync(caminho) || !statSync(caminho).isDirectory()) {
    throw new VaultAusente(
      `vault nao encontrado em ${caminho}. ` +
      'Rode `node bin/criar-vault.js` para criar um vazio, ou aponte PUNK_RECORDS para o seu.'
    );
  }
  return caminho;
}

/**
 * O Python do vault, que roda os índices (`tools/embed.py`, `tools/index_heal.py`).
 * Fica dentro do próprio vault porque as dependências — sqlite-vec — são dele, não
 * deste repositório.
 */
export function pythonDoVault(vault = caminhoVault()) {
  const win = join(vault, '.venv', 'Scripts', 'python.exe');
  const unix = join(vault, '.venv', 'bin', 'python');
  if (existsSync(win)) return win;
  if (existsSync(unix)) return unix;
  return null;
}

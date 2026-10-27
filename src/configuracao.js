// Configuração gravável pelo painel, para que ninguém precise editar `.env` à mão.
//
// O motivo é medido no comportamento, não no gosto: o passo "vá em aistudio.google.com,
// crie uma API key e cole no terminal" é o maior ponto de desistência da instalação. Quem
// nunca abriu um console de desenvolvedor do Google não passa dali, e o pior é que a falha
// é silenciosa — a pessoa cola errado, nada acontece, e ela conclui que o programa não
// funciona.
//
// Aqui a chave é **testada antes de ser gravada**. Se ela não responde, o painel diz o
// motivo na hora; só chave que funcionou entra no arquivo. É a diferença entre "salvo" e
// "funcionando", e essa diferença é o suporte que ninguém vai poder dar.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { raizDoRepo } from './ambiente.js';
import { listarModelos, escolherModelo } from './llm.js';

const CHAVES_PERMITIDAS = new Set(['GEMINI_API_KEY', 'ASSESSOR_DONO', 'ASSESSOR_MODELO']);

export function caminhoEnv() {
  return join(raizDoRepo(), '.env');
}

/**
 * Lê o `.env` como pares. Não usa `process.loadEnvFile` de propósito: aqui queremos o
 * conteúdo do arquivo para reescrever, não mexer no ambiente do processo.
 */
export function lerEnv(caminho = caminhoEnv()) {
  if (!existsSync(caminho)) return { linhas: [], valores: {} };
  // O BOM entra quando alguém salva no Bloco de Notas; sem tirar, a primeira chave do
  // arquivo vira `﻿GEMINI_API_KEY` e desaparece sem erro.
  const texto = readFileSync(caminho, 'utf8').replace(/^﻿/, '');
  const linhas = texto.split(/\r?\n/);
  const valores = {};
  for (const linha of linhas) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(linha);
    if (m) valores[m[1]] = m[2].trim();
  }
  return { linhas, valores };
}

/**
 * Grava chaves no `.env` preservando comentários e ordem, e **sem BOM**.
 * Só aceita as chaves de `CHAVES_PERMITIDAS`: o painel escreve configuração, não
 * qualquer variável de ambiente que chegar pelo corpo de um POST.
 */
export function gravarEnv(novos, caminho = caminhoEnv()) {
  for (const chave of Object.keys(novos)) {
    if (!CHAVES_PERMITIDAS.has(chave)) throw new TypeError(`chave nao permitida: ${chave}`);
    const valor = String(novos[chave] ?? '');
    // Valor com quebra de linha viraria uma linha solta no arquivo e corromperia o que
    // vem depois. Vale para o nome que a pessoa digita, não só para a chave.
    if (/[\r\n]/.test(valor)) throw new TypeError(`valor de ${chave} nao pode ter quebra de linha`);
  }

  const { linhas } = lerEnv(caminho);
  const pendentes = { ...novos };
  const saida = linhas.map(linha => {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=/.exec(linha);
    if (m && m[1] in pendentes) {
      const valor = pendentes[m[1]];
      delete pendentes[m[1]];
      return `${m[1]}=${valor}`;
    }
    return linha;
  });
  for (const [chave, valor] of Object.entries(pendentes)) saida.push(`${chave}=${valor}`);

  if (existsSync(caminho)) copyFileSync(caminho, `${caminho}.bak`);
  // Sem BOM, de propósito. Ver `src/ambiente.js`.
  writeFileSync(caminho, saida.join('\r\n').replace(/(\r\n)+$/, '') + '\r\n', 'utf8');
  return true;
}

/**
 * Testa uma chave contra a API de verdade e devolve o que ela enxerga.
 * Não grava nada — quem grava é quem chamou, depois de ver que funcionou.
 */
export async function testarChave(chave) {
  const limpa = String(chave ?? '').trim();
  if (!limpa) return { ok: false, erro: 'Cole a chave antes de testar.' };
  // O formato do Google começa com `AIza`. Conferir aqui evita uma ida à rede só para
  // descobrir que a pessoa colou a URL da página em vez da chave.
  if (!/^AIza[\w-]{30,}$/.test(limpa)) {
    return { ok: false, erro: 'Isso não parece uma chave do Gemini. Ela começa com "AIza" e não tem espaços.' };
  }

  const antes = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = limpa;
  try {
    const modelos = await listarModelos();
    const modelo = escolherModelo(modelos);
    if (!modelo) {
      return { ok: false, erro: `A chave funciona, mas não dá acesso a nenhum modelo utilizável (${modelos.length} disponíveis).` };
    }
    return { ok: true, modelo, quantosModelos: modelos.length };
  } catch (e) {
    return { ok: false, erro: String(e?.message ?? e).slice(0, 220) };
  } finally {
    if (antes === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = antes;
  }
}

/** O que o painel precisa saber para decidir se mostra o assistente de configuração. */
export function estadoConfig() {
  const { valores } = lerEnv();
  const chave = (process.env.GEMINI_API_KEY || valores.GEMINI_API_KEY || '').trim();
  return {
    temChave: Boolean(chave),
    finalDaChave: chave ? chave.slice(-6) : null,
    dono: (process.env.ASSESSOR_DONO || valores.ASSESSOR_DONO || '').trim() || null,
    // Sem chave o app captura e busca normalmente; o que fica de fora é a leitura das
    // conversas pelo modelo. A tela precisa dizer isso, em vez de parecer quebrada.
    semChaveFunciona: 'captura de mensagens e busca',
    semChaveNaoFunciona: 'extração de pendências e leads, e transcrição de áudio'
  };
}

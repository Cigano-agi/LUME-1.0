#!/usr/bin/env node
// Reconstrói as duas buscas do Punk Records depois que material novo entrou:
// a textual sobre o WhatsApp e a semântica sobre as notas.
//
//   npm run indexar
//
// As duas são incrementais, então rodar de novo é barato. A semântica precisa do
// Ollama servindo com bge-m3; se ele não estiver de pé, o passo é pulado com aviso
// em vez de derrubar a cadeia — a busca textual sozinha já responde a maior parte.

import { spawnSync } from 'node:child_process';
import { carregarEnv, vaultExigido, pythonDoVault } from '../src/ambiente.js';

carregarEnv();

const VAULT = vaultExigido();
const PY = pythonDoVault(VAULT);

if (!PY) {
  console.error(`Python do vault não encontrado em ${VAULT}/.venv`);
  console.error('Recrie com: py -3.12 -m venv .venv && .venv/Scripts/python -m pip install sqlite-vec requests "mcp<2"');
  console.error('Ou rode o instalador de novo: powershell -ExecutionPolicy Bypass -File instalar.ps1');
  process.exit(1);
}

function rodar(rotulo, args, { obrigatorio = true, env = {} } = {}) {
  process.stdout.write(`${rotulo} ... `);
  const r = spawnSync(PY, args, {
    cwd: VAULT, encoding: 'utf-8', windowsHide: true,
    env: { ...process.env, ...env }
  });
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').pop() ?? '';
  if (r.status === 0) { console.log(saida.slice(0, 160) || 'ok'); return true; }
  console.log(`FALHOU: ${saida.slice(0, 200)}`);
  if (obrigatorio) process.exitCode = 1;
  return false;
}

rodar('busca textual do WhatsApp', ['tools/whatsapp_index.py']);
rodar('índices do vault (append-only)', ['tools/index_heal.py']);

// raw/notion fica de fora: são 39 dos 44 MB do corpus e o menor retorno por token de GPU.
rodar('busca semântica (Ollama + bge-m3)', ['tools/embed.py'],
  { obrigatorio: false, env: { BRAIN_INDEX_DIRS: 'wiki,Timeline' } });

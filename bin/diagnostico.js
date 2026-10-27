#!/usr/bin/env node
// Diz o que está de pé e o que não está, com o comando exato para consertar cada coisa.
//
//   node bin/diagnostico.js
//   node bin/diagnostico.js --json    # para o instalador consumir
//
// Existe porque a caixa vai rodar numa máquina que ninguém daqui consegue olhar. Quando
// o sócio disser "não funcionou", a resposta não pode depender de adivinhação: ele roda
// isto, manda a saída, e a causa está escrita.
//
// A separação importa: **bloqueio** impede o sistema de funcionar, **aviso** degrada uma
// funcionalidade. Sem chave do Gemini nada de CRM acontece — bloqueio. Sem Ollama a busca
// semântica não roda, mas a textual responde a maior parte — aviso. O código de saída só
// é diferente de zero quando há bloqueio.

import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { carregarEnv, caminhoVault, pythonDoVault, raizDoRepo } from '../src/ambiente.js';
import { motorAtivo, chaveApi, listarModelos, escolherModelo } from '../src/llm.js';

const usouEnv = carregarEnv();
const comoJson = process.argv.includes('--json');
const itens = [];

/** estado: 'ok' | 'aviso' | 'bloqueio' */
function anotar(nome, estado, detalhe, conserto = null) {
  itens.push({ nome, estado, detalhe, conserto });
}

// --------------------------------------------------------------------------- runtime

const maior = Number(process.versions.node.split('.')[0]);
maior >= 24
  ? anotar('Node.js', 'ok', `v${process.versions.node}`)
  : anotar('Node.js', 'bloqueio', `v${process.versions.node}, o app exige 24+`,
      'winget install OpenJS.NodeJS.LTS');

anotar('.env', usouEnv ? 'ok' : 'aviso',
  usouEnv ? join(raizDoRepo(), '.env') : 'nao encontrado; valendo so o que veio do shell',
  usouEnv ? null : 'copie .env.exemplo para .env');

// ----------------------------------------------------------------------------- modelo

const motor = motorAtivo();
if (motor === 'api') {
  const chave = chaveApi();
  anotar('Motor de modelo', 'ok', `API do Gemini, chave ...${chave.slice(-6)}`);
  try {
    const modelos = await listarModelos();
    const escolhido = escolherModelo(modelos);
    escolhido
      ? anotar('Modelo', 'ok', `${escolhido} (${modelos.length} disponiveis para esta chave)`)
      : anotar('Modelo', 'bloqueio', `a chave enxerga ${modelos.length} modelos, nenhum flash`,
          'confira o projeto da chave em https://aistudio.google.com/apikey');
  } catch (e) {
    // Chave inválida e cota estourada são erros diferentes e a mensagem já distingue.
    anotar('Modelo', 'bloqueio', String(e.message).slice(0, 160),
      'gere outra chave em https://aistudio.google.com/apikey');
  }
} else {
  const agy = spawnSync(process.platform === 'win32' ? 'agy.exe' : 'agy', ['--version'],
    { encoding: 'utf-8', windowsHide: true, timeout: 15000 });
  agy.status === 0
    ? anotar('Motor de modelo', 'ok', `agy (CLI do Orca) ${String(agy.stdout ?? '').trim().slice(0, 40)}`)
    : anotar('Motor de modelo', 'bloqueio', 'sem GEMINI_API_KEY e sem agy no PATH',
        'crie a chave em https://aistudio.google.com/apikey e ponha em .env');
}

// ------------------------------------------------------------------------------ vault

const vault = caminhoVault();
if (existsSync(vault) && statSync(vault).isDirectory()) {
  anotar('Vault', 'ok', vault);
  const py = pythonDoVault(vault);
  if (py) {
    const r = spawnSync(py, ['-c', 'import sqlite_vec, requests; print("ok")'],
      { encoding: 'utf-8', windowsHide: true, timeout: 30000 });
    r.status === 0
      ? anotar('Python do vault', 'ok', py)
      : anotar('Python do vault', 'aviso', `venv existe mas falta dependencia: ${String(r.stderr ?? '').trim().slice(0, 120)}`,
          `"${py}" -m pip install sqlite-vec requests "mcp<2"`);
  } else {
    anotar('Python do vault', 'aviso', `sem .venv em ${vault}`,
      'rode o instalador de novo, ou: py -3.12 -m venv .venv (dentro do vault)');
  }
} else {
  anotar('Vault', 'bloqueio', `nao existe: ${vault}`, 'node bin/criar-vault.js');
}

// ----------------------------------------------------------------------------- Ollama

const hostOllama = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
const modeloEmbed = process.env.BRAIN_EMBED_MODEL || 'bge-m3';
try {
  const r = await fetch(`${hostOllama}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const nomes = ((await r.json())?.models ?? []).map(m => String(m.name ?? ''));
  nomes.some(n => n.startsWith(modeloEmbed))
    ? anotar('Busca semantica', 'ok', `Ollama de pe com ${modeloEmbed}`)
    : anotar('Busca semantica', 'aviso', `Ollama de pe, mas sem ${modeloEmbed} (tem: ${nomes.slice(0, 3).join(', ') || 'nenhum'})`,
        `ollama pull ${modeloEmbed}`);
} catch {
  // Aviso, não bloqueio: sem semântica a busca textual sozinha ainda responde.
  anotar('Busca semantica', 'aviso', `Ollama nao responde em ${hostOllama}; so a busca textual vai funcionar`,
    'abra o Ollama, ou: winget install Ollama.Ollama');
}

// ------------------------------------------------------------------------------ dados

const dados = process.env.ASSESSOR_DATA_DIR || join(raizDoRepo(), 'data');
const banco = join(dados, 'assessor.db');
if (existsSync(banco)) {
  const mb = (statSync(banco).size / 1048576).toFixed(0);
  let quantos = '';
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(banco, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM eventos').get()?.n ?? 0;
    db.close();
    quantos = `, ${Number(n).toLocaleString('pt-BR')} eventos`;
  } catch { /* banco novo ainda sem a tabela: o tamanho ja diz o suficiente */ }
  anotar('Banco', 'ok', `${banco} (${mb} MB${quantos})`);
} else {
  anotar('Banco', 'aviso', 'ainda nao existe; nasce no primeiro pareamento do WhatsApp');
}

const sessao = join(dados, 'wa-auth');
anotar('Sessao WhatsApp', existsSync(sessao) ? 'ok' : 'aviso',
  existsSync(sessao) ? 'pareada' : 'nao pareada',
  existsSync(sessao) ? null : 'npm start e escaneie o QR em Aparelhos conectados');

// ------------------------------------------------------------------------------ porta

const porta = Number(process.env.ASSESSOR_PORT || 8787);
const livre = await new Promise(ok => {
  const s = createServer();
  s.once('error', () => ok(false));
  s.once('listening', () => s.close(() => ok(true)));
  s.listen(porta, '127.0.0.1');
});
// Porta ocupada normalmente significa que o próprio app já está rodando — o que é bom.
anotar('Porta', 'ok', livre ? `${porta} livre` : `${porta} em uso (o app provavelmente ja esta de pe)`);

// ------------------------------------------------------------------------------ saida

const bloqueios = itens.filter(i => i.estado === 'bloqueio');
const avisos = itens.filter(i => i.estado === 'aviso');

if (comoJson) {
  console.log(JSON.stringify({ itens, bloqueios: bloqueios.length, avisos: avisos.length }, null, 2));
} else {
  const simbolo = { ok: 'OK   ', aviso: 'AVISO', bloqueio: 'FALHA' };
  const largura = Math.max(...itens.map(i => i.nome.length));
  console.log('\nDIAGNOSTICO DO ASSESSOR\n');
  for (const i of itens) {
    console.log(`  ${simbolo[i.estado]}  ${i.nome.padEnd(largura)}  ${i.detalhe}`);
    if (i.conserto && i.estado !== 'ok') console.log(`  ${' '.repeat(7 + largura)}  -> ${i.conserto}`);
  }
  console.log('');
  if (bloqueios.length) {
    console.log(`${bloqueios.length} bloqueio(s): o sistema nao vai funcionar ate resolver.`);
  } else if (avisos.length) {
    console.log(`Sem bloqueio. ${avisos.length} aviso(s): funciona, com funcionalidade reduzida.`);
  } else {
    console.log('Tudo de pe.');
  }
}

process.exit(bloqueios.length ? 1 : 0);

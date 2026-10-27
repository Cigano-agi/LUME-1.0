#!/usr/bin/env node
// Fase 1 do frescor: fecha o que ja morreu, sem chamar modelo nenhum.
//
//   node bin/frescor.js --dry           # mostra a conta, nao grava
//   node bin/frescor.js                 # aplica
//   node bin/frescor.js --dias 45       # meia-vida mais longa (padrao 30)
//
// `--dias` e knob de calibragem, nao constante: a meia-vida de uma promessa de
// WhatsApp muda com quem conversa. Meca antes de mudar -- `--dry` imprime a conta.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirBanco } from '../src/banco.js';
import { prepararEsquemaCrm } from '../src/crm.js';
import { avaliar, aplicar, DIAS_PADRAO, HORAS_RESPOSTA } from '../src/frescor.js';

import { carregarEnv } from '../src/ambiente.js';

// O .env traz GEMINI_API_KEY, PUNK_RECORDS e ASSESSOR_DONO, escritos pelo
// instalador. Sem carregar aqui, a caixa do socio roda com o ambiente vazio.
carregarEnv();

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dados = resolve(process.env.ASSESSOR_DATA_DIR || resolve(raiz, 'data'));
const arg = (nome, padrao) => { const i = process.argv.indexOf(`--${nome}`); return i >= 0 ? (process.argv[i + 1] ?? padrao) : padrao; };
const seco = process.argv.includes('--dry');
const dias = Number(arg('dias', DIAS_PADRAO));
if (!Number.isFinite(dias) || dias <= 0) { console.error('--dias precisa ser um numero maior que zero'); process.exit(2); }

const db = abrirBanco(resolve(dados, 'assessor.db'));
prepararEsquemaCrm(db);

const { abertos, decisoes, restantes } = avaliar(db, { dias, horas: HORAS_RESPOSTA });
const porEstado = decisoes.reduce((a, d) => (a[d.estado] = (a[d.estado] || 0) + 1, a), {});

console.log(`abertos antes ......... ${abertos.length}`);
console.log(`resolvido (respondido)  ${porEstado.resolvido || 0}   pendencia em DM respondida em ate ${HORAS_RESPOSTA}h`);
console.log(`expirado (envelheceu) . ${porEstado.expirado || 0}   origem com mais de ${dias} dias`);
console.log(`abertos depois ........ ${restantes}`);

const sobra = abertos.filter(i => !decisoes.some(d => d.id === i.id));
console.log(`\nos 5 mais novos que ficam abertos:`);
for (const i of sobra.sort((a, b) => Date.parse(b.quando) - Date.parse(a.quando)).slice(0, 5)) {
  const d = Math.floor((Date.now() - Date.parse(i.quando)) / 86400000);
  console.log(`  ${String(d).padStart(3)}d · ${i.tipo.padEnd(11)} · ${i.conversa_nome} · ${i.resumo.slice(0, 60)}`);
}

if (seco) { console.log('\n--dry: nada gravado.'); process.exit(0); }
const mudados = aplicar(db, decisoes);
console.log(`\n${mudados} itens saíram de "aberto". Reabra qualquer um em Pendências se a conversa disser o contrário.`);

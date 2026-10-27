#!/usr/bin/env node
// Gera o backlog diário a partir dos itens abertos do CRM.
//
//   node bin/backlog.js                      # escreve em data/BACKLOG.md
//   node bin/backlog.js --saida C:/.../BACKLOG.md
//   node bin/backlog.js --dry                # imprime na tela, não grava
//
// Abre o banco somente leitura: o coletor está escrevendo no mesmo arquivo e é
// supervisionado pela tarefa "Assessor 2.0 - Vigia".

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { carregarEnv } from '../src/ambiente.js';
import { mapaDeNomes } from '../src/crm.js';
import { montarBacklog, renderizarMarkdown } from '../src/backlog.js';
import { diaLocal, FUSO } from '../src/relogio.js';

carregarEnv();

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dados = resolve(process.env.ASSESSOR_DATA_DIR || resolve(raiz, 'data'));

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : padrao;
};
const seco = process.argv.includes('--dry');

// Onde o arquivo cai, em ordem de precedência: --saida > ASSESSOR_BACKLOG_SAIDA > data/.
// O padrão fica dentro do repo de propósito: a caixa de um sócio não pode escrever num
// caminho da máquina de outra pessoa. Quem quer o arquivo em outro lugar declara no .env,
// que é justamente o arquivo específico da máquina.
const saida = resolve(
  String(arg('saida', process.env.ASSESSOR_BACKLOG_SAIDA || resolve(dados, 'BACKLOG.md'))),
);

const db = new DatabaseSync(resolve(dados, 'assessor.db'), { readOnly: true });

let itens = [];
try {
  itens = db.prepare("SELECT * FROM itens_crm WHERE estado = 'aberto'").all();
} catch (erro) {
  console.error('Sem tabela itens_crm. Rode `npm run crm` primeiro.');
  console.error(erro.message);
  process.exit(1);
}

let ultimaExtracao = null;
try {
  const r = db.prepare('SELECT max(executado_em) AS m FROM crm_execucoes').get();
  if (r?.m) {
    ultimaExtracao = new Date(r.m).toLocaleString('pt-BR', { timeZone: FUSO });
  }
} catch {
  // Banco anterior a `crm_execucoes`: seguimos sem o aviso de frescor em vez de falhar.
}

const backlog = montarBacklog(itens, {
  agora: new Date(),
  dono: process.env.ASSESSOR_DONO || null,
  mapa: mapaDeNomes(db),
});

const md = renderizarMarkdown(backlog, { dia: diaLocal(), ultimaExtracao });

if (seco) {
  console.log(md);
  process.exit(0);
}

mkdirSync(dirname(saida), { recursive: true });
writeFileSync(saida, md, 'utf8');

const b = backlog.baldes;
console.log(`backlog escrito em ${saida}`);
console.log(
  `  ${backlog.total} itens | caixa ${b.caixa.length} | meus ${b.meu.length} | ` +
    `de terceiro ${b.terceiro.length} | leads ${b.lead.length} | ` +
    `decisoes ${b.decisao.length} | sem dono ${b.indefinido.length}`,
);
if (ultimaExtracao) console.log(`  ultima extracao de CRM: ${ultimaExtracao}`);

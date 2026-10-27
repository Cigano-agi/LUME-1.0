#!/usr/bin/env node
// Cópia de segurança do banco de mensagens, conferida antes de ser dada como boa.
//
//   node bin/backup.js              # copia, confere e roda a rotacao
//   node bin/backup.js --dry        # so mostra o que faria
//   node bin/backup.js --listar     # mostra as copias que existem
//   node bin/backup.js --destino D:/backups
//
// Por que existe: o banco tem 290 mil mensagens e ~940 MB, e `docs/16-RETOMAR.md` lista
// "sem backup" como falha irreversivel 🔴. Mensagem de WhatsApp que se perde nao volta:
// o historico so e entregue uma vez, no pareamento.
//
// Por que `VACUUM INTO` e nao copiar o arquivo: o app esta escrevendo o tempo todo e o
// banco roda em WAL. Copiar o `.db` com `cp` pega um arquivo sem as paginas que ainda
// estao no `-wal`, e o resultado e um banco corrompido que so da erro no dia em que for
// preciso. `VACUUM INTO` produz uma copia consistente com o app rodando, num arquivo so.
//
// A conferencia nao e opcional: a copia e reaberta e as linhas sao contadas. Backup que
// nunca foi restaurado nao e backup, e uma pasta que da paz de espirito falsa.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { carregarEnv, raizDoRepo } from '../src/ambiente.js';

carregarEnv();

const flag = n => process.argv.includes(`--${n}`);
const arg = (n, p) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : p; };

const seco = flag('dry');
const dados = process.env.ASSESSOR_DATA_DIR || join(raizDoRepo(), 'data');
const origem = resolve(arg('banco', join(dados, 'assessor.db')));

// Fora da pasta do projeto de proposito: backup dentro do que se quer proteger some
// junto quando alguem apaga a pasta ou o git limpa o diretorio.
const destino = resolve(arg('destino', process.env.ASSESSOR_BACKUP_DIR || join(homedir(), 'Backups', 'assessor')));
const manter = Number(arg('manter', 3));

const tamanho = c => `${(statSync(c).size / 1048576).toFixed(0)} MB`;

function copiasExistentes() {
  if (!existsSync(destino)) return [];
  return readdirSync(destino)
    .filter(n => /^assessor-\d{8}-\d{6}\.db$/.test(n))
    .map(n => ({ nome: n, caminho: join(destino, n), em: statSync(join(destino, n)).mtime }))
    .sort((a, b) => b.em - a.em);
}

if (flag('listar')) {
  const copias = copiasExistentes();
  if (!copias.length) { console.log(`nenhuma copia em ${destino}`); process.exit(0); }
  console.log(`copias em ${destino}:\n`);
  for (const c of copias) {
    console.log(`  ${c.nome}  ${tamanho(c.caminho).padStart(8)}  ${c.em.toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  process.exit(0);
}

if (!existsSync(origem)) {
  console.error(`banco nao encontrado: ${origem}`);
  process.exit(1);
}

// Contar na origem ANTES de copiar. E este numero que a copia precisa reproduzir.
const vivo = new DatabaseSync(origem, { readOnly: true });
const eventosVivos = vivo.prepare('SELECT COUNT(*) AS n FROM eventos').get().n;
vivo.close();

const carimbo = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const alvo = join(destino, `assessor-${carimbo}.db`);

console.log(`origem : ${origem} (${tamanho(origem)}, ${eventosVivos.toLocaleString('pt-BR')} eventos)`);
console.log(`destino: ${alvo}`);

if (seco) {
  console.log(`\nSimulacao. Manteria as ${manter} copias mais recentes.`);
  const copias = copiasExistentes();
  for (const c of copias.slice(manter)) console.log(`  apagaria ${c.nome}`);
  process.exit(0);
}

mkdirSync(destino, { recursive: true });

const t0 = Date.now();
process.stdout.write('copiando (VACUUM INTO, o app pode continuar rodando) ... ');
const db = new DatabaseSync(origem, { readOnly: true });
try {
  // O caminho vai literal no SQL, entao aspas simples dentro dele sao duplicadas.
  db.exec(`VACUUM INTO '${alvo.replaceAll("'", "''")}'`);
} catch (e) {
  console.log('FALHOU');
  console.error(`  ${e.message}`);
  process.exit(1);
} finally {
  db.close();
}
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s, ${tamanho(alvo)}`);

// ------------------------------------------------------------------- a conferencia

process.stdout.write('conferindo (reabrindo a copia e contando) ... ');
let eventosCopia;
try {
  const copia = new DatabaseSync(alvo, { readOnly: true });
  eventosCopia = copia.prepare('SELECT COUNT(*) AS n FROM eventos').get().n;
  // `integrity_check` pega corrupcao de pagina que a contagem sozinha nao veria.
  const integridade = copia.prepare('PRAGMA integrity_check').get();
  copia.close();
  const veredito = Object.values(integridade)[0];
  if (veredito !== 'ok') throw new Error(`integrity_check devolveu: ${veredito}`);
} catch (e) {
  console.log('FALHOU');
  console.error(`  a copia nao abre ou esta corrompida: ${e.message}`);
  console.error(`  a copia ruim foi mantida em ${alvo} para exame.`);
  process.exit(1);
}

// A copia pode ter MAIS eventos que a contagem inicial: o app segue ingerindo durante o
// VACUUM. Menos, nunca -- isso seria perda.
if (eventosCopia < eventosVivos) {
  console.log('FALHOU');
  console.error(`  a copia tem ${eventosCopia} eventos, menos que os ${eventosVivos} do banco vivo.`);
  process.exit(1);
}
console.log(`ok — ${eventosCopia.toLocaleString('pt-BR')} eventos, integridade ok`);

// ---------------------------------------------------------------------- rotacao

const copias = copiasExistentes();
for (const c of copias.slice(manter)) {
  unlinkSync(c.caminho);
  console.log(`removida copia antiga: ${c.nome}`);
}

console.log(`\nPronto. ${Math.min(copias.length, manter)} copia(s) guardada(s) em ${destino}`);
console.log('Para restaurar: pare o app, e copie a copia por cima de data/assessor.db');
console.log(`  copy "${alvo}" "${origem}"`);

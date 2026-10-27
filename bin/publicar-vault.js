#!/usr/bin/env node
// Publica no Punk Records o que foi extraído das conversas, no formato que o Obsidian
// entende: uma nota por conversa em wiki/synthesis/whatsapp/, com wikilinks para as
// entidades citadas e a data de cada evento na Timeline do ano certo.
//
//   node bin/publicar-vault.js --dry              # mostra o que escreveria
//   node bin/publicar-vault.js                    # escreve
//   node bin/publicar-vault.js --conversa WAVES   # só uma
//
// Regras do vault respeitadas (punk-records/CLAUDE.md):
// - _INDEX.md e _SUMMARIES.md são append-only: quem cuida deles é tools/index_heal.py.
// - Nunca dois anos no mesmo arquivo de Timeline.
// - Nunca fabricar data: item sem data vai para a seção de indeterminados, não some.
// - Blocos gerenciados por marcador, como notion_ingest.py já faz, para que reescrever
//   a nota não apague prosa que um humano ou outro modelo escreveu nela.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { abrirBanco } from '../src/banco.js';
import { injetarBloco, agruparPorMes, slugVault as slug } from '../src/vault.js';
import { mapaDeNomes, nomeDe } from '../src/crm.js';
import { carregarEnv, vaultExigido } from '../src/ambiente.js';

carregarEnv();

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dados = resolve(process.env.ASSESSOR_DATA_DIR || resolve(raiz, 'data'));
// Sem caminho declarado o vault e o padrao por usuario, e a pasta precisa existir:
// destino ausente e ERRO, nunca "pulado com sucesso" (achado A04 da auditoria).
const VAULT = vaultExigido();

const flag = n => process.argv.includes(`--${n}`);
const arg = (n, p) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : p; };
const seco = flag('dry');
const alvo = arg('conversa', null);

const ICONE = { compromisso: '🤝', pendencia: '⏳', lead: '💰', decisao: '📌' };
const hoje = new Date().toISOString().slice(0, 10);

const db = abrirBanco(resolve(dados, 'assessor.db'));
// Itens extraidos antes desta correcao guardam o @lid cru no responsavel; resolver
// aqui evita reprocessar conversa inteira so para trocar um rotulo.
const nomes = mapaDeNomes(db);

// Índice de entidades do vault, para transformar nome citado em wikilink de verdade.
const entidades = new Map();
for (const tipo of ['people', 'companies', 'projects']) {
  const dir = resolve(VAULT, 'wiki/entities', tipo);
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    const stem = f.replace(/\.md$/, '');
    const bruto = readFileSync(resolve(dir, f), 'utf-8').slice(0, 1200);
    const titulo = (bruto.match(/^title:\s*"?(.+?)"?\s*$/m) || [])[1] || stem;
    entidades.set(slug(titulo), { rel: `wiki/entities/${tipo}/${stem}`, titulo });
    entidades.set(slug(stem), { rel: `wiki/entities/${tipo}/${stem}`, titulo });
    const aliases = (bruto.match(/^aliases:\s*\[(.+?)\]\s*$/m) || [])[1];
    if (aliases) for (const a of aliases.split(',')) {
      const s = slug(a.replace(/["']/g, ''));
      if (s && !entidades.has(s)) entidades.set(s, { rel: `wiki/entities/${tipo}/${stem}`, titulo });
    }
  }
}

let conversas = db.prepare(`
  SELECT i.conversa_id, COALESCE(g.nome, c.nome, i.conversa_id) nome, COUNT(*) itens
  FROM itens_crm i
  LEFT JOIN grupos_app g ON g.id = i.conversa_id
  LEFT JOIN conversas_app c ON c.id = i.conversa_id
  WHERE i.estado <> 'descartado'
  GROUP BY i.conversa_id ORDER BY itens DESC
`).all();
if (alvo) conversas = conversas.filter(c => c.nome.toLowerCase().includes(String(alvo).toLowerCase()) || c.conversa_id === alvo);

if (!conversas.length) { console.log('Nada extraído ainda. Rode bin/crm.js antes.'); process.exit(0); }

console.log(`${conversas.length} conversa(s)${seco ? ' · DRY RUN' : ''}\n`);

const eventosTimeline = [];   // { ano, data, linha }
let notasEscritas = 0;

for (const conv of conversas) {
  const itens = db.prepare(`
    SELECT tipo, resumo, responsavel, quando, origem_id, estado
    FROM itens_crm WHERE conversa_id = ? AND estado <> 'descartado'
    ORDER BY quando
  `).all(conv.conversa_id);

  const periodo = db.prepare(`
    SELECT MIN(recebido_em) p, MAX(recebido_em) u, COUNT(*) n
    FROM eventos WHERE conversa_id = ? AND texto IS NOT NULL AND texto <> ''
  `).get(conv.conversa_id);

  // Quem citou o quê: os autores da conversa que existem como entidade no vault.
  const citadas = new Set();
  for (const i of itens) {
    if (!i.responsavel) continue;
    const e = entidades.get(slug(nomeDe(i.responsavel, nomes)));
    if (e) citadas.add(`[[${e.rel}|${e.titulo}]]`);
  }

  const porTipo = {};
  for (const i of itens) (porTipo[i.tipo] ||= []).push(i);

  const secoes = [];
  for (const tipo of ['pendencia', 'compromisso', 'lead', 'decisao']) {
    const lista = porTipo[tipo];
    if (!lista?.length) continue;
    const linhas = lista.map(i => {
      const data = i.quando ? i.quando.slice(0, 10) : 'sem data';
      const quem = i.responsavel ? ` — ${nomeDe(i.responsavel, nomes)}` : '';
      const marca = i.estado === 'resolvido' ? ' ✅' : '';
      return `- **${data}**${quem}: ${i.resumo}${marca} <sup>\`${i.origem_id}\`</sup>`;
    });
    secoes.push(`### ${ICONE[tipo]} ${tipo}${lista.length > 1 ? 's' : ''} (${lista.length})\n\n${linhas.join('\n')}`);
  }

  const bloco = [
    `> ${itens.length} itens extraídos de ${periodo.n} mensagens, de ${periodo.p?.slice(0, 10)} a ${periodo.u?.slice(0, 10)}.`,
    `> Cada item cita em \`código\` o id da mensagem que o originou — consultável por \`whatsapp_search\`.`,
    '',
    ...secoes,
    '',
    citadas.size ? `### Entidades citadas\n\n${[...citadas].map(c => `- ${c}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');

  const nomeArq = slug(conv.nome) || slug(conv.conversa_id);
  const destino = resolve(VAULT, 'wiki/synthesis/whatsapp', `${nomeArq}.md`);

  let conteudo;
  if (existsSync(destino)) {
    conteudo = readFileSync(destino, 'utf-8').replace(/^updated:.*$/m, `updated: ${hoje}`);
  } else {
    conteudo = `---
title: "WhatsApp — ${conv.nome}"
type: synthesis
tags: [whatsapp, conversa, crm, eventos]
sources: [assessor-2.0/data/assessor.db]
year: ${(periodo.u || hoje).slice(0, 4)}
created: ${hoje}
updated: ${hoje}
---

# WhatsApp — ${conv.nome}

## Related

- [[wiki/entities/projects/whatsapp-brain]] — o sistema que captura estas conversas
`;
  }
  conteudo = injetarBloco(conteudo, 'WHATSAPP-CRM', bloco);

  console.log(`- ${conv.nome}: ${itens.length} itens -> wiki/synthesis/whatsapp/${nomeArq}.md`);
  if (!seco) {
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, conteudo, 'utf-8');
    notasEscritas++;
  }

  // Timeline: só itens com data real. Sem data não vira evento datado — vai na nota.
  for (const i of itens) {
    if (!i.quando) continue;
    const data = i.quando.slice(0, 10);
    eventosTimeline.push({
      ano: data.slice(0, 4),
      mes: data.slice(0, 7),
      data,
      linha: `- **${data}** · [[wiki/synthesis/whatsapp/${nomeArq}|${conv.nome}]] ${ICONE[i.tipo]} ${i.resumo}`
    });
  }
}

// Um arquivo por mês, e o ano do arquivo é o ano do evento — nunca misturar.
const porMes = agruparPorMes(eventosTimeline);

for (const [mes, eventos] of Object.entries(porMes)) {
  const ano = mes.slice(0, 4);
  const destino = resolve(VAULT, 'Timeline', ano, `${mes}.md`);
  const bloco = eventos.sort((a, b) => a.data.localeCompare(b.data)).map(e => e.linha).join('\n');

  let conteudo;
  if (existsSync(destino)) {
    conteudo = readFileSync(destino, 'utf-8').replace(/^updated:.*$/m, `updated: ${hoje}`);
  } else {
    conteudo = `---
title: "Timeline ${mes}"
type: timeline
tags: [timeline, y${ano}, whatsapp]
year: ${ano}
month: ${mes}
created: ${hoje}
updated: ${hoje}
---

# Timeline · ${mes}

> Eventos datados de ${mes}.
`;
  }
  conteudo = injetarBloco(conteudo, 'WHATSAPP-EVENTOS',
    `#### Do WhatsApp\n\n${bloco}`);

  console.log(`- Timeline/${ano}/${mes}.md: ${eventos.length} evento(s)`);
  if (!seco) {
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, conteudo, 'utf-8');
  }
}

console.log(`\n${notasEscritas} nota(s) · ${eventosTimeline.length} evento(s) datado(s) em ${Object.keys(porMes).length} mês(es)`);
if (!seco) console.log('\nAgora rode no vault: .venv/Scripts/python.exe tools/index_heal.py');
db.close();

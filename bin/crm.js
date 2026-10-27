#!/usr/bin/env node
// Extração de itens acionáveis das conversas. Uma conversa por vez, sem paralelismo:
// o objetivo é conferir o resultado antes de soltar nas 300 restantes.
//
//   node bin/crm.js --lote 1 --dry          # mostra o que sairia, sem gravar
//   node bin/crm.js --conversa WAVES        # uma conversa por nome ou jid
//   node bin/crm.js --lote 10 --dm          # 10 conversas, só DM (onde ficam os leads)

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { abrirBanco } from '../src/banco.js';
import { carregarEnv } from '../src/ambiente.js';

// O .env traz GEMINI_API_KEY, PUNK_RECORDS e ASSESSOR_DONO, escritos pelo
// instalador. Sem carregar aqui, a caixa do socio roda com o ambiente vazio.
carregarEnv();

import {
  prepararEsquemaCrm, conversasParaExtrair, mensagensDaConversa,
  montarPrompt, chamarGemini, validarItens, gravarItens, registrarFalha, fatiarPorTamanho, mapaDeNomes
} from '../src/crm.js';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dados = resolve(process.env.ASSESSOR_DATA_DIR || resolve(raiz, 'data'));

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : padrao;
};
const flag = nome => process.argv.includes(`--${nome}`);

const seco = flag('dry');
const somenteDm = flag('dm');
const completo = flag('completo');
const lote = Number(arg('lote', 1));
const alvo = arg('conversa', null);
const dias = Number(arg('dias', 30));
const modelo = String(arg('modelo', 'gemini-3.8-flash-medium'));
const TENTATIVAS_POR_LOTE = 2;

const db = abrirBanco(resolve(dados, 'assessor.db'));
prepararEsquemaCrm(db);
const nomes = mapaDeNomes(db);

// O agy lê o schema de um arquivo; escrevemos num temporário para não sujar o repo.
const caminhoSchema = resolve(tmpdir(), 'assessor-crm-schema.json');
writeFileSync(caminhoSchema, JSON.stringify({
  type: 'object',
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['compromisso', 'pendencia', 'lead', 'decisao'] },
          resumo: { type: 'string' },
          responsavel: { type: 'string' },
          origem_id: { type: 'string' }
        },
        required: ['tipo', 'resumo', 'origem_id']
      }
    }
  },
  required: ['itens']
}, null, 2));

const desde = new Date(Date.now() - dias * 864e5).toISOString();

let conversas;
if (alvo) {
  conversas = db.prepare(`
    SELECT e.conversa_id, COALESCE(g.nome, c.nome, e.conversa_id) AS nome,
           COUNT(*) AS novas, MAX(e.id) AS ate_evento_id
    FROM eventos e
    LEFT JOIN grupos_app g ON g.id = e.conversa_id
    LEFT JOIN conversas_app c ON c.id = e.conversa_id
    WHERE e.texto IS NOT NULL AND e.texto <> '' AND e.recebido_em > ?
      AND (e.conversa_id = ? OR COALESCE(g.nome, c.nome) LIKE ?)
    GROUP BY e.conversa_id ORDER BY novas DESC LIMIT ?
  `).all(desde, alvo, `%${alvo}%`, lote);
} else {
  conversas = conversasParaExtrair(db, { desde, limite: lote, somenteDm });
}

if (!conversas.length) {
  console.log('Nenhuma conversa com mensagem nova no período.');
  process.exit(0);
}

console.log(`${conversas.length} conversa(s) · janela de ${dias} dias · modelo ${modelo}${seco ? ' · DRY RUN' : ''}\n`);

let totalItens = 0, totalRecusados = 0, tokens = 0;

for (const conversa of conversas) {
  // Sem --completo a extração só olha o que chegou depois da última passada. Isso é o
  // certo no dia a dia, mas deixa o passado invisível para sempre: uma vez que o
  // marcador avançou, mensagem antiga nunca mais é examinada.
  const ultimo = completo ? 0
    : (db.prepare('SELECT ultimo_evento_id FROM crm_execucoes WHERE conversa_id=?')
        .get(conversa.conversa_id)?.ultimo_evento_id ?? 0);
  const mensagens = mensagensDaConversa(db, conversa.conversa_id, {
    desdeEventoId: ultimo,
    limite: completo ? 100000 : 400
  });
  if (mensagens.length < 3) { console.log(`- ${conversa.nome}: poucas mensagens novas, pulando`); continue; }

  const fatias = fatiarPorTamanho(mensagens);
  console.log(`- ${conversa.nome} (${mensagens.length} msgs em ${fatias.length} lote(s))`);
  const aceitosDaConversa = [];
  let falhou = false;

  for (const [n, fatia] of fatias.entries()) {
    process.stdout.write(`    lote ${n + 1}/${fatias.length} (${fatia.length} msgs) ... `);
    // Um lote que falhava derrubava a conversa inteira. Como o marcador so avanca no
    // fim, a rodada seguinte recomecava do zero e batia no mesmo ponto: as 3 conversas
    // cortadas em 10/09 ficaram presas ate hoje, tentando e falhando no mesmo lugar.
    // Uma repetida cobre o corte transitorio sem abrir buraco de mensagem nao examinada.
    for (let tentativa = 1; ; tentativa++) {
      try {
        const { itens, uso } = await chamarGemini(montarPrompt(conversa.nome, fatia, nomes), { modelo, caminhoSchema });
        const { aceitos, recusados } = validarItens(itens, fatia);
        tokens += uso?.total_tokens ?? 0;
        totalRecusados += recusados.length;
        aceitosDaConversa.push(...aceitos);
        console.log(`${aceitos.length} item(ns), ${recusados.length} recusado(s)`);
        for (const r of recusados) console.log(`      RECUSADO (${r.motivo}): ${JSON.stringify(r.item).slice(0, 110)}`);
        break;
      } catch (e) {
        if (tentativa < TENTATIVAS_POR_LOTE) {
          process.stdout.write(`falhou (${e.message}); repetindo ... `);
          continue;
        }
        falhou = true;
        console.log(`FALHOU: ${e.message}`);
        if (!seco) registrarFalha(db, conversa.conversa_id, e.message);
        break;
      }
    }
    if (falhou) break;
  }

  if (seco) {
    for (const i of aceitosDaConversa) console.log(`    [${i.tipo}] ${i.resumo}  (id ${i.origem_id})`);
  } else if (!falhou) {
    // Só avança o marcador quando a conversa inteira passou: um lote perdido no meio
    // significaria mensagem nunca examinada, e ninguém saberia qual.
    const gravados = gravarItens(db, conversa.conversa_id, aceitosDaConversa, { modelo, ateEventoId: conversa.ate_evento_id });
    console.log(`    -> ${gravados} item(ns) gravado(s)`);
  }
  totalItens += aceitosDaConversa.length;
}

console.log(`\n${totalItens} itens · ${totalRecusados} recusados por citação inválida · ${tokens} tokens`);
db.close();

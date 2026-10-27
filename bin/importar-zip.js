#!/usr/bin/env node
// Importa uma exportação de conversa do WhatsApp (.zip) para dentro do banco, para que
// ela use o mesmo pipeline de tudo o mais: busca textual, CRM, painel, vault.
//
//   node bin/importar-zip.js --dry "C:/.../WhatsApp Chat - X.zip"
//   node bin/importar-zip.js "C:/.../WhatsApp Chat - X.zip"
//   node bin/importar-zip.js --pasta C:/Users/Usuario/Downloads
//
// Quando vale usar isto: a conversa NÃO está no WhatsApp pareado (contato trocou de
// número, conversa antiga, histórico anterior ao pareamento). Se ela já está lá, o
// texto entra sozinho e o ZIP é trabalho manual sem retorno — foi o caso de três dos
// quatro arquivos em Downloads.
//
// O id da conversa fica no espaço `zip:<slug>` justamente para não se passar por um
// jid do WhatsApp: a procedência continua legível depois.

import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync, globSync } from 'node:fs';
import { abrirBanco } from '../src/banco.js';
import { inventariarCaixa } from '../src/inventario.js';
import { slugVault as slug } from '../src/vault.js';

import { carregarEnv } from '../src/ambiente.js';

// O .env traz GEMINI_API_KEY, PUNK_RECORDS e ASSESSOR_DONO, escritos pelo
// instalador. Sem carregar aqui, a caixa do socio roda com o ambiente vazio.
carregarEnv();

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dados = resolve(process.env.ASSESSOR_DATA_DIR || resolve(raiz, 'data'));

const flag = n => process.argv.includes(`--${n}`);
const arg = (n, p) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : p; };
const seco = flag('dry');
const pasta = arg('pasta', null);

let alvos = process.argv.slice(2).filter(a => a.toLowerCase().endsWith('.zip'));
if (pasta) alvos = globSync(resolve(pasta, '*.zip')).filter(f => /whatsapp chat/i.test(basename(f)));
if (!alvos.length) {
  console.error('Uso: node bin/importar-zip.js [--dry] <arquivo.zip> | --pasta <diretorio>');
  process.exit(1);
}

const db = abrirBanco(resolve(dados, 'assessor.db'));

// Quem é o dono aparece na exportação com o nome do próprio aparelho. Descobrimos
// pelo nome que mais aparece em conversas já conhecidas, em vez de chutar.
const DONO = /fabr[íi]cio|cigano/i;

/** Nome do arquivo -> nome da conversa. "WhatsApp Chat - X.zip" => "X". */
function nomeDaConversa(caminho) {
  // NFC obrigatório: o nome vindo do sistema de arquivos pode trazer "ó" decomposto
  // (o + acento combinante) enquanto o banco guarda o precomposto. Sem normalizar,
  // um nome com acento não casa com a versão decomposta dele, e a conversa entra
  // duplicada. O caso real que originou isto tinha "ó" nas duas formas.
  return basename(caminho).normalize('NFC')
    .replace(/\.zip$/i, '').replace(/^WhatsApp Chat( -|_)?\s*/i, '')
    .replace(/\s*\(\d+\)$/, '').trim();
}

console.log(`${alvos.length} arquivo(s)${seco ? ' · DRY RUN' : ''}\n`);

const inserir = db.prepare(`
  INSERT INTO eventos (conversa_id, origem_id, direcao, autor_id, autor_e_dono,
                       do_proprio_bot, projeto_id, tipo, bruto, texto, recebido_em, dia_local)
  VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?)
  ON CONFLICT(conversa_id, origem_id) DO NOTHING
`);
const registrarConversa = db.prepare(`
  INSERT INTO conversas_app (id, nome) VALUES (?, ?)
  ON CONFLICT(id) DO UPDATE SET nome=excluded.nome
`);

let totalNovas = 0, totalPuladas = 0;

for (const caminho of alvos) {
  const nome = nomeDaConversa(caminho);
  let inv;
  try {
    inv = inventariarCaixa(caminho);
  } catch (e) {
    console.log(`- ${nome}: ERRO ao abrir (${e.message})`);
    continue;
  }
  if (!inv.ok) { console.log(`- ${nome}: ${inv.motivo}`); continue; }

  // Já existe no WhatsApp pareado com cobertura igual ou melhor? Então importar só
  // duplicaria a mesma conversa sob outro id, e a busca passaria a devolver as duas.
  // O nome do arquivo costuma trazer sufixo que o contato não tem ("Isaelson Oliveira
  // lead OM" contra "Isaelson Oliveira" no cadastro), então casar por igualdade exata
  // deixava passar o caso mais comum de redundância. Casa pelas duas primeiras palavras.
  const raizNome = nome.split(/\s+/).slice(0, 2).join(' ');
  const jaNoBanco = db.prepare(`
    SELECT c.id, c.nome, COUNT(e.id) n, MIN(e.recebido_em) p, MAX(e.recebido_em) u
    FROM conversas_app c JOIN eventos e ON e.conversa_id = c.id
    WHERE (c.nome = ? OR c.nome LIKE ?) AND c.id NOT LIKE 'zip:%'
      AND e.texto IS NOT NULL AND e.texto <> ''
    GROUP BY c.id ORDER BY n DESC LIMIT 1
  `).get(nome, `${raizNome}%`);

  const conversaId = `zip:${slug(nome)}`;
  const idArquivo = createHash('sha256').update(readFileSync(caminho)).digest('hex').slice(0, 12);

  if (jaNoBanco && jaNoBanco.n >= inv.totalMensagens * 0.9 && !flag('forcar')) {
    console.log(`- ${nome}: PULADO — o WhatsApp pareado já tem ${jaNoBanco.n} msgs (${jaNoBanco.p.slice(0, 10)} a ${jaNoBanco.u.slice(0, 10)}) contra ${inv.totalMensagens} do zip`);
    console.log(`    exportar conversa que já está conectada é trabalho sem retorno. Use --forcar se souber que o zip cobre mais.`);
    totalPuladas++;
    continue;
  }

  console.log(`- ${nome}: ${inv.totalMensagens} msgs de ${inv.primeiroEm?.slice(0, 10)} a ${inv.ultimoEm?.slice(0, 10)} -> ${conversaId}`);
  if (jaNoBanco) console.log(`    (o pareado tem ${jaNoBanco.n}; o zip cobre mais e entra separado)`);

  if (seco) { totalNovas += inv.totalMensagens; continue; }

  registrarConversa.run(conversaId, nome);
  let novas = 0;
  db.exec('BEGIN');
  try {
    for (const m of inv.mensagens) {
      const ehDono = DONO.test(m.autor) ? 1 : 0;
      // A hora da exportação é local do aparelho, sem fuso declarado. Guardamos como
      // veio e marcamos a origem no bruto; inventar UTC aqui deslocaria tudo em 3h.
      const recebidoEm = `${m.instanteLocal}.000Z`;
      const tipo = m.anexos.length ? 'documento' : 'texto';
      const bruto = JSON.stringify({
        tipoLote: 'importado-zip',
        arquivo: basename(caminho),
        arquivoSha256Curto: idArquivo,
        linhaFonte: m.linhaInicial,
        anexos: m.anexos,
        baseFuso: m.baseFuso
      });
      // A identidade da mensagem vem do conteúdo, não do arquivo: duas exportações da
      // mesma conversa (o caso real: dois zips do mesmo contato em Downloads, um subconjunto
      // do outro) precisam convergir para as mesmas linhas em vez de duplicar tudo.
      const impressao = createHash('sha256')
        .update(`${m.instanteLocal}|${m.autor}|${m.texto ?? ''}`).digest('hex').slice(0, 16);
      const r = inserir.run(
        conversaId, `zip:${impressao}`,
        ehDono ? 'saida' : 'entrada', ehDono ? null : m.autor, ehDono,
        tipo, bruto, m.texto || null, recebidoEm, m.instanteLocal.slice(0, 10)
      );
      novas += r.changes;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.log(`    FALHOU: ${e.message}`);
    continue;
  }
  console.log(`    ${novas} mensagem(ns) nova(s)${novas < inv.totalMensagens ? ` (${inv.totalMensagens - novas} já existiam)` : ''}`);
  totalNovas += novas;
}

console.log(`\n${totalNovas} mensagem(ns) importada(s) · ${totalPuladas} arquivo(s) pulado(s) por redundância`);
if (!seco && totalNovas) console.log('\nAgora: npm run indexar  (e depois node bin/crm.js --conversa "<nome>" --completo --dias 400)');
db.close();

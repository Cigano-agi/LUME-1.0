#!/usr/bin/env node
// Transcreve os áudios que só existem como referência no banco.
//
// `bin/transcrever.js` só alcança áudio que já está em disco, dentro de um .zip
// exportado. Os ~14.000 do banco guardam apenas a referência da mídia — e é lá que mora
// o que mais importa: como diz `src/crm.js`, "o brasileiro combina por áudio: preço,
// prazo e 'pode fazer' moram em voz". Este comando fecha essa lacuna baixando a mídia
// com a sessão do próprio assessor antes de transcrever.
//
//   node bin/transcrever-banco.js --dias 30 --limite 50
//   node bin/transcrever-banco.js --dias 30 --concorrencia 12
//   node bin/transcrever-banco.js --dias 7 --dry     # lista o que faria, sem gastar API
//
// Ordem: do mais novo para o mais velho. Não é preferência estética — a mídia do
// WhatsApp EXPIRA no servidor, então áudio velho falha no download e gastar a fila
// começando por ele é queimar tempo no que já morreu.
//
// Retomável: quem já tem linha em `transcricoes` não é refeito, inclusive os que
// falharam. Um erro gravado é resposta; repetir a chamada para o mesmo 404 é só custo.
// Para insistir num que falhou, apague a linha dele e rode de novo.

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { carregarEnv } from '../src/ambiente.js';
import { abrirBanco } from '../src/banco.js';
import { prepararEsquemaTranscricao, transcreverArquivo, gravarTranscricao } from '../src/transcricao.js';

carregarEnv();

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dados = resolve(process.env.ASSESSOR_DATA_DIR || resolve(raiz, 'data'));

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : padrao;
};
const seco = process.argv.includes('--dry');
const dias = Number(arg('dias', 30));
const limite = Number(arg('limite', 0)) || Infinity;
const concorrencia = Math.max(1, Number(arg('concorrencia', 8)));
const modelo = String(arg('modelo', 'gemini-3.8-flash-medium'));

const db = abrirBanco(resolve(dados, 'assessor.db'));
prepararEsquemaTranscricao(db);

// O coletor do WhatsApp escreve no mesmo arquivo. Sem espera, uma gravação nossa que
// cai no meio de um commit dele derruba o processo com SQLITE_BUSY e perde a
// transcrição que já foi paga.
try {
  db.exec('PRAGMA busy_timeout = 15000;');
} catch {}

const corte = new Date(Date.now() - dias * 86400000).toISOString();

const fila = db
  .prepare(
    `SELECT e.id, e.conversa_id, e.origem_id, e.recebido_em, e.bruto
       FROM eventos e
       LEFT JOIN transcricoes t
         ON t.conversa_id = e.conversa_id AND t.origem_id = e.origem_id
      WHERE e.tipo = 'audio'
        AND e.recebido_em >= ?
        AND t.id IS NULL
      ORDER BY e.recebido_em DESC`,
  )
  .all(corte)
  .slice(0, limite === Infinity ? undefined : limite);

const segundosDe = (bruto) => {
  try {
    return JSON.parse(bruto).mensagem?.message?.audioMessage?.seconds ?? 0;
  } catch {
    return 0;
  }
};
const totalSeg = fila.reduce((s, r) => s + segundosDe(r.bruto), 0);

console.log(`fila: ${fila.length} audios | janela ${dias} dias | ${(totalSeg / 60).toFixed(0)} min de audio`);
console.log(`modelo: ${modelo} | concorrencia: ${concorrencia}`);
if (!fila.length) process.exit(0);
if (seco) {
  console.log('(--dry: nada foi baixado nem transcrito)');
  process.exit(0);
}

const pasta = mkdtempSync(join(tmpdir(), 'assessor-audio-'));
const contagem = { transcrito: 0, vazio: 0, semMidia: 0, erro: 0 };
let proximo = 0;
const inicio = Date.now();

async function trabalhador(n) {
  while (proximo < fila.length) {
    const r = fila[proximo++];
    const rotulo = `${String(proximo).padStart(4)}/${fila.length}`;
    // Cada áudio num arquivo próprio, apagado logo depois: o modelo recebe a pasta, e
    // um áudio de terceiro não pode ficar exposto junto do de outra conversa.
    const arquivo = join(pasta, `w${n}-${r.id}.ogg`);
    try {
      const msg = JSON.parse(r.bruto).mensagem;
      let buf;
      try {
        buf = await downloadMediaMessage(msg, 'buffer', {});
      } catch (e) {
        contagem.semMidia++;
        gravarTranscricao(db, {
          conversaId: r.conversa_id,
          origemId: r.origem_id,
          quando: r.recebido_em,
          modelo,
          erro: `midia indisponivel: ${e?.message ?? e}`,
        });
        console.log(`${rotulo} · ${r.id} · sem midia`);
        continue;
      }
      writeFileSync(arquivo, buf);
      const t = await transcreverArquivo(arquivo, { modelo });
      gravarTranscricao(db, {
        conversaId: r.conversa_id,
        origemId: r.origem_id,
        arquivo: null,
        quando: r.recebido_em,
        texto: t.texto,
        textoOriginal: t.textoOriginal,
        respostas: t.respostas,
        modelo,
        duracaoMs: t.duracaoMs,
      });
      if (t.texto) {
        contagem.transcrito++;
        console.log(`${rotulo} · ${r.id} · ${t.texto.slice(0, 70).replace(/\n/g, ' ')}`);
      } else {
        contagem.vazio++;
        console.log(`${rotulo} · ${r.id} · (sem fala)`);
      }
    } catch (e) {
      contagem.erro++;
      gravarTranscricao(db, {
        conversaId: r.conversa_id,
        origemId: r.origem_id,
        quando: r.recebido_em,
        modelo,
        ...e.transcricao,
        erro: e?.message ?? String(e),
      });
      console.log(`${rotulo} · ${r.id} · ERRO ${e?.message ?? e}`);
    } finally {
      rmSync(arquivo, { force: true });
    }
  }
}

await Promise.all(Array.from({ length: concorrencia }, (_, i) => trabalhador(i)));
rmSync(pasta, { recursive: true, force: true });

const min = (Date.now() - inicio) / 60000;
console.log(
  `\nfim em ${min.toFixed(1)} min | transcritos ${contagem.transcrito} | ` +
    `sem fala ${contagem.vazio} | sem midia ${contagem.semMidia} | erro ${contagem.erro}`,
);

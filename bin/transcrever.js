#!/usr/bin/env node
// Transcreve os áudios de uma exportação de conversa e liga o texto à mensagem.
//
//   node bin/transcrever.js --zip "C:/.../WhatsApp Chat - X.zip" --limite 3
//   node bin/transcrever.js --pasta C:/Users/Usuario/Downloads --limite 20
//
// Começa pelos áudios que estão dentro dos .zip porque esses já estão em disco. Os
// 13.722 do banco só têm a referência: para transcrever aqueles é preciso descarregar
// a mídia antes, e a mídia antiga do WhatsApp expira no servidor.
//
// Um áudio por chamada, em série. O arquivo da vez é copiado sozinho para uma pasta
// temporária, que é o diretório entregue ao modelo — nenhum outro áudio fica exposto.

import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, globSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { abrirBanco } from '../src/banco.js';
import { lerIndiceZip, extrairEntrada, inventariarCaixa } from '../src/inventario.js';
import { prepararEsquemaTranscricao, transcreverArquivo, gravarTranscricao, dataDoNomeDeArquivo } from '../src/transcricao.js';
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
const limite = Number(arg('limite', 5));
const pasta = arg('pasta', null);
const modelo = String(arg('modelo', 'gemini-3.8-flash-medium'));

let zips = [arg('zip', null)].filter(Boolean);
if (pasta) zips = globSync(resolve(pasta, '*.zip')).filter(f => /whatsapp chat/i.test(basename(f)));
if (!zips.length) {
  console.error('Uso: node bin/transcrever.js --zip <arquivo.zip> | --pasta <diretorio> [--limite N]');
  process.exit(1);
}

const db = abrirBanco(resolve(dados, 'assessor.db'));
prepararEsquemaTranscricao(db);

const EXT_AUDIO = /\.(opus|ogg|m4a|mp3|aac|wav)$/i;
let transcritos = 0, vazios = 0, erros = 0, pulados = 0;

for (const zip of zips) {
  const nome = basename(zip).normalize('NFC').replace(/\.zip$/i, '')
    .replace(/^WhatsApp Chat( -|_)?\s*/i, '').replace(/\s*\(\d+\)$/, '').trim();
  const conversaId = `zip:${slug(nome)}`;

  let indice, inv;
  try {
    indice = lerIndiceZip(zip);
    inv = inventariarCaixa(zip);
  } catch (e) {
    console.log(`- ${nome}: ERRO ao abrir (${e.message})`);
    continue;
  }
  const audios = indice.entradas.filter(e => EXT_AUDIO.test(e.nome));
  if (!audios.length) { console.log(`- ${nome}: nenhum áudio`); continue; }

  // Liga o arquivo de áudio à mensagem que o citou, para a transcrição herdar data,
  // autor e id de origem. Áudio sem mensagem correspondente fica sem vínculo, mas é
  // registrado — nunca inventamos a quem ele pertence.
  const porAnexo = new Map();
  if (inv.ok) {
    for (const m of inv.mensagens) {
      for (const a of m.anexos) porAnexo.set(a, m);
    }
  }

  console.log(`- ${nome}: ${audios.length} áudio(s)`);
  for (const entrada of audios.slice(0, limite)) {
    const arq = basename(entrada.nome);
    const msg = porAnexo.get(arq);
    const origemId = msg
      ? `zip:${createHash('sha256').update(`${msg.instanteLocal}|${msg.autor}|${msg.texto ?? ''}`).digest('hex').slice(0, 16)}`
      : `zip:audio:${createHash('sha256').update(arq).digest('hex').slice(0, 16)}`;

    const existente = db.prepare('SELECT estado FROM transcricoes WHERE conversa_id=? AND origem_id=?')
      .get(conversaId, origemId);
    if (existente && existente.estado === 'transcrito') { pulados++; continue; }
    // 'vazio' e 'erro' voltam para a fila: a falha do modelo e intermitente.

    process.stdout.write(`    ${arq.slice(0, 46).padEnd(46)} ... `);
    if (seco) { console.log('(dry)'); continue; }

    const tmp = mkdtempSync(resolve(tmpdir(), 'assessor-audio-'));
    try {
      const destino = resolve(tmp, arq);
      writeFileSync(destino, extrairEntrada(zip, entrada));
      const { texto, duracaoMs, textoOriginal, respostas } = await transcreverArquivo(destino, { modelo });
      // Quando a pessoa falou, na ordem de confianca: a mensagem que citou o audio,
      // depois a data no nome do arquivo. Nunca a data de hoje.
      const quando = msg ? `${msg.instanteLocal}.000Z` : dataDoNomeDeArquivo(arq);
      gravarTranscricao(db, {
        conversaId, origemId, arquivo: arq, quando, texto, textoOriginal, respostas, modelo, duracaoMs
      });
      if (texto) {
        transcritos++;
        console.log(`${(duracaoMs / 1000).toFixed(0)}s · ${texto.slice(0, 70)}${texto.length > 70 ? '…' : ''}`);
      } else {
        vazios++;
        console.log('(sem fala)');
      }
    } catch (e) {
      erros++;
      gravarTranscricao(db, { conversaId, origemId, arquivo: arq, quando: msg ? `${msg.instanteLocal}.000Z` : dataDoNomeDeArquivo(arq), ...e.transcricao, erro: e.message, modelo });
      console.log(`FALHOU: ${e.message.slice(0, 70)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log(`\n${transcritos} transcrito(s) · ${vazios} sem fala · ${erros} erro(s) · ${pulados} já feito(s)`);
if (transcritos) console.log('As transcrições entram na busca no próximo `npm run indexar`.');
db.close();

#!/usr/bin/env node
// CLI do nucleo. Sem servico externo, sem credencial: roda com o que existe hoje.
//
//   node bin/assessor.js principal [--banco X] [--batimento-ms 60000]
//   node bin/assessor.js vigia     [--banco X] [--intervalo-ms 30000] [--limite-ms 180000] [--avisos Y] [--uma-rodada]
//   node bin/assessor.js saude     [--banco X]
//   node bin/assessor.js autorizar <conversaId> <modo> --por <dono>
//   node bin/assessor.js conversas [--banco X]

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { appendFileSync, openSync, readFileSync, existsSync } from "node:fs";
import { abrirBanco } from "../src/banco.js";
import { snapshot, batimento } from "../src/saude.js";
import { Vigia } from "../src/vigia.js";
import { Politica } from "../src/autorizacao.js";
import { avisoArquivo, avisoConsole, avisoToast, notificarWindows, todos } from "../src/aviso.js";

import { carregarEnv } from '../src/ambiente.js';

// O .env traz GEMINI_API_KEY, PUNK_RECORDS e ASSESSOR_DONO, escritos pelo
// instalador. Sem carregar aqui, a caixa do socio roda com o ambiente vazio.
carregarEnv();

const args = process.argv.slice(2);
const comando = args[0];
const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TETO_TENTATIVAS = 3;
const JANELA_TENTATIVAS_MS = 30 * 60_000;

/**
 * Sobe o principal de novo quando o batimento envelhece. Duas quedas diferentes caem
 * aqui: o processo que morreu (pid ausente) e o que ficou de pe mas mudo (socket
 * pendurado, o modo de 10/09). Nos dois casos a resposta e a mesma -- derrubar o que
 * sobrou e subir limpo.
 *
 * ponytail: teto burro de 3 tentativas em 30 min, contadas num .jsonl. Se estourar,
 * avisa e para de tentar -- e sinal de coisa que restart nao resolve (QR expirado,
 * porta ocupada). Backoff exponencial so se isso virar barulho na pratica.
 */
function revivePrincipal(db, limiteMs) {
  const linha = db.prepare("SELECT * FROM batimentos WHERE componente='principal'").get();
  if (!linha) return;
  if (Date.now() - Date.parse(linha.visto_em) <= limiteMs) return;

  const registro = resolve(RAIZ, "data/revive.jsonl");
  const recentes = existsSync(registro)
    ? readFileSync(registro, "utf8").trim().split("\n").filter(Boolean)
        .map((l) => Date.parse(JSON.parse(l).em))
        .filter((t) => Date.now() - t < JANELA_TENTATIVAS_MS)
    : [];
  if (recentes.length >= TETO_TENTATIVAS) {
    notificarWindows("Assessor 2.0", `Nao sobe sozinho (${recentes.length} tentativas em 30 min). Abra http://127.0.0.1:8787`);
    return;
  }

  // Um pid vivo com batimento velho e o processo mudo: mata antes de subir outro, senao
  // a porta 8787 fica ocupada e o novo nasce morto.
  let matou = false;
  try {
    process.kill(linha.pid, 0);
    process.kill(linha.pid, "SIGTERM");
    matou = true;
  } catch { /* Ja morreu; e o caso comum. */ }

  const saida = openSync(resolve(RAIZ, "data/app.stdout.log"), "a");
  const erro = openSync(resolve(RAIZ, "data/app.stderr.log"), "a");
  const filho = spawn(process.execPath, [resolve(RAIZ, "bin/app.js")], {
    cwd: RAIZ,
    detached: true,
    stdio: ["ignore", saida, erro],
  });
  filho.unref();

  appendFileSync(registro, JSON.stringify({ em: new Date().toISOString(), pidAntigo: linha.pid, matou, pidNovo: filho.pid }) + "\n");
  notificarWindows(
    "Assessor 2.0",
    `Estava ${matou ? "de pe mas mudo" : "fora do ar"} desde ${new Date(linha.visto_em).toLocaleString("pt-BR")}. Subi de novo agora.`,
  );
}

function opcao(nome, padrao) {
  const i = args.indexOf(`--${nome}`);
  return i === -1 ? padrao : args[i + 1];
}

const CAMINHO_BANCO = opcao("banco", "data/assessor.db");

function sair(msg, codigo = 1) {
  console.error(msg);
  process.exit(codigo);
}

switch (comando) {
  case "principal": {
    // Processo dono da sessao. Por enquanto so mantem o batimento -- o transporte
    // WhatsApp entra aqui no proximo segmento. O ponto provado agora e outro:
    // quando este processo morre, o batimento para.
    const db = abrirBanco(CAMINHO_BANCO);
    const intervalo = Number(opcao("batimento-ms", 60_000));
    batimento(db, "principal");
    console.log(`principal vivo pid=${process.pid} banco=${CAMINHO_BANCO} batimento=${intervalo}ms`);
    setInterval(() => batimento(db, "principal"), intervalo);
    break;
  }

  case "vigia": {
    // Processo separado, de proposito. Ele nao compartilha memoria nem event loop
    // com o principal: le o batimento do banco.
    const db = abrirBanco(CAMINHO_BANCO);
    const intervalo = Number(opcao("intervalo-ms", 30_000));
    const arquivoAvisos = opcao("avisos", "data/avisos.jsonl");
    const uma = args.includes("--uma-rodada");
    const reviver = args.includes("--reviver");
    const limiteMs = Number(opcao("limite-ms", 3 * 60_000));
    const vigia = new Vigia(db, {
      avisar: todos(avisoArquivo(arquivoAvisos), avisoConsole(), avisoToast()),
      limiteMs,
    });
    const rodada = async () => {
      const emitidos = await vigia.verificar();
      if (reviver) revivePrincipal(db, limiteMs);
      if (uma) {
        console.log(JSON.stringify(emitidos, null, 2));
        process.exit(emitidos.some((a) => a.tipo === "queda") ? 2 : 0);
      }
    };
    rodada();
    if (!uma) setInterval(rodada, intervalo);
    break;
  }

  case "saude": {
    const db = abrirBanco(CAMINHO_BANCO);
    const s = snapshot(db);
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.veredito === "ok" ? 0 : 2);
  }

  case "autorizar": {
    const [, conversaId, modo] = args;
    const por = opcao("por", null);
    if (!conversaId || !modo) sair("uso: autorizar <conversaId> <modo> --por <dono>");
    if (!por) sair("autorizacao exige --por <dono identificado>");
    const db = abrirBanco(CAMINHO_BANCO);
    const p = new Politica(db);
    console.log(JSON.stringify(p.definir(conversaId, modo, { decididoPor: por }), null, 2));
    break;
  }

  case "conversas": {
    const db = abrirBanco(CAMINHO_BANCO);
    console.log(JSON.stringify(new Politica(db).listar(), null, 2));
    break;
  }

  default:
    sair("comandos: principal | vigia | saude | autorizar | conversas");
}

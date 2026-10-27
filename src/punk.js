// Entrega ao Punk Records com destino validado, escrita por bloco e recibo.
//
// Corrige tres achados da auditoria sobre whatsapp-brain@fd40178 `src/punkrecords.ts`:
//  A04 - `vaultDir()` caia em ~/PunkRecords e `deliverToPunkRecords()` devolvia
//        `skipped:true` quando a pasta nao existia, sem o comando falhar.
//        Aqui destino inexistente e ERRO, nunca "pulado com sucesso".
//  A05a - a sintese era reescrita por inteiro, apagando complemento manual.
//        Aqui toda escrita e delimitada por marcadores; o texto fora do bloco
//        sobrevive. O marcador `<!-- PONTE:BEGIN/END -->` do sink antigo e mantido
//        como padrao para nao quebrar notas ja existentes.
//  A05b - a data vinha de `toISOString()` (UTC). Aqui vem de `diaLocal()`.
//
// A entrega so e considerada feita depois de reler o arquivo e conferir o bloco.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { diaLocal, agoraIso } from "./relogio.js";

export const MARCADOR_PADRAO = "PONTE";

export class DestinoInvalido extends Error {}

/** Resolve e valida a raiz do vault. Sem palpite de home: ou foi declarado, ou falha. */
export function raizVault(caminho = process.env.PUNK_VAULT_DIR || process.env.PUNK_RECORDS) {
  if (!caminho) {
    throw new DestinoInvalido(
      "PUNK_VAULT_DIR nao definido e nenhum vault configurado. " +
        "Rode `node bin/criar-vault.js` para criar um vazio — nao presuma ~/PunkRecords.",
    );
  }
  if (!existsSync(caminho) || !statSync(caminho).isDirectory()) {
    throw new DestinoInvalido(`PUNK_VAULT_DIR nao e uma pasta existente: ${caminho}`);
  }
  return caminho;
}

function marcadores(nome) {
  return [`<!-- ${nome}:BEGIN -->`, `<!-- ${nome}:END -->`];
}

/** Substitui apenas o bloco marcado; preserva tudo que estiver fora dele. */
export function mesclarBloco(conteudoAtual, corpo, nomeMarcador = MARCADOR_PADRAO) {
  const [inicio, fim] = marcadores(nomeMarcador);
  const bloco = `${inicio}\n${corpo.trimEnd()}\n${fim}`;
  const i = conteudoAtual.indexOf(inicio);
  const f = conteudoAtual.indexOf(fim);
  if (i !== -1 && f !== -1 && f > i) {
    return conteudoAtual.slice(0, i) + bloco + conteudoAtual.slice(f + fim.length);
  }
  const base = conteudoAtual.trimEnd();
  return base.length ? `${base}\n\n${bloco}\n` : `${bloco}\n`;
}

function escreverAtomico(destino, conteudo) {
  mkdirSync(dirname(destino), { recursive: true });
  const temporario = `${destino}.tmp-${process.pid}`;
  writeFileSync(temporario, conteudo, "utf8");
  renameSync(temporario, destino);
}

export class Punk {
  #db;
  #raiz;
  constructor(db, raiz) {
    this.#db = db;
    this.#raiz = raizVault(raiz);
  }

  get raiz() {
    return this.#raiz;
  }

  /**
   * Grava um bloco em `caminhoRelativo` e confirma relendo o arquivo.
   * Retorna o recibo persistido. Lanca se nao conseguir confirmar.
   */
  entregar({ referencia, caminhoRelativo, corpo, marcador = MARCADOR_PADRAO }, agora = new Date()) {
    const destino = join(this.#raiz, caminhoRelativo);
    try {
      const atual = existsSync(destino) ? readFileSync(destino, "utf8") : "";
      const novo = mesclarBloco(atual, corpo, marcador);
      escreverAtomico(destino, novo);

      const relido = readFileSync(destino, "utf8");
      const [inicio, fim] = marcadores(marcador);
      if (!relido.includes(inicio) || !relido.includes(fim) || !relido.includes(corpo.trimEnd())) {
        throw new Error("bloco nao encontrado na releitura");
      }
      return this.#recibo(referencia, destino, "confirmada", null, agora);
    } catch (erro) {
      this.#recibo(referencia, destino, "falha", String(erro), agora);
      throw erro;
    }
  }

  /** Nota do dia usando a data local de Sao Paulo, nao UTC. */
  entregarNotaDoDia({ referencia, corpo, quando = new Date(), marcador = MARCADOR_PADRAO }) {
    const dia = diaLocal(quando);
    return this.entregar(
      { referencia: `${referencia}:${dia}`, caminhoRelativo: join("DailyNotes", `${dia}.md`), corpo, marcador },
      quando,
    );
  }

  #recibo(referencia, destino, estado, detalhe, agora) {
    const iso = agoraIso(agora);
    this.#db
      .prepare(
        `INSERT INTO entregas_punk (referencia, destino, estado, detalhe, criado_em)
         VALUES (?,?,?,?,?)
         ON CONFLICT(referencia) DO UPDATE SET
           destino=excluded.destino, estado=excluded.estado,
           detalhe=excluded.detalhe, criado_em=excluded.criado_em`,
      )
      .run(referencia, destino, estado, detalhe, iso);
    return this.#db.prepare("SELECT * FROM entregas_punk WHERE referencia=?").get(referencia);
  }

  recibo(referencia) {
    return this.#db.prepare("SELECT * FROM entregas_punk WHERE referencia=?").get(referencia) ?? null;
  }

  falhas() {
    return this.#db.prepare("SELECT * FROM entregas_punk WHERE estado='falha'").all();
  }
}

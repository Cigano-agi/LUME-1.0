import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abrirBanco } from "../src/banco.js";
import { Punk, raizVault, mesclarBloco, DestinoInvalido } from "../src/punk.js";

const vaultTemp = () => mkdtempSync(join(tmpdir(), "punk-teste-"));

describe("entrega ao Punk Records", () => {
  test("destino inexistente e ERRO, nunca 'pulado com sucesso'", () => {
    // Achado A04: o sink antigo devolvia skipped:true e o comando terminava bem.
    assert.throws(() => raizVault(join(tmpdir(), "nao-existe-mesmo-123")), DestinoInvalido);
    assert.throws(() => raizVault(undefined), /PUNK_VAULT_DIR/);
  });

  test("escrita por bloco preserva o que foi escrito a mao fora do bloco", () => {
    const raiz = vaultTemp();
    const db = abrirBanco();
    const punk = new Punk(db, raiz);
    const rel = join("wiki", "synthesis", "ponte-whatsapp.md");
    mkdirSync(join(raiz, "wiki", "synthesis"), { recursive: true });
    writeFileSync(
      join(raiz, rel),
      "# Ponte\n\nAnotacao manual do Fabricio que nao pode sumir.\n",
      "utf8",
    );

    punk.entregar({ referencia: "sintese:1", caminhoRelativo: rel, corpo: "linha automatica v1" });
    punk.entregar({ referencia: "sintese:2", caminhoRelativo: rel, corpo: "linha automatica v2" });

    const conteudo = readFileSync(join(raiz, rel), "utf8");
    assert.match(conteudo, /Anotacao manual do Fabricio que nao pode sumir/);
    assert.match(conteudo, /linha automatica v2/);
    assert.doesNotMatch(conteudo, /linha automatica v1/, "o bloco e substituido, nao acumulado");
  });

  test("entrega so conta com recibo confirmado apos releitura", () => {
    const raiz = vaultTemp();
    const db = abrirBanco();
    const punk = new Punk(db, raiz);
    punk.entregar({ referencia: "r1", caminhoRelativo: "wiki/nota.md", corpo: "conteudo" });
    const recibo = punk.recibo("r1");
    assert.equal(recibo.estado, "confirmada");
    assert.equal(punk.falhas().length, 0);
  });

  test("falha de escrita fica registrada como falha e propaga", () => {
    const raiz = vaultTemp();
    const db = abrirBanco();
    const punk = new Punk(db, raiz);
    // Cria uma PASTA onde o arquivo deveria estar: a escrita tem de falhar.
    mkdirSync(join(raiz, "bloqueado.md"), { recursive: true });
    assert.throws(() =>
      punk.entregar({ referencia: "r2", caminhoRelativo: "bloqueado.md", corpo: "x" }),
    );
    assert.equal(punk.recibo("r2").estado, "falha");
    assert.equal(punk.falhas().length, 1);
  });

  test("nota do dia usa a data de Sao Paulo, nao a data UTC", () => {
    const raiz = vaultTemp();
    const db = abrirBanco();
    const punk = new Punk(db, raiz);
    // 23h de Sao Paulo em 03/09 == 02h UTC de 04/09. O digest antigo (achado A05)
    // gravaria 2026-09-04.
    const quando = new Date("2026-09-04T02:00:00Z");
    const recibo = punk.entregarNotaDoDia({ referencia: "digest", corpo: "resumo", quando });
    assert.match(recibo.destino, /2026-09-03\.md$/);
    assert.equal(recibo.estado, "confirmada");
  });

  test("mesclarBloco e idempotente e mantem o marcador do sink antigo", () => {
    const a = mesclarBloco("", "corpo");
    assert.match(a, /<!-- PONTE:BEGIN -->/);
    const b = mesclarBloco(a, "corpo");
    assert.equal(a, b);
  });
});

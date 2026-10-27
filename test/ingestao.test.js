import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { abrirBanco } from "../src/banco.js";
import { Ingestao } from "../src/ingestao.js";
import { Fila, MAX_TENTATIVAS } from "../src/etapas.js";
import { diaLocal } from "../src/relogio.js";
import { Projetos, ContextoIsolado } from "../src/projetos.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evento = (over = {}) => ({
  conversaId: "5511999@s.whatsapp.net",
  origemId: "MSG-1",
  tipo: "audio",
  bruto: { a: 1 },
  ...over,
});

function rotear(db, eventoId) {
  const projetos = new Projetos(db);
  projetos.cadastrar({ id: "teste/projeto", cliente: "Teste", nome: "Projeto", raiz: mkdtempSync(join(tmpdir(), "assessor-ingestao-")) });
  projetos.vincular(evento().conversaId, "teste/projeto", { decididoPor: "dono:teste" });
  new ContextoIsolado(db, projetos).atribuirEvento(evento().conversaId, eventoId, "teste/projeto");
}

describe("ingestao duravel", () => {
  test("grava a entrada antes de qualquer processamento e registra as etapas em quarentena", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    const { id, novo } = ing.registrar(evento(), ["transcricao", "analise"]);
    assert.equal(novo, true);
    const linha = ing.evento(id);
    assert.equal(linha.tipo, "audio");
    assert.equal(linha.texto, null, "texto ainda nao existe: a transcricao nem rodou");
    const registrada = db.prepare("SELECT COUNT(*) AS n FROM etapas WHERE etapa='transcricao'").get();
    assert.equal(Number(registrada.n), 1);
    assert.equal(new Fila(db).prontos("transcricao", { projetoId: "teste/projeto" }).length, 0, "sem projeto nao sai da quarentena");
  });

  test("replay pos-crash nao duplica: mesma (conversa, origem) volta como ja gravada", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    const a = ing.registrar(evento(), ["transcricao"]);
    const b = ing.registrar(evento(), ["transcricao"]);
    assert.equal(b.novo, false);
    assert.equal(b.id, a.id);
    assert.equal(ing.contar(), 1);
  });

  test("nao filtra por tipo de lote: o que o transporte entregou fica gravado", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    // O brain antigo descartava lotes history/append (achado A02). Aqui a
    // ingestao nao conhece esse conceito -- quem decide o que fazer sao as etapas.
    ing.registrar(evento({ origemId: "HIST-1" }));
    ing.registrar(evento({ origemId: "APPEND-1" }));
    assert.equal(ing.contar(), 2);
  });

  test("dia_local usa America/Sao_Paulo, nao UTC", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    // 2026-09-04T02:00:00Z = 2026-09-03 23:00 em Sao Paulo.
    const quando = new Date("2026-09-04T02:00:00Z");
    const { id } = ing.registrar(evento({ recebidoEm: quando }));
    assert.equal(ing.evento(id).dia_local, "2026-09-03");
    assert.equal(diaLocal(quando), "2026-09-03");
  });
});

describe("fila de etapas", () => {
  test("falha nao vira sucesso: reagenda com espera crescente e aparece no atraso", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    const fila = new Fila(db);
    const t0 = new Date("2026-09-03T12:00:00Z");
    const { id } = ing.registrar(evento({ recebidoEm: t0 }), ["transcricao"]);
    rotear(db, id);

    fila.iniciar(id, "transcricao", t0);
    const r = fila.falhar(id, "transcricao", "cuBLAS nao carregou", t0);
    assert.equal(r.desistiu, false);
    assert.ok(r.proximaTentativaEm > t0.toISOString(), "tem de esperar antes de tentar de novo");

    assert.equal(fila.prontos("transcricao", { projetoId: "teste/projeto", agora: t0 }).length, 0, "ainda nao venceu a espera");
    const depois = new Date(t0.getTime() + 60_000);
    assert.equal(fila.prontos("transcricao", { projetoId: "teste/projeto", agora: depois }).length, 1, "vencida a espera, volta pra fila");
    assert.equal(fila.atraso("transcricao", depois).pendentes, 1);
  });

  test("depois do limite a etapa desiste de forma visivel, nunca em silencio", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    const fila = new Fila(db);
    const { id } = ing.registrar(evento(), ["transcricao"]);
    let t = new Date("2026-09-03T12:00:00Z");
    for (let i = 0; i <= MAX_TENTATIVAS; i++) {
      fila.iniciar(id, "transcricao", t);
      var r = fila.falhar(id, "transcricao", "erro persistente", t);
      t = new Date(t.getTime() + 3600_000);
    }
    assert.equal(r.desistiu, true);
    assert.equal(fila.desistidas("transcricao").length, 1);
  });

  test("sucesso limpa o erro e carimba a saude da etapa", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    const fila = new Fila(db);
    const { id } = ing.registrar(evento(), ["transcricao"]);
    fila.iniciar(id, "transcricao");
    fila.concluir(id, "transcricao", { texto: "oi" });
    assert.equal(fila.atraso("transcricao").pendentes, 0);
    const s = db.prepare("SELECT * FROM saude WHERE etapa='transcricao'").get();
    assert.ok(s.ultimo_sucesso_em);
  });
});

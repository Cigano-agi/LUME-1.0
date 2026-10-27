import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { abrirBanco } from "../src/banco.js";
import { Politica, escopoDe } from "../src/autorizacao.js";
import { Saidas } from "../src/saidas.js";

const DM = "5511999@s.whatsapp.net";
const GRUPO = "12036300@g.us";
const DONO = "dono:fabricio";

describe("politica de autorizacao por conversa", () => {
  test("lista vazia nao libera ninguem", () => {
    const p = new Politica(abrirBanco());
    assert.deepEqual(p.podeEnviar(DM), { permitido: false, motivo: "sem regra cadastrada" });
    assert.deepEqual(p.podeEnviar(GRUPO), { permitido: false, motivo: "sem regra cadastrada" });
  });

  test("identificador exato: parecido nao serve", () => {
    const p = new Politica(abrirBanco());
    p.definir(DM, "atender", { decididoPor: DONO });
    // O brain antigo casava por substring (achado A07); aqui nao casa.
    assert.equal(p.podeEnviar("15511999@s.whatsapp.net").permitido, false);
    assert.equal(p.podeEnviar("5511999@s.whatsapp.net.br").permitido, false);
    assert.equal(p.podeEnviar(DM).permitido, true);
  });

  test("ler ou observar nunca autoriza enviar", () => {
    const p = new Politica(abrirBanco());
    p.definir(GRUPO, "observar", { decididoPor: DONO });
    assert.equal(p.podeLer(GRUPO), true);
    assert.equal(p.podeRascunhar(GRUPO), false);
    assert.equal(p.podeEnviar(GRUPO).permitido, false);
  });

  test("rascunhar prepara mas nao envia", () => {
    const p = new Politica(abrirBanco());
    p.definir(GRUPO, "rascunhar", { decididoPor: DONO });
    assert.equal(p.podeRascunhar(GRUPO), true);
    assert.equal(p.podeEnviar(GRUPO).permitido, false);
  });

  test("autorizacao em DM nao se estende ao grupo", () => {
    const p = new Politica(abrirBanco());
    p.definir(DM, "atender", { decididoPor: DONO });
    assert.equal(escopoDe(DM), "dm");
    assert.equal(escopoDe(GRUPO), "grupo");
    assert.equal(p.podeEnviar(GRUPO).permitido, false, "grupo continua sem regra propria");
  });

  test("autorizacao exige dono identificado; texto encaminhado nao vale", () => {
    const p = new Politica(abrirBanco());
    assert.throws(() => p.definir(DM, "atender", {}), /dono identificado/);
  });

  test("silencio nao autoriza: sem chamada a definir(), nada muda", () => {
    const p = new Politica(abrirBanco());
    assert.equal(p.listar().length, 0);
    assert.equal(p.podeEnviar(DM).permitido, false);
  });
});

describe("intervencao humana e revogacao", () => {
  test("mensagem do dono pausa a conversa e cancela saida preparada", () => {
    const db = abrirBanco();
    const p = new Politica(db);
    const s = new Saidas(db, p);
    p.definir(DM, "atender", { decididoPor: DONO });
    s.preparar({ conversaId: DM, corpo: "rascunho", idempotencia: "k1" });

    const r = p.registrarIntervencaoHumana(DM, { doProprioBot: false });
    assert.equal(r.pausou, true);
    assert.equal(r.saidasCanceladas, 1);
    assert.equal(p.regra(DM).modo, "pausado");
    assert.equal(s.buscar("k1").estado, "cancelada");
  });

  test("eco do proprio bot nao e confundido com intervencao humana", () => {
    const db = abrirBanco();
    const p = new Politica(db);
    p.definir(DM, "atender", { decididoPor: DONO });
    const r = p.registrarIntervencaoHumana(DM, { doProprioBot: true });
    assert.equal(r.pausou, false);
    assert.equal(p.regra(DM).modo, "atender");
  });

  test("retomar exige comando do dono: pausado nao volta sozinho", () => {
    const db = abrirBanco();
    const p = new Politica(db);
    p.definir(DM, "atender", { decididoPor: DONO });
    p.registrarIntervencaoHumana(DM, {});
    assert.equal(p.podeEnviar(DM).permitido, false);
    p.definir(DM, "atender", { decididoPor: DONO });
    assert.equal(p.podeEnviar(DM).permitido, true);
  });

  test("revogacao durante a execucao impede o envio da resposta ja preparada", async () => {
    const db = abrirBanco();
    const p = new Politica(db);
    const s = new Saidas(db, p);
    p.definir(DM, "atender", { decididoPor: DONO });
    s.preparar({ conversaId: DM, corpo: "proposta", idempotencia: "k2" });

    p.revogar(DM, { decididoPor: DONO });

    let chamou = false;
    const r = await s.enviar("k2", async () => { chamou = true; return "x"; });
    assert.equal(r.enviada, false);
    assert.equal(chamou, false, "o transporte nem pode ser tocado");
    assert.equal(s.buscar("k2").estado, "cancelada");
  });
});

describe("saidas idempotentes", () => {
  test("preparar duas vezes com a mesma chave nao cria duas saidas", () => {
    const db = abrirBanco();
    const p = new Politica(db);
    const s = new Saidas(db, p);
    p.definir(DM, "atender", { decididoPor: DONO });
    const a = s.preparar({ conversaId: DM, corpo: "oi", idempotencia: "k3" });
    const b = s.preparar({ conversaId: DM, corpo: "oi", idempotencia: "k3" });
    assert.equal(a.id, b.id);
  });

  test("envio ja realizado nao repete", async () => {
    const db = abrirBanco();
    const p = new Politica(db);
    const s = new Saidas(db, p);
    p.definir(DM, "atender", { decididoPor: DONO });
    s.preparar({ conversaId: DM, corpo: "oi", idempotencia: "k4" });
    let n = 0;
    await s.enviar("k4", async () => { n++; return "id-externo"; });
    const r = await s.enviar("k4", async () => { n++; return "id-externo"; });
    assert.equal(n, 1);
    assert.equal(r.repetida, true);
  });

  test("falha no transporte deixa a saida incerta para reconciliar, nao reenvia as cegas", async () => {
    const db = abrirBanco();
    const p = new Politica(db);
    const s = new Saidas(db, p);
    p.definir(DM, "atender", { decididoPor: DONO });
    s.preparar({ conversaId: DM, corpo: "oi", idempotencia: "k5" });
    const r = await s.enviar("k5", async () => { throw new Error("socket caiu no meio"); });
    assert.equal(r.incerta, true);
    assert.equal(s.buscar("k5").estado, "incerta");
    assert.equal(s.incertas().length, 1);
    const r2 = await s.enviar("k5", async () => "x");
    assert.equal(r2.enviada, false, "saida incerta nao se auto-reenvia");
  });
});

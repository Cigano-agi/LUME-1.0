import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { abrirBanco } from "../src/banco.js";
import { Ingestao } from "../src/ingestao.js";
import { Fila } from "../src/etapas.js";
import { Politica } from "../src/autorizacao.js";
import { Saidas } from "../src/saidas.js";
import {
  aplicarUpsert,
  normalizar,
  tipoDe,
  classificarFromMe,
} from "../src/transporte/whatsapp.js";

const DM = "5511999999999@s.whatsapp.net";
const GRUPO = "120363000000000000@g.us";
const DONO = "5511888888888@s.whatsapp.net";

const texto = (id, jid = DM, chaveExtra = {}) => ({
  key: { remoteJid: jid, id, fromMe: false, ...chaveExtra },
  messageTimestamp: 1788400000,
  message: { conversation: "preciso de um orcamento" },
});

const audio = (id, jid = DM) => ({
  key: { remoteJid: jid, id, fromMe: false },
  messageTimestamp: 1788400000,
  message: { audioMessage: { seconds: 42, ptt: true } },
});

describe("normalizacao de mensagem", () => {
  test("le os mesmos formatos que o brain antigo lia", () => {
    assert.equal(tipoDe({ message: { conversation: "oi" } }), "texto");
    assert.equal(tipoDe({ message: { extendedTextMessage: { text: "oi" } } }), "texto");
    assert.equal(tipoDe({ message: { audioMessage: {} } }), "audio");
    assert.equal(tipoDe({ message: { imageMessage: {} } }), "imagem");
    assert.equal(tipoDe({ message: { documentMessage: {} } }), "documento");
    assert.equal(tipoDe({ message: {} }), "desconhecido");
  });

  test("audio chega SEM texto: transcricao e etapa posterior", () => {
    const e = normalizar(audio("A1"));
    assert.equal(e.tipo, "audio");
    assert.equal(e.texto, null);
  });

  test("em grupo o autor vem de participant, nao do jid do grupo", () => {
    const e = normalizar(texto("G1", GRUPO, { participant: "5511777777777@s.whatsapp.net" }));
    assert.equal(e.conversaId, GRUPO);
    assert.equal(e.autorId, "5511777777777@s.whatsapp.net");
  });

  test("fromMe marca autorEDono e direcao de saida", () => {
    const e = normalizar(texto("S1", DM, { fromMe: true }), { donoJid: DONO });
    assert.equal(e.autorEDono, true);
    assert.equal(e.direcao, "saida");
    assert.equal(e.autorId, DONO);
  });
});

describe("lote messages.upsert", () => {
  test("lote ao vivo e persistido", () => {
    const ing = new Ingestao(abrirBanco());
    const r = aplicarUpsert(ing, { messages: [texto("N1"), texto("N2")], type: "notify" });
    assert.equal(r.novas, 2);
    assert.equal(ing.contar(), 2);
  });

  test("lotes de historico e append TAMBEM sao persistidos", () => {
    // O listener antigo fazia `if (type !== "notify") return;` e descartava esses
    // lotes (achado A02). Aqui eles entram, com o tipo do lote registrado.
    const ing = new Ingestao(abrirBanco());
    aplicarUpsert(ing, { messages: [texto("H1"), texto("H2")], type: "history" });
    aplicarUpsert(ing, { messages: [texto("P1")], type: "append" });
    assert.equal(ing.contar(), 3);
    assert.equal(JSON.parse(ing.evento(1).bruto).tipoLote, "history");
    assert.equal(JSON.parse(ing.evento(3).bruto).tipoLote, "append");
  });

  test("reconexao reentregando o historico nao duplica", () => {
    const ing = new Ingestao(abrirBanco());
    const lote = { messages: [texto("R1"), texto("R2")], type: "history" };
    aplicarUpsert(ing, lote);
    const segunda = aplicarUpsert(ing, lote);
    assert.equal(segunda.novas, 0);
    assert.equal(segunda.repetidas, 2);
    assert.equal(ing.contar(), 2);
  });

  test("mensagem sem jid ou sem id e ignorada, e a contagem mostra isso", () => {
    const ing = new Ingestao(abrirBanco());
    const r = aplicarUpsert(ing, {
      messages: [{ key: { remoteJid: "", id: "" }, message: {} }],
      type: "notify",
    });
    assert.equal(r.ignoradas, 1);
    assert.equal(ing.contar(), 0);
  });

  test("audio agenda transcricao; ambos ficam em quarentena antes do projeto", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    const fila = new Fila(db);
    aplicarUpsert(ing, { messages: [audio("A2"), texto("T2")], type: "notify" });
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM etapas WHERE etapa='transcricao'").get().n), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM etapas WHERE etapa='analise'").get().n), 2);
    assert.equal(fila.prontos("transcricao", { projetoId: "nao-roteado" }).length, 0);
    assert.equal(fila.prontos("analise", { projetoId: "nao-roteado" }).length, 0);
  });

  test("persistir nao autoriza nada: a conversa continua sem permissao de envio", () => {
    const db = abrirBanco();
    aplicarUpsert(new Ingestao(db), { messages: [texto("X1")], type: "notify" });
    assert.equal(new Politica(db).podeEnviar(DM).permitido, false);
  });
});

describe("eco do bot x intervencao humana", () => {
  test("fromMe cujo id consta como saida enviada e eco do bot, e nao pausa", async () => {
    const db = abrirBanco();
    const p = new Politica(db);
    const s = new Saidas(db, p);
    p.definir(DM, "atender", { decididoPor: "dono:fabricio" });
    s.preparar({ conversaId: DM, corpo: "resposta", idempotencia: "k1" });
    await s.enviar("k1", async () => "WAMSG-ECO");

    const c = classificarFromMe(db, { key: { id: "WAMSG-ECO", fromMe: true } });
    assert.equal(c.doProprioBot, true);
    assert.equal(p.registrarIntervencaoHumana(DM, c).pausou, false);
    assert.equal(p.regra(DM).modo, "atender");
  });

  test("fromMe desconhecido e o Fabricio digitando: pausa a conversa", () => {
    const db = abrirBanco();
    const p = new Politica(db);
    p.definir(DM, "atender", { decididoPor: "dono:fabricio" });
    const c = classificarFromMe(db, { key: { id: "WAMSG-HUMANO", fromMe: true } });
    assert.equal(c.doProprioBot, false);
    assert.equal(p.registrarIntervencaoHumana(DM, c).pausou, true);
    assert.equal(p.podeEnviar(DM).permitido, false);
  });
});

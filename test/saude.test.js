import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { abrirBanco } from "../src/banco.js";
import { Ingestao } from "../src/ingestao.js";
import { Fila } from "../src/etapas.js";
import { snapshot, batimento, deveBater, LIMITES } from "../src/saude.js";
import { Vigia } from "../src/vigia.js";
import { Punk } from "../src/punk.js";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DM = "5511999@s.whatsapp.net";
const ev = (id) => ({ conversaId: DM, origemId: id, tipo: "texto", bruto: {}, texto: "oi" });

describe("saude por etapa", () => {
  test("conversa quieta e 'sem_dados', nao falha", () => {
    const db = abrirBanco();
    const s = snapshot(db);
    assert.equal(s.etapas.analise.estado, "sem_dados");
    assert.equal(s.veredito, "ok", "silencio nao e queda");
  });

  test("processo vivo com analise travada NAO pode reportar saude", () => {
    const db = abrirBanco();
    const ing = new Ingestao(db);
    const fila = new Fila(db);
    const t0 = new Date("2026-09-03T12:00:00Z");
    const { id } = ing.registrar(ev("M1"), ["analise"]);
    fila.iniciar(id, "analise", t0);
    fila.falhar(id, "analise", "modelo fora do ar", t0);

    batimento(db, "principal", { agora: t0 });                       // processo vivo
    const depois = new Date(t0.getTime() + LIMITES.atrasoMaximoMs + 60_000);
    const s = snapshot(db, depois);

    assert.equal(s.batimentos[0].vivo, false);
    assert.equal(s.etapas.analise.estado, "degradada");
    assert.equal(s.veredito, "degradado");
    assert.ok(s.motivos.some((m) => m.includes("analise")));
  });

  test("entrega ao Punk com falha impede veredito ok", () => {
    const raiz = mkdtempSync(join(tmpdir(), "punk-saude-"));
    const db = abrirBanco();
    const punk = new Punk(db, raiz);
    mkdirSync(join(raiz, "trava.md"), { recursive: true });
    assert.throws(() => punk.entregar({ referencia: "x", caminhoRelativo: "trava.md", corpo: "c" }));
    const s = snapshot(db);
    assert.equal(s.entregasPunkComFalha, 1);
    assert.equal(s.veredito, "degradado");
  });

  test("evento antigo sem projeto degrada a saude como quarentena", () => {
    const db = abrirBanco();
    const t0 = new Date("2026-09-03T12:00:00Z");
    new Ingestao(db).registrar({ ...ev("Q-SAude"), recebidoEm: t0 }, ["analise"]);
    const depois = new Date(t0.getTime() + LIMITES.atrasoMaximoMs + 1);
    const s = snapshot(db, depois);
    assert.equal(s.quarentena.pendentes, 1);
    assert.equal(s.veredito, "degradado");
    assert.ok(s.motivos.some((m) => m.includes("quarentena")));
  });
});

describe("vigia independente", () => {
  test("batimento parado gera alarme uma vez e recuperacao depois", async () => {
    const db = abrirBanco();
    const avisos = [];
    const vigia = new Vigia(db, { avisar: async (a) => avisos.push(a) });
    const t0 = new Date("2026-09-03T12:00:00Z");

    batimento(db, "principal", { agora: t0 });
    assert.deepEqual(await vigia.verificar(t0), [], "vivo nao alarma");

    const morto = new Date(t0.getTime() + LIMITES.batimentoMs + 1000);
    assert.equal((await vigia.verificar(morto)).length, 1, "alarma na primeira deteccao");
    assert.equal((await vigia.verificar(morto)).length, 0, "nao repete o mesmo alarme");
    assert.equal(avisos[0].tipo, "queda");
    assert.equal(avisos[0].componente, "principal");

    batimento(db, "principal", { agora: morto });
    const emitidos = await vigia.verificar(new Date(morto.getTime() + 1000));
    assert.equal(emitidos[0].tipo, "recuperacao");
  });

  test("o vigia exige canal de aviso externo injetado", () => {
    const db = abrirBanco();
    assert.throws(() => new Vigia(db, {}), /canal de aviso externo/);
  });

  test("o vigia le o batimento de fora: matar o processo principal nao o silencia", async () => {
    // O processo principal escreve o batimento; o vigia le do banco. Nao ha
    // temporizador dentro do processo vigiado (achado A01 / REL-03).
    const db = abrirBanco();
    const avisos = [];
    const vigia = new Vigia(db, { avisar: async (a) => avisos.push(a) });
    const t0 = new Date("2026-09-03T12:00:00Z");
    batimento(db, "principal", { pid: 4242, agora: t0 });
    // "processo morto": ninguem mais escreve batimento.
    await vigia.verificar(new Date(t0.getTime() + 10 * 60_000));
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].tipo, "queda");
  });
});

describe("vigia com estado persistido", () => {
  test("um vigia NOVO nao repete o alarme de uma queda ja avisada", async () => {
    // Regressao do teste de queda real de 03/09/2026: com o estado em memoria,
    // cada rodada de cron avisava de novo a mesma queda.
    const db = abrirBanco();
    const avisos = [];
    const canal = async (a) => avisos.push(a);
    const t0 = new Date("2026-09-03T12:00:00Z");
    batimento(db, "principal", { agora: t0 });
    const morto = new Date(t0.getTime() + LIMITES.batimentoMs + 1000);

    assert.equal((await new Vigia(db, { avisar: canal }).verificar(morto)).length, 1);
    assert.equal((await new Vigia(db, { avisar: canal }).verificar(morto)).length, 0);
    assert.equal((await new Vigia(db, { avisar: canal }).verificar(morto)).length, 0);
    assert.equal(avisos.length, 1);
  });

  test("canal de aviso quebrado nao vira alarme repetido na rodada seguinte", async () => {
    const db = abrirBanco();
    const t0 = new Date("2026-09-03T12:00:00Z");
    batimento(db, "principal", { agora: t0 });
    const morto = new Date(t0.getTime() + LIMITES.batimentoMs + 1000);
    const quebrado = new Vigia(db, { avisar: async () => { throw new Error("sem rede"); } });
    await assert.rejects(() => quebrado.verificar(morto));
    let n = 0;
    await new Vigia(db, { avisar: async () => { n++; } }).verificar(morto);
    assert.equal(n, 0, "a queda ja esta marcada como alarmada");
  });
});

describe("batimento so vale enquanto ingere", () => {
  const boot = 1_000;
  test("conectada bate", () => {
    assert.equal(deveBater("conectada", 9_999, boot), true);
  });
  test("socket morto com processo vivo NAO bate -- foi a cegueira de 10/09", () => {
    for (const estado of ["reconectando", "desconectada", "auth_invalida", "aguardando_qr", "erro"]) {
      assert.equal(deveBater(estado, 9_999, boot), false, `${estado} nao podia bater`);
    }
  });
  test("folga de boot cobre a primeira conexao, mas expira", () => {
    assert.equal(deveBater("conectando", 500, boot), true);
    assert.equal(deveBater("conectando", 1_000, boot), false);
  });
});

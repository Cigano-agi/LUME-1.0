import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdaptadorAgy,
  ExecucaoAgyInvalida,
  ambienteMinimo,
  interpretarJsonl,
  montarComando,
} from "../src/agy.js";

function raizTemporaria() {
  return mkdtempSync(join(tmpdir(), "assessor-agy-"));
}

function manifesto(raiz = raizTemporaria()) {
  return {
    projetoId: "cliente/site",
    cliente: "Cliente",
    nome: "Site",
    raizesPermitidas: [raiz.replaceAll("\\", "/")],
    negarPorPadrao: true,
  };
}

function linha(evento) {
  return JSON.stringify(evento);
}

describe("adaptador AGY", () => {
  test("monta uma execucao confinada sem opcoes perigosas", () => {
    const raiz = raizTemporaria();
    const { arquivo, argumentos, cwd } = montarComando({
      executavel: "agy.exe",
      manifesto: manifesto(raiz),
      tarefa: "Leia briefing.md e devolva o diagnostico.",
    });

    assert.equal(arquivo, "agy.exe");
    assert.equal(cwd.replaceAll("\\", "/"), raiz.replaceAll("\\", "/"));
    assert.ok(argumentos.includes("--sandbox"));
    assert.ok(argumentos.includes("--new-project"));
    assert.ok(argumentos.includes("--disable-slash-commands"));
    assert.ok(argumentos.includes("stream-json"));
    assert.ok(argumentos.includes("assessor-executor"));
    assert.ok(argumentos.includes("plan"));
    assert.ok(argumentos.includes("600s"));
    assert.equal(argumentos.includes("--json-schema"), false);
    assert.equal(argumentos.includes("--dangerously-skip-permissions"), false);
    assert.equal(argumentos.includes("--add-dir"), false);
    assert.equal(argumentos.includes("--project"), false);
  });

  test("recusa manifesto com mais de uma raiz", () => {
    const a = raizTemporaria();
    const b = raizTemporaria();
    assert.throws(() => montarComando({
      executavel: "agy.exe",
      manifesto: { ...manifesto(a), raizesPermitidas: [a, b] },
      tarefa: "oi",
    }), /exatamente uma raiz/);
  });

  test("recusa sucesso vazio", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({ event: "result", result: { status: "SUCCESS", response: "" } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /resposta vazia/);
  });

  test("recusa erro intermediario mesmo quando o resultado diz sucesso", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({ event: "step_update", step_update: { state: "ERROR", step_type: "tool", tool_name: "view_file" } }),
      linha({ event: "result", result: { status: "SUCCESS", response: "{}" } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /etapa terminou em ERROR/);
  });

  test("recusa ferramenta fora da politica", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({ event: "step_update", step_update: { state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool" } }),
      linha({ event: "result", result: { status: "SUCCESS", response: "{}" } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /ferramenta proibida/);
  });

  test("aceita busca local de nome como ferramenta somente de leitura", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const resposta = { status: "concluido", resumo: "ok", evidencias: ["busca local"], arquivos: [], proximaAcao: "fim" };
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({ event: "step_update", step_update: { state: "DONE", step_type: "tool", tool_name: "find_by_name" } }),
      linha({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(resposta) } }),
    ].join("\n");
    assert.deepEqual(interpretarJsonl(saida, { raiz }).auditoria.ferramentasUsadas, ["find_by_name"]);
  });

  test("interrompe ferramenta permitida quando o argumento aponta para fora da raiz", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const fora = raizTemporaria().replaceAll("\\", "/");
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "find_by_name",
          tool_info: { parameters: { SearchDirectory: fora, Pattern: "*.md" } },
        },
      }),
      linha({ event: "result", result: { status: "SUCCESS", response: "{}" } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /caminho fora da raiz/);
  });

  test("aceita argumento de caminho que permanece dentro da raiz", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const resposta = { status: "concluido", resumo: "ok", evidencias: ["arquivo lido"], arquivos: [], proximaAcao: "fim" };
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { parameters: { AbsolutePath: `${raiz}/permitido.txt` } },
        },
      }),
      linha({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(resposta) } }),
    ].join("\n");
    assert.equal(interpretarJsonl(saida, { raiz }).status, "concluido");
  });

  test("recusa junction dentro da raiz quando o destino fisico fica fora", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const fora = raizTemporaria();
    const destino = join(fora, "segredo");
    const atalho = join(raiz, "atalho");
    mkdirSync(destino);
    symlinkSync(destino, atalho, process.platform === "win32" ? "junction" : "dir");
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "list_dir",
          tool_info: { parameters: { DirectoryPath: atalho } },
        },
      }),
      linha({ event: "result", result: { status: "SUCCESS", response: "{}" } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /destino fisico fora da raiz/);
  });

  test("modo de edicao permanece bloqueado ate ganhar prova operacional", () => {
    assert.throws(() => montarComando({
      executavel: "agy.exe",
      manifesto: manifesto(),
      tarefa: "edite",
      mode: "accept-edits",
    }), /edicao AGY ainda nao habilitada/);
  });

  test("status concluido exige pelo menos uma evidencia", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const resposta = { status: "concluido", resumo: "confie em mim", evidencias: [], arquivos: [], proximaAcao: "fim" };
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(resposta) } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /concluido exige evidencia/);
  });

  test("ambiente minimo remove segredos arbitrarios do processo pai", () => {
    const limpo = ambienteMinimo({
      PATH: "C:/Windows",
      USERPROFILE: "C:/Users/Teste",
      TEMP: "C:/Temp",
      OPENAI_API_KEY: "segredo",
      TOKEN_CLIENTE_X: "segredo-2",
    });
    assert.equal(limpo.PATH, "C:/Windows");
    assert.equal(limpo.USERPROFILE, "C:/Users/Teste");
    assert.equal(limpo.OPENAI_API_KEY, undefined);
    assert.equal(limpo.TOKEN_CLIENTE_X, undefined);
  });

  test("grep_search nao escapa por SearchPath", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const fora = raizTemporaria().replaceAll("\\", "/");
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "grep_search",
          tool_info: { parameters: { SearchPath: fora, Query: "segredo" } },
        },
      }),
      linha({ event: "result", result: { status: "SUCCESS", response: "{}" } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /caminho fora da raiz/);
  });

  test("concluido exige ferramenta que tenha terminado", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const resposta = { status: "concluido", resumo: "feito", evidencias: ["feito"], arquivos: [], proximaAcao: "fim" };
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: [] } }),
      linha({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(resposta) } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /ferramenta concluida/);
  });

  test("recusa quando o AGY iniciou fora da raiz canonica", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const outra = raizTemporaria().replaceAll("\\", "/");
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: outra, tools: [] } }),
      linha({ event: "result", result: { status: "SUCCESS", response: "{}" } }),
    ].join("\n");
    assert.throws(() => interpretarJsonl(saida, { raiz }), /cwd inesperado/);
  });

  test("aceita resposta estruturada completa e preserva evidencias de auditoria", () => {
    const raiz = raizTemporaria().replaceAll("\\", "/");
    const resposta = {
      status: "concluido",
      resumo: "Briefing analisado",
      evidencias: ["briefing.md:1"],
      arquivos: [],
      proximaAcao: "revisar",
    };
    const saida = [
      linha({ event: "init", conversation_id: "c1", init: { cwd: raiz, tools: ["view_file"] } }),
      linha({ event: "step_update", step_update: { state: "DONE", step_type: "tool", tool_name: "view_file" } }),
      linha({ event: "result", result: { conversation_id: "c1", status: "SUCCESS", response: JSON.stringify(resposta), usage: { total_tokens: 42 } } }),
    ].join("\n");

    assert.deepEqual(interpretarJsonl(saida, { raiz }), {
      ...resposta,
      auditoria: {
        conversaId: "c1",
        uso: { total_tokens: 42 },
        ferramentasUsadas: ["view_file"],
        ferramentasConcluidas: ["view_file"],
      },
    });
  });

  test("propaga falha do processo e nao interpreta stdout parcial", async () => {
    const adaptador = new AdaptadorAgy({
      executavel: "agy.exe",
      executar: async () => ({ codigo: 9, stdout: "parcial", stderr: "falhou" }),
    });
    await assert.rejects(
      () => adaptador.executar({ manifesto: manifesto(), tarefa: "oi" }),
      (erro) => erro instanceof ExecucaoAgyInvalida && /codigo 9/.test(erro.message),
    );
  });
});

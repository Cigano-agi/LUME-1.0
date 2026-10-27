import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FERRAMENTAS_LEITURA = new Set(["view_file", "list_dir", "grep_search", "find_by_name"]);

const VARIAVEIS_AMBIENTE_AGY = new Set([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
  "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "LANG", "LC_ALL", "TERM",
]);
export class ExecucaoAgyInvalida extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = "ExecucaoAgyInvalida";
  }
}

export function ambienteMinimo(fonte = process.env) {
  return Object.fromEntries(Object.entries(fonte).filter(([chave]) => VARIAVEIS_AMBIENTE_AGY.has(chave)));
}

function caminhoComparavel(caminho) {
  const normal = resolve(String(caminho)).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normal.toLowerCase() : normal;
}

function estaDentro(raiz, caminho) {
  const base = caminhoComparavel(raiz);
  const alvo = caminhoComparavel(resolve(raiz, String(caminho)));
  return alvo === base || alvo.startsWith(`${base}/`);
}

function destinoFisico(caminho) {
  let existente = resolve(caminho);
  while (!existsSync(existente)) {
    const pai = dirname(existente);
    if (pai === existente) break;
    existente = pai;
  }
  return realpathSync.native(existente);
}

function conferirCaminhosDaFerramenta(etapa, raiz) {
  const parametros = etapa?.tool_info?.parameters;
  if (!parametros || !raiz) return;
  const chavesDeCaminho = new Set(["absolutepath", "directorypath", "searchdirectory", "searchpath", "cwd", "path"]);
  for (const [chave, valor] of Object.entries(parametros)) {
    if (!chavesDeCaminho.has(chave.toLowerCase()) || typeof valor !== "string") continue;
    if (!estaDentro(raiz, valor)) {
      throw new ExecucaoAgyInvalida(`ferramenta ${etapa.tool_name} tentou caminho fora da raiz`);
    }
    if (!estaDentro(raiz, destinoFisico(resolve(raiz, valor)))) {
      throw new ExecucaoAgyInvalida(`ferramenta ${etapa.tool_name} tentou destino fisico fora da raiz`);
    }
  }
}

function raizUnica(manifesto) {
  if (!manifesto?.negarPorPadrao || manifesto.raizesPermitidas?.length !== 1) {
    throw new ExecucaoAgyInvalida("manifesto precisa negar por padrao e ter exatamente uma raiz");
  }
  const declarada = String(manifesto.raizesPermitidas[0]);
  let fisica;
  try {
    fisica = realpathSync.native(declarada);
  } catch (erro) {
    throw new ExecucaoAgyInvalida(`raiz do projeto indisponivel: ${erro.message}`);
  }
  if (caminhoComparavel(fisica) !== caminhoComparavel(declarada)) {
    throw new ExecucaoAgyInvalida("raiz fisica divergiu do manifesto; gere um manifesto novo");
  }
  return fisica;
}

function politica(mode) {
  if (mode === "plan") return FERRAMENTAS_LEITURA;
  if (mode === "accept-edits") throw new ExecucaoAgyInvalida("edicao AGY ainda nao habilitada sem prova operacional");
  throw new ExecucaoAgyInvalida(`modo AGY invalido: ${mode}`);
}

function promptDaTarefa(manifesto, tarefa, mode) {
  return [
    `Projeto autorizado: ${manifesto.projetoId} (${manifesto.cliente} / ${manifesto.nome}).`,
    `Modo: ${mode}. Trabalhe somente no diretório atual e nunca tente acessar caminhos externos.`,
    "Não use navegador, MCP, mensagens, agendamentos ou subagentes.",
    "Não declare sucesso sem evidência verificável. Se uma ferramenta falhar, responda bloqueado ou falhou.",
    "Responda uma única vez e estritamente neste formato, sem outras chaves ou bloco markdown:",
    '{"status":"concluido|bloqueado|falhou","resumo":"...","evidencias":["..."],"arquivos":["..."],"proximaAcao":"..."}',
    "",
    `Tarefa: ${String(tarefa)}`,
  ].join("\n");
}

export function montarComando({ executavel, manifesto, tarefa, mode = "plan", agente = "assessor-executor" }) {
  if (!tarefa || !String(tarefa).trim()) throw new ExecucaoAgyInvalida("tarefa AGY vazia");
  politica(mode);
  const cwd = raizUnica(manifesto);
  return {
    arquivo: executavel,
    cwd,
    argumentos: [
      "--new-project",
      "--agent", agente,
      "--effort", "low",
      "--mode", mode,
      "--sandbox",
      "--disable-slash-commands",
      "--output-format", "stream-json",
      "--print-timeout", "600s",
      "--print", promptDaTarefa(manifesto, tarefa, mode),
    ],
  };
}

function eventosJsonl(stdout) {
  return String(stdout).split(/\r?\n/).filter((x) => x.trim()).map((linha, indice) => {
    try {
      return JSON.parse(linha);
    } catch {
      throw new ExecucaoAgyInvalida(`saida AGY invalida na linha ${indice + 1}`);
    }
  });
}

function validarResposta(resposta) {
  if (!resposta || typeof resposta !== "object" || Array.isArray(resposta)) {
    throw new ExecucaoAgyInvalida("resposta final nao e um objeto JSON");
  }
  if (!["concluido", "bloqueado", "falhou"].includes(resposta.status)) {
    throw new ExecucaoAgyInvalida("status estruturado invalido");
  }
  for (const campo of ["resumo", "proximaAcao"]) {
    if (typeof resposta[campo] !== "string") throw new ExecucaoAgyInvalida(`campo ${campo} invalido`);
  }
  for (const campo of ["evidencias", "arquivos"]) {
    if (!Array.isArray(resposta[campo]) || resposta[campo].some((x) => typeof x !== "string")) {
      throw new ExecucaoAgyInvalida(`campo ${campo} invalido`);
    }
  }
  if (resposta.status === "concluido" && resposta.evidencias.length === 0) {
    throw new ExecucaoAgyInvalida("status concluido exige evidencia");
  }
  return resposta;
}

function conferirEvento(evento, permitidas, raiz = null) {
  const etapa = evento?.event === "step_update" ? evento.step_update : null;
  if (!etapa) return null;
  if (["ERROR", "CANCELLED"].includes(etapa.state)) {
    throw new ExecucaoAgyInvalida(`etapa terminou em ${etapa.state}`);
  }
  if (etapa.tool_name && !permitidas.has(etapa.tool_name)) {
    throw new ExecucaoAgyInvalida(`ferramenta proibida: ${etapa.tool_name}`);
  }
  conferirCaminhosDaFerramenta(etapa, raiz);
  return etapa.tool_name ?? null;
}

export function interpretarJsonl(stdout, { raiz, mode = "plan" }) {
  const permitidas = politica(mode);
  const eventos = eventosJsonl(stdout);
  const init = eventos.find((x) => x.event === "init");
  if (!init?.init?.cwd) throw new ExecucaoAgyInvalida("evento init ausente");
  if (caminhoComparavel(init.init.cwd) !== caminhoComparavel(raiz)) {
    throw new ExecucaoAgyInvalida(`cwd inesperado: ${init.init.cwd}`);
  }

  const ferramentasUsadas = [];
  const ferramentasConcluidas = [];
  for (const evento of eventos) {
    const ferramenta = conferirEvento(evento, permitidas, raiz);
    if (ferramenta && !ferramentasUsadas.includes(ferramenta)) ferramentasUsadas.push(ferramenta);
    if (ferramenta && evento.step_update?.state === "DONE" && !ferramentasConcluidas.includes(ferramenta)) {
      ferramentasConcluidas.push(ferramenta);
    }
  }

  const finais = eventos.filter((x) => x.event === "result");
  if (finais.length !== 1) throw new ExecucaoAgyInvalida("resultado final AGY ausente ou duplicado");
  const final = finais[0].result;
  if (final?.status !== "SUCCESS") throw new ExecucaoAgyInvalida(`resultado AGY: ${final?.status ?? "ausente"}`);
  if (!final.response || !String(final.response).trim()) throw new ExecucaoAgyInvalida("resposta vazia apesar de SUCCESS");

  let resposta;
  try {
    resposta = JSON.parse(final.response);
  } catch {
    throw new ExecucaoAgyInvalida("resposta final nao respeitou JSON estruturado");
  }
  validarResposta(resposta);
  if (resposta.status === "concluido" && ferramentasConcluidas.length === 0) {
    throw new ExecucaoAgyInvalida("status concluido exige ferramenta concluida");
  }
  return {
    ...resposta,
    auditoria: {
      conversaId: final.conversation_id ?? init.conversation_id,
      uso: final.usage ?? null,
      ferramentasUsadas,
      ferramentasConcluidas,
    },
  };
}

export function executarProcesso({ arquivo, argumentos, cwd, timeoutMs = 620_000, aoEvento = null }) {
  return new Promise((resolvePromise, reject) => {
    const processo = spawn(arquivo, argumentos, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: ambienteMinimo(),
    });
    let stdout = "";
    let stderr = "";
    let pendente = "";
    let violacao = null;
    const timer = setTimeout(() => {
      violacao = new ExecucaoAgyInvalida("tempo limite da execucao AGY excedido");
      processo.kill();
    }, timeoutMs);

    processo.stdout.setEncoding("utf8");
    processo.stderr.setEncoding("utf8");
    processo.stdout.on("data", (trecho) => {
      stdout += trecho;
      pendente += trecho;
      const linhas = pendente.split(/\r?\n/);
      pendente = linhas.pop() ?? "";
      for (const linha of linhas.filter((x) => x.trim())) {
        try {
          aoEvento?.(JSON.parse(linha));
        } catch (erro) {
          violacao = erro;
          processo.kill();
          break;
        }
      }
    });
    processo.stderr.on("data", (trecho) => { stderr += trecho; });
    processo.on("error", (erro) => {
      clearTimeout(timer);
      reject(new ExecucaoAgyInvalida(`nao foi possivel iniciar AGY: ${erro.message}`));
    });
    processo.on("close", (codigo) => {
      clearTimeout(timer);
      if (violacao) return reject(violacao);
      resolvePromise({ codigo, stdout, stderr });
    });
  });
}

export class AdaptadorAgy {
  #executavel;
  #executar;
  constructor({ executavel, executar = executarProcesso }) {
    this.#executavel = executavel;
    this.#executar = executar;
  }

  async executar({ manifesto, tarefa, mode = "plan" }) {
    const comando = montarComando({ executavel: this.#executavel, manifesto, tarefa, mode });
    const permitidas = politica(mode);
    const resultado = await this.#executar({
      ...comando,
      aoEvento: (evento) => conferirEvento(evento, permitidas, comando.cwd),
    });
    if (resultado.codigo !== 0) {
      throw new ExecucaoAgyInvalida(`processo AGY terminou com codigo ${resultado.codigo}: ${resultado.stderr}`);
    }
    return interpretarJsonl(resultado.stdout, { raiz: comando.cwd, mode });
  }
}

// Motor de modelo, com dois backends atrás da mesma interface.
//
// Até 09/2026 o único caminho era `agy.exe`, a CLI Gemini de dentro do Orca. Isso
// funciona nesta máquina e não funciona na do sócio: o agy é ferramenta interna, não
// se instala sozinho e tem autenticação própria. Para a caixa que vai embalada, o mesmo
// pedido passa a sair pela API pública do Gemini, com chave que cada pessoa cria em
// https://aistudio.google.com/apikey .
//
// A escolha nunca é silenciosa: `motorAtivo()` diz qual dos dois está valendo e
// `bin/diagnostico.js` imprime isso antes de qualquer coisa rodar. Com `GEMINI_API_KEY`
// no ambiente vale a API; sem ela cai no agy como era antes — e por isso a máquina do
// Fabrício continua funcionando exatamente igual, sem migração e sem regressão.

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, resolve as resolverCaminho } from 'node:path';

const RAIZ_API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * O agy aceita sufixo de nível de raciocínio no nome do modelo
 * (`gemini-3.8-flash-medium`). A API pública não conhece esse sufixo e devolve 404.
 * Normalizar aqui deixa todos os chamadores existentes intactos.
 */
export function modeloDaApi(nome) {
  return String(nome ?? '').replace(/-(low|medium|high)$/i, '');
}

export function chaveApi() {
  const k = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  return k.trim() || null;
}

/** `api` | `agy`. Respeita `ASSESSOR_LLM` quando alguém quer forçar um dos dois. */
export function motorAtivo() {
  const forcado = String(process.env.ASSESSOR_LLM ?? '').trim().toLowerCase();
  if (forcado === 'api' || forcado === 'agy') return forcado;
  return chaveApi() ? 'api' : 'agy';
}

function binarioAgy() {
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}

// ---------------------------------------------------------------- JSON estruturado

/**
 * Pede ao modelo um JSON que obedece `schema` (objeto, não caminho de arquivo).
 * Devolve `{ dados, uso }` com `uso.total_tokens` em ambos os backends, porque é isso
 * que `bin/crm.js` soma para estimar custo.
 */
export async function gerarJson(prompt, { schema, modelo = 'gemini-3.8-flash-medium', timeoutMs = 540000 } = {}) {
  if (!schema || typeof schema !== 'object') throw new TypeError('schema obrigatorio');
  return motorAtivo() === 'api'
    ? gerarJsonPelaApi(prompt, { schema, modelo, timeoutMs })
    : gerarJsonPeloAgy(prompt, { schema, modelo, timeoutMs });
}

async function gerarJsonPelaApi(prompt, { schema, modelo, timeoutMs }) {
  const corpo = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: limparSchema(schema)
    }
  };
  const env = await pedirApi(modeloDaApi(modelo), corpo, timeoutMs);
  const texto = primeiroTexto(env);
  if (!texto) throw new Error(`resposta da API sem texto: ${motivoDeParada(env)}`);
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    // Com responseSchema isto praticamente não acontece; quando acontece é corte por
    // limite de saída, e o pedaço de JSON truncado precisa aparecer no erro.
    throw new Error(`resposta da API nao e JSON (${motivoDeParada(env)}): ${texto.slice(0, 200)}`);
  }
  return { dados, uso: usoDaApi(env) };
}

async function gerarJsonPeloAgy(prompt, { schema, modelo, timeoutMs }) {
  // O agy lê o schema de arquivo. Escrevemos num temporário exclusivo desta chamada
  // para duas execuções simultâneas não disputarem o mesmo caminho.
  const caminhoSchema = resolverCaminho(tmpdir(), `assessor-schema-${process.pid}-${Date.now()}.json`);
  writeFileSync(caminhoSchema, JSON.stringify(schema, null, 2));
  try {
    return await new Promise((ok, falhar) => {
      const args = [
        '--model', modelo,
        '--output-format', 'json',
        '--json-schema', caminhoSchema,
        '--disable-slash-commands',
        '--print-timeout', '8m',
        `--print=${prompt}`
      ];
      // Sem `shell: true`: com shell o prompt passaria por interpretação de aspas e
      // cifrões do cmd, e o texto vem de mensagens de terceiros.
      const proc = spawn(binarioAgy(), args, { windowsHide: true });
      let saida = '', erro = '';
      const timer = setTimeout(() => { proc.kill(); falhar(new Error('timeout do worker Gemini')); }, timeoutMs);
      proc.stdout.on('data', d => { saida += d; });
      proc.stderr.on('data', d => { erro += d; });
      proc.on('error', e => { clearTimeout(timer); falhar(erroDeAgyAusente(e)); });
      proc.on('close', codigo => {
        clearTimeout(timer);
        if (codigo !== 0) return falhar(new Error(`agy saiu com ${codigo}: ${erro.slice(0, 300)}`));
        try {
          ok(interpretarSaidaAgy(saida));
        } catch (e) {
          falhar(e);
        }
      });
    });
  } finally {
    try { unlinkSync(caminhoSchema); } catch { /* temporário some no reboot de qualquer forma */ }
  }
}

/**
 * Interpreta a saída em texto do binário agy.
 *
 * O agy desiste sozinho aos 5 min e sai com código 0, devolvendo texto em vez
 * de JSON: "print timeout after 5m0s with turn in progress; returning partial
 * output". Sem reconhecer isso, a falha vira "resposta nao e JSON" e ninguém
 * descobre que o modelo ainda estava trabalhando quando foi cortado (A6).
 */
export function interpretarSaidaAgy(saida) {
  if (/print timeout after .* turn in progress/i.test(saida)) {
    throw new Error('Gemini cortado pelo timeout interno do agy com o turno em andamento: lote grande demais');
  }
  try {
    const env = JSON.parse(saida);
    return { dados: env?.structured_output ?? null, uso: env?.usage ?? null };
  } catch {
    throw new Error(`resposta do agy nao e JSON: ${String(saida ?? '').slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------- transcrição

/**
 * Transcreve um arquivo de áudio. Devolve `{ texto, duracaoMs }` — `texto` cru, sem
 * limpeza: quem limpa é `limparTranscricao()` em `src/transcricao.js`, que já sabe
 * reconhecer "(sem fala)" e o preâmbulo que o modelo às vezes inventa.
 */
export async function transcreverAudio(caminho, { instrucao, modelo = 'gemini-3.8-flash-medium', timeoutMs = 300000 } = {}) {
  return motorAtivo() === 'api'
    ? transcreverPelaApi(caminho, { instrucao, modelo, timeoutMs })
    : transcreverPeloAgy(caminho, { instrucao, modelo, timeoutMs });
}

// Áudio do WhatsApp é .opus dentro de container ogg. A API aceita os dois rótulos;
// mandamos o que corresponde à extensão real para não depender de adivinhação do lado
// deles. Fonte: https://ai.google.dev/gemini-api/docs/audio
const TIPOS_DE_AUDIO = {
  '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.mp3': 'audio/mp3', '.m4a': 'audio/m4a', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.webm': 'audio/webm',
  '.mpeg': 'audio/mpeg', '.mpga': 'audio/mpeg', '.aiff': 'audio/aiff'
};

// Limite da requisição inline é 20 MB somando tudo. Áudio de WhatsApp raramente passa
// de 1 MB, então não vale a complexidade da File API — mas o erro precisa dizer o que
// houve em vez de devolver 400 cru do Google.
const LIMITE_INLINE_BYTES = 18 * 1024 * 1024;

async function transcreverPelaApi(caminho, { instrucao, modelo, timeoutMs }) {
  const t0 = Date.now();
  const tipo = TIPOS_DE_AUDIO[extname(caminho).toLowerCase()];
  if (!tipo) throw new Error(`extensao de audio nao suportada: ${basename(caminho)}`);
  const bytes = await readFile(caminho);
  if (bytes.length > LIMITE_INLINE_BYTES) {
    throw new Error(`audio de ${(bytes.length / 1048576).toFixed(1)} MB passa do limite inline de 18 MB: ${basename(caminho)}`);
  }
  const corpo = {
    contents: [{
      role: 'user',
      parts: [
        { text: instrucao },
        { inlineData: { mimeType: tipo, data: bytes.toString('base64') } }
      ]
    }]
  };
  const env = await pedirApi(modeloDaApi(modelo), corpo, timeoutMs);
  return { texto: primeiroTexto(env) ?? '', duracaoMs: Date.now() - t0 };
}

function transcreverPeloAgy(caminho, { instrucao, modelo, timeoutMs }) {
  const dir = resolverCaminho(caminho, '..');
  return new Promise((ok, falhar) => {
    const args = [
      '--model', modelo,
      '--add-dir', dir,
      '--disable-slash-commands',
      `--print=${instrucao}\n\nArquivo: ${basename(caminho)}`
    ];
    const proc = spawn(binarioAgy(), args, { windowsHide: true });
    let saida = '', erro = '';
    const t0 = Date.now();
    const timer = setTimeout(() => { proc.kill(); falhar(new Error('timeout na transcricao')); }, timeoutMs);
    proc.stdout.on('data', d => { saida += d; });
    proc.stderr.on('data', d => { erro += d; });
    proc.on('error', e => { clearTimeout(timer); falhar(erroDeAgyAusente(e)); });
    proc.on('close', codigo => {
      clearTimeout(timer);
      if (codigo !== 0) return falhar(new Error(`agy saiu com ${codigo}: ${erro.slice(0, 200)}`));
      ok({ texto: saida, duracaoMs: Date.now() - t0 });
    });
  });
}

// --------------------------------------------------------------------- infraestrutura

/**
 * `spawn` de binário inexistente devolve ENOENT, que em Git Bash aparece como
 * "Permission denied" e manda todo mundo caçar permissão de arquivo. Na caixa do sócio
 * este é o erro mais provável de todos, então ele diz a saída em vez do sintoma.
 */
function erroDeAgyAusente(e) {
  if (e?.code !== 'ENOENT') return e;
  return new Error(
    'agy nao encontrado no PATH e GEMINI_API_KEY nao esta definida. ' +
    'Crie a chave em https://aistudio.google.com/apikey e rode `node bin/diagnostico.js`.'
  );
}

async function pedirApi(modelo, corpo, timeoutMs) {
  const chave = chaveApi();
  if (!chave) throw new Error('GEMINI_API_KEY nao definida');
  let resposta;
  try {
    resposta = await fetch(`${RAIZ_API}/models/${encodeURIComponent(modelo)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Error(`timeout de ${Math.round(timeoutMs / 1000)}s na API do Gemini`);
    throw new Error(`falha de rede ao chamar a API do Gemini: ${e?.message ?? e}`);
  }
  if (!resposta.ok) {
    const detalhe = (await resposta.text().catch(() => '')).slice(0, 300);
    // 429 é a cota do plano gratuito. Quem está começando bate nela, e o erro do Google
    // fala de "quota metric" — inútil para quem acabou de instalar.
    if (resposta.status === 429) {
      throw new Error(`cota do Gemini esgotada (429). O plano gratuito tem limite por minuto e por dia: ${detalhe}`);
    }
    if (resposta.status === 400 && /API key not valid/i.test(detalhe)) {
      throw new Error('GEMINI_API_KEY invalida. Gere outra em https://aistudio.google.com/apikey');
    }
    throw new Error(`API do Gemini devolveu ${resposta.status}: ${detalhe}`);
  }
  return resposta.json();
}

function primeiroTexto(env) {
  const partes = env?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(partes)) return null;
  const texto = partes.map(p => p?.text ?? '').join('').trim();
  return texto || null;
}

function motivoDeParada(env) {
  return env?.candidates?.[0]?.finishReason ?? env?.promptFeedback?.blockReason ?? 'sem motivo declarado';
}

function usoDaApi(env) {
  const u = env?.usageMetadata;
  if (!u) return null;
  // `bin/crm.js` soma `uso.total_tokens`; a API chama de `totalTokenCount`. Traduzir
  // aqui evita que o relatório de custo zere silenciosamente no backend novo.
  return {
    total_tokens: u.totalTokenCount ?? 0,
    prompt_tokens: u.promptTokenCount ?? 0,
    output_tokens: u.candidatesTokenCount ?? 0
  };
}

/**
 * `responseSchema` do Gemini é um subconjunto do OpenAPI: chaves de JSON Schema como
 * `$schema`, `additionalProperties` e `definitions` fazem a requisição voltar 400.
 * Tiramos elas em vez de exigir que o chamador saiba dessa regra.
 */
export function limparSchema(no) {
  if (Array.isArray(no)) return no.map(limparSchema);
  if (!no || typeof no !== 'object') return no;
  const PERMITIDAS = new Set([
    'type', 'format', 'description', 'nullable', 'enum', 'items',
    'properties', 'required', 'propertyOrdering', 'minItems', 'maxItems'
  ]);
  const saida = {};
  for (const [chave, valor] of Object.entries(no)) {
    if (!PERMITIDAS.has(chave)) continue;
    saida[chave] = (chave === 'properties')
      ? Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, limparSchema(v)]))
      : limparSchema(valor);
  }
  return saida;
}

/**
 * Lista os modelos que a chave realmente enxerga. Serve ao instalador: em vez de
 * cravar um nome que vai envelhecer, o `bin/diagnostico.js` pergunta ao Google quais
 * existem hoje e escolhe entre os que voltaram.
 */
export async function listarModelos() {
  const chave = chaveApi();
  if (!chave) throw new Error('GEMINI_API_KEY nao definida');
  let r;
  try {
    r = await fetch(`${RAIZ_API}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': chave },
      signal: AbortSignal.timeout(30000)
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Error('A API do Gemini nao respondeu em 30s. Confira sua internet.');
    throw new Error(`Nao consegui falar com a API do Gemini: ${e?.message ?? e}`);
  }
  if (!r.ok) {
    // Esta mensagem vai direto para a tela de quem esta instalando. O JSON cru do Google
    // fala de "INVALID_ARGUMENT" e "quota metric" -- inutil para quem acabou de colar uma
    // chave e so quer saber se ela serve.
    const detalhe = (await r.text().catch(() => '')).slice(0, 300);
    if (r.status === 400 && /API key not valid/i.test(detalhe)) {
      throw new Error('Essa chave nao e valida. Confira se copiou inteira, ou gere outra em aistudio.google.com/apikey');
    }
    if (r.status === 403) throw new Error('A chave existe mas nao tem permissao para a API do Gemini. Gere outra em aistudio.google.com/apikey');
    if (r.status === 429) throw new Error('Cota esgotada nessa chave. Espere alguns minutos e tente de novo.');
    throw new Error(`A API do Gemini devolveu erro ${r.status}. Tente de novo em alguns minutos.`);
  }
  const env = await r.json();
  return (env?.models ?? [])
    .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map(m => String(m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}

/**
 * Escolhe o modelo de trabalho entre os que a chave enxerga. A ordem é preferência
 * declarada, não ranking do Google: flash primeiro porque o volume aqui é alto
 * (289 mil eventos) e a tarefa — extrair item de conversa — não pede o modelo caro.
 */
export function escolherModelo(disponiveis, preferidos = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']) {
  const conjunto = new Set(disponiveis);
  for (const p of preferidos) if (conjunto.has(p)) return p;
  // Nenhum preferido — geração nova que esta lista ainda não conhece. A ordem aqui é
  // por estabilidade, não por capacidade: `preview` e `exp` são descontinuados sem
  // aviso, e uma caixa instalada na máquina do sócio não pode parar de funcionar
  // porque o Google aposentou um preview. `lite` é estável e mais barato, então vem
  // antes de qualquer coisa instável.
  const instavel = /preview|exp|live/;
  const flash = disponiveis.filter(m => /flash/.test(m));
  return flash.find(m => !instavel.test(m) && !/lite/.test(m))
    ?? flash.find(m => !instavel.test(m))
    ?? flash[0]
    ?? null;
}

/**
 * Estimativa barata, deterministica e monotonica de tokens.
 *
 * Nao precisa ser exata (a API e a CLI tem tokenizers proprios), mas precisa ser
 * monotonica: texto maior nunca estima menos tokens que um texto menor.
 * 1 token ~= 4 caracteres, que e a media em portugues e ingles para modelos Gemini.
 * Zero dependencias para manter a instalacao leve e sem risco de quebra externa.
 */
export function estimarTokens(texto) {
  if (texto == null) return 0;
  const s = typeof texto === 'string' ? texto : String(texto);
  if (s.length === 0) return 0;
  return Math.ceil(s.length / 4);
}


import { isProxy } from 'node:util/types';

// Fronteira pura, sem modelo, persistência, UI ou autoridade para executar ações.
// Validar literalidade NÃO comprova que a fonte sustenta semanticamente a síntese.
export const CAMPOS = Object.freeze(['quem', 'acontecimento', 'combinado', 'mudanca', 'proximoPasso']);
const ID = /^E[1-9][0-9]*$/u;
const DATA = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

function recusar(caminho, motivo) {
  // Caminho/motivo são locais: não vazar texto, identidade ou chaves da entrada.
  const erro = new TypeError(`${caminho}: ${motivo}`);
  erro.code = 'SINTESE_CONTRATO_INVALIDO';
  erro.caminho = caminho;
  throw erro;
}

function recipiente(valor, prototipo, caminho) {
  // isProxy também reconhece proxies revogados sem disparar seus traps.
  if (valor === null || typeof valor !== 'object' || isProxy(valor)
      || Object.getPrototypeOf(valor) !== prototipo) {
    recusar(caminho, 'esperado recipiente comum do mesmo realm, sem Proxy ou protótipo customizado.');
  }
}

function dadoProprio(valor, chave, caminho) {
  const descritor = Object.getOwnPropertyDescriptor(valor, chave);
  if (!descritor || !Object.hasOwn(descritor, 'value') || !descritor.enumerable) {
    recusar(caminho, 'esperada propriedade própria enumerável de dados, sem getter/setter.');
  }
  return descritor.value;
}

function objeto(valor, chaves, caminho) {
  recipiente(valor, Object.prototype, caminho);
  const presentes = Reflect.ownKeys(valor);
  if (presentes.length !== chaves.length || presentes.some(chave => !chaves.includes(chave))) {
    recusar(caminho, 'campos obrigatórios ausentes ou campos extras/symbols.');
  }
  const copia = {};
  for (const chave of chaves) copia[chave] = dadoProprio(valor, chave, `${caminho}.${chave}`);
  return copia;
}

function lista(valor, minimo, maximo, caminho) {
  recipiente(valor, Array.prototype, caminho);
  if (!Array.isArray(valor)) recusar(caminho, 'esperado array comum.');
  const tamanho = Object.getOwnPropertyDescriptor(valor, 'length').value;
  if (tamanho < minimo || tamanho > maximo) recusar(caminho, 'quantidade fora do limite.');
  // length é a única propriedade não enumerável permitida; sem buracos/extras.
  if (Reflect.ownKeys(valor).length !== tamanho + 1) recusar(caminho, 'array com lacunas ou propriedades extras.');
  const copia = [];
  for (let i = 0; i < tamanho; i++) copia.push(dadoProprio(valor, String(i), `${caminho}[${i}]`));
  return copia;
}

function texto(valor, maximo, caminho) {
  if (typeof valor !== 'string' || valor.length > maximo || !valor.isWellFormed() || !valor.trim()) {
    recusar(caminho, 'esperada string bem formada, não vazia e dentro do limite UTF-16.');
  }
  // trim só detecta vazio; nenhum texto retornado é cortado ou normalizado.
  return valor;
}

function identidade(valor, caminho) {
  const id = texto(valor, 64, caminho);
  // Comparar a captura inteira também recusa a quebra de linha aceita por $.
  if (ID.exec(id)?.[0] !== id) recusar(caminho, 'esperado E seguido de inteiro positivo sem zeros iniciais.');
  return id; // Identidade textual: sem conversão numérica e sem arredondamento.
}

function dataISO(valor, caminho) {
  const data = texto(valor, 29, caminho);
  const partes = DATA.exec(data);
  if (!partes || partes[0] !== data) recusar(caminho, 'esperada data ISO completa com fuso explícito.');
  const [, anoTexto, mesTexto, diaTexto, horaTexto, minutoTexto, segundoTexto, , fuso] = partes;
  const [ano, mes, dia, hora, minuto, segundo] = [anoTexto, mesTexto, diaTexto, horaTexto, minutoTexto, segundoTexto].map(Number);
  const bissexto = ano % 4 === 0 && (ano % 100 !== 0 || ano % 400 === 0);
  const dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mes < 1 || mes > 12 || dia < 1 || dia > dias[mes - 1] || hora > 23 || minuto > 59 || segundo > 59) {
    recusar(caminho, 'data ou horário inexistente.');
  }
  if (fuso !== 'Z') {
    const horas = Number(fuso.slice(1, 3)), minutos = Number(fuso.slice(4, 6));
    if (horas > 14 || minutos > 59 || (horas === 14 && minutos !== 0)) {
      recusar(caminho, 'fuso fora do perfil ISO aceito (até 14:00).');
    }
  }
  return data;
}

/**
 * Valida 1–20 fontes {id, autor, data, texto} e devolve cópia profundamente
 * congelada. Texto integral: até 6000 por fonte e 24000 no total (UTF-16).
 * autor é somente a identidade fornecida; esta função não identifica pessoas.
 * Falha com TypeError/code SINTESE_CONTRATO_INVALIDO, sem conteúdo das fontes.
 */
export function validarFontes(fontes) {
  const entradas = lista(fontes, 1, 20, 'fontes');
  const ids = new Set();
  let total = 0;
  const copia = entradas.map((entrada, i) => {
    const caminho = `fontes[${i}]`;
    const fonte = objeto(entrada, ['id', 'autor', 'data', 'texto'], caminho);
    const id = identidade(fonte.id, `${caminho}.id`);
    if (ids.has(id)) recusar(`${caminho}.id`, 'identidade repetida.');
    ids.add(id);
    const autor = texto(fonte.autor, 256, `${caminho}.autor`);
    const data = dataISO(fonte.data, `${caminho}.data`);
    const integral = texto(fonte.texto, 6000, `${caminho}.texto`);
    total += integral.length;
    if (total > 24000) recusar('fontes', 'texto total excede 24000 unidades UTF-16.');
    return Object.freeze({ id, autor, data, texto: integral });
  });
  return Object.freeze(copia);
}

function campo(valor, fontes, caminho) {
  if (valor === null) return null;
  const entrada = objeto(valor, ['texto', 'citacoes'], caminho);
  const descricao = texto(entrada.texto, 500, `${caminho}.texto`);
  const citacoes = lista(entrada.citacoes, 1, 4, `${caminho}.citacoes`);
  const vistas = new Map();
  const copia = citacoes.map((valorCitacao, i) => {
    const local = `${caminho}.citacoes[${i}]`;
    const citacao = objeto(valorCitacao, ['fonte', 'trecho'], local);
    const fonte = identidade(citacao.fonte, `${local}.fonte`);
    const trecho = texto(citacao.trecho, 1000, `${local}.trecho`);
    const integral = fontes.get(fonte);
    if (integral === undefined) recusar(`${local}.fonte`, 'fonte ausente do recorte validado.');
    const trechosVistos = vistas.get(fonte) ?? new Set();
    if (trechosVistos.has(trecho)) recusar(local, 'citação duplicada neste campo.');
    trechosVistos.add(trecho);
    vistas.set(fonte, trechosVistos);
    const inicio = integral.indexOf(trecho);
    if (inicio === -1) recusar(`${local}.trecho`, 'trecho literal ausente na fonte.');
    // +1 encontra inclusive repetições sobrepostas ("aa" em "aaa").
    if (integral.indexOf(trecho, inicio + 1) !== -1) recusar(`${local}.trecho`, 'trecho ambíguo: mais de uma ocorrência.');
    return Object.freeze({ fonte, trecho, inicio, fim: inicio + trecho.length });
  });
  return Object.freeze({ texto: descricao, citacoes: Object.freeze(copia) });
}

/**
 * Entrada já estruturada, fechada: {versao:1, estado, cartao:{...cinco campos}}.
 * Devolve cópia congelada, com inicio/fim derivados em cada citação: índices
 * UTF-16, base zero, fim exclusivo. Offsets da entrada são campos extras.
 * Literalidade e estado "interpretado" NÃO são aprovação semântica, segurança
 * contra prompt injection, autorização, execução ou conclusão do CYCLE-03.
 */
export function validarSintese(saida, fontes) {
  // Nunca confiar que a fonte foi validada antes nem manter cache por referência.
  const recorte = validarFontes(fontes);
  const entrada = objeto(saida, ['versao', 'estado', 'cartao'], 'saida');
  if (entrada.versao !== 1) recusar('saida.versao', 'versão deve ser o número 1.');
  if (entrada.estado !== 'interpretado' && entrada.estado !== 'insuficiente') {
    recusar('saida.estado', 'estado deve ser interpretado ou insuficiente.');
  }
  const valores = objeto(entrada.cartao, CAMPOS, 'saida.cartao');
  const mapa = new Map(recorte.map(fonte => [fonte.id, fonte.texto]));
  const cartao = {};
  let preenchidos = 0;
  for (const nome of CAMPOS) {
    cartao[nome] = campo(valores[nome], mapa, `saida.cartao.${nome}`);
    if (cartao[nome] !== null) preenchidos++;
  }
  if (entrada.estado === 'insuficiente' && preenchidos !== 0) recusar('saida.cartao', 'insuficiente exige todos os campos null.');
  if (entrada.estado === 'interpretado' && preenchidos === 0) recusar('saida.cartao', 'interpretado exige ao menos um campo preenchido.');
  return Object.freeze({ versao: 1, estado: entrada.estado, cartao: Object.freeze(cartao) });
}
